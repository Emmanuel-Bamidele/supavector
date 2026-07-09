//
//  db.js
//  SupaVector
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// db.js
// Postgres helper functions for storing chunk text persistently.

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  STORAGE_BILLING_FORMULA_VERSION,
  buildUtcMonthWindow,
  splitRangeByUtcMonth,
  estimateVectorBytes,
  normalizeStorageBreakdown
} = require("./storage_billing");

const DB_CONNECT_TIMEOUT_MS = parseInt(process.env.DB_CONNECT_TIMEOUT_MS || "5000", 10);
const DB_QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS || "15000", 10);
const DB_STATEMENT_TIMEOUT_MS = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || "15000", 10);

// Pool manages a set of DB connections (better than one connection)
const poolConfig = {
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD
};

if (Number.isFinite(DB_CONNECT_TIMEOUT_MS) && DB_CONNECT_TIMEOUT_MS > 0) {
  poolConfig.connectionTimeoutMillis = DB_CONNECT_TIMEOUT_MS;
}
if (Number.isFinite(DB_QUERY_TIMEOUT_MS) && DB_QUERY_TIMEOUT_MS > 0) {
  poolConfig.query_timeout = DB_QUERY_TIMEOUT_MS;
}
if (Number.isFinite(DB_STATEMENT_TIMEOUT_MS) && DB_STATEMENT_TIMEOUT_MS > 0) {
  poolConfig.statement_timeout = DB_STATEMENT_TIMEOUT_MS;
}

const pool = new Pool(poolConfig);
const TENANT_SELECT_FIELDS = "tenant_id, name, external_id, metadata, auth_mode, sso_providers, sso_config, answer_provider, answer_model, boolean_ask_provider, boolean_ask_model, reflect_provider, reflect_model, compact_provider, compact_model, created_at";

const MEMORY_ITEM_SELECT_COLUMNS = `id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, agent_id, tags, visibility, acl_principals, title,
            source_type, source_url, metadata, parent_id, created_at, expires_at, value_score, tier, value_last_update_ts, tier_last_update_ts, reuse_count, last_used_at, utility_ema,
            redundancy_score, trust_score, importance_hint, pinned`;

const MEMORY_ITEM_STORAGE_BYTES_EXPR = `(
  octet_length(COALESCE(title, '')) +
  octet_length(COALESCE(source_type, '')) +
  octet_length(COALESCE(source_url, '')) +
  octet_length(COALESCE(external_id, '')) +
  octet_length(COALESCE(principal_id, '')) +
  octet_length(COALESCE(agent_id, '')) +
  octet_length(COALESCE(collection, '')) +
  octet_length(COALESCE(item_type, '')) +
  octet_length(COALESCE(visibility, '')) +
  octet_length(COALESCE(array_to_string(tags, ','), '')) +
  octet_length(COALESCE(array_to_string(acl_principals, ','), '')) +
  octet_length(COALESCE(metadata::text, ''))
)`;

const MEMORY_DOCUMENT_TYPE_SQL = "LOWER(COALESCE(metadata->>'documentType', metadata->>'document_type', metadata->>'docType', metadata->>'doc_type', ''))";
const FRESHNESS_METADATA_KEYS = [
  "updatedAt",
  "updated_at",
  "lastUpdatedAt",
  "last_updated_at",
  "modifiedAt",
  "modified_at",
  "publishedAt",
  "published_at",
  "effectiveAt",
  "effective_at",
  "sourceUpdatedAt",
  "source_updated_at",
  "syncedAt",
  "synced_at",
  "lastSyncedAt",
  "last_synced_at"
];
const MEMORY_FRESHNESS_SQL = `COALESCE(
  ${FRESHNESS_METADATA_KEYS.map((key) => `sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'${key}' END)`).join(",\n  ")},
  created_at
)`;

function resolveMemoryTimeFieldSql(field = "created_at") {
  return String(field || "").trim().toLowerCase() === "freshness"
    ? MEMORY_FRESHNESS_SQL
    : "created_at";
}

// Save a chunk row
async function saveChunk({ chunkId, docId, idx, text }) {
  await pool.query(
    `INSERT INTO chunks(chunk_id, doc_id, idx, text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chunk_id) DO UPDATE
     SET doc_id = EXCLUDED.doc_id,
         idx    = EXCLUDED.idx,
         text   = EXCLUDED.text`,
    [chunkId, docId, idx, text]
  );
}

async function saveChunks(chunks, options = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  const requestedBatchSize = Number(options?.batchSize);
  const batchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0
    ? Math.min(Math.floor(requestedBatchSize), 512)
    : 128;

  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    await pool.query(
      `INSERT INTO chunks(chunk_id, doc_id, idx, text)
       SELECT *
       FROM UNNEST($1::text[], $2::text[], $3::int[], $4::text[])
         AS t(chunk_id, doc_id, idx, text)
       ON CONFLICT (chunk_id) DO UPDATE
       SET doc_id = EXCLUDED.doc_id,
           idx    = EXCLUDED.idx,
           text   = EXCLUDED.text`,
      [
        batch.map((item) => item.chunkId),
        batch.map((item) => item.docId),
        batch.map((item) => item.idx),
        batch.map((item) => item.text)
      ]
    );
  }
}

// Get many chunks by ids (returns a Map)
async function getChunksByIds(ids) {
  if (!ids || ids.length === 0) return new Map();

  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     WHERE chunk_id = ANY($1)`,
    [ids]
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.chunk_id, row);
  }
  return map;
}

async function runLexicalChunkQuery({
  tsQueryFn,
  tenantPrefix,
  collectionPrefix,
  query,
  limit,
  namespacedDocIds
}) {
  const params = [query, limit, tenantPrefix, tenantPrefix.length];
  const clauses = [
    "LEFT(c.doc_id, $4) = $3",
    `to_tsvector('simple', c.text) @@ ${tsQueryFn}('simple', $1)`
  ];

  if (collectionPrefix) {
    params.push(collectionPrefix);
    clauses.push(`c.doc_id LIKE $${params.length}`);
  }
  if (Array.isArray(namespacedDocIds) && namespacedDocIds.length > 0) {
    params.push(namespacedDocIds);
    clauses.push(`c.doc_id = ANY($${params.length})`);
  }

  const res = await pool.query(
    `SELECT c.chunk_id, c.doc_id, c.idx, c.text,
            ts_rank_cd(to_tsvector('simple', c.text), ${tsQueryFn}('simple', $1)) AS lexical_score
     FROM chunks c
     WHERE ${clauses.join(" AND ")}
     ORDER BY lexical_score DESC, c.idx ASC
     LIMIT $2`,
    params
  );
  return res.rows;
}

async function searchChunksLexical({ tenantId, collection, query, limit, namespacedDocIds }) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];

  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  const tenantPrefix = `${tenantId}::`;
  const collectionPrefix = collection ? `${tenantId}::${collection}::%` : null;

  try {
    return await runLexicalChunkQuery({
      tsQueryFn: "websearch_to_tsquery",
      tenantPrefix,
      collectionPrefix,
      query: cleanQuery,
      limit: cleanLimit,
      namespacedDocIds
    });
  } catch (err) {
    const message = String(err?.message || "");
    if (!/tsquery|syntax/i.test(message)) {
      throw err;
    }
    return runLexicalChunkQuery({
      tsQueryFn: "plainto_tsquery",
      tenantPrefix,
      collectionPrefix,
      query: cleanQuery,
      limit: cleanLimit,
      namespacedDocIds
    });
  }
}

// Get all chunks for a doc (ordered)
async function getChunksByDocId(docId) {
  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     WHERE doc_id = $1
     ORDER BY idx ASC`,
    [docId]
  );
  return res.rows;
}

async function getChunksByDocIds(docIds) {
  if (!Array.isArray(docIds) || docIds.length === 0) return [];
  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     WHERE doc_id = ANY($1)
     ORDER BY doc_id ASC, idx ASC`,
    [docIds]
  );
  return res.rows;
}

// Delete all chunks for a docId
async function deleteDoc(docId) {
  await pool.query(`DELETE FROM chunks WHERE doc_id = $1`, [docId]);
}

async function countChunks() {
  const res = await pool.query(`SELECT COUNT(*)::bigint AS count FROM chunks`);
  return Number(res.rows[0]?.count || 0);
}

async function listChunksAfter({ afterId, limit }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? limit : 500;
  if (afterId) {
    const res = await pool.query(
      `SELECT chunk_id, doc_id, idx, text
       FROM chunks
       WHERE chunk_id > $1
       ORDER BY chunk_id
       LIMIT $2`,
      [afterId, cleanLimit]
    );
    return res.rows;
  }

  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     ORDER BY chunk_id
     LIMIT $1`,
    [cleanLimit]
  );
  return res.rows;
}

// Create or update an artifact memory item for a document
async function upsertMemoryArtifact({ tenantId, collection, externalId, namespaceId, title, sourceType, sourceUrl, metadata, expiresAt, principalId, visibility, acl, agentId, tags }) {
  return upsertMemoryItem({
    tenantId,
    collection,
    itemType: "artifact",
    externalId,
    namespaceId,
    title,
    sourceType,
    sourceUrl,
    metadata,
    expiresAt,
    principalId,
    visibility,
    acl,
    agentId,
    tags
  });
}

async function upsertMemoryItem({
  tenantId,
  collection,
  itemType,
  externalId,
  namespaceId,
  title,
  sourceType,
  sourceUrl,
  metadata,
  createdAt,
  expiresAt,
  itemId,
  principalId,
  visibility,
  acl,
  agentId,
  tags,
  importanceHint,
  pinned,
  initialValueScore,
  initialTier,
  valueLastUpdateTs,
  tierLastUpdateTs
}) {
  await ensureTenant(tenantId);
  if (!itemType) {
    throw new Error("itemType is required");
  }

  const id = itemId || namespaceId || crypto.randomUUID();
  const cleanVisibility = visibility || "tenant";
  const aclList = Array.isArray(acl) && acl.length ? acl : null;
  const tagList = Array.isArray(tags) && tags.length ? tags : null;
  const cleanAgentId = agentId || null;
  const tierRaw = String(initialTier || "WARM").trim().toUpperCase();
  const cleanTier = tierRaw === "HOT" || tierRaw === "COLD" ? tierRaw : "WARM";
  const nowMs = Date.now();
  const cleanValueScore = Number(initialValueScore);
  const valueScore = Number.isFinite(cleanValueScore) ? cleanValueScore : 0.5;
  const valueTs = Number.isFinite(valueLastUpdateTs) ? Math.floor(valueLastUpdateTs) : nowMs;
  const tierTs = Number.isFinite(tierLastUpdateTs) ? Math.floor(tierLastUpdateTs) : valueTs;
  const payload = [
    id,
    tenantId,
    collection,
    itemType,
    externalId || null,
    principalId || null,
    cleanAgentId,
    tagList,
    cleanVisibility,
    aclList,
    title || null,
    sourceType || null,
    sourceUrl || null,
    metadata ? JSON.stringify(metadata) : null,
    namespaceId || id,
    expiresAt ? new Date(expiresAt) : null,
    importanceHint === undefined ? null : Number(importanceHint),
    pinned === undefined ? null : Boolean(pinned),
    valueScore,
    cleanTier,
    valueTs,
    tierTs
  ];

  let sql = `INSERT INTO memory_items(
      id, tenant_id, collection, item_type, external_id, principal_id, agent_id, tags, visibility, acl_principals,
      title, source_type, source_url, metadata, namespace_id, expires_at, importance_hint, pinned, value_score, tier, value_last_update_ts, tier_last_update_ts
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
    ON CONFLICT (tenant_id, collection, item_type, external_id)
    DO UPDATE SET
      principal_id = EXCLUDED.principal_id,
      agent_id = EXCLUDED.agent_id,
      tags = EXCLUDED.tags,
      visibility = EXCLUDED.visibility,
      acl_principals = EXCLUDED.acl_principals,
      title = EXCLUDED.title,
      source_type = EXCLUDED.source_type,
      source_url = EXCLUDED.source_url,
      metadata = EXCLUDED.metadata,
      expires_at = EXCLUDED.expires_at,
      importance_hint = EXCLUDED.importance_hint,
      pinned = EXCLUDED.pinned
    RETURNING ${MEMORY_ITEM_SELECT_COLUMNS}`;

  if (createdAt) {
    payload.push(new Date(createdAt));
    sql = `INSERT INTO memory_items(
        id, tenant_id, collection, item_type, external_id, principal_id, agent_id, tags, visibility, acl_principals,
        title, source_type, source_url, metadata, namespace_id, expires_at, importance_hint, pinned, value_score, tier, value_last_update_ts, tier_last_update_ts, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (tenant_id, collection, item_type, external_id)
      DO UPDATE SET
        principal_id = EXCLUDED.principal_id,
        agent_id = EXCLUDED.agent_id,
        tags = EXCLUDED.tags,
        visibility = EXCLUDED.visibility,
        acl_principals = EXCLUDED.acl_principals,
        title = EXCLUDED.title,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
        metadata = EXCLUDED.metadata,
        expires_at = EXCLUDED.expires_at,
        importance_hint = EXCLUDED.importance_hint,
        pinned = EXCLUDED.pinned
      RETURNING ${MEMORY_ITEM_SELECT_COLUMNS}`;
  }

  const res = await pool.query(sql, payload);
  return res.rows[0] || { id, namespace_id: namespaceId || id };
}

function appendVisibilityClauses(clauses, params, { principalId, privileges } = {}) {
  const aclPrincipals = new Set();
  if (Array.isArray(privileges)) {
    for (const item of privileges) {
      const clean = String(item || "").trim();
      if (clean) aclPrincipals.add(clean);
    }
  }
  if (principalId) {
    aclPrincipals.add(principalId);
  }
  if (principalId || aclPrincipals.size > 0) {
    const visibilityClauses = [
      "visibility IS NULL",
      "visibility = 'tenant'"
    ];
    if (principalId) {
      params.push(principalId);
      const idx = params.length;
      visibilityClauses.push(`(visibility = 'private' AND principal_id = $${idx})`);
    }
    if (aclPrincipals.size > 0) {
      params.push(Array.from(aclPrincipals));
      const idx = params.length;
      visibilityClauses.push(`(visibility = 'acl' AND (principal_id = ANY($${idx}) OR COALESCE(acl_principals, ARRAY[]::TEXT[]) && $${idx}))`);
    }
    clauses.push(`(${visibilityClauses.join(" OR ")})`);
  }
}

function buildMemoryItemFilter({
  tenantId,
  collection,
  namespaceIds,
  externalIds,
  tier,
  types,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  excludeExpired,
  principalId,
  privileges,
  tags,
  agentId
}) {
  const clauses = [];
  const params = [];

  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (collection) {
    params.push(collection);
    clauses.push(`collection = $${params.length}`);
  }
  if (namespaceIds && namespaceIds.length) {
    params.push(namespaceIds);
    clauses.push(`namespace_id = ANY($${params.length})`);
  }
  if (externalIds && externalIds.length) {
    params.push(externalIds);
    clauses.push(`external_id = ANY($${params.length})`);
  }
  if (tier) {
    params.push(String(tier).trim().toUpperCase());
    clauses.push(`tier = $${params.length}`);
  }
  if (types && types.length) {
    params.push(types);
    clauses.push(`item_type = ANY($${params.length})`);
  }
  if (sourceTypes && sourceTypes.length) {
    params.push(sourceTypes.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
    clauses.push(`LOWER(COALESCE(source_type, '')) = ANY($${params.length})`);
  }
  if (documentTypes && documentTypes.length) {
    params.push(documentTypes.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
    clauses.push(`${MEMORY_DOCUMENT_TYPE_SQL} = ANY($${params.length})`);
  }
  if (agentId) {
    params.push(agentId);
    clauses.push(`agent_id = $${params.length}`);
  }
  if (tags && tags.length) {
    params.push(tags);
    clauses.push(`tags && $${params.length}`);
  }
  const timeSql = resolveMemoryTimeFieldSql(timeField);
  if (since) {
    params.push(since);
    clauses.push(`${timeSql} >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    clauses.push(`${timeSql} <= $${params.length}`);
  }
  if (excludeExpired) {
    clauses.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }
  appendVisibilityClauses(clauses, params, { principalId, privileges });
  return { clauses, params };
}

async function listMemoryItemsBySelectors({
  tenantId,
  collection,
  namespaceIds,
  externalIds,
  tier,
  types,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  excludeExpired,
  principalId,
  privileges,
  tags,
  agentId,
  limit,
  orderBy = "value"
}) {
  const { clauses, params } = buildMemoryItemFilter({
    tenantId,
    collection,
    namespaceIds,
    externalIds,
    tier,
    types,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    excludeExpired,
    principalId,
    privileges,
    tags,
    agentId
  });
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (cleanLimit > 0) {
    params.push(cleanLimit);
  }
  const mode = String(orderBy || "value").trim().toLowerCase();
  let orderClause = "ORDER BY value_score DESC NULLS LAST, id ASC";
  if (mode === "lru") {
    orderClause = "ORDER BY COALESCE(last_used_at, created_at) DESC NULLS LAST, id ASC";
  } else if (mode === "freshness") {
    orderClause = `ORDER BY ${resolveMemoryTimeFieldSql("freshness")} DESC NULLS LAST, value_score DESC NULLS LAST, id ASC`;
  } else if (mode === "created_at") {
    orderClause = "ORDER BY created_at DESC NULLS LAST, id ASC";
  }
  const limitClause = cleanLimit > 0 ? `LIMIT $${params.length}` : "";
  const whereClause = clauses.length ? clauses.join(" AND ") : "TRUE";

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${whereClause}
     ${orderClause}
     ${limitClause}`,
    params
  );
  return res.rows;
}

async function getMemoryItemsByNamespaceIds({
  tenantId,
  collection,
  namespaceIds,
  types,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  excludeExpired,
  principalId,
  privileges,
  tags,
  agentId
}) {
  if (!namespaceIds || namespaceIds.length === 0) return new Map();
  const rows = await listMemoryItemsBySelectors({
    tenantId,
    collection,
    namespaceIds,
    types,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    excludeExpired,
    principalId,
    privileges,
    tags,
    agentId
  });
  const map = new Map();
  for (const row of rows) {
    map.set(row.namespace_id, row);
  }
  return map;
}

function buildTierScopedMemoryFilter({
  tenantId,
  collection,
  tier,
  types,
  since,
  until,
  excludeExpired,
  principalId,
  privileges,
  tags,
  agentId,
  namespaceIds,
  externalIds,
  sourceTypes,
  documentTypes,
  timeField = "created_at"
}) {
  return buildMemoryItemFilter({
    tenantId,
    collection,
    namespaceIds,
    externalIds,
    tier,
    types,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    excludeExpired,
    principalId,
    privileges,
    tags,
    agentId
  });
}

async function listMemoryItemsByTier({
  tenantId,
  collection,
  tier,
  types,
  since,
  until,
  excludeExpired,
  principalId,
  privileges,
  tags,
  agentId,
  namespaceIds,
  externalIds,
  sourceTypes,
  documentTypes,
  timeField = "created_at",
  limit,
  sample
}) {
  const { clauses, params } = buildTierScopedMemoryFilter({
    tenantId,
    collection,
    namespaceIds,
    externalIds,
    tier,
    types,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    excludeExpired,
    principalId,
    privileges,
    tags,
    agentId
  });
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (cleanLimit > 0) {
    params.push(cleanLimit);
  }
  const sampleMode = String(sample || "").trim().toLowerCase();
  const orderBy = sampleMode === "lru"
    ? "ORDER BY COALESCE(last_used_at, created_at) DESC NULLS LAST, id ASC"
    : (sampleMode === "freshness"
      ? `ORDER BY ${resolveMemoryTimeFieldSql("freshness")} DESC NULLS LAST, value_score DESC NULLS LAST, id ASC`
      : "ORDER BY value_score DESC NULLS LAST, id ASC");
  const limitClause = cleanLimit > 0 ? `LIMIT $${params.length}` : "";
  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ${orderBy}
     ${limitClause}`,
    params
  );
  return res.rows;
}

async function countMemoryItemsByTier({
  tenantId,
  collection,
  tier,
  types,
  since,
  until,
  excludeExpired,
  principalId,
  privileges,
  tags,
  agentId,
  namespaceIds,
  externalIds,
  sourceTypes,
  documentTypes,
  timeField = "created_at"
}) {
  const { clauses, params } = buildTierScopedMemoryFilter({
    tenantId,
    collection,
    namespaceIds,
    externalIds,
    tier,
    types,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    excludeExpired,
    principalId,
    privileges,
    tags,
    agentId
  });
  const res = await pool.query(
    `SELECT COUNT(*)::bigint AS count
     FROM memory_items
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  return Number(res.rows[0]?.count || 0);
}

async function getMemoryItemById(id, tenantId, principalId) {
  const clauses = ["id = $1"];
  const params = [id];

  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  return res.rows[0] || null;
}

async function getMemoryItemByExternalId({ tenantId, collection, externalId, principalId }) {
  const clauses = ["tenant_id = $1", "collection = $2", "external_id = $3"];
  const params = [tenantId, collection, externalId];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

async function deleteMemoryItemById(id) {
  await pool.query(`DELETE FROM memory_items WHERE id = $1`, [id]);
}

async function deleteMemoryItemByNamespaceId(namespaceId) {
  await pool.query(`DELETE FROM memory_items WHERE namespace_id = $1`, [namespaceId]);
}

async function getArtifactByExternalId(tenantId, collection, externalId, principalId) {
  const clauses = ["tenant_id = $1", "collection = $2", "item_type = 'artifact'", "external_id = $3"];
  const params = [tenantId, collection, externalId];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

async function listExpiredMemoryItems({ tenantId, collection, before, limit, principalId }) {
  const clauses = [
    "tenant_id = $1",
    "collection = $2",
    "expires_at IS NOT NULL",
    "expires_at <= $3"
  ];
  const params = [tenantId, collection, before];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(limit);
  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals, title, expires_at
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY expires_at ASC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

async function listExpiredMemoryItemsGlobal({ before, limit }) {
  const cutoff = before || new Date();
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? limit : 200;
  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, expires_at
     FROM memory_items
     WHERE expires_at IS NOT NULL AND expires_at <= $1
     ORDER BY expires_at ASC
     LIMIT $2`,
    [cutoff, cleanLimit]
  );
  return res.rows;
}

async function listMemoryItemsForCompaction({ tenantId, collection, types, since, until, limit, principalId }) {
  const clauses = ["tenant_id = $1", "collection = $2"];
  const params = [tenantId, collection];

  if (types && types.length) {
    params.push(types);
    clauses.push(`item_type = ANY($${params.length})`);
  }
  if (since) {
    params.push(since);
    clauses.push(`created_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    clauses.push(`created_at <= $${params.length}`);
  }

  clauses.push(`(expires_at IS NULL OR expires_at > NOW())`);

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(limit);
  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return res.rows;
}

async function listMemoryItemsByExternalPrefix({ tenantId, collection, prefix }) {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix) return [];
  const res = await pool.query(
    `SELECT id, namespace_id, external_id, item_type, tenant_id, collection, created_at
     FROM memory_items
     WHERE tenant_id = $1
       AND collection = $2
       AND external_id LIKE $3`,
    [tenantId, collection, `${cleanPrefix}%`]
  );
  return res.rows;
}

async function listConversationWikiItems({ tenantId, collection, conversationId, pages, principalId }) {
  const clauses = [
    "tenant_id = $1",
    "collection = $2",
    "item_type = 'summary'",
    "metadata->>'conversationId' = $3",
    "metadata->>'kind' = 'conversation_wiki_page'"
  ];
  const params = [tenantId, collection, conversationId];

  if (Array.isArray(pages) && pages.length) {
    params.push(pages);
    clauses.push(`metadata->>'page' = ANY($${params.length})`);
  }

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, id ASC`,
    params
  );
  return res.rows;
}

async function listConversationTurnItems({ tenantId, collection, conversationId, afterCreatedAt = null, limit = 24, principalId }) {
  const clauses = [
    "tenant_id = $1",
    "collection = $2",
    "item_type = 'conversation'",
    "metadata->>'conversationId' = $3"
  ];
  const params = [tenantId, collection, conversationId];

  if (afterCreatedAt) {
    params.push(afterCreatedAt);
    clauses.push(`created_at > $${params.length}`);
  }

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(limit);
  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, id ASC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

async function listRecentConversationTurnItems({ tenantId, collection, conversationId, limit = 24, principalId }) {
  const clauses = [
    "tenant_id = $1",
    "collection = $2",
    "item_type = 'conversation'",
    "metadata->>'conversationId' = $3"
  ];
  const params = [tenantId, collection, conversationId];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(limit);
  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return res.rows.slice().reverse();
}

async function listConversationTurnItemsForPrune({ tenantId, collection, conversationId, beforeCreatedAt, keepRecentTurns = 4, principalId }) {
  const clauses = [
    "tenant_id = $1",
    "collection = $2",
    "item_type = 'conversation'",
    "metadata->>'conversationId' = $3",
    "created_at <= $4"
  ];
  const params = [tenantId, collection, conversationId, beforeCreatedAt];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(Math.max(0, keepRecentTurns));
  const res = await pool.query(
    `WITH ranked AS (
       SELECT ${MEMORY_ITEM_SELECT_COLUMNS},
              ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
       FROM memory_items
       WHERE ${clauses.join(" AND ")}
     )
     SELECT *
     FROM ranked
     WHERE rn > $${params.length}
     ORDER BY created_at ASC, id ASC`,
    params
  );
  return res.rows;
}

async function findActiveConversationWikiJob({ tenantId, collection, conversationId }) {
  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at
     FROM memory_jobs
     WHERE tenant_id = $1
       AND job_type = 'conversation_wiki_update'
       AND status IN ('queued', 'running')
       AND input->>'collection' = $2
       AND input->>'conversationId' = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, collection, conversationId]
  );
  return res.rows[0] || null;
}

async function recordMemoryEvent({ memoryId, tenantId, eventType, eventValue, createdAt }) {
  const cleanType = String(eventType || "").trim();
  if (!cleanType) throw new Error("eventType is required");
  const value = Number(eventValue);
  if (!Number.isFinite(value)) throw new Error("eventValue must be a number");
  const time = createdAt ? new Date(createdAt) : null;
  const res = await pool.query(
    `INSERT INTO memory_events(memory_id, tenant_id, event_type, event_value, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
     RETURNING id, memory_id, tenant_id, event_type, event_value, created_at`,
    [memoryId, tenantId, cleanType, value, time]
  );
  return res.rows[0] || null;
}

async function updateMemoryItemMetrics({
  id,
  tenantId,
  reuseCount,
  lastUsedAt,
  utilityEma,
  redundancyScore,
  trustScore,
  importanceHint,
  pinned,
  valueScore,
  tier,
  valueLastUpdateTs,
  tierLastUpdateTs
}) {
  const updates = [];
  const params = [id, tenantId];
  if (reuseCount !== undefined) {
    params.push(Number(reuseCount));
    updates.push(`reuse_count = $${params.length}`);
  }
  if (lastUsedAt !== undefined) {
    params.push(lastUsedAt ? new Date(lastUsedAt) : null);
    updates.push(`last_used_at = $${params.length}`);
  }
  if (utilityEma !== undefined) {
    params.push(Number(utilityEma));
    updates.push(`utility_ema = $${params.length}`);
  }
  if (redundancyScore !== undefined) {
    params.push(Number(redundancyScore));
    updates.push(`redundancy_score = $${params.length}`);
  }
  if (trustScore !== undefined) {
    params.push(Number(trustScore));
    updates.push(`trust_score = $${params.length}`);
  }
  if (importanceHint !== undefined) {
    params.push(importanceHint === null ? null : Number(importanceHint));
    updates.push(`importance_hint = $${params.length}`);
  }
  if (pinned !== undefined) {
    params.push(Boolean(pinned));
    updates.push(`pinned = $${params.length}`);
  }
  if (valueScore !== undefined) {
    params.push(valueScore === null ? null : Number(valueScore));
    updates.push(`value_score = $${params.length}`);
  }
  if (tier !== undefined) {
    params.push(tier === null ? null : String(tier).trim().toUpperCase());
    updates.push(`tier = $${params.length}`);
  }
  if (valueLastUpdateTs !== undefined) {
    params.push(valueLastUpdateTs === null ? null : Math.floor(Number(valueLastUpdateTs)));
    updates.push(`value_last_update_ts = $${params.length}`);
  }
  if (tierLastUpdateTs !== undefined) {
    params.push(tierLastUpdateTs === null ? null : Math.floor(Number(tierLastUpdateTs)));
    updates.push(`tier_last_update_ts = $${params.length}`);
  }

  if (updates.length === 0) return null;

  const res = await pool.query(
    `UPDATE memory_items
     SET ${updates.join(", ")}
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${MEMORY_ITEM_SELECT_COLUMNS}`,
    params
  );
  return res.rows[0] || null;
}

async function listMemoryItemsForValueDecay({ limit, afterId }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200;
  if (afterId) {
    const res = await pool.query(
      `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
       FROM memory_items
       WHERE id > $1
       ORDER BY id
       LIMIT $2`,
      [afterId, cleanLimit]
    );
    return res.rows;
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     ORDER BY id
     LIMIT $1`,
    [cleanLimit]
  );
  return res.rows;
}

async function listMemoryItemsForRedundancy({ limit, afterId }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 100;
  const clauses = ["item_type != 'artifact'"];
  if (afterId) {
    clauses.push(`id > $1`);
    const res = await pool.query(
      `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
       FROM memory_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY id
       LIMIT $2`,
      [afterId, cleanLimit]
    );
    return res.rows;
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY id
     LIMIT $1`,
    [cleanLimit]
  );
  return res.rows;
}

async function listMemoryItemsForLifecycle({ limit, afterId }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 100;
  const clauses = ["item_type != 'artifact'"];
  if (afterId) {
    clauses.push(`id > $1`);
    const res = await pool.query(
      `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
       FROM memory_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY id
       LIMIT $2`,
      [afterId, cleanLimit]
    );
    return res.rows;
  }

  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY id
     LIMIT $1`,
    [cleanLimit]
  );
  return res.rows;
}

async function createAuditLog({ tenantId, actorId, actorType, action, targetType, targetId, metadata, requestId, ip }) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `INSERT INTO audit_logs(
        tenant_id, actor_id, actor_type, action, target_type, target_id, metadata, request_id, ip
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, actor_id, actor_type, action, target_type, target_id, metadata, request_id, ip, created_at`,
    [
      tenantId,
      actorId || null,
      actorType || null,
      action,
      targetType || null,
      targetId || null,
      metadata ? JSON.stringify(metadata) : null,
      requestId || null,
      ip || null
    ]
  );
  return res.rows[0] || null;
}

async function listAuditLogs({ tenantId = null, action = null, targetType = null, targetId = null, limit = 100 } = {}) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const params = [tenantId || null];
  const clauses = ["($1::text IS NULL OR tenant_id = $1)"];
  if (action) {
    params.push(String(action).trim());
    clauses.push(`action = $${params.length}`);
  }
  if (targetType) {
    params.push(String(targetType).trim());
    clauses.push(`target_type = $${params.length}`);
  }
  if (targetId) {
    params.push(String(targetId).trim());
    clauses.push(`target_id = $${params.length}`);
  }
  params.push(cleanLimit);
  const res = await pool.query(
    `SELECT id, tenant_id, actor_id, actor_type, action, target_type, target_id, metadata, request_id, ip, created_at
     FROM audit_logs
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

async function createMemoryLink({ tenantId, fromItemId, toItemId, relation, metadata }) {
  const res = await pool.query(
    `INSERT INTO memory_links(tenant_id, from_item_id, to_item_id, relation, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, from_item_id, to_item_id, relation) DO NOTHING
     RETURNING id, tenant_id, from_item_id, to_item_id, relation, metadata, created_at`,
    [tenantId, fromItemId, toItemId, relation, metadata ? JSON.stringify(metadata) : null]
  );
  return res.rows[0];
}

async function createMemoryJob({ tenantId, jobType, status, input, maxAttempts, nextRunAt }) {
  const cleanMax = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3;
  const cleanNextRun = nextRunAt ? new Date(nextRunAt) : null;
  const res = await pool.query(
    `INSERT INTO memory_jobs(tenant_id, job_type, status, input, max_attempts, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at`,
    [tenantId, jobType, status, input ? JSON.stringify(input) : null, cleanMax, cleanNextRun]
  );
  return res.rows[0];
}

async function updateMemoryJob({ id, status, output, error, attempts, maxAttempts, nextRunAt }) {
  const attemptsValue = Number.isFinite(attempts) ? attempts : null;
  const maxAttemptsValue = Number.isFinite(maxAttempts) ? maxAttempts : null;
  const nextRunValue = nextRunAt ? new Date(nextRunAt) : null;
  const res = await pool.query(
    `UPDATE memory_jobs
     SET status = COALESCE($2, status),
         output = COALESCE($3, output),
         error = COALESCE($4, error),
         attempts = COALESCE($5, attempts),
         max_attempts = COALESCE($6, max_attempts),
         next_run_at = COALESCE($7, next_run_at),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at`,
    [id, status || null, output ? JSON.stringify(output) : null, error || null, attemptsValue, maxAttemptsValue, nextRunValue]
  );
  return res.rows[0] || null;
}

async function getMemoryJobById(id, tenantId) {
  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at
     FROM memory_jobs
     WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)`,
    [id, tenantId || null]
  );
  return res.rows[0] || null;
}

async function claimMemoryJob({ id, tenantId }) {
  const res = await pool.query(
    `UPDATE memory_jobs
     SET status = 'running',
         error = NULL,
         next_run_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND ($2::text IS NULL OR tenant_id = $2)
       AND status = 'queued'
       AND (next_run_at IS NULL OR next_run_at <= NOW())
     RETURNING id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at`,
    [id, tenantId || null]
  );
  return res.rows[0] || null;
}

function buildConversationWikiLockKey({ tenantId, collection, conversationId }) {
  return [
    "conversation_wiki",
    String(tenantId || "").trim(),
    String(collection || "").trim(),
    String(conversationId || "").trim()
  ].join(":");
}

function buildAdvisoryLockInts(key) {
  const digest = crypto.createHash("sha256").update(String(key || "")).digest();
  return [
    digest.readInt32BE(0),
    digest.readInt32BE(4)
  ];
}

async function acquireConversationWikiLock({ tenantId, collection, conversationId }) {
  const key = buildConversationWikiLockKey({ tenantId, collection, conversationId });
  const [major, minor] = buildAdvisoryLockInts(key);
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [major, minor]
    );
    if (!res.rows[0]?.locked) {
      client.release();
      return null;
    }
    return { client, key, major, minor };
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseConversationWikiLock(lock) {
  const client = lock?.client;
  if (!client) return;
  try {
    if (Number.isFinite(lock.major) && Number.isFinite(lock.minor)) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [lock.major, lock.minor]).catch(() => null);
    }
  } finally {
    client.release();
  }
}

async function getIdempotencyKey({ tenantId, endpoint, idempotencyKey }) {
  const res = await pool.query(
    `SELECT tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at
     FROM idempotency_keys
     WHERE tenant_id = $1 AND endpoint = $2 AND idem_key = $3`,
    [tenantId, endpoint, idempotencyKey]
  );
  return res.rows[0] || null;
}

async function beginIdempotencyKey({ tenantId, endpoint, idempotencyKey, requestHash }) {
  await ensureTenant(tenantId);
  const insert = await pool.query(
    `INSERT INTO idempotency_keys(tenant_id, endpoint, idem_key, request_hash, status)
     VALUES ($1, $2, $3, $4, 'in_progress')
     ON CONFLICT (tenant_id, endpoint, idem_key) DO NOTHING
     RETURNING tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at`,
    [tenantId, endpoint, idempotencyKey, requestHash]
  );

  if (insert.rows[0]) {
    return { inserted: true, record: insert.rows[0] };
  }

  const record = await getIdempotencyKey({ tenantId, endpoint, idempotencyKey });
  return { inserted: false, record };
}

async function touchIdempotencyKey({ tenantId, endpoint, idempotencyKey }) {
  const res = await pool.query(
    `UPDATE idempotency_keys
     SET updated_at = NOW(), status = 'in_progress'
     WHERE tenant_id = $1 AND endpoint = $2 AND idem_key = $3
     RETURNING tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at`,
    [tenantId, endpoint, idempotencyKey]
  );
  return res.rows[0] || null;
}

async function completeIdempotencyKey({ tenantId, endpoint, idempotencyKey, responseStatus, responseBody }) {
  const res = await pool.query(
    `UPDATE idempotency_keys
     SET status = 'completed',
         response_status = $4,
         response_body = $5,
         updated_at = NOW()
     WHERE tenant_id = $1 AND endpoint = $2 AND idem_key = $3
     RETURNING tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at`,
    [tenantId, endpoint, idempotencyKey, responseStatus, responseBody ? JSON.stringify(responseBody) : null]
  );
  return res.rows[0] || null;
}

async function createServiceToken({ tenantId, name, principalId, roles, keyHash, expiresAt }) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `INSERT INTO service_tokens(tenant_id, name, principal_id, roles, key_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at`,
    [tenantId, name, principalId, roles || [], keyHash, expiresAt ? new Date(expiresAt) : null]
  );
  return res.rows[0];
}

async function listServiceTokens(tenantId) {
  const res = await pool.query(
    `SELECT id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at
     FROM service_tokens
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return res.rows;
}

async function countTenantUsers(tenantId) {
  const res = await pool.query(
    `SELECT COUNT(*)::bigint AS count
     FROM users
     WHERE tenant_id = $1`,
    [tenantId]
  );
  return Number(res.rows[0]?.count || 0);
}

async function countTenantServiceTokens(tenantId) {
  const res = await pool.query(
    `SELECT COUNT(*)::bigint AS count
     FROM service_tokens
     WHERE tenant_id = $1 AND revoked_at IS NULL`,
    [tenantId]
  );
  return Number(res.rows[0]?.count || 0);
}

async function getServiceTokenByHash(keyHash) {
  const res = await pool.query(
    `SELECT id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at
     FROM service_tokens
     WHERE key_hash = $1
     LIMIT 1`,
    [keyHash]
  );
  return res.rows[0] || null;
}

async function recordServiceTokenUse(id) {
  await pool.query(
    `UPDATE service_tokens
     SET last_used_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function revokeServiceToken(id, tenantId) {
  const res = await pool.query(
    `UPDATE service_tokens
     SET revoked_at = NOW()
     WHERE id = $1 AND tenant_id = $2
     RETURNING id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at`,
    [id, tenantId]
  );
  return res.rows[0] || null;
}

async function deleteMemoryItemsByCollection(tenantId, collection) {
  const res = await pool.query(
    `DELETE FROM memory_items
     WHERE tenant_id = $1 AND collection = $2`,
    [tenantId, collection]
  );
  return res.rowCount || 0;
}

async function listMemoryItemsByCollection({ tenantId, collection }) {
  const res = await pool.query(
    `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
     FROM memory_items
     WHERE tenant_id = $1
       AND collection = $2
     ORDER BY created_at ASC, id ASC`,
    [tenantId, collection]
  );
  return res.rows;
}

async function listMemoryJobsByCollection({ tenantId, collection, jobTypes, statuses }) {
  const clauses = [
    "tenant_id = $1",
    "input->>'collection' = $2"
  ];
  const params = [tenantId, collection];

  if (Array.isArray(jobTypes) && jobTypes.length) {
    params.push(jobTypes.map((value) => String(value || "").trim()).filter(Boolean));
    clauses.push(`job_type = ANY($${params.length})`);
  }

  if (Array.isArray(statuses) && statuses.length) {
    params.push(statuses.map((value) => String(value || "").trim()).filter(Boolean));
    clauses.push(`status = ANY($${params.length})`);
  }

  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at
     FROM memory_jobs
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, id ASC`,
    params
  );
  return res.rows;
}

async function deleteMemoryJobsByCollection({ tenantId, collection, jobTypes, statuses }) {
  const clauses = [
    "tenant_id = $1",
    "input->>'collection' = $2"
  ];
  const params = [tenantId, collection];

  if (Array.isArray(jobTypes) && jobTypes.length) {
    params.push(jobTypes.map((value) => String(value || "").trim()).filter(Boolean));
    clauses.push(`job_type = ANY($${params.length})`);
  }

  if (Array.isArray(statuses) && statuses.length) {
    params.push(statuses.map((value) => String(value || "").trim()).filter(Boolean));
    clauses.push(`status = ANY($${params.length})`);
  }

  const res = await pool.query(
    `DELETE FROM memory_jobs
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  return res.rowCount || 0;
}

async function listMemoryJobs({ tenantId, limit, status, jobType }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  let statusClause = "$2::text IS NULL OR status = $2";
  let statusParam = status || null;

  if (Array.isArray(status)) {
    const filtered = status.map(s => String(s || "").trim()).filter(Boolean);
    if (filtered.length === 0) {
      statusParam = null;
    } else if (filtered.length === 1) {
      statusClause = "status = $2";
      statusParam = filtered[0];
    } else {
      statusClause = "status = ANY($2)";
      statusParam = filtered;
    }
  }

  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at
     FROM memory_jobs
     WHERE tenant_id = $1
       AND (${statusClause})
       AND ($3::text IS NULL OR job_type = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [tenantId, statusParam, jobType || null, cleanLimit]
  );
  return res.rows;
}

async function findActiveDeleteJob({ tenantId, memoryId }) {
  if (!tenantId || !memoryId) return null;
  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, attempts, max_attempts, next_run_at, created_at, updated_at
     FROM memory_jobs
     WHERE tenant_id = $1
       AND job_type = 'delete_reconcile'
       AND status = ANY($2)
       AND input->>'memoryId' = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, ["queued", "running"], memoryId]
  );
  return res.rows[0] || null;
}

async function listDueMemoryJobs({ limit }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  const res = await pool.query(
    `SELECT id, tenant_id, job_type
     FROM memory_jobs
     WHERE status = 'queued'
       AND (next_run_at IS NULL OR next_run_at <= NOW())
     ORDER BY next_run_at NULLS FIRST, id
     LIMIT $1`,
    [cleanLimit]
  );
  return res.rows;
}

// List documents for a tenant (distinct doc_id with chunk counts)
async function listDocsByTenant(tenantId, principalId, privileges) {
  const prefix = `${tenantId}::`;
  if (!principalId && (!Array.isArray(privileges) || privileges.length === 0)) {
    const res = await pool.query(
      `SELECT doc_id, COUNT(*)::int AS chunks
       FROM chunks
       WHERE LEFT(doc_id, $2) = $1
       GROUP BY doc_id
       ORDER BY doc_id`,
      [prefix, prefix.length]
    );
    return res.rows;
  }

  const params = [prefix, prefix.length, tenantId];
  const aclPrincipals = new Set();
  if (Array.isArray(privileges)) {
    for (const item of privileges) {
      const clean = String(item || "").trim();
      if (clean) aclPrincipals.add(clean);
    }
  }
  if (principalId) {
    aclPrincipals.add(principalId);
  }
  const visibilityClauses = [
    "m.visibility IS NULL",
    "m.visibility = 'tenant'"
  ];
  if (principalId) {
    params.push(principalId);
    const idx = params.length;
    visibilityClauses.push(`(m.visibility = 'private' AND m.principal_id = $${idx})`);
  }
  if (aclPrincipals.size > 0) {
    params.push(Array.from(aclPrincipals));
    const idx = params.length;
    visibilityClauses.push(`(m.visibility = 'acl' AND (m.principal_id = ANY($${idx}) OR COALESCE(m.acl_principals, ARRAY[]::TEXT[]) && $${idx}))`);
  }
  const res = await pool.query(
    `SELECT c.doc_id, COUNT(*)::int AS chunks
     FROM chunks c
     JOIN memory_items m ON m.namespace_id = c.doc_id AND m.item_type = 'artifact'
     WHERE LEFT(c.doc_id, $2) = $1
       AND m.tenant_id = $3
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
       AND (${visibilityClauses.join(" OR ")})
     GROUP BY c.doc_id
     ORDER BY c.doc_id`,
    params
  );
  return res.rows;
}

// Ensure tenant exists
async function ensureTenant(tenantId, name) {
  const cleanId = String(tenantId || "").trim();
  if (!cleanId) return;
  await pool.query(
    `INSERT INTO tenants(tenant_id, name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [cleanId, name || null]
  );
}

// Fetch user by username
async function getUserByUsername(username) {
  const res = await pool.query(
    `SELECT u.id, u.username, u.password_hash, u.tenant_id, u.roles, u.disabled, u.sso_only, u.auth_provider, u.auth_subject,
            u.email, u.full_name, u.failed_attempts, u.lock_until, u.last_login, t.auth_mode AS tenant_auth_mode
     FROM users u
     LEFT JOIN tenants t ON t.tenant_id = u.tenant_id
     WHERE u.username = $1`,
    [username]
  );
  return res.rows[0] || null;
}

async function countUsers() {
  const res = await pool.query(
    `SELECT COUNT(*)::bigint AS total
     FROM users`
  );
  return Number(res.rows[0]?.total || 0);
}

async function getTenantById(tenantId) {
  const res = await pool.query(
    `SELECT ${TENANT_SELECT_FIELDS}
     FROM tenants
     WHERE tenant_id = $1`,
    [tenantId]
  );
  return res.rows[0] || null;
}

async function createTenant({
  tenantId,
  name,
  externalId,
  metadata,
  authMode,
  ssoProviders,
  ssoConfig,
  answerProvider,
  answerModel,
  booleanAskProvider,
  booleanAskModel,
  reflectProvider,
  reflectModel,
  compactProvider,
  compactModel
}) {
  const res = await pool.query(
    `INSERT INTO tenants(
        tenant_id, name, external_id, metadata,
        auth_mode, sso_providers, sso_config,
        answer_provider, answer_model,
        boolean_ask_provider, boolean_ask_model,
        reflect_provider, reflect_model,
        compact_provider, compact_model
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${TENANT_SELECT_FIELDS}`,
    [
      tenantId,
      name || null,
      externalId || null,
      metadata ? JSON.stringify(metadata) : JSON.stringify({}),
      authMode || null,
      ssoProviders !== undefined ? ssoProviders : null,
      ssoConfig ? JSON.stringify(ssoConfig) : JSON.stringify({}),
      answerProvider || null,
      answerModel || null,
      booleanAskProvider || null,
      booleanAskModel || null,
      reflectProvider || null,
      reflectModel || null,
      compactProvider || null,
      compactModel || null
    ]
  );
  return res.rows[0] || null;
}

async function createTenantWithBootstrap({
  tenant,
  bootstrapUser = null,
  bootstrapServiceToken = null
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tenantRes = await client.query(
      `INSERT INTO tenants(
          tenant_id, name, external_id, metadata,
          auth_mode, sso_providers, sso_config,
          answer_provider, answer_model,
          boolean_ask_provider, boolean_ask_model,
          reflect_provider, reflect_model,
          compact_provider, compact_model
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${TENANT_SELECT_FIELDS}`,
      [
        tenant?.tenantId,
        tenant?.name || null,
        tenant?.externalId || null,
        tenant?.metadata ? JSON.stringify(tenant.metadata) : JSON.stringify({}),
        tenant?.authMode || null,
        tenant?.ssoProviders !== undefined ? tenant.ssoProviders : null,
        tenant?.ssoConfig ? JSON.stringify(tenant.ssoConfig) : JSON.stringify({}),
        tenant?.answerProvider || null,
        tenant?.answerModel || null,
        tenant?.booleanAskProvider || null,
        tenant?.booleanAskModel || null,
        tenant?.reflectProvider || null,
        tenant?.reflectModel || null,
        tenant?.compactProvider || null,
        tenant?.compactModel || null
      ]
    );

    let userRecord = null;
    if (bootstrapUser) {
      const userRes = await client.query(
        `INSERT INTO users(username, password_hash, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name)
         VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8, $9)
         RETURNING id, username, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name, failed_attempts, lock_until, last_login, created_at`,
        [
          bootstrapUser.username,
          bootstrapUser.passwordHash,
          tenant?.tenantId,
          bootstrapUser.roles || [],
          Boolean(bootstrapUser.ssoOnly),
          bootstrapUser.authProvider || null,
          bootstrapUser.authSubject || null,
          bootstrapUser.email || null,
          bootstrapUser.fullName || null
        ]
      );
      userRecord = userRes.rows[0] || null;
    }

    let tokenRecord = null;
    if (bootstrapServiceToken) {
      const tokenRes = await client.query(
        `INSERT INTO service_tokens(tenant_id, name, principal_id, roles, key_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at`,
        [
          tenant?.tenantId,
          bootstrapServiceToken.name,
          bootstrapServiceToken.principalId,
          bootstrapServiceToken.roles || [],
          bootstrapServiceToken.keyHash,
          bootstrapServiceToken.expiresAt ? new Date(bootstrapServiceToken.expiresAt) : null
        ]
      );
      tokenRecord = tokenRes.rows[0] || null;
    }

    await client.query("COMMIT");
    return {
      tenant: tenantRes.rows[0] || null,
      bootstrapUser: userRecord,
      bootstrapServiceToken: tokenRecord
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listTenants({ limit = 100, search = "" } = {}) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const cleanSearch = String(search || "").trim().toLowerCase();
  const params = [cleanLimit];
  const clauses = [];
  if (cleanSearch) {
    params.push(`%${cleanSearch}%`);
    clauses.push(`(
      LOWER(tenant_id) LIKE $${params.length}
      OR LOWER(COALESCE(name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(external_id, '')) LIKE $${params.length}
    )`);
  }
  const res = await pool.query(
    `SELECT ${TENANT_SELECT_FIELDS},
            (SELECT COUNT(*)::bigint FROM users u WHERE u.tenant_id = tenants.tenant_id) AS user_count,
            (SELECT COUNT(*)::bigint FROM service_tokens st WHERE st.tenant_id = tenants.tenant_id AND st.revoked_at IS NULL) AS service_token_count
     FROM tenants
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY created_at DESC, tenant_id ASC
     LIMIT $1`,
    params
  );
  return res.rows;
}

async function getTenantAuthMode(tenantId) {
  const tenant = await getTenantById(tenantId);
  return tenant ? tenant.auth_mode : null;
}

async function setTenantAuthMode(tenantId, authMode) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `UPDATE tenants
     SET auth_mode = $2
     WHERE tenant_id = $1
     RETURNING ${TENANT_SELECT_FIELDS}`,
    [tenantId, authMode]
  );
  return res.rows[0] || null;
}

async function setTenantSsoProviders(tenantId, providers) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `UPDATE tenants
     SET sso_providers = $2
     WHERE tenant_id = $1
     RETURNING ${TENANT_SELECT_FIELDS}`,
    [tenantId, providers]
  );
  return res.rows[0] || null;
}

async function setTenantSettings(tenantId, {
  name,
  externalId,
  metadata,
  authMode,
  ssoProviders,
  ssoConfig,
  answerProvider,
  answerModel,
  booleanAskProvider,
  booleanAskModel,
  reflectProvider,
  reflectModel,
  compactProvider,
  compactModel
}) {
  await ensureTenant(tenantId);
  const updates = [];
  const params = [tenantId];
  if (name !== undefined) {
    params.push(name || null);
    updates.push(`name = $${params.length}`);
  }
  if (externalId !== undefined) {
    params.push(externalId || null);
    updates.push(`external_id = $${params.length}`);
  }
  if (metadata !== undefined) {
    params.push(metadata ? JSON.stringify(metadata) : null);
    updates.push(`metadata = $${params.length}`);
  }
  if (authMode !== undefined) {
    params.push(authMode);
    updates.push(`auth_mode = $${params.length}`);
  }
  if (ssoProviders !== undefined) {
    params.push(ssoProviders);
    updates.push(`sso_providers = $${params.length}`);
  }
  if (ssoConfig !== undefined) {
    params.push(ssoConfig ? JSON.stringify(ssoConfig) : null);
    updates.push(`sso_config = $${params.length}`);
  }
  if (answerProvider !== undefined) {
    params.push(answerProvider);
    updates.push(`answer_provider = $${params.length}`);
  }
  if (answerModel !== undefined) {
    params.push(answerModel);
    updates.push(`answer_model = $${params.length}`);
  }
  if (booleanAskProvider !== undefined) {
    params.push(booleanAskProvider);
    updates.push(`boolean_ask_provider = $${params.length}`);
  }
  if (booleanAskModel !== undefined) {
    params.push(booleanAskModel);
    updates.push(`boolean_ask_model = $${params.length}`);
  }
  if (reflectProvider !== undefined) {
    params.push(reflectProvider);
    updates.push(`reflect_provider = $${params.length}`);
  }
  if (reflectModel !== undefined) {
    params.push(reflectModel);
    updates.push(`reflect_model = $${params.length}`);
  }
  if (compactProvider !== undefined) {
    params.push(compactProvider);
    updates.push(`compact_provider = $${params.length}`);
  }
  if (compactModel !== undefined) {
    params.push(compactModel);
    updates.push(`compact_model = $${params.length}`);
  }
  if (updates.length === 0) {
    return getTenantById(tenantId);
  }
  const res = await pool.query(
    `UPDATE tenants
     SET ${updates.join(", ")}
     WHERE tenant_id = $1
     RETURNING ${TENANT_SELECT_FIELDS}`,
    params
  );
  return res.rows[0] || null;
}

// Create a user (expects hashed password)
async function createUser({ username, passwordHash, tenantId, roles }) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `INSERT INTO users(username, password_hash, tenant_id, roles, sso_only)
     VALUES ($1, $2, $3, $4, FALSE)
     RETURNING id, username, tenant_id, roles, disabled`,
    [username, passwordHash, tenantId, roles || []]
  );
  return res.rows[0];
}

async function listTenantUsers(tenantId) {
  const res = await pool.query(
    `SELECT id, username, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name, failed_attempts, lock_until, last_login, created_at
     FROM users
     WHERE tenant_id = $1
     ORDER BY created_at ASC, id ASC`,
    [tenantId]
  );
  return res.rows;
}

async function getTenantUserById(tenantId, userId) {
  const res = await pool.query(
    `SELECT id, username, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name, failed_attempts, lock_until, last_login, created_at
     FROM users
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId]
  );
  return res.rows[0] || null;
}

async function createTenantUser({ tenantId, username, passwordHash, roles, email, fullName, ssoOnly = false, authProvider = null, authSubject = null }) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `INSERT INTO users(username, password_hash, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name)
     VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8, $9)
     RETURNING id, username, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name, failed_attempts, lock_until, last_login, created_at`,
    [username, passwordHash, tenantId, roles || [], Boolean(ssoOnly), authProvider, authSubject, email || null, fullName || null]
  );
  return res.rows[0] || null;
}

async function updateTenantUser(tenantId, userId, {
  roles,
  disabled,
  passwordHash,
  email,
  fullName,
  ssoOnly
}) {
  const updates = [];
  const params = [tenantId, userId];
  if (roles !== undefined) {
    params.push(roles);
    updates.push(`roles = $${params.length}`);
  }
  if (disabled !== undefined) {
    params.push(Boolean(disabled));
    updates.push(`disabled = $${params.length}`);
  }
  if (passwordHash !== undefined) {
    params.push(passwordHash);
    updates.push(`password_hash = $${params.length}`);
    updates.push(`failed_attempts = 0`);
    updates.push(`lock_until = NULL`);
  }
  if (email !== undefined) {
    params.push(email || null);
    updates.push(`email = $${params.length}`);
  }
  if (fullName !== undefined) {
    params.push(fullName || null);
    updates.push(`full_name = $${params.length}`);
  }
  if (ssoOnly !== undefined) {
    params.push(Boolean(ssoOnly));
    updates.push(`sso_only = $${params.length}`);
  }
  if (updates.length === 0) {
    return getTenantUserById(tenantId, userId);
  }
  const res = await pool.query(
    `UPDATE users
     SET ${updates.join(", ")}
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, username, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name, failed_attempts, lock_until, last_login, created_at`,
    params
  );
  return res.rows[0] || null;
}

async function upsertSsoUser({ provider, subject, tenantId, email, fullName, passwordHash }) {
  await ensureTenant(tenantId);
  const username = `${provider}:${subject}`;

  const res = await pool.query(
    `INSERT INTO users(username, password_hash, tenant_id, roles, sso_only, auth_provider, auth_subject, email, full_name)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8)
     ON CONFLICT (auth_provider, auth_subject)
     DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       email = EXCLUDED.email,
       full_name = EXCLUDED.full_name
     RETURNING id, username, tenant_id, roles, disabled, sso_only`,
    [username, passwordHash, tenantId, [], provider, subject, email || null, fullName || null]
  );
  return res.rows[0];
}

async function recordFailedLogin(username, maxAttempts, lockMinutes) {
  const safeMax = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5;
  const safeMinutes = Number.isFinite(lockMinutes) && lockMinutes > 0 ? lockMinutes : 15;

  const res = await pool.query(
    `UPDATE users
     SET failed_attempts = failed_attempts + 1,
         lock_until = CASE
           WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval
           ELSE lock_until
         END
     WHERE username = $1
     RETURNING failed_attempts, lock_until`,
    [username, safeMax, String(safeMinutes)]
  );
  return res.rows[0] || null;
}

async function recordSuccessfulLogin(userId) {
  await pool.query(
    `UPDATE users
     SET failed_attempts = 0,
         lock_until = NULL,
         last_login = NOW()
     WHERE id = $1`,
    [userId]
  );
}

async function recordTenantUsage({
  tenantId,
  embeddingTokens = 0,
  embeddingRequests = 0,
  generationInputTokens = 0,
  generationOutputTokens = 0,
  generationTotalTokens = 0,
  generationRequests = 0,
  eventKind = null,
  requestId = null,
  collection = null,
  source = null,
  estimated = false,
  billable = true,
  metadata = null
}) {
  await ensureTenant(tenantId);
  const payload = [
    tenantId,
    Number(embeddingTokens || 0),
    Number(embeddingRequests || 0),
    Number(generationInputTokens || 0),
    Number(generationOutputTokens || 0),
    Number(generationTotalTokens || 0),
    Number(generationRequests || 0)
  ];

  await pool.query(
    `INSERT INTO tenant_usage(
        tenant_id,
        embedding_tokens,
        embedding_requests,
        generation_input_tokens,
        generation_output_tokens,
        generation_total_tokens,
        generation_requests
      )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET
       embedding_tokens = tenant_usage.embedding_tokens + EXCLUDED.embedding_tokens,
       embedding_requests = tenant_usage.embedding_requests + EXCLUDED.embedding_requests,
       generation_input_tokens = tenant_usage.generation_input_tokens + EXCLUDED.generation_input_tokens,
       generation_output_tokens = tenant_usage.generation_output_tokens + EXCLUDED.generation_output_tokens,
       generation_total_tokens = tenant_usage.generation_total_tokens + EXCLUDED.generation_total_tokens,
       generation_requests = tenant_usage.generation_requests + EXCLUDED.generation_requests,
       updated_at = NOW()`,
    payload
  );

  const rollupSql = `INSERT INTO tenant_usage_rollups(
        tenant_id,
        bucket_kind,
        bucket_start,
        embedding_tokens,
        embedding_requests,
        generation_input_tokens,
        generation_output_tokens,
        generation_total_tokens,
        generation_requests
      )
      VALUES ($1, $2, date_trunc($3, NOW()), $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, bucket_kind, bucket_start) DO UPDATE SET
        embedding_tokens = tenant_usage_rollups.embedding_tokens + EXCLUDED.embedding_tokens,
        embedding_requests = tenant_usage_rollups.embedding_requests + EXCLUDED.embedding_requests,
        generation_input_tokens = tenant_usage_rollups.generation_input_tokens + EXCLUDED.generation_input_tokens,
        generation_output_tokens = tenant_usage_rollups.generation_output_tokens + EXCLUDED.generation_output_tokens,
        generation_total_tokens = tenant_usage_rollups.generation_total_tokens + EXCLUDED.generation_total_tokens,
        generation_requests = tenant_usage_rollups.generation_requests + EXCLUDED.generation_requests,
        updated_at = NOW()`;

  await pool.query(rollupSql, [tenantId, "hour", "hour", ...payload.slice(1)]);
  await pool.query(rollupSql, [tenantId, "day", "day", ...payload.slice(1)]);

  const cleanEventKind = String(eventKind || "").trim().toLowerCase();
  if (cleanEventKind === "embedding" || cleanEventKind === "generation") {
    await insertTenantUsageHistory({
      tenantId,
      eventKind: cleanEventKind,
      requestId,
      collection,
      source,
      estimated,
      billable,
      embeddingTokens: payload[1],
      generationInputTokens: payload[3],
      generationOutputTokens: payload[4],
      generationTotalTokens: payload[5],
      metadata
    });
  }
}

async function getTenantUsage(tenantId) {
  const res = await pool.query(
    `SELECT embedding_tokens,
            embedding_requests,
            generation_input_tokens,
            generation_output_tokens,
            generation_total_tokens,
            generation_requests,
            updated_at
     FROM tenant_usage
     WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!res.rows.length) {
    return {
      embedding_tokens: 0,
      embedding_requests: 0,
      generation_input_tokens: 0,
      generation_output_tokens: 0,
      generation_total_tokens: 0,
      generation_requests: 0,
      updated_at: null
    };
  }
  return res.rows[0];
}

async function getTenantUsageWindow(tenantId, window) {
  const win = String(window || "all").toLowerCase();
  if (win === "all") {
    return getTenantUsage(tenantId);
  }

  let kind = null;
  let interval = null;
  if (win === "24h" || win === "24hr" || win === "1d") {
    kind = "hour";
    interval = "24 hours";
  } else if (win === "7d" || win === "7day" || win === "7days") {
    kind = "day";
    interval = "7 days";
  } else {
    return getTenantUsage(tenantId);
  }

  const res = await pool.query(
    `SELECT COALESCE(SUM(embedding_tokens), 0)::bigint AS embedding_tokens,
            COALESCE(SUM(embedding_requests), 0)::bigint AS embedding_requests,
            COALESCE(SUM(generation_input_tokens), 0)::bigint AS generation_input_tokens,
            COALESCE(SUM(generation_output_tokens), 0)::bigint AS generation_output_tokens,
            COALESCE(SUM(generation_total_tokens), 0)::bigint AS generation_total_tokens,
            COALESCE(SUM(generation_requests), 0)::bigint AS generation_requests
     FROM tenant_usage_rollups
     WHERE tenant_id = $1
       AND bucket_kind = $2
       AND bucket_start >= NOW() - INTERVAL '${interval}'`,
    [tenantId, kind]
  );
  return res.rows[0] || {
    embedding_tokens: 0,
    embedding_requests: 0,
    generation_input_tokens: 0,
    generation_output_tokens: 0,
    generation_total_tokens: 0,
    generation_requests: 0
  };
}

async function insertTenantUsageHistory({
  tenantId,
  eventKind,
  requestId = null,
  collection = null,
  source = null,
  estimated = false,
  billable = true,
  embeddingTokens = 0,
  generationInputTokens = 0,
  generationOutputTokens = 0,
  generationTotalTokens = 0,
  storageBytesDelta = 0,
  storageBytesTotal = 0,
  storageChunksDelta = 0,
  storageChunksTotal = 0,
  storageDocumentsDelta = 0,
  storageDocumentsTotal = 0,
  storageMemoryItemsDelta = 0,
  storageMemoryItemsTotal = 0,
  storageCollectionsDelta = 0,
  storageCollectionsTotal = 0,
  metadata = null
}) {
  await pool.query(
    `INSERT INTO tenant_usage_history(
        tenant_id,
        event_kind,
        request_id,
        collection,
        source,
        estimated,
        billable,
        embedding_tokens,
        generation_input_tokens,
        generation_output_tokens,
        generation_total_tokens,
        storage_bytes_delta,
        storage_bytes_total,
        storage_chunks_delta,
        storage_chunks_total,
        storage_documents_delta,
        storage_documents_total,
        storage_memory_items_delta,
        storage_memory_items_total,
        storage_collections_delta,
        storage_collections_total,
        metadata
      )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
       $22
     )`,
    [
      tenantId,
      eventKind,
      requestId || null,
      collection || null,
      source || null,
      estimated === true,
      billable !== false,
      Number(embeddingTokens || 0),
      Number(generationInputTokens || 0),
      Number(generationOutputTokens || 0),
      Number(generationTotalTokens || 0),
      Number(storageBytesDelta || 0),
      Number(storageBytesTotal || 0),
      Number(storageChunksDelta || 0),
      Number(storageChunksTotal || 0),
      Number(storageDocumentsDelta || 0),
      Number(storageDocumentsTotal || 0),
      Number(storageMemoryItemsDelta || 0),
      Number(storageMemoryItemsTotal || 0),
      Number(storageCollectionsDelta || 0),
      Number(storageCollectionsTotal || 0),
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

function resolveUsageWindowClause(window) {
  const win = String(window || "all").toLowerCase();
  if (win === "24h" || win === "24hr" || win === "1d") {
    return "created_at >= NOW() - INTERVAL '24 hours'";
  }
  if (win === "7d" || win === "7day" || win === "7days") {
    return "created_at >= NOW() - INTERVAL '7 days'";
  }
  return "";
}

async function getTenantBillableGenerationUsageWindow(tenantId, window) {
  const clause = resolveUsageWindowClause(window);
  const where = [
    "tenant_id = $1",
    "event_kind = 'generation'",
    "billable = TRUE"
  ];
  if (clause) where.push(clause);
  const res = await pool.query(
    `SELECT COALESCE(SUM(generation_total_tokens), 0)::bigint AS generation_total_tokens
     FROM tenant_usage_history
     WHERE ${where.join(" AND ")}`,
    [tenantId]
  );
  return {
    generation_total_tokens: Number(res.rows[0]?.generation_total_tokens || 0)
  };
}

async function listTenantUsageHistory(tenantId, options = {}) {
  const cleanLimit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.min(Math.floor(options.limit), 200)
    : 50;
  const clause = resolveUsageWindowClause(options.window);
  const where = ["tenant_id = $1"];
  if (clause) where.push(clause);
  const res = await pool.query(
    `SELECT id,
            tenant_id,
            event_kind,
            request_id,
            collection,
            source,
            estimated,
            billable,
            embedding_tokens,
            generation_input_tokens,
            generation_output_tokens,
            generation_total_tokens,
            storage_bytes_delta,
            storage_bytes_total,
            storage_chunks_delta,
            storage_chunks_total,
            storage_documents_delta,
            storage_documents_total,
            storage_memory_items_delta,
            storage_memory_items_total,
            storage_collections_delta,
            storage_collections_total,
            metadata,
            created_at
     FROM tenant_usage_history
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [tenantId, cleanLimit]
  );
  return res.rows;
}

function normalizeStorageUsageRow(row) {
  const normalized = normalizeStorageBreakdown({
    chunk_text_bytes: row?.chunk_text_bytes,
    metadata_bytes: row?.metadata_bytes,
    vector_bytes: row?.vector_bytes,
    vector_dim: row?.vector_dim,
    chunks: row?.chunks,
    documents: row?.documents,
    memory_items: row?.memory_items,
    collections: row?.collections
  });
  return {
    ...normalized,
    formula_version: row?.formula_version || STORAGE_BILLING_FORMULA_VERSION,
    updated_at: row?.updated_at || null
  };
}

function normalizeStorageBillingStateRow(row) {
  return {
    tenant_id: row?.tenant_id || null,
    current_bytes: Number(row?.current_bytes || 0),
    current_chunk_text_bytes: Number(row?.current_chunk_text_bytes || 0),
    current_metadata_bytes: Number(row?.current_metadata_bytes || 0),
    current_vector_bytes: Number(row?.current_vector_bytes || 0),
    current_vector_dim: Number(row?.current_vector_dim || 0),
    formula_version: row?.formula_version || STORAGE_BILLING_FORMULA_VERSION,
    last_accrued_at: row?.last_accrued_at || null,
    updated_at: row?.updated_at || null
  };
}

function normalizeStorageBillingPeriodRow(row) {
  return {
    tenant_id: row?.tenant_id || null,
    period_start: row?.period_start || null,
    period_end: row?.period_end || null,
    storage_byte_seconds: Number(row?.storage_byte_seconds || 0),
    closing_bytes: Number(row?.closing_bytes || 0),
    closing_chunk_text_bytes: Number(row?.closing_chunk_text_bytes || 0),
    closing_metadata_bytes: Number(row?.closing_metadata_bytes || 0),
    closing_vector_bytes: Number(row?.closing_vector_bytes || 0),
    closing_vector_dim: Number(row?.closing_vector_dim || 0),
    formula_version: row?.formula_version || STORAGE_BILLING_FORMULA_VERSION,
    last_event_at: row?.last_event_at || null,
    closed_at: row?.closed_at || null,
    updated_at: row?.updated_at || null
  };
}

async function queryTenantStorageSnapshot(executor, tenantId, options = {}) {
  const cleanVectorDim = Number.isFinite(options.vectorDim) && options.vectorDim > 0
    ? Math.floor(options.vectorDim)
    : 0;
  const pattern = `${tenantId}::%`;
  const res = await executor.query(
    `WITH chunk_stats AS (
        SELECT COUNT(*)::bigint AS chunks,
               COALESCE(SUM(octet_length(text)), 0)::bigint AS chunk_text_bytes
        FROM chunks
        WHERE doc_id LIKE $2
      ),
      item_stats AS (
        SELECT COUNT(*) FILTER (WHERE item_type = 'artifact')::bigint AS documents,
               COUNT(*)::bigint AS memory_items,
               COUNT(DISTINCT collection)::bigint AS collections,
               COALESCE(SUM(${MEMORY_ITEM_STORAGE_BYTES_EXPR}), 0)::bigint AS metadata_bytes
        FROM memory_items
        WHERE tenant_id = $1
      )
      SELECT chunk_stats.chunks,
             chunk_stats.chunk_text_bytes,
             item_stats.metadata_bytes,
             item_stats.documents,
             item_stats.memory_items,
             item_stats.collections
      FROM chunk_stats
      CROSS JOIN item_stats`,
    [tenantId, pattern]
  );
  const row = res.rows[0] || {};
  const normalized = normalizeStorageBreakdown({
    chunk_text_bytes: row.chunk_text_bytes,
    metadata_bytes: row.metadata_bytes,
    vector_bytes: estimateVectorBytes({
      chunkCount: row.chunks,
      vectorDim: cleanVectorDim
    }),
    vector_dim: cleanVectorDim,
    chunks: row.chunks,
    documents: row.documents,
    memory_items: row.memory_items,
    collections: row.collections
  });
  return {
    ...normalized,
    formula_version: STORAGE_BILLING_FORMULA_VERSION,
    updated_at: null
  };
}

async function getTenantStorageSnapshot(tenantId, options = {}) {
  return queryTenantStorageSnapshot(pool, tenantId, options);
}

async function getTenantStorageUsage(tenantId) {
  const res = await pool.query(
    `SELECT bytes,
            chunk_text_bytes,
            metadata_bytes,
            vector_bytes,
            vector_dim,
            formula_version,
            chunks,
            documents,
            memory_items,
            collections,
            updated_at
     FROM tenant_storage_usage
     WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!res.rows.length) return null;
  return normalizeStorageUsageRow(res.rows[0]);
}

async function getTenantStorageBillingState(tenantId) {
  const res = await pool.query(
    `SELECT tenant_id,
            current_bytes,
            current_chunk_text_bytes,
            current_metadata_bytes,
            current_vector_bytes,
            current_vector_dim,
            formula_version,
            last_accrued_at,
            updated_at
     FROM tenant_storage_billing_state
     WHERE tenant_id = $1`,
    [tenantId]
  );
  return res.rows.length ? normalizeStorageBillingStateRow(res.rows[0]) : null;
}

async function getCurrentTenantStorageBillingPeriod(tenantId, options = {}) {
  const { periodStart } = buildUtcMonthWindow(options.now || new Date());
  const res = await pool.query(
    `SELECT tenant_id,
            period_start,
            period_end,
            storage_byte_seconds,
            closing_bytes,
            closing_chunk_text_bytes,
            closing_metadata_bytes,
            closing_vector_bytes,
            closing_vector_dim,
            formula_version,
            last_event_at,
            closed_at,
            updated_at
     FROM tenant_storage_billing_periods
     WHERE tenant_id = $1 AND period_start = $2`,
    [tenantId, periodStart]
  );
  return res.rows.length ? normalizeStorageBillingPeriodRow(res.rows[0]) : null;
}

async function listTenantStorageBillingPeriods(tenantId, options = {}) {
  const cleanLimit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.min(Math.floor(options.limit), 24)
    : 6;
  const res = await pool.query(
    `SELECT tenant_id,
            period_start,
            period_end,
            storage_byte_seconds,
            closing_bytes,
            closing_chunk_text_bytes,
            closing_metadata_bytes,
            closing_vector_bytes,
            closing_vector_dim,
            formula_version,
            last_event_at,
            closed_at,
            updated_at
     FROM tenant_storage_billing_periods
     WHERE tenant_id = $1
     ORDER BY period_start DESC
     LIMIT $2`,
    [tenantId, cleanLimit]
  );
  return res.rows.map(normalizeStorageBillingPeriodRow);
}

async function listTenantIdsWithStorageBillingState(options = {}) {
  const cleanLimit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.min(Math.floor(options.limit), 500)
    : 100;
  const afterTenantId = options.afterTenantId ? String(options.afterTenantId) : null;
  const params = afterTenantId ? [afterTenantId, cleanLimit] : [cleanLimit];
  const res = await pool.query(
    afterTenantId
      ? `SELECT tenant_id
         FROM (
           SELECT tenant_id FROM tenant_storage_billing_state
           UNION
           SELECT tenant_id FROM tenant_storage_usage
         ) storage_tenants
         WHERE tenant_id > $1
         ORDER BY tenant_id ASC
         LIMIT $2`
      : `SELECT tenant_id
         FROM (
           SELECT tenant_id FROM tenant_storage_billing_state
           UNION
           SELECT tenant_id FROM tenant_storage_usage
         ) storage_tenants
         ORDER BY tenant_id ASC
         LIMIT $1`,
    params
  );
  return res.rows.map((row) => String(row.tenant_id || "").trim()).filter(Boolean);
}

async function loadOrSeedTenantStorageBillingState(client, { tenantId, seedSnapshot, now }) {
  const existing = await client.query(
    `SELECT tenant_id,
            current_bytes,
            current_chunk_text_bytes,
            current_metadata_bytes,
            current_vector_bytes,
            current_vector_dim,
            formula_version,
            last_accrued_at,
            updated_at
     FROM tenant_storage_billing_state
     WHERE tenant_id = $1
     FOR UPDATE`,
    [tenantId]
  );
  if (existing.rows.length) {
    return normalizeStorageBillingStateRow(existing.rows[0]);
  }

  const seed = normalizeStorageUsageRow(seedSnapshot || {});
  const seededAtRaw = seedSnapshot?.updated_at ? new Date(seedSnapshot.updated_at) : now;
  const seededAt = Number.isNaN(seededAtRaw?.getTime?.()) ? now : seededAtRaw;
  const res = await client.query(
    `INSERT INTO tenant_storage_billing_state(
        tenant_id,
        current_bytes,
        current_chunk_text_bytes,
        current_metadata_bytes,
        current_vector_bytes,
        current_vector_dim,
        formula_version,
        last_accrued_at
      )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id) DO UPDATE SET
       current_bytes = tenant_storage_billing_state.current_bytes
     RETURNING tenant_id,
               current_bytes,
               current_chunk_text_bytes,
               current_metadata_bytes,
               current_vector_bytes,
               current_vector_dim,
               formula_version,
               last_accrued_at,
               updated_at`,
    [
      tenantId,
      seed.bytes,
      seed.chunk_text_bytes,
      seed.metadata_bytes,
      seed.vector_bytes,
      seed.vector_dim,
      seed.formula_version || STORAGE_BILLING_FORMULA_VERSION,
      seededAt
    ]
  );
  return normalizeStorageBillingStateRow(res.rows[0]);
}

async function upsertTenantStorageBillingPeriod(client, {
  tenantId,
  periodStart,
  periodEnd,
  storageByteSeconds = 0,
  snapshot,
  lastEventAt,
  closedAt = null
}) {
  const normalized = normalizeStorageUsageRow(snapshot || {});
  await client.query(
    `INSERT INTO tenant_storage_billing_periods(
        tenant_id,
        period_start,
        period_end,
        storage_byte_seconds,
        closing_bytes,
        closing_chunk_text_bytes,
        closing_metadata_bytes,
        closing_vector_bytes,
        closing_vector_dim,
        formula_version,
        last_event_at,
        closed_at
      )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, period_start) DO UPDATE SET
       period_end = EXCLUDED.period_end,
       storage_byte_seconds = tenant_storage_billing_periods.storage_byte_seconds + EXCLUDED.storage_byte_seconds,
       closing_bytes = EXCLUDED.closing_bytes,
       closing_chunk_text_bytes = EXCLUDED.closing_chunk_text_bytes,
       closing_metadata_bytes = EXCLUDED.closing_metadata_bytes,
       closing_vector_bytes = EXCLUDED.closing_vector_bytes,
       closing_vector_dim = EXCLUDED.closing_vector_dim,
       formula_version = EXCLUDED.formula_version,
       last_event_at = EXCLUDED.last_event_at,
       closed_at = CASE
         WHEN EXCLUDED.closed_at IS NOT NULL THEN EXCLUDED.closed_at
         ELSE tenant_storage_billing_periods.closed_at
       END,
       updated_at = NOW()`,
    [
      tenantId,
      periodStart,
      periodEnd,
      Number(storageByteSeconds || 0),
      normalized.bytes,
      normalized.chunk_text_bytes,
      normalized.metadata_bytes,
      normalized.vector_bytes,
      normalized.vector_dim,
      normalized.formula_version || STORAGE_BILLING_FORMULA_VERSION,
      lastEventAt || null,
      closedAt || null
    ]
  );
}

async function accrueTenantStorageBillingStateTx(client, { tenantId, now, state }) {
  const currentState = state ? normalizeStorageBillingStateRow(state) : await loadOrSeedTenantStorageBillingState(client, {
    tenantId,
    seedSnapshot: null,
    now
  });
  const lastAccruedAt = currentState.last_accrued_at ? new Date(currentState.last_accrued_at) : null;
  if (!lastAccruedAt || now <= lastAccruedAt) {
    return currentState;
  }

  const segments = splitRangeByUtcMonth(lastAccruedAt, now);
  for (const segment of segments) {
    const storageByteSeconds = currentState.current_bytes > 0
      ? currentState.current_bytes * Number(segment.elapsedSeconds || 0)
      : 0;
    const closesPeriod = segment.segmentEnd.getTime() === segment.periodEnd.getTime();
    if (storageByteSeconds > 0 || closesPeriod) {
      await upsertTenantStorageBillingPeriod(client, {
        tenantId,
        periodStart: segment.periodStart,
        periodEnd: segment.periodEnd,
        storageByteSeconds,
        snapshot: {
          bytes: currentState.current_bytes,
          chunk_text_bytes: currentState.current_chunk_text_bytes,
          metadata_bytes: currentState.current_metadata_bytes,
          vector_bytes: currentState.current_vector_bytes,
          vector_dim: currentState.current_vector_dim
        },
        lastEventAt: segment.segmentEnd,
        closedAt: closesPeriod ? segment.periodEnd : null
      });
    }
  }

  await client.query(
    `UPDATE tenant_storage_billing_state
     SET last_accrued_at = $2,
         updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId, now]
  );

  return {
    ...currentState,
    last_accrued_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

async function updateTenantStorageBillingStateCurrentTx(client, { tenantId, snapshot, now }) {
  const normalized = normalizeStorageUsageRow(snapshot || {});
  await client.query(
    `INSERT INTO tenant_storage_billing_state(
        tenant_id,
        current_bytes,
        current_chunk_text_bytes,
        current_metadata_bytes,
        current_vector_bytes,
        current_vector_dim,
        formula_version,
        last_accrued_at
      )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id) DO UPDATE SET
       current_bytes = EXCLUDED.current_bytes,
       current_chunk_text_bytes = EXCLUDED.current_chunk_text_bytes,
       current_metadata_bytes = EXCLUDED.current_metadata_bytes,
       current_vector_bytes = EXCLUDED.current_vector_bytes,
       current_vector_dim = EXCLUDED.current_vector_dim,
       formula_version = EXCLUDED.formula_version,
       updated_at = NOW()`,
    [
      tenantId,
      normalized.bytes,
      normalized.chunk_text_bytes,
      normalized.metadata_bytes,
      normalized.vector_bytes,
      normalized.vector_dim,
      normalized.formula_version || STORAGE_BILLING_FORMULA_VERSION,
      now
    ]
  );
}

async function touchCurrentTenantStorageBillingPeriodTx(client, { tenantId, snapshot, now }) {
  const { periodStart, periodEnd } = buildUtcMonthWindow(now);
  await upsertTenantStorageBillingPeriod(client, {
    tenantId,
    periodStart,
    periodEnd,
    storageByteSeconds: 0,
    snapshot,
    lastEventAt: now,
    closedAt: null
  });
}

async function syncTenantStorageUsage({
  tenantId,
  requestId = null,
  collection = null,
  source = null,
  metadata = null,
  recordHistory = true,
  vectorDim = 0,
  now = new Date()
}) {
  await ensureTenant(tenantId);
  const currentTime = now instanceof Date ? now : new Date(now);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previousRes = await client.query(
      `SELECT bytes,
              chunk_text_bytes,
              metadata_bytes,
              vector_bytes,
              vector_dim,
              formula_version,
              chunks,
              documents,
              memory_items,
              collections,
              updated_at
       FROM tenant_storage_usage
       WHERE tenant_id = $1
       FOR UPDATE`,
      [tenantId]
    );
    const previous = previousRes.rows.length
      ? normalizeStorageUsageRow(previousRes.rows[0])
      : normalizeStorageUsageRow(null);
    const current = await queryTenantStorageSnapshot(client, tenantId, { vectorDim });

    await client.query(
      `INSERT INTO tenant_storage_usage(
          tenant_id,
          bytes,
          chunk_text_bytes,
          metadata_bytes,
          vector_bytes,
          vector_dim,
          formula_version,
          chunks,
          documents,
          memory_items,
          collections
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id) DO UPDATE SET
         bytes = EXCLUDED.bytes,
         chunk_text_bytes = EXCLUDED.chunk_text_bytes,
         metadata_bytes = EXCLUDED.metadata_bytes,
         vector_bytes = EXCLUDED.vector_bytes,
         vector_dim = EXCLUDED.vector_dim,
         formula_version = EXCLUDED.formula_version,
         chunks = EXCLUDED.chunks,
         documents = EXCLUDED.documents,
         memory_items = EXCLUDED.memory_items,
         collections = EXCLUDED.collections,
         updated_at = NOW()`,
      [
        tenantId,
        current.bytes,
        current.chunk_text_bytes,
        current.metadata_bytes,
        current.vector_bytes,
        current.vector_dim,
        current.formula_version,
        current.chunks,
        current.documents,
        current.memory_items,
        current.collections
      ]
    );

    const state = await loadOrSeedTenantStorageBillingState(client, {
      tenantId,
      seedSnapshot: previousRes.rows.length ? previous : null,
      now: currentTime
    });
    await accrueTenantStorageBillingStateTx(client, {
      tenantId,
      now: currentTime,
      state
    });
    await updateTenantStorageBillingStateCurrentTx(client, {
      tenantId,
      snapshot: current,
      now: currentTime
    });
    await touchCurrentTenantStorageBillingPeriodTx(client, {
      tenantId,
      snapshot: current,
      now: currentTime
    });

    const delta = {
      bytes: current.bytes - previous.bytes,
      chunk_text_bytes: current.chunk_text_bytes - previous.chunk_text_bytes,
      metadata_bytes: current.metadata_bytes - previous.metadata_bytes,
      vector_bytes: current.vector_bytes - previous.vector_bytes,
      chunks: current.chunks - previous.chunks,
      documents: current.documents - previous.documents,
      memory_items: current.memory_items - previous.memory_items,
      collections: current.collections - previous.collections
    };

    const changed = Object.values(delta).some((value) => Number(value) !== 0);
    if (recordHistory && changed) {
      await client.query(
        `INSERT INTO tenant_usage_history(
            tenant_id,
            event_kind,
            request_id,
            collection,
            source,
            estimated,
            billable,
            storage_bytes_delta,
            storage_bytes_total,
            storage_chunks_delta,
            storage_chunks_total,
            storage_documents_delta,
            storage_documents_total,
            storage_memory_items_delta,
            storage_memory_items_total,
            storage_collections_delta,
            storage_collections_total,
            metadata
          )
         VALUES (
           $1, 'storage', $2, $3, $4, FALSE, TRUE,
           $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         )`,
        [
          tenantId,
          requestId || null,
          collection || null,
          source || null,
          delta.bytes,
          current.bytes,
          delta.chunks,
          current.chunks,
          delta.documents,
          current.documents,
          delta.memory_items,
          current.memory_items,
          delta.collections,
          current.collections,
          JSON.stringify({
            ...(metadata || {}),
            formulaVersion: current.formula_version,
            storageComponents: {
              chunkTextBytesDelta: delta.chunk_text_bytes,
              chunkTextBytesTotal: current.chunk_text_bytes,
              metadataBytesDelta: delta.metadata_bytes,
              metadataBytesTotal: current.metadata_bytes,
              vectorBytesDelta: delta.vector_bytes,
              vectorBytesTotal: current.vector_bytes,
              vectorDim: current.vector_dim
            }
          })
        ]
      );
    }

    await client.query("COMMIT");
    return {
      previous,
      current,
      delta,
      changed
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function accrueTenantStorageBillingState({ tenantId, now = new Date() }) {
  await ensureTenant(tenantId);
  const currentTime = now instanceof Date ? now : new Date(now);
  const seedSnapshot = await getTenantStorageUsage(tenantId) || await getTenantStorageSnapshot(tenantId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await loadOrSeedTenantStorageBillingState(client, {
      tenantId,
      seedSnapshot,
      now: currentTime
    });
    const updatedState = await accrueTenantStorageBillingStateTx(client, {
      tenantId,
      now: currentTime,
      state
    });
    await touchCurrentTenantStorageBillingPeriodTx(client, {
      tenantId,
      snapshot: {
        bytes: updatedState.current_bytes,
        chunk_text_bytes: updatedState.current_chunk_text_bytes,
        metadata_bytes: updatedState.current_metadata_bytes,
        vector_bytes: updatedState.current_vector_bytes,
        vector_dim: updatedState.current_vector_dim
      },
      now: currentTime
    });
    await client.query("COMMIT");
    return updatedState;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getTenantStorageStats(tenantId, options = {}) {
  const snapshot = await getTenantStorageSnapshot(tenantId, options);
  return {
    chunks: snapshot.chunks,
    bytes: snapshot.bytes
  };
}

async function getTenantItemStats(tenantId, options = {}) {
  const snapshot = await getTenantStorageSnapshot(tenantId, options);
  return {
    documents: snapshot.documents,
    memory_items: snapshot.memory_items,
    collections: snapshot.collections
  };
}

async function getMemoryStateSnapshot(tenantId) {
  const cleanTenantId = tenantId ? String(tenantId).trim() : null;
  const params = [cleanTenantId];
  const whereClause = "($1::text IS NULL OR tenant_id = $1)";

  const totalsRes = await pool.query(
    `SELECT COUNT(*)::bigint AS total_items,
            COALESCE(SUM(
              CASE
                WHEN metadata IS NULL THEN 0
                WHEN (metadata ? '_tokens_est') AND (metadata->>'_tokens_est') ~ '^[0-9]+(\\.[0-9]+)?$'
                  THEN (metadata->>'_tokens_est')::double precision
                WHEN (metadata ? 'tokens_est') AND (metadata->>'tokens_est') ~ '^[0-9]+(\\.[0-9]+)?$'
                  THEN (metadata->>'tokens_est')::double precision
                ELSE 0
              END
            ), 0)::bigint AS approx_tokens,
            COUNT(*) FILTER (WHERE value_score IS NULL)::bigint AS value_null,
            COUNT(*) FILTER (WHERE value_score < 0)::bigint AS value_lt_0,
            COUNT(*) FILTER (WHERE value_score >= 0 AND value_score < 0.25)::bigint AS value_0_025,
            COUNT(*) FILTER (WHERE value_score >= 0.25 AND value_score < 0.5)::bigint AS value_025_05,
            COUNT(*) FILTER (WHERE value_score >= 0.5 AND value_score < 0.75)::bigint AS value_05_075,
            COUNT(*) FILTER (WHERE value_score >= 0.75 AND value_score < 1)::bigint AS value_075_1,
            COUNT(*) FILTER (WHERE value_score >= 1)::bigint AS value_gte_1
     FROM memory_items
     WHERE ${whereClause}`,
    params
  );

  const typesRes = await pool.query(
    `SELECT item_type, COUNT(*)::bigint AS count
     FROM memory_items
     WHERE ${whereClause}
     GROUP BY item_type
     ORDER BY item_type ASC`,
    params
  );

  const tiersRes = await pool.query(
    `SELECT tier, COUNT(*)::bigint AS count
     FROM memory_items
     WHERE ${whereClause}
     GROUP BY tier
     ORDER BY tier ASC`,
    params
  );

  const typeDistribution = {};
  for (const row of typesRes.rows) {
    typeDistribution[row.item_type] = Number(row.count || 0);
  }
  const tierDistribution = {};
  for (const row of tiersRes.rows) {
    tierDistribution[String(row.tier || "WARM").toUpperCase()] = Number(row.count || 0);
  }

  const row = totalsRes.rows[0] || {};
  return {
    tenant_id: cleanTenantId || null,
    total_items: Number(row.total_items || 0),
    approx_tokens: Number(row.approx_tokens || 0),
    type_distribution: typeDistribution,
    tier_distribution: tierDistribution,
    value_distribution: {
      null: Number(row.value_null || 0),
      lt_0: Number(row.value_lt_0 || 0),
      "0_0.25": Number(row.value_0_025 || 0),
      "0.25_0.5": Number(row.value_025_05 || 0),
      "0.5_0.75": Number(row.value_05_075 || 0),
      "0.75_1": Number(row.value_075_1 || 0),
      gte_1: Number(row.value_gte_1 || 0)
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared with supavector-portal/plugins/index.js. The gateway and the portal plugin apply
// their DDL scripts concurrently on separate pool connections; without a common lock they
// take AccessExclusiveLock on overlapping relations in opposite order and deadlock (40P01).
// Both sides MUST use this exact key.
const MIGRATION_ADVISORY_LOCK_KEY = "4344282031982157";
const MIGRATION_DEADLOCK_ATTEMPTS = 3;

// pg_advisory_lock is session-scoped, so the lock must be held on the same connection that
// runs the DDL. pool.query() would hand each statement a different pooled connection.
async function runSqlWithMigrationLock(sql) {
  if (typeof pool.connect !== "function") {
    await pool.query(sql);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      await client.query(sql);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function runMigrations() {
  if (process.env.MIGRATIONS_AUTO === "0") return;

  const attempts = parseInt(process.env.MIGRATIONS_ATTEMPTS || "15", 10);
  const delayMs = parseInt(process.env.MIGRATIONS_DELAY_MS || "2000", 10);

  for (let i = 1; i <= attempts; i += 1) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (err) {
      if (i === attempts) throw err;
      await sleep(delayMs);
    }
  }

  const sqlPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  for (let attempt = 1; attempt <= MIGRATION_DEADLOCK_ATTEMPTS; attempt += 1) {
    try {
      await runSqlWithMigrationLock(sql);
      return;
    } catch (err) {
      if (err?.code !== "40P01" || attempt === MIGRATION_DEADLOCK_ATTEMPTS) throw err;
      await sleep(delayMs);
    }
  }
}

module.exports = {
  saveChunk,
  saveChunks,
  getChunksByIds,
  searchChunksLexical,
  getChunksByDocId,
  getChunksByDocIds,
  deleteDoc,
  countChunks,
  listChunksAfter,
  listDocsByTenant,
  upsertMemoryArtifact,
  upsertMemoryItem,
  getMemoryItemsByNamespaceIds,
  listMemoryItemsByTier,
  countMemoryItemsByTier,
  getMemoryItemById,
  getMemoryItemByExternalId,
  deleteMemoryItemById,
  deleteMemoryItemByNamespaceId,
  getArtifactByExternalId,
  listExpiredMemoryItems,
  listExpiredMemoryItemsGlobal,
  listMemoryItemsForCompaction,
  listMemoryItemsByExternalPrefix,
  listConversationWikiItems,
  listConversationTurnItems,
  listRecentConversationTurnItems,
  listConversationTurnItemsForPrune,
  recordMemoryEvent,
  updateMemoryItemMetrics,
  listMemoryItemsForValueDecay,
  listMemoryItemsForRedundancy,
  listMemoryItemsForLifecycle,
  createAuditLog,
  listAuditLogs,
  createMemoryLink,
  createMemoryJob,
  claimMemoryJob,
  acquireConversationWikiLock,
  releaseConversationWikiLock,
  updateMemoryJob,
  getMemoryJobById,
  findActiveConversationWikiJob,
  ensureTenant,
  listTenants,
  getUserByUsername,
  countUsers,
  createTenant,
  createTenantWithBootstrap,
  getTenantById,
  getTenantAuthMode,
  setTenantAuthMode,
  setTenantSsoProviders,
  setTenantSettings,
  createUser,
  listTenantUsers,
  getTenantUserById,
  createTenantUser,
  updateTenantUser,
  upsertSsoUser,
  recordFailedLogin,
  recordSuccessfulLogin,
  recordTenantUsage,
  getTenantUsage,
  getTenantUsageWindow,
  getTenantBillableGenerationUsageWindow,
  listTenantUsageHistory,
  getTenantStorageUsage,
  getTenantStorageSnapshot,
  getTenantStorageBillingState,
  getCurrentTenantStorageBillingPeriod,
  listTenantStorageBillingPeriods,
  listTenantIdsWithStorageBillingState,
  syncTenantStorageUsage,
  accrueTenantStorageBillingState,
  getTenantStorageStats,
  getTenantItemStats,
  getMemoryStateSnapshot,
  getIdempotencyKey,
  beginIdempotencyKey,
  touchIdempotencyKey,
  completeIdempotencyKey,
  createServiceToken,
  listServiceTokens,
  countTenantUsers,
  countTenantServiceTokens,
  getServiceTokenByHash,
  recordServiceTokenUse,
  revokeServiceToken,
  deleteMemoryItemsByCollection,
  listMemoryItemsByCollection,
  listMemoryJobsByCollection,
  deleteMemoryJobsByCollection,
  findActiveDeleteJob,
  listDueMemoryJobs,
  listMemoryJobs,
  runMigrations
};
