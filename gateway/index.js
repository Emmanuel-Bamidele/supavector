// index.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const { embedTexts, resolveEmbedDimension } = require("./ai");
const { chunkText } = require("./chunk");
const {
  normalizeRangeScore,
  resolveHybridFusionMode,
  resolveHybridFusionWeights,
  tokenizeForRerank,
  computeTokenOverlapScore,
  reciprocalRankContribution,
  rankSearchCandidates
} = require("./hybrid_retrieval");
const {
  buildRetrievalPlan,
  determineRecencyBoostMode,
  matchesRetrievalFilters,
  memoryFreshnessTimestampMs,
  normalizeRetrievalTimeField,
  resolveMemoryFavorRecencyPreference,
  resolveMemoryKnowledgeType
} = require("./retrieval_planner");
const { sendCmd, sendCmdBatch, buildVset, buildVsearchIn, buildVdel, buildVclear, parseVsearchReply } = require("./tcp");

const {
  saveChunks,
  getChunksByDocIds,
  searchChunksLexical,
  getChunksByDocId,
  deleteDoc,
  countChunks,
  listChunksAfter,
  listDocsByTenant,
  upsertMemoryArtifact,
  upsertMemoryItem,
  getMemoryItemsByNamespaceIds,
  listMemoryItemsByTier,
  getMemoryItemById,
  getMemoryItemByExternalId,
  deleteMemoryItemById,
  deleteMemoryItemByNamespaceId,
  getArtifactByExternalId,
  listExpiredMemoryItems,
  listExpiredMemoryItemsGlobal,
  listMemoryItemsForCompaction,
  listMemoryItemsByExternalPrefix,
  listMemoryItemsByCollection,
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
  listDueMemoryJobs,
  listMemoryJobs,
  listMemoryJobsByCollection,
  findActiveDeleteJob,
  deleteMemoryJobsByCollection,
  deleteMemoryItemsByCollection,
  beginIdempotencyKey,
  touchIdempotencyKey,
  completeIdempotencyKey,
  recordTenantUsage,
  getTenantUsage,
  getTenantUsageWindow,
  getTenantBillableGenerationUsageWindow,
  listTenantUsageHistory,
  getTenantStorageUsage,
  getTenantStorageBillingState,
  getCurrentTenantStorageBillingPeriod,
  listTenantStorageBillingPeriods,
  listTenantIdsWithStorageBillingState,
  syncTenantStorageUsage,
  accrueTenantStorageBillingState,
  getTenantStorageStats,
  getTenantItemStats,
  getMemoryStateSnapshot,
  listTenants,
  countUsers,
  createTenantWithBootstrap,
  getTenantById,
  setTenantSettings,
  listTenantUsers,
  getTenantUserById,
  createTenantUser,
  updateTenantUser,
  recordFailedLogin,
  recordSuccessfulLogin,
  createServiceToken,
  listServiceTokens,
  countTenantUsers,
  countTenantServiceTokens,
  revokeServiceToken,
  runMigrations,
  upsertSsoUser
} = require("./db");
const { requireJwt, limiter, loginLimiter } = require("./security");
const { generateAnswer, generateBooleanAskAnswer, generateCodeAnswer, normalizeCodeTask } = require("./answer");
const { reflectMemories, summarizeMemories } = require("./memory_reflect");
const { generateProviderText } = require("./provider_clients");
const {
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_EMBED_MODEL,
  buildPublicModelCatalog,
  resolveEnvModelDefaults,
  normalizeModelId,
  normalizeProviderId,
  resolveTenantModelSettings,
  parseTenantModelSettingsInput,
  hasTenantModelSettingsInput,
  resolveRequestedGenerationConfig
} = require("./model_config");
const {
  INSTANCE_ADMIN_ROLE,
  ENTERPRISE_ROLE_VALUES,
  ENTERPRISE_CONTROL_ROLE_VALUES,
  ENTERPRISE_SSO_PROVIDERS,
  normalizeRoleList,
  normalizeControlPlaneRoleList,
  normalizeTenantSsoConfigInput,
  buildTenantSsoConfigPublic
} = require("./enterprise_auth");
const { computeStoragePeriodSummary } = require("./storage_billing");
const { estimateTokensFromText, computeRecencyDecay } = require("./memory_value");
const {
  isBelowMinAgeForLifecycle,
  createDeleteBudget,
  consumeDeleteBudget,
  canConsumeDeleteBudget
} = require("./lifecycle_policy");
const { verifyCredentials, issueToken, parseAuthMode, normalizeAuthMode, isSsoAllowed } = require("./auth");
const { recordLatency, getLatencyStats, getAllTenantLatencyStats } = require("./metrics");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const openApiSpec = require("./openapi.json");
const {
  generators,
  deriveSsoRoles,
  getClient,
  getRedirectUri,
  buildStateCookie,
  isEmailAllowedForProvider,
  resolveSsoProviderConfig,
  resolveTenant,
  getUserProfile
} = require("./sso");
const {
  createRequestId: createTelemetryRequestId,
  getTelemetryMeta,
  isTelemetryEnabled,
  logTelemetry
} = require("./telemetry");

const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");
const UI_TEMPLATE_CANDIDATES = ["index.html"];
const UI_PARTIALS_DIR = path.join(PUBLIC_DIR, "partials");

function resolveUiTemplatePath() {
  for (const fileName of UI_TEMPLATE_CANDIDATES) {
    const candidate = path.join(PUBLIC_DIR, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Missing UI template. Expected one of: ${UI_TEMPLATE_CANDIDATES.join(", ")}`);
}

function renderPublicUiTemplate() {
  const templatePath = resolveUiTemplatePath();
  const template = fs.readFileSync(templatePath, "utf8");
  return template.replace(/<!--\s*@@include:([a-z0-9._-]+)\s*-->/gi, (match, partialName) => {
    const clean = String(partialName || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(clean)) {
      throw new Error(`Invalid UI partial include: ${partialName}`);
    }
    const partialPath = path.join(UI_PARTIALS_DIR, `${clean}.html`);
    if (!fs.existsSync(partialPath)) {
      throw new Error(`Missing UI partial: ${clean}.html`);
    }
    return fs.readFileSync(partialPath, "utf8");
  });
}

function parseEnvFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const clean = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(clean)) return true;
  if (["0", "false", "no", "off"].includes(clean)) return false;
  return defaultValue;
}

function normalizeDeploymentMode(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (["hosted", "shared", "saas", "cloud"].includes(clean)) return "hosted";
  return "self_hosted";
}

const COOKIE_SIGNING_SECRET = String(process.env.COOKIE_SECRET || process.env.JWT_SECRET || "").trim();
if (!COOKIE_SIGNING_SECRET) {
  throw new Error("COOKIE_SECRET or JWT_SECRET must be set");
}
const COOKIE_SECURE = parseEnvFlag(process.env.COOKIE_SECURE, false);
const DEPLOYMENT_MODE = normalizeDeploymentMode(
  process.env.SUPAVECTOR_DEPLOYMENT_MODE
  || process.env.DEPLOYMENT_MODE
  || ""
);
const DASHBOARD_URL = String(
  process.env.SUPAVECTOR_DASHBOARD_URL
  || process.env.DASHBOARD_URL
  || ""
).trim();
const PUBLIC_REGISTRATION_ENABLED = parseEnvFlag(
  process.env.PUBLIC_REGISTRATION_ENABLED,
  DEPLOYMENT_MODE === "hosted"
);
let portalPluginMounted = false;
let portalPluginReady = null;

const JSON_BODY_LIMIT = String(process.env.JSON_BODY_LIMIT || "64mb").trim() || "64mb";
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(cookieParser(COOKIE_SIGNING_SECRET));

app.use((req, res, next) => {
  const incoming = req.header("x-request-id");
  const requestId = incoming ? String(incoming).trim() : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

app.use((req, res, next) => {
  if (!isTelemetryEnabled()) {
    return next();
  }
  const path = req.path || "";
  const isStaticAsset = /\.[a-z0-9]+$/i.test(path);
  if (isStaticAsset) {
    return next();
  }

  const requestPath = req.originalUrl || req.path || "";
  const endpoint = classifyTelemetryEndpoint(requestPath);
  const startTsMs = Date.now();
  req.telemetryEndpoint = endpoint;
  req.telemetryStartTsMs = startTsMs;
  const start = process.hrtime.bigint();
  logTelemetry("request_start", {
    requestId: req.requestId,
    tenantId: resolveTenantForMetrics(req)
  }, {
    method: req.method,
    path: requestPath,
    endpoint,
    start_ts_ms: startTsMs,
    start_ts: new Date(startTsMs).toISOString()
  });

  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const endTsMs = Date.now();
    const status = Number(res.statusCode || 0);
    logTelemetry("request_finish", {
      requestId: req.requestId,
      tenantId: resolveTenantForMetrics(req)
    }, {
      method: req.method,
      path: requestPath,
      endpoint: req.telemetryEndpoint || classifyTelemetryEndpoint(requestPath),
      status,
      success: status >= 200 && status < 300,
      failure: status >= 400,
      start_ts_ms: Number.isFinite(req.telemetryStartTsMs) ? req.telemetryStartTsMs : null,
      end_ts_ms: endTsMs,
      end_ts: new Date(endTsMs).toISOString(),
      latency_ms: Number(elapsedMs.toFixed(2)),
      collection: req.collection ?? null
    });
  });

  next();
});

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const path = req.path || "";
    const isStaticAsset = /\.[a-z0-9]+$/i.test(path);
    if (path === "/health" && res.statusCode < 400) return;
    if (isStaticAsset) return;

    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tenantId = resolveTenantForMetrics(req) || null;
    const collection = req.collection ?? null;
    const payload = {
      level: "info",
      event: "request",
      request_id: req.requestId || null,
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      duration_ms: Number(ms.toFixed(2)),
      tenant_id: tenantId,
      collection
    };
    console.log(JSON.stringify(payload));
  });
  next();
});

// ── Optional private portal plugin ───────────────────────────────────────────
// Not part of the open-source distribution. Place the private plugin in
// gateway/plugins/ (directory is git-ignored). The app runs normally without it.
const skipPrivatePortalPlugin = ["1", "true", "yes", "on"].includes(
  String(process.env.GATEWAY_SKIP_PRIVATE_PORTAL_PLUGIN || "").trim().toLowerCase()
);
if (!skipPrivatePortalPlugin) {
  try {
    const portalPlugin = require("./plugins");
    portalPlugin.mount(app, { renderPublicUiTemplate });
    portalPluginMounted = true;
    if (typeof portalPlugin.ready === "function") {
      portalPluginReady = portalPlugin.ready;
    }
    console.log("[plugins] portal: mounted");
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    // gateway/plugins/ not present — running as open-source build, no portal features
  }
}
// ─────────────────────────────────────────────────────────────────────────────

app.get(["/", "/index.html"], (req, res, next) => {
  try {
    const html = renderPublicUiTemplate();
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

// Static UI is public (safe)
app.use(express.static(PUBLIC_DIR));

// Apply rate limiting to ALL API routes
app.use(limiter);

// Latency tracking (API routes only)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const rawPath = req.route?.path ?? req.path ?? "";
    const routePath = typeof rawPath === "string" ? rawPath : String(rawPath);
    const isApi = routePath.startsWith("/v1") ||
      routePath.startsWith("/docs") ||
      routePath.startsWith("/openapi") ||
      routePath.startsWith("/mcp") ||
      routePath.startsWith("/llms") ||
      routePath.startsWith("/ask") ||
      routePath.startsWith("/yes-no") ||
      routePath.startsWith("/boolean_ask") ||
      routePath.startsWith("/search") ||
      routePath.startsWith("/stats") ||
      routePath.startsWith("/health") ||
      routePath.startsWith("/login") ||
      routePath.startsWith("/auth");

    if (!isApi) return;
    const key = `${req.method} ${routePath}`;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tenantId = resolveTenantForMetrics(req);
    recordLatency(key, ms, res.statusCode, tenantId);
  });
  next();
});

const MAX_DOC_CHARS = parseInt(process.env.MAX_DOC_CHARS || "2000000", 10);
const MAX_FETCH_CHARS = parseInt(process.env.MAX_FETCH_CHARS || "5000000", 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const MAX_FETCH_REDIRECTS = parseInt(process.env.MAX_FETCH_REDIRECTS || "5", 10);
const MAX_REFLECT_CHARS = parseInt(process.env.REFLECT_MAX_CHARS || "12000", 10);
const MAX_COMPACT_CHARS = parseInt(process.env.COMPACT_MAX_CHARS || "12000", 10);
const DEBUG_INDEX = process.env.DEBUG_INDEX === "1";
const REINDEX_MODE = String(process.env.REINDEX_ON_START || "auto").toLowerCase();
const REINDEX_BATCH_SIZE = parseInt(process.env.REINDEX_BATCH_SIZE || "64", 10);
const REINDEX_FETCH_SIZE = parseInt(process.env.REINDEX_FETCH_SIZE || "256", 10);
const REINDEX_SLEEP_MS = parseInt(process.env.REINDEX_SLEEP_MS || "0", 10);
const REINDEX_LOG_EVERY = parseInt(process.env.REINDEX_LOG_EVERY || "500", 10);
const REINDEX_TCP_ATTEMPTS = parseInt(process.env.REINDEX_TCP_ATTEMPTS || "12", 10);
const REINDEX_TCP_DELAY_MS = parseInt(process.env.REINDEX_TCP_DELAY_MS || "2000", 10);
const TTL_SWEEP_ENABLED = process.env.TTL_SWEEP_ENABLED !== "0";
const TTL_SWEEP_INTERVAL_MS = parseInt(process.env.TTL_SWEEP_INTERVAL_MS || "300000", 10);
const TTL_SWEEP_BATCH_SIZE = parseInt(process.env.TTL_SWEEP_BATCH_SIZE || "200", 10);
const STORAGE_BILLING_ACCRUAL_INTERVAL_MS = parseInt(process.env.STORAGE_BILLING_ACCRUAL_INTERVAL_MS || "3600000", 10);
const STORAGE_USAGE_SYNC_DEBOUNCE_MS = parseInt(process.env.STORAGE_USAGE_SYNC_DEBOUNCE_MS || "5000", 10);
const DOCS_BULK_MAX_ITEMS = parseInt(process.env.DOCS_BULK_MAX_ITEMS || "250", 10);
const JOB_MAX_ATTEMPTS = parseInt(process.env.JOB_MAX_ATTEMPTS || "3", 10);
const JOB_RETRY_BASE_MS = parseInt(process.env.JOB_RETRY_BASE_MS || "2000", 10);
const JOB_RETRY_MAX_MS = parseInt(process.env.JOB_RETRY_MAX_MS || "30000", 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.JOB_SWEEP_INTERVAL_MS || "5000", 10);
const JOB_SWEEP_BATCH_SIZE = parseInt(process.env.JOB_SWEEP_BATCH_SIZE || "20", 10);
const CONVERSATION_WIKI_PAGES = [];
const CONVERSATION_WIKI_ARTICLE_PAGE = "article";
const CONVERSATION_WIKI_PAGE_SET = new Set([CONVERSATION_WIKI_ARTICLE_PAGE]);
const CONVERSATION_WIKI_SECTION_KEYS = ["confirmed", "uncertain", "open"];
const CONVERSATION_WIKI_MAX_PAGE_CHARS = parseInt(process.env.CONVERSATION_WIKI_MAX_PAGE_CHARS || "9000", 10);
const CONVERSATION_WIKI_MAX_SOURCE_TURNS = parseInt(process.env.CONVERSATION_WIKI_MAX_SOURCE_TURNS || "32", 10);
const CONVERSATION_WIKI_TURNS_PER_EXCHANGE = 2;
const CONVERSATION_WIKI_MAX_ITEMS_PER_SECTION = parseInt(process.env.CONVERSATION_WIKI_MAX_ITEMS_PER_SECTION || "18", 10);
const CONVERSATION_WIKI_MAX_TITLE_CHARS = parseInt(process.env.CONVERSATION_WIKI_MAX_TITLE_CHARS || "120", 10);
const CONVERSATION_WIKI_MAX_NOTE_CHARS = parseInt(process.env.CONVERSATION_WIKI_MAX_NOTE_CHARS || "240", 10);
const CONVERSATION_WIKI_MAX_PARAGRAPH_CHARS = parseInt(process.env.CONVERSATION_WIKI_MAX_PARAGRAPH_CHARS || "1800", 10);
const CONVERSATION_WIKI_MAX_SECTIONS = parseInt(process.env.CONVERSATION_WIKI_MAX_SECTIONS || "8", 10);
const CONVERSATION_WIKI_MAX_STORED_EXCHANGES = parseInt(process.env.CONVERSATION_WIKI_MAX_STORED_EXCHANGES || "24", 10);
const CONVERSATION_WIKI_MAX_EXCHANGE_RESPONSES = parseInt(process.env.CONVERSATION_WIKI_MAX_EXCHANGE_RESPONSES || "4", 10);
const CONVERSATION_WIKI_MAX_EXCHANGE_QUESTION_CHARS = parseInt(process.env.CONVERSATION_WIKI_MAX_EXCHANGE_QUESTION_CHARS || "900", 10);
const CONVERSATION_WIKI_MAX_EXCHANGE_RESPONSE_CHARS = parseInt(process.env.CONVERSATION_WIKI_MAX_EXCHANGE_RESPONSE_CHARS || "1800", 10);
const CONVERSATION_WIKI_CLEAR_COLLECTION_JOB_TYPE = "conversation_wiki_clear_collection";
const CONVERSATION_WIKI_CLEAR_LOCK_WAIT_MS = parseInt(process.env.CONVERSATION_WIKI_CLEAR_LOCK_WAIT_MS || "15000", 10);
const CONVERSATION_WIKI_CLEAR_LOCK_RETRY_MS = parseInt(process.env.CONVERSATION_WIKI_CLEAR_LOCK_RETRY_MS || "250", 10);
const MEMORY_RECENCY_HALFLIFE_DAYS = parseFloat(process.env.MEMORY_RECENCY_HALFLIFE_DAYS || "30");
const MEMORY_UTILITY_ALPHA = parseFloat(process.env.MEMORY_UTILITY_ALPHA || "0.2");
const MEMORY_TRUST_STEP = parseFloat(process.env.MEMORY_TRUST_STEP || "0.05");
const MEMORY_VALUE_MAX = parseFloat(process.env.MEMORY_VALUE_MAX || "1");
const MEMORY_ACCESS_ALPHA = parseFloat(process.env.MEMORY_ACCESS_ALPHA || "0.08");
const MEMORY_CONTRIBUTION_BETA = parseFloat(process.env.MEMORY_CONTRIBUTION_BETA || "0.2");
const MEMORY_NEGATIVE_STEP = parseFloat(process.env.MEMORY_NEGATIVE_STEP || "0.08");
const MEMORY_VALUE_DECAY_LAMBDA = parseFloat(
  process.env.MEMORY_VALUE_DECAY_LAMBDA
  || String(Math.log(2) / (Number.isFinite(MEMORY_RECENCY_HALFLIFE_DAYS) && MEMORY_RECENCY_HALFLIFE_DAYS > 0 ? MEMORY_RECENCY_HALFLIFE_DAYS : 30))
);
const MEMORY_TIER_HOT_UP = parseFloat(process.env.MEMORY_TIER_HOT_UP || process.env.MEMORY_LIFECYCLE_PROMOTE_THRESHOLD || "0.7");
const MEMORY_TIER_HOT_DOWN = parseFloat(process.env.MEMORY_TIER_HOT_DOWN || "0.62");
const MEMORY_TIER_WARM_UP = parseFloat(process.env.MEMORY_TIER_WARM_UP || "0.45");
const MEMORY_TIER_WARM_DOWN = parseFloat(process.env.MEMORY_TIER_WARM_DOWN || process.env.MEMORY_LIFECYCLE_DELETE_THRESHOLD || "0.25");
const MEMORY_TIER_EVICT = parseFloat(process.env.MEMORY_TIER_EVICT || process.env.MEMORY_LIFECYCLE_DELETE_THRESHOLD || "0.25");
const MEMORY_INIT_VALUE = parseFloat(process.env.MEMORY_INIT_VALUE || "0.5");
const MEMORY_RETRIEVAL_WARM_SAMPLE_K = parseInt(process.env.MEMORY_RETRIEVAL_WARM_SAMPLE_K || "8", 10);
const MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER = parseInt(process.env.MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER || "4", 10);
const MEMORY_RETRIEVAL_WARM_SELECTION = String(process.env.MEMORY_RETRIEVAL_WARM_SELECTION || "random").trim().toLowerCase() === "lru"
  ? "lru"
  : "random";
const MEMORY_RETRIEVAL_COLD_PROBE_EPSILON = parseInt(process.env.MEMORY_RETRIEVAL_COLD_PROBE_EPSILON || "0", 10);
const MEMORY_EVENT_FLUSH_INTERVAL_MS = parseInt(process.env.MEMORY_EVENT_FLUSH_INTERVAL_MS || "250", 10);
const MEMORY_EVENT_FLUSH_MAX_EVENTS = parseInt(process.env.MEMORY_EVENT_FLUSH_MAX_EVENTS || "200", 10);
const MEMORY_VALUE_DECAY_INTERVAL_MS = parseInt(process.env.MEMORY_VALUE_DECAY_INTERVAL_MS || "3600000", 10);
const MEMORY_VALUE_BATCH_SIZE = parseInt(process.env.MEMORY_VALUE_BATCH_SIZE || "200", 10);
const MEMORY_VALUE_MAX_ITEMS = parseInt(process.env.MEMORY_VALUE_MAX_ITEMS || "0", 10);
const MEMORY_REDUNDANCY_INTERVAL_MS = parseInt(process.env.MEMORY_REDUNDANCY_INTERVAL_MS || "86400000", 10);
const MEMORY_REDUNDANCY_BATCH_SIZE = parseInt(process.env.MEMORY_REDUNDANCY_BATCH_SIZE || "100", 10);
const MEMORY_REDUNDANCY_TOP_K = parseInt(process.env.MEMORY_REDUNDANCY_TOP_K || "8", 10);
const MEMORY_REDUNDANCY_QUERY_CHARS = parseInt(process.env.MEMORY_REDUNDANCY_QUERY_CHARS || "800", 10);
const MEMORY_LIFECYCLE_INTERVAL_MS = parseInt(process.env.MEMORY_LIFECYCLE_INTERVAL_MS || "86400000", 10);
const MEMORY_LIFECYCLE_BATCH_SIZE = parseInt(process.env.MEMORY_LIFECYCLE_BATCH_SIZE || "50", 10);
const MEMORY_LIFECYCLE_MIN_AGE_HOURS = parseFloat(process.env.MEMORY_LIFECYCLE_MIN_AGE_HOURS || "24");
const MEMORY_LIFECYCLE_MAX_DELETES = parseInt(process.env.MEMORY_LIFECYCLE_MAX_DELETES || "0", 10);
const MEMORY_LIFECYCLE_DRY_RUN = process.env.MEMORY_LIFECYCLE_DRY_RUN === "1";
const MEMORY_LIFECYCLE_DELETE_THRESHOLD = parseFloat(process.env.MEMORY_LIFECYCLE_DELETE_THRESHOLD || "0.25");
const MEMORY_LIFECYCLE_SUMMARY_THRESHOLD = parseFloat(process.env.MEMORY_LIFECYCLE_SUMMARY_THRESHOLD || "0.45");
const MEMORY_LIFECYCLE_PROMOTE_THRESHOLD = parseFloat(process.env.MEMORY_LIFECYCLE_PROMOTE_THRESHOLD || "0.70");
const MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE = parseInt(process.env.MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE || "5", 10);
const MEMORY_LIFECYCLE_COMPACT_DELETE_ORIGINALS = process.env.MEMORY_LIFECYCLE_COMPACT_DELETE_ORIGINALS !== "0";
const MEMORY_PROMOTION_MAX_ITEMS = parseInt(process.env.MEMORY_PROMOTION_MAX_ITEMS || "3", 10);
const MEMORY_PROMOTION_COOLDOWN_HOURS = parseInt(process.env.MEMORY_PROMOTION_COOLDOWN_HOURS || "24", 10);
const MEMORY_COMPACT_COOLDOWN_HOURS = parseInt(process.env.MEMORY_COMPACT_COOLDOWN_HOURS || "24", 10);
const MEMORY_SNAPSHOT_INTERVAL_MS = parseInt(process.env.TELEMETRY_SNAPSHOT_INTERVAL_MS || "300000", 10);
const BILLING_STORAGE_INCLUDED_GB_MONTH = parseFloat(process.env.BILLING_STORAGE_INCLUDED_GB_MONTH || "0");
let reindexStarted = false;
let ttlSweepRunning = false;
let storageBillingAccrualRunning = false;
let jobSweepRunning = false;
let valueDecayRunning = false;
let redundancyRunning = false;
let lifecycleRunning = false;
let memorySnapshotRunning = false;
let memoryEventFlushRunning = false;
const storageUsageSyncQueue = new Map();
const redundancyPending = new Set();
const memoryEventQueue = [];
const FETCH_USER_AGENT = process.env.FETCH_USER_AGENT
  || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const DOC_ID_RE = /^[a-zA-Z0-9._-]+$/;
const TENANT_RE = /^[a-zA-Z0-9._-]+$/;
const COLLECTION_RE = /^[a-zA-Z0-9._-]+$/;
const ITEM_TYPE_RE = /^[a-zA-Z0-9._-]+$/;
const PRINCIPAL_RE = /^[a-zA-Z0-9._:@-]+$/;
const TAG_RE = /^[a-zA-Z0-9._:@-]+$/;
const AGENT_RE = /^[a-zA-Z0-9._:@-]+$/;
const DEFAULT_COLLECTION = process.env.DEFAULT_COLLECTION || "default";
const SELF_SERVICE_REGISTRATION_ROLES = Object.freeze(["admin", "indexer", "reader"]);
const TENANT_SEARCH_MULTIPLIER = parseInt(process.env.TENANT_SEARCH_MULTIPLIER || "5", 10);
const TENANT_SEARCH_CAP = parseInt(process.env.TENANT_SEARCH_CAP || "50", 10);
const CHUNK_STRATEGY = String(process.env.CHUNK_STRATEGY || "token").toLowerCase() === "char" ? "char" : "token";
const CHUNK_MAX_CHARS = parseInt(process.env.CHUNK_MAX_CHARS || "900", 10);
const CHUNK_MAX_TOKENS = parseInt(process.env.CHUNK_MAX_TOKENS || "220", 10);
const CHUNK_OVERLAP_TOKENS = parseInt(process.env.CHUNK_OVERLAP_TOKENS || "40", 10);
const CODE_CHUNK_MAX_TOKENS = parseInt(process.env.CODE_CHUNK_MAX_TOKENS || "360", 10);
const CODE_CHUNK_OVERLAP_TOKENS = parseInt(process.env.CODE_CHUNK_OVERLAP_TOKENS || "72", 10);
const HYBRID_RETRIEVAL_ENABLED = process.env.HYBRID_RETRIEVAL_ENABLED !== "0";
const HYBRID_FUSION_MODE = resolveHybridFusionMode(process.env.HYBRID_FUSION_MODE || "rrf");
const HYBRID_RRF_K = parseInt(process.env.HYBRID_RRF_K || "60", 10);
const HYBRID_VECTOR_WEIGHT = parseFloat(process.env.HYBRID_VECTOR_WEIGHT || "0.72");
const HYBRID_LEXICAL_WEIGHT = parseFloat(process.env.HYBRID_LEXICAL_WEIGHT || "0.28");
const HYBRID_LEXICAL_MULTIPLIER = parseInt(process.env.HYBRID_LEXICAL_MULTIPLIER || "2", 10);
const HYBRID_LEXICAL_CAP = parseInt(process.env.HYBRID_LEXICAL_CAP || "120", 10);
const HYBRID_RERANK_OVERLAP_BOOST = parseFloat(process.env.HYBRID_RERANK_OVERLAP_BOOST || "0.12");
const HYBRID_RERANK_EXACT_BOOST = parseFloat(process.env.HYBRID_RERANK_EXACT_BOOST || "0.08");
const MEMORY_RETRIEVAL_RECENCY_WEIGHT = parseFloat(process.env.MEMORY_RETRIEVAL_RECENCY_WEIGHT || "0.3");
const MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS = parseFloat(process.env.MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS || "14");
const RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED = process.env.RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED !== "0";
const CHUNK_UPSERT_BATCH_SIZE = 128;
const VECTOR_WRITE_BATCH_SIZE = 8;
const VECTOR_WRITE_BATCH_CONCURRENCY = 2;
const VECTOR_DELETE_BATCH_SIZE = 128;
const VECTOR_DELETE_BATCH_CONCURRENCY = 2;
const SSO_PROVIDERS = ["google", "azure", "okta"];
const ROLE_DEFAULT = "reader";
const ROLE_ALIASES = new Map([
  [INSTANCE_ADMIN_ROLE, INSTANCE_ADMIN_ROLE],
  ["platform_admin", INSTANCE_ADMIN_ROLE],
  ["enterprise_admin", INSTANCE_ADMIN_ROLE],
  ["admin", "admin"],
  ["owner", "admin"],
  ["indexer", "indexer"],
  ["writer", "indexer"],
  ["reader", "reader"]
]);
const MEMORY_TYPES = ["artifact", "semantic", "procedural", "episodic", "conversation", "summary"];
const DEFAULT_MEMORY_POLICY = "amvl";
const MEMORY_POLICIES = [DEFAULT_MEMORY_POLICY, "ttl", "lru"];
const MEMORY_POLICY_ALIASES = new Map([
  ["amv-l", DEFAULT_MEMORY_POLICY],
  ["amv_l", DEFAULT_MEMORY_POLICY]
]);
const MEMORY_POLICY_OVERRIDES = Object.freeze({
  ttl: {
    tierHotUp: 0.51,
    tierHotDown: 0.01,
    tierWarmUp: 0.50,
    tierWarmDown: 0.00,
    tierEvict: 0.00,
    initValue: 0.50,
    retrievalWarmSampleK: 2000,
    retrievalWarmSamplePoolMultiplier: 8,
    retrievalWarmSelection: "random",
    valueDecayLoopEnabled: false,
    redundancyEnabled: false,
    lifecycleEnabled: false
  },
  lru: {
    tierHotUp: 0.99,
    tierHotDown: 0.01,
    tierWarmUp: 0.00,
    tierWarmDown: 0.00,
    tierEvict: 0.00,
    initValue: 0.50,
    accessAlpha: 0,
    contributionBeta: 0,
    negativeStep: 0,
    valueDecayLambda: 0,
    retrievalWarmSampleK: 8,
    retrievalWarmSamplePoolMultiplier: 1,
    retrievalWarmSelection: "lru",
    valueDecayLoopEnabled: false,
    redundancyEnabled: false,
    lifecycleEnabled: false
  }
});
const LEGACY_TYPE_ALIASES = new Map([
  ["memory", "semantic"]
]);
const MEMORY_EVENT_DEFAULTS = {
  retrieved: 0.1,
  used_in_answer: 0.6,
  user_positive: 1.0,
  user_negative: -1.0,
  task_success: 0.8,
  task_fail: -0.8
};
const MEMORY_TASK_EVENT_TYPES = new Set(["task_success", "task_fail"]);
const OPENAPI_HIDDEN_TAGS = new Set(["Metrics"]);
const MCP_SERVER_NAME = "supavector-docs";
const MCP_SERVER_VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_RESOURCE_URI_PREFIX = "supavector://docs/";

function filterPublicOpenApiDoc(doc) {
  const inputTags = Array.isArray(doc?.tags) ? doc.tags : [];
  const inputPaths = doc?.paths && typeof doc.paths === "object" ? doc.paths : {};
  const paths = {};

  for (const [route, ops] of Object.entries(inputPaths)) {
    const cleanOps = {};
    for (const [method, op] of Object.entries(ops || {})) {
      const tags = Array.isArray(op?.tags) ? op.tags : [];
      const hiddenByTag = tags.some((tag) => OPENAPI_HIDDEN_TAGS.has(tag));
      if (op?.["x-internal"] === true || hiddenByTag) continue;
      cleanOps[method] = op;
    }
    if (Object.keys(cleanOps).length > 0) {
      paths[route] = cleanOps;
    }
  }

  return {
    ...doc,
    tags: inputTags.filter((tag) => !OPENAPI_HIDDEN_TAGS.has(tag.name)),
    paths
  };
}

function resolvePublicBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.OPENAPI_BASE_URL;
  if (envBase) return String(envBase).trim().replace(/\/+$/, "");

  const forwardedProto = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim() || "http";
  const forwardedHost = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  if (!forwardedHost) return "http://localhost:3000";
  return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, "");
}

function buildPublicRegistrationProjectName({ projectName, fullName, username } = {}) {
  const explicit = parseOptionalString(projectName, { label: "projectName", max: 80 });
  if (explicit) return explicit;
  const cleanFullName = parseOptionalString(fullName, { label: "fullName", max: 120 });
  if (cleanFullName) return `${cleanFullName}'s Project`;
  const cleanUsername = normalizePublicRegistrationUsername(username);
  return `${cleanUsername} Project`;
}

function normalizePublicRegistrationUsername(value) {
  const clean = String(value || "").trim();
  if (!clean) {
    throw new Error("username is required");
  }
  if (!TENANT_RE.test(clean)) {
    throw new Error("username must use only letters, numbers, dot, dash, or underscore");
  }
  return clean;
}

function slugifyPublicRegistrationProjectBase(value, fallback = "project") {
  const clean = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = clean || fallback;
  return base.slice(0, 32).replace(/^-+|-+$/g, "") || fallback;
}

function buildPublicRegistrationTenantId({ projectName, username, suffix } = {}) {
  const base = slugifyPublicRegistrationProjectBase(projectName || username || "project");
  const cleanSuffix = String(
    suffix
    || crypto.randomBytes(3).toString("hex")
  ).trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "default";
  return `${base}-${cleanSuffix}`;
}

function buildPublicRegistrationInstructions(baseUrl) {
  const cleanBaseUrl = String(baseUrl || "http://localhost:3000").trim().replace(/\/+$/, "");
  return {
    baseUrl: cleanBaseUrl,
    installCommand: "pip install supavector",
    env: [
      `SUPAVECTOR_BASE_URL=${cleanBaseUrl}`,
      "SUPAVECTOR_API_KEY=<paste-the-copied-service-token>"
    ],
    python: [
      "from supavector import Client",
      "",
      `client = Client(base_url=\"${cleanBaseUrl}\", api_key=\"<paste-the-copied-service-token>\")`,
      `result = client.search(query=\"hello\", collection=\"${DEFAULT_COLLECTION}\")`
    ]
  };
}

async function resolvePublicRegistrationState() {
  if (PUBLIC_REGISTRATION_ENABLED) {
    return {
      enabled: true,
      reason: DEPLOYMENT_MODE === "hosted" ? "hosted_self_serve" : "env_enabled"
    };
  }
  if (DEPLOYMENT_MODE === "self_hosted") {
    const totalUsers = await countUsers();
    if (totalUsers === 0) {
      return {
        enabled: true,
        reason: "first_user_bootstrap"
      };
    }
  }
  return {
    enabled: false,
    reason: DEPLOYMENT_MODE === "hosted" ? "disabled" : "self_hosted_bootstrapped"
  };
}

function describePublicRegistrationState(state) {
  if (state?.enabled && state?.reason === "first_user_bootstrap") {
    return "Browser registration is available because this self-hosted deployment does not have an admin yet.";
  }
  if (state?.enabled && state?.reason === "env_enabled") {
    return "Self-serve browser registration is enabled on this self-hosted deployment.";
  }
  if (state?.enabled) {
    return "Create an account, get a default project, and mint a service token in one flow.";
  }
  if (DEPLOYMENT_MODE === "hosted") {
    return "Self-serve registration is disabled. Use the hosted control plane or ask an admin for access.";
  }
  return "Self-serve registration is disabled on this self-hosted deployment. Use supavector onboard for the first admin, or ask an admin to create a user and service token.";
}

function buildOpenApiDoc(req, options = {}) {
  const { publicView = false } = options;
  const baseUrl = resolvePublicBaseUrl(req);
  const doc = {
    ...openApiSpec,
    servers: [{ url: baseUrl }]
  };
  return publicView ? filterPublicOpenApiDoc(doc) : doc;
}

function resolveTenantForMetrics(req) {
  const candidate = req.user?.tenant || req.user?.tid || req.user?.sub;
  const clean = String(candidate || "").trim();
  if (!clean || !TENANT_RE.test(clean)) return null;
  return clean;
}

function classifyTelemetryEndpoint(rawPath) {
  const cleanPath = String(rawPath || "").split("?")[0];
  if (
    cleanPath === "/memory/write"
    || cleanPath === "/v1/memory"
    || cleanPath === "/v1/memory/write"
    || cleanPath === "/memory"
  ) {
    return "write";
  }
  if (cleanPath === "/memory/recall" || cleanPath === "/v1/memory/recall") {
    return "recall";
  }
  if (cleanPath === "/ask" || cleanPath === "/v1/ask") {
    return "ask";
  }
  if (cleanPath === "/code" || cleanPath === "/v1/code") {
    return "code";
  }
  if (
    cleanPath === "/yes-no" || cleanPath === "/v1/yes-no" ||
    cleanPath === "/boolean_ask" || cleanPath === "/v1/boolean_ask"
  ) {
    return "boolean_ask";
  }
  return "other";
}

function buildTelemetryContext({ requestId, tenantId, collection, source, ...rest } = {}) {
  return {
    requestId: requestId || null,
    tenantId: tenantId || null,
    collection: collection || null,
    source: source || null,
    ...rest
  };
}

function emitTelemetry(eventType, context = {}, payload = {}) {
  if (!isTelemetryEnabled()) return;
  logTelemetry(eventType, {
    requestId: context.requestId || null,
    tenantId: context.tenantId || null
  }, {
    ...(context.collection ? { collection: context.collection } : {}),
    ...(context.source ? { source: context.source } : {}),
    ...payload
  });
}

function emitLifecycleActionTelemetry(action, item, details = {}, context = {}) {
  if (!isTelemetryEnabled()) return;
  emitTelemetry("memory_lifecycle", {
    requestId: context.requestId || null,
    tenantId: item?.tenant_id || context.tenantId || null,
    collection: item?.collection || context.collection || null,
    source: context.source || "lifecycle"
  }, {
    action,
    memory_id: item?.id || null,
    namespace_id: item?.namespace_id || null,
    item_type: item?.item_type || null,
    ...details
  });
}

const conversationWikiStatsByTenant = new Map();

function getOrCreateConversationWikiStats(tenantId) {
  const key = String(tenantId || "").trim();
  if (!key) return null;
  let entry = conversationWikiStatsByTenant.get(key) || null;
  if (!entry) {
    entry = {
      succeeded: 0,
      failed: 0,
      skipped: 0,
      pagesUpdated: 0,
      turnsPruned: 0,
      queuedDeletes: 0,
      lastPageCount: 0,
      lastUpdatedAt: null
    };
    conversationWikiStatsByTenant.set(key, entry);
  }
  return entry;
}

function recordConversationWikiMetrics(tenantId, updates = {}) {
  const entry = getOrCreateConversationWikiStats(tenantId);
  if (!entry) return null;
  const numericKeys = [
    "succeeded",
    "failed",
    "skipped",
    "pagesUpdated",
    "turnsPruned",
    "queuedDeletes"
  ];
  for (const key of numericKeys) {
    const value = Number(updates?.[key]);
    if (Number.isFinite(value) && value !== 0) {
      entry[key] += value;
    }
  }
  const lastPageCount = Number(updates?.lastPageCount);
  if (Number.isFinite(lastPageCount) && lastPageCount >= 0) {
    entry.lastPageCount = Math.floor(lastPageCount);
  }
  const rawLastUpdatedAt = updates?.lastUpdatedAt;
  const parsedLastUpdatedAt = rawLastUpdatedAt ? Date.parse(rawLastUpdatedAt) : NaN;
  if (Number.isFinite(parsedLastUpdatedAt)) {
    entry.lastUpdatedAt = new Date(parsedLastUpdatedAt).toISOString();
  }
  return { ...entry };
}

function emitConversationWikiTelemetry(eventType, context = {}, payload = {}) {
  emitTelemetry("conversation_wiki", {
    requestId: context.requestId || null,
    tenantId: context.tenantId || null,
    collection: context.collection || null,
    source: context.source || "conversation_wiki"
  }, {
    event: String(eventType || "").trim() || "unknown",
    ...payload
  });
}

function logIndex(message) {
  if (DEBUG_INDEX) {
    console.log(`[index] ${message}`);
  }
}

function isValidDocId(docId) {
  return DOC_ID_RE.test(docId);
}

function normalizeCollection(value) {
  const clean = String(value || "").trim();
  if (!clean) return DEFAULT_COLLECTION;
  if (!COLLECTION_RE.test(clean)) {
    throw new Error("collection must use only letters, numbers, dot, dash, or underscore (no spaces)");
  }
  return clean;
}

function normalizeTypeValue(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return null;
  if (!ITEM_TYPE_RE.test(clean)) return null;
  if (LEGACY_TYPE_ALIASES.has(clean)) {
    return LEGACY_TYPE_ALIASES.get(clean);
  }
  if (MEMORY_TYPES.includes(clean)) return clean;
  return null;
}

function normalizeItemType(value) {
  const clean = String(value || "").trim();
  if (!clean) return "semantic";
  const normalized = normalizeTypeValue(clean);
  if (!normalized) {
    throw new Error(`type must be one of: ${MEMORY_TYPES.join(", ")}`);
  }
  return normalized;
}

function normalizeMemoryPolicy(value, fallback = DEFAULT_MEMORY_POLICY) {
  if (value === undefined || value === null || value === "") return fallback;
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return fallback;
  const normalized = MEMORY_POLICY_ALIASES.get(clean) || clean;
  if (MEMORY_POLICIES.includes(normalized)) return normalized;
  throw new Error(`policy must be one of: ${MEMORY_POLICIES.join(", ")}`);
}

function resolveRequestedMemoryPolicy(input, fallback = DEFAULT_MEMORY_POLICY) {
  if (!input || typeof input !== "object") return fallback;
  const rawPolicy = Object.prototype.hasOwnProperty.call(input, "policy")
    ? input.policy
    : undefined;
  const rawMode = Object.prototype.hasOwnProperty.call(input, "mode")
    ? input.mode
    : undefined;
  const candidate = rawPolicy ?? rawMode;
  if (Array.isArray(candidate)) {
    const first = candidate.find((value) => typeof value === "string" || typeof value === "number");
    return normalizeMemoryPolicy(first, fallback);
  }
  if (typeof candidate !== "string" && typeof candidate !== "number") {
    return fallback;
  }
  return normalizeMemoryPolicy(candidate, fallback);
}

function getMemoryPolicy(memory, fallback = DEFAULT_MEMORY_POLICY) {
  const metadata = memory?.metadata && typeof memory.metadata === "object" && !Array.isArray(memory.metadata)
    ? memory.metadata
    : null;
  try {
    return normalizeMemoryPolicy(metadata?._policy ?? memory?.policy, fallback);
  } catch {
    return fallback;
  }
}

function resolveMemoryPolicyConfig(policy = DEFAULT_MEMORY_POLICY) {
  const clean = normalizeMemoryPolicy(policy, DEFAULT_MEMORY_POLICY);
  const base = {
    policy: clean,
    valueMax: Number.isFinite(MEMORY_VALUE_MAX) && MEMORY_VALUE_MAX > 0 ? MEMORY_VALUE_MAX : 1,
    accessAlpha: Number.isFinite(MEMORY_ACCESS_ALPHA) ? MEMORY_ACCESS_ALPHA : 0,
    contributionBeta: Number.isFinite(MEMORY_CONTRIBUTION_BETA) ? MEMORY_CONTRIBUTION_BETA : 0,
    negativeStep: Number.isFinite(MEMORY_NEGATIVE_STEP) ? MEMORY_NEGATIVE_STEP : 0,
    valueDecayLambda: Number.isFinite(MEMORY_VALUE_DECAY_LAMBDA) && MEMORY_VALUE_DECAY_LAMBDA >= 0 ? MEMORY_VALUE_DECAY_LAMBDA : 0,
    tierHotUp: Number.isFinite(MEMORY_TIER_HOT_UP) ? MEMORY_TIER_HOT_UP : 0.7,
    tierHotDown: Number.isFinite(MEMORY_TIER_HOT_DOWN) ? MEMORY_TIER_HOT_DOWN : 0.62,
    tierWarmUp: Number.isFinite(MEMORY_TIER_WARM_UP) ? MEMORY_TIER_WARM_UP : 0.45,
    tierWarmDown: Number.isFinite(MEMORY_TIER_WARM_DOWN) ? MEMORY_TIER_WARM_DOWN : 0.25,
    tierEvict: Number.isFinite(MEMORY_TIER_EVICT) ? MEMORY_TIER_EVICT : 0.25,
    initValue: Number.isFinite(MEMORY_INIT_VALUE) ? MEMORY_INIT_VALUE : 0.5,
    retrievalWarmSampleK: Number.isFinite(MEMORY_RETRIEVAL_WARM_SAMPLE_K) && MEMORY_RETRIEVAL_WARM_SAMPLE_K > 0 ? MEMORY_RETRIEVAL_WARM_SAMPLE_K : 8,
    retrievalWarmSamplePoolMultiplier: Number.isFinite(MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER) && MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER > 0
      ? MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER
      : 4,
    retrievalWarmSelection: MEMORY_RETRIEVAL_WARM_SELECTION === "lru" ? "lru" : "random",
    retrievalColdProbeEpsilon: Number.isFinite(MEMORY_RETRIEVAL_COLD_PROBE_EPSILON) && MEMORY_RETRIEVAL_COLD_PROBE_EPSILON > 0
      ? Math.floor(MEMORY_RETRIEVAL_COLD_PROBE_EPSILON)
      : 0,
    valueDecayLoopEnabled: true,
    redundancyEnabled: true,
    lifecycleEnabled: true
  };
  const override = MEMORY_POLICY_OVERRIDES[clean] || null;
  return override ? { ...base, ...override, policy: clean } : base;
}

function normalizeVisibility(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return "tenant";
  if (!["tenant", "private", "acl"].includes(clean)) {
    throw new Error("visibility must be one of: tenant, private, acl");
  }
  return clean;
}

function normalizeAgentId(value) {
  const clean = String(value || "").trim();
  if (!clean) return null;
  if (!AGENT_RE.test(clean)) {
    throw new Error("agentId must use only letters, numbers, dot, dash, underscore, colon, or @");
  }
  return clean;
}

function parseTagsInput(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    if (!TAG_RE.test(clean)) {
      throw new Error("tags must use only letters, numbers, dot, dash, underscore, colon, or @");
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function normalizeSsoProvidersInput(raw) {
  if (raw === undefined) return { provided: false, value: null };
  if (raw === null) return { provided: true, value: null };
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    if (!SSO_PROVIDERS.includes(clean)) {
      throw new Error(`ssoProviders must be one of: ${SSO_PROVIDERS.join(", ")}`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return { provided: true, value: out };
}

function parseTenantSsoConfigInput(raw, currentConfig = {}) {
  if (raw === undefined) return undefined;
  return normalizeTenantSsoConfigInput(raw, currentConfig || {});
}

function resolveSsoProviders(tenant) {
  if (!tenant || tenant.sso_providers == null) return Array.from(SSO_PROVIDERS);
  return Array.isArray(tenant.sso_providers) ? tenant.sso_providers : [];
}

function isSsoProviderAllowed(tenant, provider) {
  if (!tenant || tenant.sso_providers == null) return true;
  if (!Array.isArray(tenant.sso_providers)) return false;
  return tenant.sso_providers.includes(provider);
}

function normalizeAclList(raw, principalId) {
  if (!raw) {
    return principalId ? [principalId] : [];
  }
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    if (!PRINCIPAL_RE.test(clean)) {
      throw new Error("acl principals must use only letters, numbers, dot, dash, underscore, colon, or @");
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  if (principalId && !seen.has(principalId)) {
    out.push(principalId);
  }
  return out;
}

function parseTypeFilter(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const normalized = normalizeTypeValue(item);
    if (!normalized) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  if (seen.has("semantic") && !seen.has("memory")) {
    out.push("memory");
  }
  return out;
}

function normalizeReflectTypes(raw) {
  const allowed = new Set(["semantic", "procedural", "summary"]);
  const list = parseTypeFilter(raw);
  if (!list.length) return Array.from(allowed);
  const filtered = list.filter(t => allowed.has(t));
  if (!filtered.length) {
    throw new Error("types must include semantic, procedural, or summary");
  }
  return filtered;
}

function parseTimeInput(value, label) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return date;
}

function resolveExpiresAt(input) {
  if (!input) return null;
  if (input.expiresAt) {
    return parseTimeInput(input.expiresAt, "expiresAt");
  }
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null && input.ttlSeconds !== "") {
    const ttl = Number(input.ttlSeconds);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error("ttlSeconds must be a positive number");
    }
    return new Date(Date.now() + ttl * 1000);
  }
  return null;
}

function getTenantId(req) {
  const tenant = req.user?.tenant || req.user?.tid || req.user?.sub;
  const clean = String(tenant || "").trim();
  if (!clean || !TENANT_RE.test(clean)) {
    throw new Error("Invalid tenant in token");
  }
  return clean;
}

function resolveTenantId(req) {
  const tenantId = getTenantId(req);
  const provided = req.body?.tenantId || req.body?.tenantID || req.query?.tenantId || req.query?.tenantID;
  if (provided && String(provided).trim() !== tenantId) {
    throw new Error("tenantId mismatch");
  }
  return tenantId;
}

function normalizeTenantIdentifier(value, label = "tenantId") {
  const clean = String(value || "").trim();
  if (!clean) {
    throw new Error(`${label} is required`);
  }
  if (!TENANT_RE.test(clean)) {
    throw new Error(`${label} must use only letters, numbers, dot, dash, or underscore`);
  }
  return clean;
}

function resolveEnterpriseTenantId(req, paramName = "tenantId") {
  const tenantId = normalizeTenantIdentifier(req.params?.[paramName], paramName);
  const provided = req.body?.tenantId ?? req.body?.tenantID ?? req.query?.tenantId ?? req.query?.tenantID;
  if (provided !== undefined && provided !== null && String(provided).trim() !== tenantId) {
    throw new Error("tenantId mismatch");
  }
  return tenantId;
}

function parseTenantMetadataInput(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("metadata must be an object");
  }
  return raw;
}

function parseOptionalString(raw, { label, max = 2000 } = {}) {
  if (raw === undefined || raw === null) return null;
  const clean = String(raw).trim();
  if (!clean) return null;
  if (max && clean.length > max) {
    throw new Error(`${label} too long`);
  }
  return clean;
}

function normalizeDocumentSourceType(raw, fallback = "text") {
  const clean = parseOptionalString(raw, { label: "sourceType", max: 80 });
  if (!clean) return fallback;
  if (!/^[a-z0-9._:-]+$/i.test(clean)) {
    throw new Error("sourceType contains unsupported characters");
  }
  return clean.toLowerCase();
}

function pushUniqueCodeValue(target, raw, maxItems = 24, maxLength = 120) {
  if (!Array.isArray(target) || target.length >= maxItems) return;
  const clean = String(raw || "").trim();
  if (!clean || clean.length > maxLength) return;
  const key = clean.toLowerCase();
  if (target.some((value) => String(value || "").trim().toLowerCase() === key)) return;
  target.push(clean);
}

function normalizeCodeMetadataList(values, { maxItems = 24, maxItemLength = 120 } = {}) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    pushUniqueCodeValue(out, value, maxItems, maxItemLength);
  }
  return out;
}

function inferCodeLanguageFromMetadata(metadata = {}, fallbackPath = "") {
  const explicit = parseOptionalString(metadata?.language ?? metadata?.lang, {
    label: "metadata.language",
    max: 80
  });
  if (explicit) return explicit.toLowerCase();
  const pathname = String((metadata?.path ?? metadata?.filePath ?? metadata?.file_path ?? fallbackPath) || "").trim().toLowerCase();
  if (!pathname.includes(".")) return null;
  const ext = pathname.split(".").pop();
  const map = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    cs: "csharp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "javascript",
    jsx: "jsx",
    kt: "kotlin",
    mjs: "javascript",
    cjs: "javascript",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    swift: "swift",
    ts: "typescript",
    tsx: "tsx",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml"
  };
  return map[ext] || ext || null;
}

function inferCodeConfigKinds(fallbackPath = "") {
  const lowerPath = String(fallbackPath || "").trim().toLowerCase();
  if (!lowerPath) return [];
  const kinds = [];
  const pushKind = (value) => {
    if (!value || kinds.includes(value)) return;
    kinds.push(value);
  };
  if (/package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|requirements\.txt$|poetry\.lock$|pyproject\.toml$|pom\.xml$|build\.gradle(?:\.kts)?$|cargo\.toml$|composer\.json$|gemfile$|go\.mod$/.test(lowerPath)) {
    pushKind("package");
  }
  if (/pnpm-workspace\.yaml$|lerna\.json$|turbo\.json$|nx\.json$|workspace\.json$/.test(lowerPath)) {
    pushKind("workspace");
  }
  if (/docker-compose(?:\.[^.]+)?\.ya?ml$|compose\.ya?ml$|dockerfile$/.test(lowerPath)) {
    pushKind("docker");
  }
  if (/\.github\/workflows\/.+\.ya?ml$/.test(lowerPath)) {
    pushKind("workflow");
  }
  if (/(^|\/)\.env(?:\.[^/]+)?$|env\.(?:example|sample|template)/.test(lowerPath)) {
    pushKind("env");
  }
  if (/tsconfig(?:\.[^.]+)?\.json$|jsconfig\.json$|vite\.config\.[^.]+$|webpack(?:\.[^.]+)*\.[^.]+$|rollup\.config\.[^.]+$|next\.config\.[^.]+$|nuxt\.config\.[^.]+$|jest\.config\.[^.]+$|pytest\.ini$|tox\.ini$|mypy\.ini$|babel\.config\.[^.]+$|eslint\.config\.[^.]+$|eslint(?:\.|$)|prettier(?:\.|$)/.test(lowerPath)) {
    pushKind("tooling");
  }
  return kinds;
}

function extractYamlSectionKeys(source, sectionName, { maxItems = 10 } = {}) {
  const lines = String(source || "").split(/\r?\n/);
  const keys = [];
  let inSection = false;
  let sectionIndent = 0;
  for (const rawLine of lines) {
    const line = String(rawLine || "").replace(/\t/g, "  ");
    const sectionMatch = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (!inSection) {
      if (sectionMatch && sectionMatch[2] === sectionName) {
        inSection = true;
        sectionIndent = sectionMatch[1].length;
      }
      continue;
    }
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0]?.length || 0;
    if (indent <= sectionIndent && /^[A-Za-z0-9_.-]+:\s*/.test(line.trim())) break;
    if (indent <= sectionIndent) continue;
    const keyMatch = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (!keyMatch) continue;
    pushUniqueCodeValue(keys, keyMatch[1], maxItems, 120);
  }
  return keys;
}

function extractPackageJsonSignals(source) {
  const parsedSignals = {
    packageName: null,
    scripts: [],
    workspacePackages: []
  };
  try {
    const parsed = JSON.parse(String(source || ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        parsedSignals.packageName = parsed.name.trim().slice(0, 160);
      }
      if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
        for (const scriptName of Object.keys(parsed.scripts)) {
          pushUniqueCodeValue(parsedSignals.scripts, scriptName, 12, 120);
        }
      }
      const workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces
        : (parsed.workspaces && typeof parsed.workspaces === "object" && Array.isArray(parsed.workspaces.packages)
          ? parsed.workspaces.packages
          : []);
      for (const workspacePattern of workspaces) {
        pushUniqueCodeValue(parsedSignals.workspacePackages, workspacePattern, 10, 200);
      }
    }
  } catch {
    // Ignore package manifest parsing failures; heuristics still work.
  }
  return parsedSignals;
}

function extractCodeStructureMetadata(text, options = {}) {
  const source = String(text || "");
  const fallbackPath = String(options?.path || "").trim();
  const lowerPath = fallbackPath.toLowerCase();
  const baseName = path.basename(lowerPath);
  const functions = [];
  const classes = [];
  const exportsList = [];
  const imports = [];
  const modules = [];
  const calls = [];
  const routes = [];
  const envVars = [];
  const testTargets = [];
  const scripts = [];
  const services = [];
  const workflowJobs = [];
  const workspacePackages = [];
  const importedSymbols = [];
  const reexports = [];
  const definedSymbols = [];
  const referencedSymbols = [];
  const configKinds = inferCodeConfigKinds(fallbackPath);
  let packageName = null;

  const pushModule = (value) => {
    pushUniqueCodeValue(modules, value, 20, 160);
  };
  const pushDefinedSymbol = (value) => {
    pushUniqueCodeValue(definedSymbols, value, 40, 120);
  };
  const pushReferencedSymbol = (value) => {
    pushUniqueCodeValue(referencedSymbols, value, 48, 120);
  };

  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    pushUniqueCodeValue(functions, match[1], 28, 120);
    pushDefinedSymbol(match[1]);
  }
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm)) {
    pushUniqueCodeValue(functions, match[1], 28, 120);
    pushDefinedSymbol(match[1]);
  }
  for (const match of source.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm)) {
    pushUniqueCodeValue(functions, match[1], 28, 120);
    pushDefinedSymbol(match[1]);
  }
  for (const match of source.matchAll(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/gm)) {
    pushUniqueCodeValue(functions, match[1], 28, 120);
    pushDefinedSymbol(match[1]);
  }

  for (const match of source.matchAll(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm)) {
    pushUniqueCodeValue(classes, match[1], 20, 120);
    pushDefinedSymbol(match[1]);
  }
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/gm)) {
    pushUniqueCodeValue(classes, match[1], 20, 120);
    pushDefinedSymbol(match[1]);
  }

  for (const match of source.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    pushUniqueCodeValue(exportsList, match[1], 20, 120);
  }
  for (const match of source.matchAll(/^\s*export\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/gm)) {
    pushUniqueCodeValue(exportsList, match[1], 20, 120);
  }
  for (const match of source.matchAll(/^\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=/gm)) {
    pushUniqueCodeValue(exportsList, match[1], 20, 120);
  }
  for (const match of source.matchAll(/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/gm)) {
    pushUniqueCodeValue(exportsList, match[1], 20, 120);
  }
  for (const match of source.matchAll(/^\s*export\s*\{\s*([^}]+)\s*\}/gm)) {
    const names = String(match[1] || "").split(",");
    for (const name of names) {
      const parts = String(name || "").split(/\s+as\s+/i);
      const clean = parts[0].trim();
      pushUniqueCodeValue(exportsList, clean, 20, 120);
      if (parts[1]?.trim()) {
        pushUniqueCodeValue(reexports, `${clean} as ${parts[1].trim()}`, 20, 160);
      }
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) {
    pushUniqueCodeValue(exportsList, "default", 20, 120);
  }

  const importSymbolPatterns = [
    /^\s*import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gm,
    /^\s*const\s+\{\s*([^}]+)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm,
    /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm,
    /^\s*from\s+([A-Za-z0-9_.$/:-]+)\s+import\s+([A-Za-z0-9_,*\s]+)/gm
  ];

  for (const match of source.matchAll(/^\s*import\s+.+?\s+from\s+['"]([^'"]+)['"]/gm)) {
    pushUniqueCodeValue(imports, match[1], 20, 160);
    pushModule(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    pushUniqueCodeValue(imports, match[1], 20, 160);
    pushModule(match[1]);
  }
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    pushUniqueCodeValue(imports, match[1], 20, 160);
    pushModule(match[1]);
  }
  for (const match of source.matchAll(/^\s*from\s+([A-Za-z0-9_.$/:-]+)\s+import\b/gm)) {
    pushUniqueCodeValue(imports, match[1], 20, 160);
    pushModule(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+([A-Za-z0-9_.$/:-]+)\s*$/gm)) {
    pushUniqueCodeValue(imports, match[1], 20, 160);
    pushModule(match[1]);
  }
  for (const pattern of importSymbolPatterns) {
    for (const match of source.matchAll(pattern)) {
      const groups = match.slice(1).filter(Boolean);
      const rawSymbols = groups.slice(0, -1);
      const last = groups[groups.length - 1];
      const maybeModule = /[./:@-]/.test(String(last || "")) ? String(last || "") : "";
      for (const rawPart of rawSymbols) {
        const pieces = String(rawPart || "").split(",");
        for (const piece of pieces) {
          const clean = String(piece || "")
            .replace(/[{}*]/g, "")
            .split(/\s+as\s+/i)[0]
            .trim();
          if (!clean) continue;
          if (clean === "type") continue;
          pushUniqueCodeValue(importedSymbols, maybeModule ? `${clean} from ${maybeModule}` : clean, 28, 200);
        }
      }
    }
  }

  for (const match of source.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    pushUniqueCodeValue(routes, `${match[1].toUpperCase()} ${match[2]}`, 16, 200);
  }

  const callStopwords = new Set([
    "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
    "console", "require", "import", "function", "class", "await", "super"
  ]);
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(/g)) {
    const name = String(match[1] || "");
    if (callStopwords.has(name)) continue;
    pushUniqueCodeValue(calls, name, 28, 120);
    pushReferencedSymbol(name);
  }

  const referenceStopwords = new Set([
    "const", "let", "var", "function", "class", "interface", "type", "enum", "return",
    "if", "else", "for", "while", "switch", "case", "break", "continue", "new", "await",
    "async", "default", "export", "import", "from", "module", "exports", "require", "this",
    "super", "true", "false", "null", "undefined", "typeof", "instanceof", "extends", "implements",
    "public", "private", "protected", "static", "yield", "try", "catch", "finally", "throw", "get", "set"
  ]);
  for (const match of source.matchAll(/\b([A-Z][A-Za-z0-9_$]{2,}|[a-z][A-Za-z0-9_$]{2,})\b/g)) {
    const name = String(match[1] || "");
    if (referenceStopwords.has(name)) continue;
    if (/^[A-Z0-9_]+$/.test(name)) continue;
    pushReferencedSymbol(name);
  }

  const isTestFile = /(?:^|\/)(?:__tests__|__specs__|tests?|specs?)\//.test(lowerPath)
    || /\.(?:test|spec)\.[^.]+$/.test(baseName);
  const isConfigFile = configKinds.length > 0;
  const isEntrypoint = Boolean(
    routes.length
    || /(?:^|\/)(?:index|main|app|server|cli|worker|wsgi|asgi)\.[^.]+$/.test(lowerPath)
    || /(?:^|\/)(?:cmd|bin|scripts?)\//.test(lowerPath)
    || (/^\s*if\s+__name__\s*==\s*['"]__main__['"]/m.test(source))
    || (/\bapp\.listen\s*\(|\bserve\s*\(|\bhttp\.createServer\s*\(/.test(source))
  );

  if (lowerPath.endsWith("package.json")) {
    const packageSignals = extractPackageJsonSignals(source);
    packageName = packageSignals.packageName;
    for (const scriptName of packageSignals.scripts) {
      pushUniqueCodeValue(scripts, scriptName, 12, 120);
    }
    for (const workspacePattern of packageSignals.workspacePackages) {
      pushUniqueCodeValue(workspacePackages, workspacePattern, 10, 200);
    }
  } else if (lowerPath.endsWith("pnpm-workspace.yaml")) {
    for (const workspacePattern of String(source || "").matchAll(/^\s*-\s+["']?([^"'#\n]+)["']?\s*$/gm)) {
      pushUniqueCodeValue(workspacePackages, workspacePattern[1], 10, 200);
    }
  }

  if (configKinds.includes("docker")) {
    for (const service of extractYamlSectionKeys(source, "services", { maxItems: 10 })) {
      pushUniqueCodeValue(services, service, 10, 120);
    }
  }
  if (configKinds.includes("workflow")) {
    for (const jobName of extractYamlSectionKeys(source, "jobs", { maxItems: 10 })) {
      pushUniqueCodeValue(workflowJobs, jobName, 10, 120);
    }
  }

  const envPatterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b/g,
    /\bos\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\)/g,
    /\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
    /\bSystem\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\)/g,
    /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g
  ];
  for (const pattern of envPatterns) {
    for (const match of source.matchAll(pattern)) {
      pushUniqueCodeValue(envVars, match[1], 12, 120);
    }
  }
  if (configKinds.includes("env")) {
    for (const match of source.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)) {
      pushUniqueCodeValue(envVars, match[1], 12, 120);
    }
  }

  if (isTestFile) {
    for (const importRef of [...imports, ...modules]) {
      if (/^(?:\.{1,2}\/|\/)/.test(String(importRef || "").trim())) {
        pushUniqueCodeValue(testTargets, importRef, 10, 200);
      }
    }
  }

  return {
    language: options?.language || null,
    functions,
    classes,
    exports: exportsList,
    imports,
    modules,
    calls,
    routes,
    envVars,
    testTargets,
    scripts,
    services,
    workflowJobs,
    workspacePackages,
    importedSymbols,
    reexports,
    definedSymbols,
    referencedSymbols,
    packageName,
    configKinds,
    isTestFile,
    isConfigFile,
    isEntrypoint
  };
}

function enrichCodeSourceMetadata(source = {}, text, docId) {
  const base = source?.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? { ...source.metadata }
    : {};
  const title = String(source?.title || docId || "").trim();
  const inferredLanguage = inferCodeLanguageFromMetadata(base, base.path || title || source?.url || "");
  const structure = extractCodeStructureMetadata(text, {
    language: inferredLanguage,
    path: base.path || title || source?.url || ""
  });
  if (inferredLanguage && !base.language && !base.lang) {
    base.language = inferredLanguage;
  }
  return {
    ...base,
    functions: normalizeCodeMetadataList(structure.functions, { maxItems: 28 }),
    classes: normalizeCodeMetadataList(structure.classes, { maxItems: 20 }),
    exports: normalizeCodeMetadataList(structure.exports, { maxItems: 20 }),
    imports: normalizeCodeMetadataList(structure.imports, { maxItems: 20, maxItemLength: 160 }),
    modules: normalizeCodeMetadataList(structure.modules, { maxItems: 20, maxItemLength: 160 }),
    calls: normalizeCodeMetadataList(structure.calls, { maxItems: 28 }),
    routes: normalizeCodeMetadataList(structure.routes, { maxItems: 16, maxItemLength: 200 }),
    envVars: normalizeCodeMetadataList(structure.envVars, { maxItems: 12, maxItemLength: 120 }),
    testTargets: normalizeCodeMetadataList(structure.testTargets, { maxItems: 10, maxItemLength: 200 }),
    scripts: normalizeCodeMetadataList(structure.scripts, { maxItems: 12, maxItemLength: 120 }),
    services: normalizeCodeMetadataList(structure.services, { maxItems: 10, maxItemLength: 120 }),
    workflowJobs: normalizeCodeMetadataList(structure.workflowJobs, { maxItems: 10, maxItemLength: 120 }),
    workspacePackages: normalizeCodeMetadataList(structure.workspacePackages, { maxItems: 10, maxItemLength: 200 }),
    importedSymbols: normalizeCodeMetadataList(structure.importedSymbols, { maxItems: 28, maxItemLength: 200 }),
    reexports: normalizeCodeMetadataList(structure.reexports, { maxItems: 20, maxItemLength: 160 }),
    definedSymbols: normalizeCodeMetadataList(structure.definedSymbols, { maxItems: 40, maxItemLength: 120 }),
    referencedSymbols: normalizeCodeMetadataList(structure.referencedSymbols, { maxItems: 48, maxItemLength: 120 }),
    packageName: normalizeCodeMetadataString(structure.packageName, 160),
    configKinds: normalizeCodeMetadataList(structure.configKinds, { maxItems: 8, maxItemLength: 80 }),
    isTestFile: Boolean(structure.isTestFile),
    isConfigFile: Boolean(structure.isConfigFile),
    isEntrypoint: Boolean(structure.isEntrypoint)
  };
}

function parseDocumentSourceInput(body = {}, { defaultType = "text", defaultUrl = null } = {}) {
  const metadata = parseTenantMetadataInput(body?.metadata);
  const sourceUrl = parseOptionalString(body?.sourceUrl ?? body?.source_url ?? defaultUrl, {
    label: "sourceUrl",
    max: 4000
  });
  return {
    title: parseOptionalString(body?.title, { label: "title", max: 200 }),
    metadata: metadata === undefined ? null : metadata,
    sourceType: normalizeDocumentSourceType(body?.sourceType ?? body?.source_type, defaultType),
    sourceUrl
  };
}

function parseBulkDocumentsInput(body = {}) {
  const documents = Array.isArray(body?.documents)
    ? body.documents
    : (Array.isArray(body?.items) ? body.items : null);
  if (!documents) {
    throw new Error("documents array is required");
  }
  if (!documents.length) {
    throw new Error("documents array cannot be empty");
  }
  if (documents.length > DOCS_BULK_MAX_ITEMS) {
    throw new Error(`documents array too large (max ${DOCS_BULK_MAX_ITEMS})`);
  }
  for (const document of documents) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("each bulk document must be an object");
    }
  }
  return documents;
}

function buildBulkDocumentFailure(index, body, err, tenantId, collection) {
  const cleanDocId = String(body?.docId || "").trim() || null;
  const errorPayload = buildErrorPayload(err, err?.code || "INDEX_FAILED", tenantId, collection).error;
  return {
    index,
    ok: false,
    docId: cleanDocId,
    error: errorPayload
  };
}

async function indexDocumentRequestBody({
  tenantId,
  collection,
  principalId,
  embedConfig,
  body = {},
  telemetrySource = "docs_index_v1",
  requestId = null
}) {
  const { docId, text } = body || {};
  const cleanDocId = String(docId || "").trim();
  if (!cleanDocId || !text) {
    const err = new Error("docId and text required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (!isValidDocId(cleanDocId)) {
    const err = new Error("docId must use only letters, numbers, dot, dash, or underscore (no spaces)");
    err.code = "INVALID_DOC_ID";
    throw err;
  }
  const agentId = normalizeAgentId(body?.agentId ?? body?.agent_id);
  const tags = parseTagsInput(body?.tags);
  const sourceInput = parseDocumentSourceInput(body, { defaultType: "text" });
  const expiresAt = resolveExpiresAt(body);
  const { chunksIndexed, truncated } = await indexDocument(
    tenantId,
    collection,
    cleanDocId,
    text,
    {
      type: sourceInput.sourceType,
      title: sourceInput.title,
      metadata: sourceInput.metadata,
      url: sourceInput.sourceUrl,
      expiresAt,
      principalId,
      agentId,
      tags,
      visibility: body?.visibility,
      acl: body?.acl
    },
    {
      apiKey: embedConfig.apiKey,
      embedProvider: embedConfig.embedProvider,
      embedModel: embedConfig.embedModel,
      telemetry: buildTelemetryContext({ requestId, tenantId, collection, source: telemetrySource })
    }
  );
  return {
    docId: cleanDocId,
    chunksIndexed,
    truncated
  };
}

function parseListLimit(raw, { fallback = 100, max = 500, label = "limit" } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.min(Math.floor(value), max);
}

async function getEffectiveTenantModels(tenantId) {
  const tenant = tenantId ? await getTenantById(tenantId) : null;
  return resolveTenantModelSettings(tenant).effective;
}

function buildTenantSettingsPayload(tenantId, tenant) {
  const resolved = resolveTenantModelSettings(tenant);
  return {
    id: tenantId,
    name: tenant?.name || null,
    externalId: tenant?.external_id || null,
    metadata: tenant?.metadata && typeof tenant.metadata === "object" ? tenant.metadata : {},
    authMode: normalizeAuthMode(tenant?.auth_mode),
    ssoProviders: resolveSsoProviders(tenant),
    ssoConfig: buildTenantSsoConfigPublic(tenant?.sso_config || {}),
    models: resolved,
    createdAt: tenant?.created_at || null
  };
}

function resolveRequestedTenantInput(source) {
  const clean = String(
    source?.query?.tenantId
    ?? source?.query?.tenant
    ?? source?.body?.tenantId
    ?? source?.body?.tenant
    ?? ""
  ).trim();
  if (!clean) return "";
  if (!TENANT_RE.test(clean)) {
    throw new Error("tenant must use only letters, numbers, dot, dash, underscore, or colon");
  }
  return clean;
}

function formatTenantUser(user) {
  return {
    id: user?.id || null,
    username: user?.username || null,
    tenantId: user?.tenant_id || null,
    roles: Array.isArray(user?.roles) ? user.roles : [],
    disabled: Boolean(user?.disabled),
    ssoOnly: Boolean(user?.sso_only),
    authProvider: user?.auth_provider || null,
    authSubject: user?.auth_subject || null,
    email: user?.email || null,
    fullName: user?.full_name || null,
    lastLogin: user?.last_login || null,
    createdAt: user?.created_at || null
  };
}

function formatTenantRecord(tenant, options = {}) {
  if (!tenant) return null;
  const payload = buildTenantSettingsPayload(tenant.tenant_id || tenant.id || null, tenant);
  const summary = {};
  if (tenant.user_count !== undefined) summary.userCount = Number(tenant.user_count || 0);
  if (tenant.service_token_count !== undefined) summary.serviceTokenCount = Number(tenant.service_token_count || 0);
  if (options.summary && typeof options.summary === "object") {
    Object.assign(summary, options.summary);
  }
  if (Object.keys(summary).length) payload.summary = summary;
  return payload;
}

function formatAuditLogEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id || null,
    tenantId: entry.tenant_id || null,
    actorId: entry.actor_id || null,
    actorType: entry.actor_type || null,
    action: entry.action || null,
    targetType: entry.target_type || null,
    targetId: entry.target_id || null,
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : null,
    requestId: entry.request_id || null,
    ip: entry.ip || null,
    createdAt: entry.created_at || null
  };
}

async function buildEnterpriseTenantSummary(tenantId) {
  const [userCount, serviceTokenCount, storageStats, itemStats] = await Promise.all([
    countTenantUsers(tenantId),
    countTenantServiceTokens(tenantId),
    getTenantStorageStats(tenantId),
    getTenantItemStats(tenantId)
  ]);
  return {
    userCount,
    serviceTokenCount,
    storageBytes: Number(storageStats?.bytes || 0),
    chunkCount: Number(storageStats?.chunks || 0),
    documentCount: Number(itemStats?.documents || 0),
    memoryItemCount: Number(itemStats?.memory_items || 0),
    collectionCount: Number(itemStats?.collections || 0)
  };
}

async function mintServiceTokenForTenant({ tenantId, name, principalId, roles, expiresAt }) {
  const rawToken = `supav_${crypto.randomBytes(24).toString("base64url")}`;
  const keyHash = hashToken(rawToken);
  const record = await createServiceToken({
    tenantId,
    name,
    principalId,
    roles,
    keyHash,
    expiresAt
  });
  return { rawToken, record };
}

function formatAuthProviderAvailability(provider, cfg, tenant) {
  const allowed = isSsoProviderAllowed(tenant, provider);
  if (!allowed) {
    return { enabled: false, source: null, provider, reason: "provider_not_allowed" };
  }
  if (!cfg) {
    return { enabled: false, source: null, provider, reason: "not_configured" };
  }
  return {
    enabled: true,
    source: cfg.source || null,
    provider,
    issuer: cfg.issuer || "",
    clientIdConfigured: Boolean(cfg.clientId),
    tenantClaim: cfg.tenantClaim || "",
    roleClaim: cfg.roleClaim || "",
    allowedDomains: Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : [],
    allowsDomains: Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : []
  };
}

function resolveAskProviderOverride(body = {}) {
  return normalizeProviderId(body?.provider ?? body?.answerProvider ?? body?.answer_provider) || "";
}

function resolveAskModelOverride(body = {}) {
  return normalizeModelId(body?.model ?? body?.answerModel ?? body?.answer_model) || "";
}

function resolveBooleanAskProviderOverride(body = {}) {
  return normalizeProviderId(body?.provider ?? body?.booleanAskProvider ?? body?.boolean_ask_provider ?? body?.answerProvider ?? body?.answer_provider) || "";
}

function resolveBooleanAskModelOverride(body = {}) {
  return normalizeModelId(body?.model ?? body?.booleanAskModel ?? body?.boolean_ask_model ?? body?.answerModel ?? body?.answer_model) || "";
}

async function getRequestEmbeddingConfig(req, tenantId, models = null) {
  const effectiveModels = models || await getEffectiveTenantModels(tenantId);
  return {
    models: effectiveModels,
    embedProvider: effectiveModels.embedProvider,
    embedModel: effectiveModels.embedModel,
    apiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider)
  };
}

function getStorageBillingRates() {
  const storagePricePerGBMonth = parseFloat(process.env.BILLING_PRICE_PER_GB_STORAGE || "0");
  return {
    storagePricePerGBMonth: Number.isFinite(storagePricePerGBMonth) ? storagePricePerGBMonth : 0,
    includedGBMonth: Number.isFinite(BILLING_STORAGE_INCLUDED_GB_MONTH) ? Math.max(0, BILLING_STORAGE_INCLUDED_GB_MONTH) : 0
  };
}

async function resolveStorageVectorDim(tenantId, metadata = null) {
  const rawVectorDim = Number(metadata?.vectorDim ?? metadata?.vector_dim ?? 0);
  if (Number.isFinite(rawVectorDim) && rawVectorDim > 0) {
    return Math.floor(rawVectorDim);
  }

  const embedProvider = metadata?.embedProvider || metadata?.embed_provider || null;
  const embedModel = metadata?.embedModel || metadata?.embed_model || null;
  if (embedProvider || embedModel) {
    return resolveEmbedDimension({
      embedProvider: embedProvider || DEFAULT_EMBED_PROVIDER,
      embedModel: embedModel || DEFAULT_EMBED_MODEL
    });
  }

  const effectiveModels = tenantId
    ? await getEffectiveTenantModels(tenantId)
    : resolveEnvModelDefaults();
  return resolveEmbedDimension({
    embedProvider: effectiveModels?.embedProvider || DEFAULT_EMBED_PROVIDER,
    embedModel: effectiveModels?.embedModel || DEFAULT_EMBED_MODEL
  });
}

function resolvePrincipalId(req) {
  const tokenPrincipal = req.user?.principal_id || req.user?.sub;
  const clean = String(tokenPrincipal || "").trim();
  if (!clean || !PRINCIPAL_RE.test(clean)) {
    throw new Error("Invalid principal in token");
  }
  const provided = req.body?.principalId || req.body?.principal_id || req.query?.principalId || req.query?.principal_id;
  if (provided) {
    const candidate = String(provided).trim();
    if (!PRINCIPAL_RE.test(candidate)) {
      throw new Error("Invalid principal in request");
    }
    const allowOverride = process.env.ALLOW_PRINCIPAL_OVERRIDE === "1"
      && req.user?.auth === "api_key"
      && hasRequiredRole(req, "admin");
    if (allowOverride) {
      return candidate;
    }
    if (candidate !== clean) {
      throw new Error("principalId mismatch");
    }
  }
  return clean;
}

function parsePrivilegesInput(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    if (!PRINCIPAL_RE.test(clean)) {
      throw new Error("Invalid privilege value");
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function hasAccessOverrideInput(req) {
  const provided = req.body?.principalId || req.body?.principal_id || req.query?.principalId || req.query?.principal_id;
  const privilegesRaw = req.body?.privileges ?? req.query?.privileges;
  const privileges = parsePrivilegesInput(privilegesRaw);
  return Boolean(provided) || privileges.length > 0;
}

function normalizeRole(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return null;
  return ROLE_ALIASES.get(clean) || null;
}

function normalizeRuntimeRoleList(input, { allowInstanceAdmin = false, allowEmpty = true } = {}) {
  if (input === undefined || input === null) {
    const allowed = Array.from(new Set(allowInstanceAdmin ? ENTERPRISE_CONTROL_ROLE_VALUES : ENTERPRISE_ROLE_VALUES));
    if (!allowEmpty) {
      throw new Error(`roles must include at least one of: ${allowed.join(", ")}`);
    }
    return [];
  }
  const list = Array.isArray(input)
    ? input
    : (typeof input === "string" ? input.split(",") : []);
  const allowed = new Set(allowInstanceAdmin ? ENTERPRISE_CONTROL_ROLE_VALUES : ENTERPRISE_ROLE_VALUES);
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const normalized = normalizeRole(value);
    if (!normalized) {
      const clean = String(value || "").trim();
      if (clean) {
        throw new Error(`roles must be one of: ${Array.from(allowed).join(", ")}`);
      }
      continue;
    }
    if (!allowed.has(normalized)) {
      throw new Error(`roles must be one of: ${Array.from(allowed).join(", ")}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  if (!allowEmpty && out.length === 0) {
    throw new Error(`roles must include at least one of: ${Array.from(allowed).join(", ")}`);
  }
  return out;
}

function isPrincipalTenantMatch(req) {
  const principal = req.user?.principal_id || req.user?.sub;
  const tenant = req.user?.tenant || req.user?.tid || req.user?.sub;
  if (!principal || !tenant) return false;
  return String(principal).trim() === String(tenant).trim();
}

function getEffectiveRoles(req) {
  const rawRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const out = new Set();
  for (const role of rawRoles) {
    const normalized = normalizeRole(role);
    if (normalized) out.add(normalized);
  }
  if (isPrincipalTenantMatch(req)) {
    out.add("admin");
  }
  if (out.size === 0) {
    out.add(ROLE_DEFAULT);
  }
  return out;
}

function hasRequiredRole(req, required) {
  const roles = getEffectiveRoles(req);
  if (roles.has(INSTANCE_ADMIN_ROLE)) {
    return true;
  }
  if (required === INSTANCE_ADMIN_ROLE) {
    return false;
  }
  if (roles.has("admin")) return true;
  if (required === "admin") return false;
  if (required === "indexer") return roles.has("indexer");
  if (required === "reader") return roles.has("reader") || roles.has("indexer");
  return false;
}

function hasInstanceAdminAccess(req) {
  return getEffectiveRoles(req).has(INSTANCE_ADMIN_ROLE);
}

function allowAccessOverride(req) {
  return process.env.ALLOW_PRINCIPAL_OVERRIDE === "1"
    && req.user?.auth === "api_key"
    && hasRequiredRole(req, "admin");
}

function resolveAccessContext(req) {
  const provided = req.body?.principalId || req.body?.principal_id || req.query?.principalId || req.query?.principal_id;
  const privileges = parsePrivilegesInput(req.body?.privileges ?? req.query?.privileges);
  const hasOverride = Boolean(provided) || privileges.length > 0;

  if (!hasOverride) {
    return { principalId: resolvePrincipalId(req), privileges: [] };
  }
  if (!allowAccessOverride(req)) {
    throw new Error("principal override not allowed");
  }

  let principalId = null;
  if (provided) {
    principalId = resolvePrincipalId(req);
  }
  return { principalId, privileges };
}

function normalizeRoles(input, options = {}) {
  return normalizeRuntimeRoleList(input, options);
}

function formatServiceToken(record) {
  if (!record) return null;
  return {
    id: record.id,
    tenantId: record.tenant_id,
    name: record.name,
    principalId: record.principal_id,
    roles: record.roles || [],
    lastUsedAt: record.last_used_at,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at,
    createdAt: record.created_at
  };
}

function buildCollectionsFromDocs(docs) {
  const map = new Map();
  for (const doc of docs || []) {
    const collection = doc.collection || DEFAULT_COLLECTION;
    if (!map.has(collection)) {
      map.set(collection, { collection, totalDocs: 0, titles: [] });
    }
    const entry = map.get(collection);
    entry.totalDocs += 1;
    if (doc.docId) entry.titles.push(doc.docId);
  }
  return Array.from(map.values()).sort((a, b) => a.collection.localeCompare(b.collection));
}

function hasTokenAdminAccess(req) {
  return hasRequiredRole(req, "admin");
}

function requireRole(required) {
  return (req, res, next) => {
    if (!hasRequiredRole(req, required)) {
      let message = "Reader, indexer, or admin role required";
      if (required === INSTANCE_ADMIN_ROLE) {
        message = "Instance admin role required";
      } else if (required === "admin") {
        message = "Admin role required";
      } else if (required === "indexer") {
        message = "Indexer or admin role required";
      }
      if (req.path.startsWith("/v1")) {
        return sendError(res, 403, message, "FORBIDDEN", null, null);
      }
      return res.status(403).json({ error: message });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  return requireRole("admin")(req, res, next);
}

function requireInstanceAdmin(req, res, next) {
  return requireRole(INSTANCE_ADMIN_ROLE)(req, res, next);
}

function readProviderKeyHeader(req, headerName) {
  const raw = req?.header(headerName);
  if (raw === undefined || raw === null) return "";
  const clean = String(raw).trim();
  if (!clean) return "";
  if (clean.length > 4096) {
    throw new Error(`${headerName} header is too long`);
  }
  return clean;
}

function resolveProviderApiKeyOverrides(req) {
  return {
    openai: readProviderKeyHeader(req, "x-openai-api-key"),
    gemini: readProviderKeyHeader(req, "x-gemini-api-key"),
    anthropic: readProviderKeyHeader(req, "x-anthropic-api-key")
  };
}

function resolveProviderApiKeyOverride(req, provider) {
  const cleanProvider = normalizeProviderId(provider) || "openai";
  const overrides = resolveProviderApiKeyOverrides(req);
  return overrides[cleanProvider] || "";
}

function assertNoOpenAiApiKeyOverride(req, endpointLabel) {
  const overrides = resolveProviderApiKeyOverrides(req);
  if (!overrides.openai && !overrides.gemini && !overrides.anthropic) return;
  const endpoint = endpointLabel || "this endpoint";
  throw new Error(`${endpoint} does not support request-scoped provider API key headers because the work runs asynchronously after the request ends`);
}

function resolveCollection(req, options = {}) {
  const provided = req.body?.collection || req.query?.collection;
  const collection = normalizeCollection(provided);
  const track = options.track !== false;
  if (req && track) req.collection = collection;
  return collection;
}

function resolveCollectionScope(req, options = {}) {
  const rawScope = req.body?.collectionScope ?? req.query?.collectionScope;
  const scope = String(rawScope || "").trim().toLowerCase();
  const rawCollection = req.body?.collection ?? req.query?.collection;
  const cleanRaw = rawCollection === undefined || rawCollection === null
    ? ""
    : String(rawCollection).trim();
  const defaultAll = options.defaultAll === true;
  const track = options.track !== false;

  if (scope === "all" || cleanRaw === "*" || cleanRaw.toLowerCase() === "all") {
    if (req && track) req.collection = null;
    return null;
  }

  if (!cleanRaw && defaultAll) {
    if (req && track) req.collection = null;
    return null;
  }

  if (!cleanRaw) {
    return resolveCollection(req, options);
  }

  if (!COLLECTION_RE.test(cleanRaw)) {
    throw new Error("collection must use only letters, numbers, dot, dash, or underscore (no spaces)");
  }

  if (req && track) req.collection = cleanRaw;
  return cleanRaw;
}

function namespaceDocId(tenantId, collection, docId) {
  return `${tenantId}::${collection}::${docId}`;
}

function parseNamespacedDocId(value) {
  const raw = String(value || "");
  if (!raw) return null;
  const parts = raw.split("::");
  if (parts.length === 2) {
    return { tenantId: parts[0], collection: DEFAULT_COLLECTION, docId: parts[1], legacy: true };
  }
  if (parts.length === 3) {
    return { tenantId: parts[0], collection: parts[1], docId: parts[2], legacy: false };
  }
  return null;
}

function parseChunkId(value) {
  const raw = String(value || "");
  if (!raw) return null;
  const docPart = raw.split("#")[0];
  const parsed = parseNamespacedDocId(docPart);
  if (!parsed) return null;
  return { ...parsed, chunkId: raw, docPart };
}

function stripChunkNamespace(value) {
  const raw = String(value || "");
  const docPart = raw.split("#")[0];
  const parsed = parseNamespacedDocId(docPart);
  if (!parsed) return raw;
  const suffix = raw.slice(docPart.length);
  return `${parsed.docId}${suffix}`;
}

function buildMeta(tenantId, collection) {
  return {
    tenantId: tenantId || null,
    collection: collection || null,
    timestamp: new Date().toISOString()
  };
}

function buildOkPayload(data, tenantId, collection) {
  return { ok: true, data, meta: buildMeta(tenantId, collection) };
}

function buildErrorPayload(message, code, tenantId, collection) {
  return {
    ok: false,
    error: { message: String(message || "Request failed"), code: code || null },
    meta: buildMeta(tenantId, collection)
  };
}

function withTokenEstimate(metadata, text) {
  const tokensEst = estimateTokensFromText(text);
  const hasMeta = metadata && typeof metadata === "object" && !Array.isArray(metadata);
  const base = hasMeta ? { ...metadata } : null;
  if (Number.isFinite(tokensEst) && tokensEst > 0) {
    const out = base || {};
    out._tokens_est = tokensEst;
    return out;
  }
  return base;
}

function withStoredMemoryPolicy(metadata, policy) {
  const cleanPolicy = normalizeMemoryPolicy(policy, DEFAULT_MEMORY_POLICY);
  const hasMeta = metadata && typeof metadata === "object" && !Array.isArray(metadata);
  const out = hasMeta ? { ...metadata } : {};
  out._policy = cleanPolicy;
  return out;
}

function buildStoredMemoryMetadata(metadata, text, policy) {
  return withStoredMemoryPolicy(withTokenEstimate(metadata, text), policy);
}

function formatMemoryMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata || null;
  }
  const out = { ...metadata };
  delete out._policy;
  return Object.keys(out).length ? out : null;
}

function formatMemoryItem(memory) {
  if (!memory) return null;
  return {
    id: memory.id,
    namespaceId: memory.namespace_id,
    type: memory.item_type,
    policy: getMemoryPolicy(memory),
    externalId: memory.external_id || null,
    principalId: memory.principal_id || null,
    agentId: memory.agent_id || null,
    tags: memory.tags || [],
    visibility: memory.visibility || "tenant",
    acl: memory.acl_principals || [],
    title: memory.title || null,
    sourceType: memory.source_type || null,
    sourceUrl: memory.source_url || null,
    metadata: formatMemoryMetadata(memory.metadata),
    createdAt: memory.created_at,
    expiresAt: memory.expires_at || null,
    valueScore: memory.value_score ?? null,
    tier: normalizeTier(memory.tier, "WARM"),
    valueLastUpdateTs: Number.isFinite(Number(memory.value_last_update_ts)) ? Number(memory.value_last_update_ts) : null,
    tierLastUpdateTs: Number.isFinite(Number(memory.tier_last_update_ts)) ? Number(memory.tier_last_update_ts) : null,
    reuseCount: memory.reuse_count ?? 0,
    lastUsedAt: memory.last_used_at || null,
    utilityEma: memory.utility_ema ?? 0,
    redundancyScore: memory.redundancy_score ?? 0,
    trustScore: memory.trust_score ?? 0.5,
    importanceHint: memory.importance_hint ?? null,
    pinned: Boolean(memory.pinned)
  };
}

function stableJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeConversationWikiInlineText(value, max = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, max));
}

function normalizeConversationWikiParagraphText(value, max = CONVERSATION_WIKI_MAX_PARAGRAPH_CHARS) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, Math.max(0, max));
}

function slugifyConversationWiki(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizeConversationWikiPagesInput(raw) {
  const source = raw === undefined || raw === null || raw === ""
    ? CONVERSATION_WIKI_PAGES
    : (Array.isArray(raw) ? raw : String(raw).split(/[\n,;]+/));
  const pages = [];
  const seen = new Set();
  for (const value of source) {
    const clean = normalizeConversationWikiInlineText(value, CONVERSATION_WIKI_MAX_TITLE_CHARS);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(clean);
  }
  return pages;
}

function buildConversationWikiExternalId(conversationId, page) {
  return `conversation-wiki:${String(conversationId || "").trim()}:${String(page || "").trim()}`;
}

function buildConversationWikiPageTitle(page) {
  if (String(page || "").trim() === CONVERSATION_WIKI_ARTICLE_PAGE) {
    return "Conversation wiki";
  }
  const label = String(page || "")
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `Conversation ${label || "Wiki"}`;
}

function normalizeConversationWikiSectionItems(raw) {
  const source = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(/\r?\n+/) : []);
  const items = [];
  const seen = new Set();
  for (const value of source) {
    const clean = normalizeConversationWikiInlineText(value, 320);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    items.push(clean);
    if (items.length >= CONVERSATION_WIKI_MAX_ITEMS_PER_SECTION) break;
  }
  return items;
}

function normalizeConversationWikiSections(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sections = {};
  for (const key of CONVERSATION_WIKI_SECTION_KEYS) {
    sections[key] = normalizeConversationWikiSectionItems(source[key]);
  }
  return sections;
}

function buildConversationWikiKnowledgeGapParagraph(items = []) {
  const gaps = Array.isArray(items)
    ? items.map((item) => normalizeConversationWikiInlineText(item, 320).replace(/[.?!]+$/g, "")).filter(Boolean)
    : [];
  if (!gaps.length) return null;
  const label = gaps.length === 1
    ? "Additional knowledge base coverage could help answer this unresolved point"
    : "Additional knowledge base coverage could help answer these unresolved points";
  return `${label}: ${gaps.join("; ")}.`;
}

function buildConversationWikiNarrativeParagraphs(sections = {}) {
  const confirmed = Array.isArray(sections.confirmed) ? sections.confirmed : [];
  const uncertain = Array.isArray(sections.uncertain) ? sections.uncertain : [];
  const knowledgeGap = buildConversationWikiKnowledgeGapParagraph(sections.open);
  const paragraphs = [
    ...confirmed.map((item) => normalizeConversationWikiParagraphText(item)).filter(Boolean),
    ...uncertain.map((item) => normalizeConversationWikiParagraphText(item)).filter(Boolean)
  ];
  if (knowledgeGap) paragraphs.push(knowledgeGap);
  return paragraphs;
}

function normalizeConversationWikiParagraphs(value, { label = "conversationWiki.article.paragraphs" } = {}) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/\n\s*\n+/) : []);
  const paragraphs = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const paragraph = String(raw[index] || "").replace(/\r\n/g, "\n").trim();
    if (!paragraph) continue;
    const key = paragraph.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paragraphs.push(paragraph);
    if (paragraphs.length >= CONVERSATION_WIKI_MAX_ITEMS_PER_SECTION) break;
  }
  return paragraphs;
}

function normalizeConversationWikiNote(value) {
  const note = normalizeConversationWikiInlineText(value, CONVERSATION_WIKI_MAX_NOTE_CHARS);
  return note || null;
}

function normalizeConversationWikiArticleSection(value, fallbackId = "", fallbackTitle = "") {
  const rawSection = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { paragraphs: value };
  const title = normalizeConversationWikiInlineText(
    rawSection.title ?? rawSection.heading ?? fallbackTitle,
    CONVERSATION_WIKI_MAX_TITLE_CHARS
  ) || buildConversationWikiPageTitle(fallbackId || fallbackTitle || "section");
  const cleanId = normalizeConversationWikiInlineText(
    rawSection.id ?? rawSection.page ?? rawSection.slug ?? fallbackId,
    80
  );
  const note = normalizeConversationWikiNote(
    rawSection.note ?? rawSection.summary ?? rawSection.updatedAtNote ?? rawSection.subtitle
  );
  const directParagraphs = normalizeConversationWikiParagraphs(
    rawSection.paragraphs ?? rawSection.body ?? rawSection.content ?? rawSection.text
  );
  const legacySections = rawSection.sections && typeof rawSection.sections === "object"
    ? normalizeConversationWikiSections(rawSection.sections)
    : (CONVERSATION_WIKI_SECTION_KEYS.some((key) => key in rawSection)
      ? normalizeConversationWikiSections(rawSection)
      : null);
  const paragraphs = directParagraphs.length
    ? directParagraphs
    : buildConversationWikiNarrativeParagraphs(legacySections || {});
  return {
    id: slugifyConversationWiki(cleanId || title || fallbackId || "section") || "section",
    title,
    note,
    paragraphs
  };
}

function normalizeConversationWikiArticleSections(value, { fallbackPages = CONVERSATION_WIKI_PAGES } = {}) {
  let rawSections = null;
  if (Array.isArray(value)) {
    rawSections = value;
  } else if (value && typeof value === "object") {
    if (Array.isArray(value.sections)) {
      rawSections = value.sections;
    } else if (Array.isArray(value.pages)) {
      rawSections = value.pages;
    } else {
      const source = value.pages && typeof value.pages === "object" && !Array.isArray(value.pages)
        ? value.pages
        : value.sections && typeof value.sections === "object" && !Array.isArray(value.sections)
          ? value.sections
          : value;
      const orderedKeys = [];
      const seen = new Set();
      for (const key of Array.isArray(fallbackPages) ? fallbackPages : []) {
        const cleanKey = String(key || "").trim();
        if (!cleanKey || !(cleanKey in source) || seen.has(cleanKey)) continue;
        seen.add(cleanKey);
        orderedKeys.push(cleanKey);
      }
      for (const key of Object.keys(source)) {
        if (seen.has(key)) continue;
        seen.add(key);
        orderedKeys.push(key);
      }
      rawSections = orderedKeys.map((key) => ({
        id: key,
        ...(source[key] && typeof source[key] === "object" && !Array.isArray(source[key])
          ? source[key]
          : { paragraphs: source[key] })
      }));
    }
  }
  const output = [];
  const seenIds = new Set();
  for (let index = 0; index < (Array.isArray(rawSections) ? rawSections.length : 0); index += 1) {
    const rawSection = rawSections[index];
    const fallbackId = Array.isArray(fallbackPages) && fallbackPages[index] ? fallbackPages[index] : `section-${index + 1}`;
    const section = normalizeConversationWikiArticleSection(rawSection, fallbackId);
    if (!section.paragraphs.length && !section.note) continue;
    let sectionId = section.id || slugifyConversationWiki(section.title) || `section-${index + 1}`;
    let suffix = 2;
    while (seenIds.has(sectionId)) {
      sectionId = `${section.id || slugifyConversationWiki(section.title) || "section"}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(sectionId);
    output.push({
      ...section,
      id: sectionId
    });
    if (output.length >= CONVERSATION_WIKI_MAX_SECTIONS) break;
  }
  return output;
}

function buildConversationWikiArticle(records = []) {
  const normalizedRecords = Array.isArray(records)
    ? records.map((record) => normalizeConversationWikiArticleSection({
      id: record?.page,
      title: record?.title ?? record?.metadata?.title ?? null,
      note: record?.note ?? record?.metadata?.note ?? record?.metadata?.summary,
      paragraphs: record?.paragraphs ?? record?.metadata?.paragraphs,
      sections: record?.sections ?? record?.metadata?.sections
    }, record?.page || CONVERSATION_WIKI_ARTICLE_PAGE))
      .filter((record) => record.paragraphs.length || record.note)
    : [];
  const articleRecord = normalizedRecords.find((record) => record.id === CONVERSATION_WIKI_ARTICLE_PAGE) || null;
  if (articleRecord) {
    return {
      page: CONVERSATION_WIKI_ARTICLE_PAGE,
      title: articleRecord.title || "Conversation wiki",
      note: articleRecord.note || null,
      paragraphs: articleRecord.paragraphs
    };
  }
  const paragraphs = [];
  for (const record of normalizedRecords) {
    for (const paragraph of record.paragraphs) {
      const cleanParagraph = normalizeConversationWikiParagraphText(paragraph);
      if (cleanParagraph) paragraphs.push(cleanParagraph);
    }
  }
  return {
    page: CONVERSATION_WIKI_ARTICLE_PAGE,
    title: "Conversation wiki",
    note: normalizedRecords.length > 1
      ? "Merged from the previous wiki version so durable context is preserved across rebuilds."
      : normalizedRecords[0]?.note || null,
    paragraphs
  };
}

function buildConversationWikiTurnExchanges(recentTurns = []) {
  return buildConversationWikiTurnExchangeSpans(recentTurns).map((exchange) => ({
    index: exchange.index,
    question: exchange.question || null,
    askedAt: exchange.askedAt || null,
    questionExternalId: exchange.questionExternalId || null,
    responseCount: exchange.responseCount,
    responses: Array.isArray(exchange.responses) ? exchange.responses : []
  }));
}

function normalizeConversationWikiStoredExchanges(value = [], { label = "conversationWiki.sourceExchanges" } = {}) {
  const exchanges = [];
  const seen = new Set();
  for (let exchangeIndex = 0; exchangeIndex < (Array.isArray(value) ? value.length : 0); exchangeIndex += 1) {
    const rawExchange = value[exchangeIndex];
    if (!rawExchange || typeof rawExchange !== "object" || Array.isArray(rawExchange)) continue;
    const question = normalizeConversationWikiParagraphText(
      rawExchange.question,
      CONVERSATION_WIKI_MAX_EXCHANGE_QUESTION_CHARS
    ) || null;
    const askedAt = normalizeConversationWikiInlineText(rawExchange.askedAt, 80) || null;
    const questionExternalId = normalizeConversationWikiInlineText(rawExchange.questionExternalId, 160) || null;
    const responses = [];
    const rawResponses = Array.isArray(rawExchange.responses) ? rawExchange.responses : [];
    for (let responseIndex = 0; responseIndex < rawResponses.length; responseIndex += 1) {
      const rawResponse = rawResponses[responseIndex];
      if (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse)) continue;
      const text = normalizeConversationWikiParagraphText(
        rawResponse.text,
        CONVERSATION_WIKI_MAX_EXCHANGE_RESPONSE_CHARS
      ) || null;
      if (!text) continue;
      const role = normalizeConversationWikiInlineText(rawResponse.role, 40) || "assistant";
      const createdAt = normalizeConversationWikiInlineText(rawResponse.createdAt, 80) || null;
      const externalId = normalizeConversationWikiInlineText(rawResponse.externalId, 160) || null;
      responses.push({ role, text, createdAt, externalId });
      if (responses.length >= CONVERSATION_WIKI_MAX_EXCHANGE_RESPONSES) break;
    }
    if (!question && !responses.length) continue;
    const key = stableJson({
      questionExternalId,
      question: question ? question.toLowerCase() : null,
      responses: responses.map((response) => ({
        externalId: response.externalId || null,
        text: response.text.toLowerCase()
      }))
    });
    if (seen.has(key)) continue;
    seen.add(key);
    exchanges.push({
      question,
      askedAt,
      questionExternalId,
      responseCount: responses.length,
      responses
    });
    if (exchanges.length >= CONVERSATION_WIKI_MAX_STORED_EXCHANGES) break;
  }
  return exchanges;
}

function mergeConversationWikiStoredExchanges(...sets) {
  return normalizeConversationWikiStoredExchanges(
    sets.flatMap((set) => (Array.isArray(set) ? set : []))
  );
}

function countConversationWikiAnsweredStoredExchanges(value = []) {
  return normalizeConversationWikiStoredExchanges(value).filter((exchange) => (
    Array.isArray(exchange?.responses) && exchange.responses.length > 0
  )).length;
}

function buildConversationWikiFallbackParagraphs(sourceExchanges = [], { label = "conversationWiki.fallbackSourceExchanges" } = {}) {
  const exchanges = normalizeConversationWikiStoredExchanges(sourceExchanges, { label });
  const paragraphs = [];
  for (let exchangeIndex = 0; exchangeIndex < exchanges.length; exchangeIndex += 1) {
    const exchange = exchanges[exchangeIndex];
    const sentences = [];
    if (exchange?.question) {
      sentences.push(`The user asked: ${exchange.question}`);
    } else {
      sentences.push("The conversation continued without a newly captured user question before the assistant responded.");
    }
    const responses = Array.isArray(exchange?.responses) ? exchange.responses : [];
    if (responses.length) {
      for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
        const response = responses[responseIndex];
        const responseText = String(response?.text || "").trim();
        if (!responseText) continue;
        sentences.push(`${responseIndex === 0 ? "The assistant answered:" : "A follow-up assistant response added:"} ${responseText}`);
      }
    } else {
      sentences.push("No assistant answer was captured for this exchange.");
    }
    const paragraph = normalizeConversationWikiParagraphs(
      [sentences.join(" ")],
      { label: `${label}[${exchangeIndex}].paragraph` }
    )[0] || null;
    if (paragraph) paragraphs.push(paragraph);
  }
  return paragraphs;
}

function repairConversationWikiArticleDraft(article, {
  sourceExchanges = [],
  previousWiki = null,
  minAnsweredExchanges = 0,
  fallbackTitle = "Conversation wiki"
} = {}) {
  void minAnsweredExchanges;
  const normalized = normalizeConversationWikiArticle(article, {
    fallbackId: CONVERSATION_WIKI_ARTICLE_PAGE,
    fallbackTitle
  });
  const exchangeParagraphs = buildConversationWikiFallbackParagraphs(sourceExchanges, {
    label: "conversationWiki.repair.sourceExchanges"
  });
  const previousParagraphs = normalizeConversationWikiParagraphs(
    previousWiki?.paragraphs,
    { label: "conversationWiki.repair.previousWiki.paragraphs" }
  );
  const hasReadableParagraphs = Array.isArray(normalized.paragraphs) && normalized.paragraphs.length > 0;
  if (hasReadableParagraphs) {
    return normalized;
  }
  const fallbackParagraphs = exchangeParagraphs.length ? exchangeParagraphs : previousParagraphs;
  if (!fallbackParagraphs.length) {
    return normalized;
  }
  return normalizeConversationWikiArticle({
    article: {
      id: CONVERSATION_WIKI_ARTICLE_PAGE,
      title: normalized.title || fallbackTitle,
      note: normalized.note || "Rebuilt directly from captured exchanges because the generator returned no readable article.",
      paragraphs: fallbackParagraphs
    }
  }, {
    fallbackId: CONVERSATION_WIKI_ARTICLE_PAGE,
    fallbackTitle
  });
}

function buildConversationWikiExchangeDigest(recentTurns = []) {
  const exchanges = Array.isArray(recentTurns) && recentTurns.length && recentTurns[0] && typeof recentTurns[0] === "object" && "responses" in recentTurns[0]
    ? normalizeConversationWikiStoredExchanges(recentTurns)
    : normalizeConversationWikiStoredExchanges(buildConversationWikiTurnExchanges(recentTurns));
  if (!exchanges.length) return "No question-and-answer exchanges were available.";
  return exchanges.map((exchange) => {
    const lines = [`Exchange ${exchange.index}`];
    if (exchange.question) {
      lines.push(`Question: ${exchange.question}`);
    } else {
      lines.push("Question: None captured before the following responses.");
    }
    if (Array.isArray(exchange.responses) && exchange.responses.length) {
      exchange.responses.forEach((response, responseIndex) => {
        const role = String(response?.role || "assistant").trim() || "assistant";
        const createdAt = response?.createdAt ? ` @ ${new Date(response.createdAt).toISOString()}` : "";
        lines.push(`Answer ${responseIndex + 1} (${role}${createdAt}): ${String(response?.text || "").trim()}`);
      });
    } else {
      lines.push("Answer: No assistant answer was captured for this exchange.");
    }
    return lines.join("\n");
  }).join("\n\n");
}

function countConversationWikiItems(section = {}) {
  return Array.isArray(section.paragraphs) ? section.paragraphs.length : 0;
}

function buildConversationWikiPageText(page, section, maxChars = CONVERSATION_WIKI_MAX_PAGE_CHARS) {
  const normalized = normalizeConversationWikiArticleSection(section || {}, page, buildConversationWikiPageTitle(page));
  const paragraphSource = Array.isArray(normalized.paragraphs) ? normalized.paragraphs : [];
  const lines = [normalized.title];
  if (normalized.note) {
    lines.push("");
    lines.push(`Note: ${normalized.note}`);
  }
  if (!paragraphSource.length) {
    lines.push("");
    lines.push("No durable narrative has been captured for this section yet.");
  } else {
    for (const paragraph of paragraphSource) {
      lines.push("");
      lines.push(paragraph);
    }
  }
  return {
    text: lines.join("\n"),
    page: normalized.id,
    title: normalized.title,
    note: normalized.note,
    paragraphs: paragraphSource,
    itemCount: countConversationWikiItems({ paragraphs: paragraphSource })
  };
}

function stripJsonFences(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const match = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return match ? String(match[1] || "").trim() : raw;
}

function normalizeConversationWikiArticle(value, { fallbackId = CONVERSATION_WIKI_ARTICLE_PAGE, fallbackTitle = "Conversation wiki" } = {}) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.article && typeof value.article === "object" && !Array.isArray(value.article)) {
    return normalizeConversationWikiArticleSection(value.article, fallbackId, fallbackTitle);
  }
  if (Array.isArray(value?.sections) || Array.isArray(value?.pages)) {
    const merged = buildConversationWikiArticle(normalizeConversationWikiArticleSections(value, { fallbackPages: [fallbackId] }));
    return normalizeConversationWikiArticleSection(merged, fallbackId, fallbackTitle);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const legacyKeys = Object.keys(value);
    if (legacyKeys.some((key) => value[key] && typeof value[key] === "object" && !Array.isArray(value[key]) && CONVERSATION_WIKI_SECTION_KEYS.some((sectionKey) => sectionKey in value[key]))) {
      const merged = buildConversationWikiArticle(normalizeConversationWikiArticleSections(value, { fallbackPages: [fallbackId] }));
      return normalizeConversationWikiArticleSection(merged, fallbackId, fallbackTitle);
    }
  }
  return normalizeConversationWikiArticleSection(value, fallbackId, fallbackTitle);
}

function parseConversationWikiResponse(text, pages = CONVERSATION_WIKI_PAGES) {
  const raw = stripJsonFences(text);
  if (!raw) return normalizeConversationWikiArticle({}, {
    fallbackId: CONVERSATION_WIKI_ARTICLE_PAGE,
    fallbackTitle: "Conversation wiki"
  });
  const candidates = [raw];
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  let parsed = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("conversation wiki generator did not return a JSON object");
  }
  const fallbackTitle = Array.isArray(pages) && pages.length
    ? normalizeConversationWikiInlineText(pages[0], CONVERSATION_WIKI_MAX_TITLE_CHARS) || "Conversation wiki"
    : "Conversation wiki";
  return normalizeConversationWikiArticle(parsed, {
    fallbackId: CONVERSATION_WIKI_ARTICLE_PAGE,
    fallbackTitle
  });
}

function extractConversationMessageBody(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const match = raw.match(/(?:^|\n)Message:\s*\n([\s\S]*)$/i);
  if (match && String(match[1] || "").trim()) {
    return String(match[1]).trim();
  }
  return raw;
}

function formatConversationWikiItem(memory, text) {
  const metadata = memory?.metadata && typeof memory.metadata === "object" ? memory.metadata : {};
  const normalized = normalizeConversationWikiArticleSection({
    id: metadata.page || null,
    title: metadata.title || null,
    note: metadata.note ?? metadata.summary,
    paragraphs: metadata.paragraphs,
    sections: metadata.sections
  }, metadata.page || CONVERSATION_WIKI_ARTICLE_PAGE);
  return {
    page: metadata.page || normalized.id || null,
    checkpointTurnExternalId: metadata.checkpointTurnExternalId || null,
    revision: Number(metadata.revision || 0),
    itemCount: Number(metadata.itemCount || normalized.paragraphs.length || 0),
    updatedAt: metadata.updatedAt || memory?.created_at || null,
    updatedBySource: metadata.updatedBySource || memory?.source_type || null,
    title: normalized.title,
    note: normalized.note,
    paragraphs: normalized.paragraphs,
    sourceExchanges: normalizeConversationWikiStoredExchanges(metadata.sourceExchanges),
    sections: normalizeConversationWikiSections(metadata.sections),
    text: String(text || "").trim(),
    memory: formatMemoryItem(memory)
  };
}

function getConversationWikiLastUpdatedAt(records = []) {
  return records.reduce((latest, record) => {
    const timestamp = record?.updatedAt || record?.memory?.createdAt || null;
    if (!timestamp) return latest;
    if (!latest) return timestamp;
    return Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest;
  }, null);
}

function formatConversationWikiJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status || null,
    attempts: Number(job.attempts || 0),
    createdAt: job.created_at || null,
    updatedAt: job.updated_at || null
  };
}

function buildConversationWikiUpdatePrompt({ conversationId, pages, existingWikiState, recentTurns }) {
  const articleHints = Array.isArray(pages) ? pages.map((page) => normalizeConversationWikiInlineText(page, CONVERSATION_WIKI_MAX_TITLE_CHARS)).filter(Boolean) : [];
  const turnPayload = Array.isArray(recentTurns)
    ? recentTurns.map((turn, index) => ({
      index: index + 1,
      externalId: turn.externalId || null,
      role: turn.role || null,
      kind: String(turn?.role || "").trim().toLowerCase() === "user" ? "question" : "response",
      createdAt: turn.createdAt || null,
      text: extractConversationMessageBody(turn.text)
    }))
    : [];
  const turnExchanges = buildConversationWikiTurnExchanges(recentTurns);
  const turnExchangeDigest = buildConversationWikiExchangeDigest(recentTurns);
  const previousWikiSourceExchanges = normalizeConversationWikiStoredExchanges(
    existingWikiState?.previousWikiSourceExchanges,
    { label: "conversationWiki.previousWikiSourceExchanges" }
  );
  const previousWikiArticleText = Array.isArray(existingWikiState?.previousWiki?.paragraphs)
    ? existingWikiState.previousWiki.paragraphs.map((paragraph) => String(paragraph || "").trim()).filter(Boolean).join("\n\n")
    : "";
  return {
    system: [
      "You maintain one living conversation wiki article for one conversation.",
      "Return JSON only.",
      "Use exactly this schema:",
      stableJson({
        article: {
          id: "article",
          title: "Career growth through managing up and visible execution",
          note: "Optional one-line editorial note or null.",
          paragraphs: [
            "Long, information-dense paragraph one.",
            "Long, information-dense paragraph two."
          ]
        }
      }),
      "Rules:",
      "- Only include information grounded in the previous wiki article and the provided turns.",
      "- Prefer newer turns when they contradict older wiki material, but preserve still-relevant earlier context.",
      "- Use a concise, subject-specific article title. Avoid generic labels such as 'Conversation wiki' or 'Living conversation article'.",
      "- Write one continuous article, not sections, not lists, not dashboards, and not bucket labels.",
      "- Make it clear what the user asked, what the assistant answered, and how understanding changed over time.",
      "- The article must visibly incorporate both the user's questions and the assistant's answers. Do not treat the user questions as the only source of substance.",
      "- Treat answered questions as answered. Do not rewrite answered exchanges as generic knowledge gaps just because the answer was broad, advisory, or not user-specific.",
      "- If there are multiple user questions or question-response exchanges, cover each exchange with its own substantial paragraph before any concluding synthesis.",
      "- When there are N answered exchanges, write at least N substantial body paragraphs before any concluding synthesis or knowledge-base gap paragraph.",
      "- Do not mention a user question without also carrying forward the substance of the assistant answer that followed it, unless no answer was actually given.",
      "- Preserve the substance of assistant answers in the article. Summaries should retain what was actually advised, explained, corrected, or recommended.",
      "- Do not silently drop an answered exchange from the digest or source exchanges. If a newer exchange corrects an older one, keep both in the article by explicitly explaining the correction.",
      "- Use the explicit question-and-answer digest and the raw turn transcript together. The digest is the primary structure; the transcript is there to preserve wording and sequence.",
      "- Use previous wiki source exchanges as factual scaffolding so earlier answered exchanges are not silently dropped when older raw turns are no longer available.",
      "- Only add a knowledge-base gap paragraph when the assistant response explicitly lacked enough information, deferred the answer, or clearly identified missing source material.",
      "- Avoid filler like 'no user-specific context provided' unless that absence materially changed the answer.",
      "- Use the previous wiki article as source material to preserve durable information unless the newer turns clearly supersede it.",
      "- If something is still missing or unresolved, explain in normal prose what knowledge should be added to the knowledge base; do not create open-loop sections.",
      "- Write substantial paragraphs with multiple sentences. Avoid tiny summary paragraphs.",
      "- Aim for 6 to 12 dense paragraphs when the material supports it. If there is less material, still prefer fewer substantial paragraphs over many short ones.",
      "- It is better to be long and information-dense than short and generic, as long as every paragraph stays grounded in the source material.",
      "- Use lightweight formatting inside paragraphs when it improves readability: **bold**, *italics*, > blockquotes, inline code, markdown links, and tone callouts like {accent|important}, {muted|context}, {success|resolved}, {warning|caution}, or {danger|critical}.",
      "- Use formatting sparingly but intentionally. Emphasize genuinely important shifts, caveats, or cited phrasing from the conversation so the article does not read like a flat wall of text.",
      "- If article hints are provided, treat them as loose editorial guidance, not a required outline.",
      "- Never invent durable knowledge, preferences, or conclusions."
    ].join("\n"),
    user: [
      `Conversation ID: ${conversationId || ""}`,
      `Article hints: ${articleHints.length ? articleHints.join(", ") : "none"}`,
      "Previous wiki article text:",
      previousWikiArticleText || "No previous wiki article was available.",
      "Previous wiki JSON:",
      stableJson(existingWikiState || {}),
      "Previous wiki source exchanges JSON:",
      stableJson(previousWikiSourceExchanges),
      "Question and answer digest:",
      turnExchangeDigest,
      "Question and response exchanges JSON:",
      stableJson(turnExchanges),
      "Recent turn transcript JSON:",
      stableJson(turnPayload)
    ].join("\n\n")
  };
}
function buildAuditActor(req) {
  const auth = req.user?.auth || "system";
  const actorId = req.user?.principal_id || req.user?.sub || null;
  let actorType = "system";
  if (auth === "api_key") actorType = "service";
  else if (auth === "jwt") actorType = "user";
  else if (auth) actorType = String(auth);
  const tokenId = req.user?.token_id || null;
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : null;
  return {
    actorId,
    actorType,
    auth,
    tokenId,
    roles
  };
}

function mergeAuditMetadata(base, actor) {
  const metadata = { ...(base || {}) };
  if (actor?.auth) metadata.auth = actor.auth;
  if (actor?.tokenId) metadata.tokenId = actor.tokenId;
  if (actor?.roles && actor.roles.length) metadata.roles = actor.roles;
  return metadata;
}

async function recordAudit(req, tenantId, { action, targetType, targetId, metadata }) {
  if (!tenantId || !action) return;
  const actor = buildAuditActor(req);
  const merged = mergeAuditMetadata(metadata, actor);
  const payload = {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action,
    targetType: targetType || null,
    targetId: targetId || null,
    metadata: Object.keys(merged).length ? merged : null,
    requestId: req.requestId || null,
    ip: req.ip || null
  };
  try {
    await createAuditLog(payload);
  } catch (err) {
    console.warn("[audit] Failed to record audit log:", err?.message || err);
  }
}

function normalizeEventValue(eventType, eventValue) {
  const fallback = MEMORY_EVENT_DEFAULTS[eventType] ?? 0;
  if (eventValue === undefined || eventValue === null || eventValue === "") {
    return clampNumber(fallback, -1, 1);
  }
  const value = Number(eventValue);
  if (!Number.isFinite(value)) {
    throw new Error("eventValue must be a number");
  }
  return clampNumber(value, -1, 1);
}

function shouldIncrementReuse(eventType) {
  return eventType === "retrieved" || eventType === "used_in_answer";
}

function isContributionEvent(eventType, normalizedValue) {
  if (eventType === "used_in_answer") return true;
  if (eventType === "task_success") return normalizedValue > 0;
  if (eventType === "user_positive") return normalizedValue > 0;
  return false;
}

function shouldUpdateUtility(eventType) {
  return eventType in MEMORY_EVENT_DEFAULTS;
}

function updateUtilityEma(previous, eventValue) {
  const prev = Number(previous || 0);
  const alpha = Number.isFinite(MEMORY_UTILITY_ALPHA) ? MEMORY_UTILITY_ALPHA : 0.2;
  return clampNumber(prev * (1 - alpha) + eventValue * alpha, -1, 1);
}

function updateTrustScore(previous, eventType, eventValue) {
  if (!["user_positive", "user_negative", "task_success", "task_fail"].includes(eventType)) {
    return clampNumber(Number(previous ?? 0.5), 0, 1);
  }
  const prev = Number(previous ?? 0.5);
  const step = Number.isFinite(MEMORY_TRUST_STEP) ? MEMORY_TRUST_STEP : 0.05;
  return clampNumber(prev + step * eventValue, 0, 1);
}

function buildValueUpdateForMemory(memory, eventType, normalizedValue, nowMs, options = {}) {
  const policy = normalizeMemoryPolicy(options.policy ?? getMemoryPolicy(memory), DEFAULT_MEMORY_POLICY);
  const config = resolveMemoryPolicyConfig(policy);
  const now = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const maxValue = Number.isFinite(config.valueMax) && config.valueMax > 0 ? config.valueMax : 1;
  const existingValue = clampNumber(
    Number(memory?.value_score ?? resolveInitialValueScore(config)),
    0,
    maxValue
  );
  const existingTs = Number(memory?.value_last_update_ts);
  const lastUpdateTs = Number.isFinite(existingTs) && existingTs > 0 ? existingTs : now;
  const decayed = decayMemoryValue(existingValue, lastUpdateTs, now, config);

  let delta = 0;
  if (!options.decayOnly) {
    const accessAlpha = Number.isFinite(config.accessAlpha) ? config.accessAlpha : 0;
    const contributionBeta = Number.isFinite(config.contributionBeta) ? config.contributionBeta : 0;
    const negativeStep = Number.isFinite(config.negativeStep) ? config.negativeStep : 0;
    const access = shouldIncrementReuse(eventType) ? 1 : 0;
    const contribution = isContributionEvent(eventType, normalizedValue) ? 1 : 0;
    delta += accessAlpha * access;
    delta += contributionBeta * contribution;
    if (eventType === "task_fail" || eventType === "user_negative") {
      delta -= negativeStep * Math.max(0, Math.abs(normalizedValue) || 1);
    }
  }

  const nextValue = clampNumber(decayed + delta, 0, maxValue);
  const currentTier = normalizeTier(memory?.tier, "WARM");
  const nextTier = resolveTierForValue(currentTier, nextValue, Boolean(memory?.pinned), config);
  const priorTierTs = Number(memory?.tier_last_update_ts);
  const tierLastUpdateTs = nextTier === currentTier
    ? (Number.isFinite(priorTierTs) && priorTierTs > 0 ? priorTierTs : now)
    : now;

  return {
    valueScore: nextValue,
    tier: nextTier,
    valueLastUpdateTs: now,
    tierLastUpdateTs
  };
}

async function recordMemoryEventForItem(memory, eventType, eventValue, options = {}) {
  if (!memory || !memory.id || !memory.tenant_id) return null;
  const normalizedValue = normalizeEventValue(eventType, eventValue);
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const previousTier = normalizeTier(memory.tier, "WARM");
  if (options.persistEvent !== false) {
    await recordMemoryEvent({
      memoryId: memory.id,
      tenantId: memory.tenant_id,
      eventType,
      eventValue: normalizedValue,
      createdAt: new Date(nowMs)
    });
  }

  const reuseCount = shouldIncrementReuse(eventType)
    ? Number(memory.reuse_count || 0) + 1
    : Number(memory.reuse_count || 0);
  const utilityEma = shouldUpdateUtility(eventType)
    ? updateUtilityEma(memory.utility_ema, normalizedValue)
    : Number(memory.utility_ema || 0);
  const trustScore = updateTrustScore(memory.trust_score, eventType, normalizedValue);
  const lastUsedAt = new Date(nowMs);
  const valueUpdate = buildValueUpdateForMemory(memory, eventType, normalizedValue, nowMs, {
    decayOnly: options.decayOnly === true
  });

  const updated = await updateMemoryItemMetrics({
    id: memory.id,
    tenantId: memory.tenant_id,
    reuseCount,
    lastUsedAt,
    utilityEma,
    trustScore,
    valueScore: valueUpdate.valueScore,
    tier: valueUpdate.tier,
    valueLastUpdateTs: valueUpdate.valueLastUpdateTs,
    tierLastUpdateTs: valueUpdate.tierLastUpdateTs
  });
  const next = updated || {
    ...memory,
    reuse_count: reuseCount,
    last_used_at: lastUsedAt,
    utility_ema: utilityEma,
    trust_score: trustScore,
    value_score: valueUpdate.valueScore,
    tier: valueUpdate.tier,
    value_last_update_ts: valueUpdate.valueLastUpdateTs,
    tier_last_update_ts: valueUpdate.tierLastUpdateTs
  };
  emitTierTransitionTelemetry(
    next,
    previousTier,
    valueUpdate.tier,
    {
      reason: options.decayOnly ? "value_decay" : eventType,
      event_type: eventType,
      value_score: valueUpdate.valueScore
    },
    {
      source: options.decayOnly ? "value_decay" : "memory_event"
    }
  );
  return next;
}

function enqueueMemoryEvent(memory, eventType, eventValue, nowMs = Date.now()) {
  if (!memory?.id || !memory?.tenant_id) return;
  memoryEventQueue.push({
    memoryId: memory.id,
    tenantId: memory.tenant_id,
    eventType,
    eventValue,
    nowMs: Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now()
  });
}

async function flushMemoryEventQueue() {
  if (memoryEventFlushRunning) return;
  if (!memoryEventQueue.length) return;
  memoryEventFlushRunning = true;
  const batchSize = Number.isFinite(MEMORY_EVENT_FLUSH_MAX_EVENTS) && MEMORY_EVENT_FLUSH_MAX_EVENTS > 0
    ? MEMORY_EVENT_FLUSH_MAX_EVENTS
    : 200;
  const batch = memoryEventQueue.splice(0, batchSize);
  try {
    const grouped = new Map();
    for (const event of batch) {
      const key = `${event.tenantId}:${event.memoryId}`;
      const list = grouped.get(key) || [];
      list.push(event);
      grouped.set(key, list);
    }

    for (const events of grouped.values()) {
      const first = events[0];
      let memory = await getMemoryItemById(first.memoryId, first.tenantId, null);
      if (!memory) continue;
      for (const event of events) {
        try {
          memory = await recordMemoryEventForItem(memory, event.eventType, event.eventValue, {
            nowMs: event.nowMs,
            persistEvent: true
          });
        } catch (err) {
          console.warn(`[memory_events] Failed to flush ${event.eventType} for ${event.memoryId}:`, err?.message || err);
        }
      }
    }
  } finally {
    memoryEventFlushRunning = false;
  }
}

async function recordMemoryEventsForItems(memories, eventType, eventValue) {
  if (!Array.isArray(memories) || memories.length === 0) return;
  const nowMs = Date.now();
  for (const memory of memories) {
    enqueueMemoryEvent(memory, eventType, eventValue, nowMs);
  }
  if (memoryEventQueue.length >= (Number.isFinite(MEMORY_EVENT_FLUSH_MAX_EVENTS) && MEMORY_EVENT_FLUSH_MAX_EVENTS > 0 ? MEMORY_EVENT_FLUSH_MAX_EVENTS : 200)) {
    setImmediate(() => {
      flushMemoryEventQueue().catch((err) => {
        console.warn("[memory_events] flush failed:", err?.message || err);
      });
    });
  }
}

function scheduleMemoryEventFlush() {
  if (!Number.isFinite(MEMORY_EVENT_FLUSH_INTERVAL_MS) || MEMORY_EVENT_FLUSH_INTERVAL_MS <= 0) return;
  setInterval(() => {
    flushMemoryEventQueue().catch((err) => {
      console.warn("[memory_events] flush failed:", err?.message || err);
    });
  }, MEMORY_EVENT_FLUSH_INTERVAL_MS);
}

function toPositiveInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function parseEmbeddingUsage(usage) {
  const total = toPositiveInt(usage?.total_tokens ?? usage?.prompt_tokens);
  const prompt = toPositiveInt(usage?.prompt_tokens);
  return { total, prompt };
}

function parseGenerationUsage(usage) {
  const input = toPositiveInt(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = toPositiveInt(usage?.output_tokens ?? usage?.completion_tokens);
  const total = toPositiveInt(usage?.total_tokens) || (input + output);
  return { input, output, total };
}

function safeUsageRecord(promise) {
  if (!promise || typeof promise.catch !== "function") return;
  promise.catch((err) => {
    console.warn("[usage] Failed to record usage:", err?.message || err);
  });
}

function isRequestScopedProviderUsage(apiKey) {
  return Boolean(String(apiKey || "").trim());
}

function recordEmbeddingUsage(tenantId, usage, telemetryContext) {
  if (!tenantId) return;
  const tokens = parseEmbeddingUsage(usage);
  if (!tokens.total) return;
  const estimated = usage?.estimated === true || usage?.fallback === true;
  const billable = telemetryContext?.billable === true;
  safeUsageRecord(recordTenantUsage({
    tenantId,
    embeddingTokens: tokens.total,
    embeddingRequests: 1,
    eventKind: "embedding",
    requestId: telemetryContext?.requestId || null,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "embedding",
    estimated,
    billable,
    metadata: {
      tokenPrompt: tokens.prompt
    }
  }));
  emitTelemetry("token_usage", buildTelemetryContext({
    requestId: telemetryContext?.requestId,
    tenantId,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "embedding"
  }), {
    token_kind: "embedding",
    token_total: tokens.total,
    token_prompt: tokens.prompt,
    token_estimated: estimated
  });
}

function recordGenerationUsage(tenantId, usage, telemetryContext) {
  if (!tenantId) return;
  const tokens = parseGenerationUsage(usage);
  if (!tokens.total) return;
  const estimated = usage?.estimated === true || usage?.fallback === true;
  const billable = telemetryContext?.billable !== false;
  safeUsageRecord(recordTenantUsage({
    tenantId,
    generationInputTokens: tokens.input,
    generationOutputTokens: tokens.output,
    generationTotalTokens: tokens.total,
    generationRequests: 1,
    eventKind: "generation",
    requestId: telemetryContext?.requestId || null,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "generation",
    estimated,
    billable
  }));
  emitTelemetry("token_usage", buildTelemetryContext({
    requestId: telemetryContext?.requestId,
    tenantId,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "generation"
  }), {
    token_kind: "generation",
    token_input: tokens.input,
    token_output: tokens.output,
    token_total: tokens.total,
    token_estimated: estimated
  });
}

async function syncStorageUsageMeter(tenantId, telemetryContext, metadata) {
  if (!tenantId) return null;
  const cleanMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata }
    : null;
  const vectorDim = await resolveStorageVectorDim(tenantId, cleanMetadata);
  if (cleanMetadata) {
    cleanMetadata.vectorDim = vectorDim;
  }
  return syncTenantStorageUsage({
    tenantId,
    requestId: telemetryContext?.requestId || null,
    collection: telemetryContext?.collection || null,
    source: telemetryContext?.source || "storage_sync",
    metadata: cleanMetadata,
    recordHistory: true,
    vectorDim
  });
}

function normalizeQueuedStorageSyncMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return { ...metadata };
}

function getOrCreateQueuedStorageUsageEntry(tenantId) {
  const key = String(tenantId || "").trim();
  let entry = storageUsageSyncQueue.get(key) || null;
  if (!entry) {
    entry = {
      tenantId: key,
      timer: null,
      running: false,
      pending: false,
      count: 0,
      lastRequestId: null,
      lastCollection: null,
      lastSource: null,
      collections: new Set(),
      sources: new Set(),
      lastMetadata: null
    };
    storageUsageSyncQueue.set(key, entry);
  }
  return entry;
}

function clearQueuedStorageUsageTimer(entry) {
  if (!entry?.timer) return;
  clearTimeout(entry.timer);
  entry.timer = null;
}

function mergeQueuedStorageUsageRequest(entry, telemetryContext, metadata) {
  entry.pending = true;
  entry.count += 1;
  const requestId = String(telemetryContext?.requestId || "").trim();
  const collection = String(telemetryContext?.collection || "").trim();
  const source = String(telemetryContext?.source || "").trim();
  if (requestId) entry.lastRequestId = requestId;
  if (collection) {
    entry.lastCollection = collection;
    entry.collections.add(collection);
  }
  if (source) {
    entry.lastSource = source;
    entry.sources.add(source);
  }
  entry.lastMetadata = normalizeQueuedStorageSyncMetadata(metadata);
}

function buildQueuedStorageUsageMetadata(entry) {
  const metadata = entry.lastMetadata ? { ...entry.lastMetadata } : {};
  metadata.debounced = true;
  metadata.debounceCount = entry.count;
  if (entry.sources.size > 1) {
    metadata.sources = Array.from(entry.sources).slice(0, 8);
  }
  if (entry.collections.size > 1) {
    metadata.collections = Array.from(entry.collections).slice(0, 8);
  }
  return metadata;
}

function scheduleQueuedStorageUsageFlush(entry, delayMs = STORAGE_USAGE_SYNC_DEBOUNCE_MS) {
  clearQueuedStorageUsageTimer(entry);
  entry.timer = setTimeout(() => {
    flushQueuedStorageUsage(entry.tenantId).catch((err) => {
      console.warn(`[storage] queued usage sync failed tenant=${entry.tenantId}:`, err.message);
    });
  }, Math.max(0, delayMs));
  if (typeof entry.timer.unref === "function") entry.timer.unref();
}

async function flushQueuedStorageUsage(tenantId) {
  const entry = storageUsageSyncQueue.get(String(tenantId || "").trim());
  if (!entry) return null;
  clearQueuedStorageUsageTimer(entry);
  if (entry.running) return null;
  if (!entry.pending) {
    storageUsageSyncQueue.delete(entry.tenantId);
    return null;
  }

  entry.running = true;
  const runContext = {
    requestId: entry.lastRequestId,
    collection: entry.collections.size === 1 ? entry.lastCollection : null,
    source: entry.sources.size === 1
      ? (entry.lastSource || "storage_sync")
      : "storage_sync_debounce"
  };
  const runMetadata = buildQueuedStorageUsageMetadata(entry);
  entry.pending = false;
  entry.count = 0;
  entry.collections = new Set();
  entry.sources = new Set();
  entry.lastRequestId = null;
  entry.lastCollection = null;
  entry.lastSource = null;
  entry.lastMetadata = null;

  try {
    return await syncStorageUsageMeter(entry.tenantId, runContext, runMetadata);
  } finally {
    entry.running = false;
    if (entry.pending) {
      scheduleQueuedStorageUsageFlush(entry, 0);
    } else {
      storageUsageSyncQueue.delete(entry.tenantId);
    }
  }
}

function scheduleStorageUsageMeter(tenantId, telemetryContext, metadata) {
  if (!tenantId) return null;
  if (STORAGE_USAGE_SYNC_DEBOUNCE_MS <= 0) {
    syncStorageUsageMeter(tenantId, telemetryContext, metadata).catch((err) => {
      console.warn(`[storage] usage sync failed tenant=${tenantId}:`, err.message);
    });
    return null;
  }
  const entry = getOrCreateQueuedStorageUsageEntry(tenantId);
  mergeQueuedStorageUsageRequest(entry, telemetryContext, metadata);
  if (!entry.running) {
    scheduleQueuedStorageUsageFlush(entry);
  }
  return null;
}

function buildStorageBillingPeriodDetails(period, options = {}) {
  if (!period?.period_start || !period?.period_end) return null;
  const currentBytes = options.closed
    ? Number(period?.closing_bytes || 0)
    : Number(options.currentBytes ?? period?.closing_bytes ?? 0);
  const lastAccruedAt = options.closed
    ? (period?.closed_at || period?.period_end)
    : (options.lastAccruedAt || period?.last_event_at || period?.period_start);
  const summary = computeStoragePeriodSummary({
    periodStart: period.period_start,
    periodEnd: period.period_end,
    byteSeconds: Number(period?.storage_byte_seconds || 0),
    currentBytes,
    lastAccruedAt,
    now: options.now || new Date(),
    storagePricePerGBMonth: Number(options.storagePricePerGBMonth || 0),
    includedGBMonth: Number(options.includedGBMonth || 0)
  });
  return {
    ...summary,
    charge: options.closed ? summary.chargeToDate : summary.projectedCharge,
    closed: Boolean(options.closed),
    byteSeconds: Number(period?.storage_byte_seconds || 0),
    formulaVersion: period?.formula_version || null,
    lastEventAt: period?.last_event_at || null,
    closedAt: period?.closed_at || null,
    closingBytes: Number(period?.closing_bytes || 0),
    components: {
      chunkTextBytes: Number(period?.closing_chunk_text_bytes || 0),
      metadataBytes: Number(period?.closing_metadata_bytes || 0),
      vectorBytes: Number(period?.closing_vector_bytes || 0),
      vectorDim: Number(period?.closing_vector_dim || 0)
    }
  };
}

function buildStorageBillingSummary({
  state = null,
  currentPeriod = null,
  recentPeriods = [],
  now = new Date(),
  storagePricePerGBMonth = 0,
  includedGBMonth = 0
} = {}) {
  if (!currentPeriod && !recentPeriods.length && !state) return null;
  const current = currentPeriod
    ? buildStorageBillingPeriodDetails(currentPeriod, {
      closed: false,
      currentBytes: Number(state?.current_bytes ?? currentPeriod?.closing_bytes ?? 0),
      lastAccruedAt: state?.last_accrued_at || currentPeriod?.last_event_at || currentPeriod?.period_start,
      now,
      storagePricePerGBMonth,
      includedGBMonth
    })
    : null;
  const recent = (recentPeriods || [])
    .filter((period) => {
      if (!period?.period_start) return false;
      if (!period?.closed_at) return false;
      return !currentPeriod || period.period_start !== currentPeriod.period_start;
    })
    .slice(0, 6)
    .map((period) => buildStorageBillingPeriodDetails(period, {
      closed: true,
      now: period?.closed_at || period?.period_end || now,
      storagePricePerGBMonth,
      includedGBMonth
    }))
    .filter(Boolean);

  return {
    model: "gb_month_average",
    meterSource: "supavector",
    storagePricePerGBMonth: Number(storagePricePerGBMonth || 0),
    includedGBMonth: Number(includedGBMonth || 0),
    formulaVersion: current?.formulaVersion || state?.formula_version || recent[0]?.formulaVersion || null,
    current,
    recentPeriods: recent
  };
}

function computeUsageCosts({
  storageBytes = 0,
  storagePricePerGB = 0,
  totalAiTokens = 0,
  billableAiTokens = 0,
  aiTokenPricePer1K = 0
}) {
  const cleanStorageBytes = Number(storageBytes || 0);
  const cleanStoragePricePerGB = Number(storagePricePerGB || 0);
  const cleanTotalAiTokens = Number(totalAiTokens || 0);
  const cleanBillableAiTokens = Number(billableAiTokens || 0);
  const cleanAiTokenPricePer1K = Number(aiTokenPricePer1K || 0);
  const storageGB = cleanStorageBytes / (1024 * 1024 * 1024);
  return {
    storageBytes: cleanStorageBytes,
    storageGB,
    storageCharge: cleanStoragePricePerGB > 0 ? parseFloat((storageGB * cleanStoragePricePerGB).toFixed(6)) : 0,
    aiTokens: cleanTotalAiTokens,
    aiTokens1K: cleanTotalAiTokens / 1000,
    billableAiTokens: cleanBillableAiTokens,
    billableAiTokens1K: cleanBillableAiTokens / 1000,
    aiTokensCharge: cleanAiTokenPricePer1K > 0 ? parseFloat(((cleanBillableAiTokens / 1000) * cleanAiTokenPricePer1K).toFixed(6)) : 0
  };
}

function buildUsageHistoryEntry(row, rates = {}) {
  const eventKind = String(row?.event_kind || "");
  const embeddingTokens = Number(row?.embedding_tokens || 0);
  const generationInputTokens = Number(row?.generation_input_tokens || 0);
  const generationOutputTokens = Number(row?.generation_output_tokens || 0);
  const generationTotalTokens = Number(row?.generation_total_tokens || 0);
  const storageBytesDelta = Number(row?.storage_bytes_delta || 0);
  const storageBytesTotal = Number(row?.storage_bytes_total || 0);
  const storageChunksDelta = Number(row?.storage_chunks_delta || 0);
  const storageChunksTotal = Number(row?.storage_chunks_total || 0);
  const storageDocumentsDelta = Number(row?.storage_documents_delta || 0);
  const storageDocumentsTotal = Number(row?.storage_documents_total || 0);
  const storageMemoryItemsDelta = Number(row?.storage_memory_items_delta || 0);
  const storageMemoryItemsTotal = Number(row?.storage_memory_items_total || 0);
  const storageCollectionsDelta = Number(row?.storage_collections_delta || 0);
  const storageCollectionsTotal = Number(row?.storage_collections_total || 0);
  const storagePricePerGB = Number(rates?.storagePerGB || 0);
  const aiTokenPricePer1K = Number(rates?.aiTokensPer1K || 0);

  let charges = {
    storageCharge: 0,
    aiTokensCharge: 0
  };
  if (eventKind === "storage") {
    charges = {
      storageCharge: storagePricePerGB > 0 ? parseFloat((((storageBytesTotal / (1024 * 1024 * 1024)) * storagePricePerGB)).toFixed(6)) : 0,
      aiTokensCharge: 0
    };
  } else if (eventKind === "generation") {
    charges = {
      storageCharge: 0,
      aiTokensCharge: row?.billable === false || aiTokenPricePer1K <= 0
        ? 0
        : parseFloat((((generationTotalTokens / 1000) * aiTokenPricePer1K)).toFixed(6))
    };
  }

  return {
    id: Number(row?.id || 0),
    eventKind,
    requestId: row?.request_id || null,
    collection: row?.collection || null,
    source: row?.source || null,
    estimated: row?.estimated === true,
    billable: row?.billable !== false,
    usage: {
      embeddingTokens,
      generationInputTokens,
      generationOutputTokens,
      generationTotalTokens,
      storageBytesDelta,
      storageBytesTotal,
      storageChunksDelta,
      storageChunksTotal,
      storageDocumentsDelta,
      storageDocumentsTotal,
      storageMemoryItemsDelta,
      storageMemoryItemsTotal,
      storageCollectionsDelta,
      storageCollectionsTotal
    },
    charges,
    metadata: row?.metadata || null,
    createdAt: row?.created_at || null
  };
}

function sendOk(res, data, tenantId, collection) {
  res.json(buildOkPayload(data, tenantId, collection));
}

function sendError(res, status, message, code, tenantId, collection) {
  res.status(status).json(buildErrorPayload(message, code, tenantId, collection));
}

function escapePromLabel(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function formatPromLabels(labels) {
  const entries = Object.entries(labels || {}).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapePromLabel(v)}"`);
  return `{${parts.join(",")}}`;
}

function pushPromMetric(lines, name, labels, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  lines.push(`${name}${formatPromLabels(labels)} ${value}`);
}

function emitPromLatencySummary(lines, summary, labels) {
  if (!summary) return;
  const base = labels || {};
  const quantiles = [
    ["0.5", summary.p50_ms],
    ["0.9", summary.p90_ms],
    ["0.95", summary.p95_ms],
    ["0.99", summary.p99_ms]
  ];
  for (const [q, v] of quantiles) {
    pushPromMetric(lines, "supavector_request_latency_ms", { ...base, quantile: q }, v);
  }
  if (Number.isFinite(summary.avg_ms) && Number.isFinite(summary.count)) {
    const sum = summary.avg_ms * summary.count;
    pushPromMetric(lines, "supavector_request_latency_ms_sum", base, sum);
    pushPromMetric(lines, "supavector_request_latency_ms_count", base, summary.count);
  }
  if (Number.isFinite(summary.count)) {
    pushPromMetric(lines, "supavector_requests_total", base, summary.count);
  }
  if (Number.isFinite(summary.error_count)) {
    pushPromMetric(lines, "supavector_request_errors_total", base, summary.error_count);
  }
  if (Number.isFinite(summary.error_rate)) {
    pushPromMetric(lines, "supavector_request_error_rate", base, summary.error_rate);
  }
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function hashPayload(payload) {
  const raw = stableStringify(payload);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPositiveInt(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  const clean = Math.floor(numeric);
  if (Number.isFinite(max) && max > 0) {
    return Math.min(clean, max);
  }
  return clean;
}

function splitIntoBatches(items, size) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const batchSize = clampPositiveInt(size, items.length, 1024);
  const batches = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    batches.push(items.slice(offset, offset + batchSize));
  }
  return batches;
}

async function mapWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = clampPositiveInt(limit, 1, items.length);
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = [];
  for (let i = 0; i < concurrency; i += 1) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

function buildChunkRows(docId, chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  return chunks.map((chunk, idx) => ({
    chunkId: chunk.chunkId,
    docId,
    idx,
    text: chunk.text
  }));
}

function isVectorCommandReplyOk(reply) {
  const text = String(reply || "").trim();
  if (!text) return false;
  return !/^ERR\b/i.test(text);
}

async function runBatchedCommandSet(commands, options = {}) {
  const cleanCommands = Array.isArray(commands)
    ? commands.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (!cleanCommands.length) return [];

  const batchSize = clampPositiveInt(options.batchSize, VECTOR_WRITE_BATCH_SIZE, 1024);
  const concurrency = clampPositiveInt(options.concurrency, 1, 32);
  const runBatch = typeof options.runBatch === "function" ? options.runBatch : sendCmdBatch;
  const batches = splitIntoBatches(cleanCommands, batchSize)
    .map((batch, batchIndex) => ({ batch, offset: batchIndex * batchSize }));
  const results = new Array(cleanCommands.length);

  await mapWithConcurrency(batches, concurrency, async ({ batch, offset }) => {
    try {
      const replies = await runBatch(batch);
      for (let i = 0; i < batch.length; i += 1) {
        const reply = String(replies[i] || "");
        results[offset + i] = isVectorCommandReplyOk(reply)
          ? { ok: true, reply }
          : { ok: false, reply, error: new Error(reply || "Vector command failed") };
      }
    } catch (err) {
      for (let i = 0; i < batch.length; i += 1) {
        results[offset + i] = { ok: false, error: err };
      }
    }
  });

  return results;
}

function countFailedBatchCommands(results) {
  return Array.isArray(results)
    ? results.reduce((total, item) => total + (item?.ok ? 0 : 1), 0)
    : 0;
}

function normalizeReindexMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (["1", "true", "yes", "on", "always", "force"].includes(raw)) return "always";
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return "off";
  return "auto";
}

async function waitForVectorStore() {
  const attempts = Number.isFinite(REINDEX_TCP_ATTEMPTS) && REINDEX_TCP_ATTEMPTS > 0 ? REINDEX_TCP_ATTEMPTS : 12;
  const delayMs = Number.isFinite(REINDEX_TCP_DELAY_MS) && REINDEX_TCP_DELAY_MS >= 0 ? REINDEX_TCP_DELAY_MS : 2000;
  let lastError = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const reply = await sendCmd("PING");
      if (String(reply || "").trim() === "PONG") return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(delayMs);
  }

  if (lastError) {
    throw lastError;
  }
  return false;
}

async function getVectorCount() {
  const reply = await sendCmd("STATS");
  const stats = JSON.parse(reply);
  return Number(stats.vectors || 0);
}

async function getVectorStats() {
  const reply = await sendCmd("STATS");
  const stats = JSON.parse(reply);
  return {
    vectors: Number(stats.vectors || 0),
    vectorDims: Number(stats.vector_dims || 0)
  };
}

async function clearVectorStore() {
  await sendCmd(buildVclear());
}

function shouldReindexStoredVectors({ mode, totalChunks, vectorCount, vectorDims, expectedVectorDim }) {
  const normalizedMode = normalizeReindexMode(mode);
  if (normalizedMode === "off") {
    return { shouldReindex: false, clearFirst: false, reason: "disabled" };
  }
  if (normalizedMode === "always") {
    return { shouldReindex: true, clearFirst: vectorCount > 0, reason: "forced" };
  }

  const dimsMismatch = expectedVectorDim > 0 && vectorDims > 0 && vectorDims !== expectedVectorDim;
  const countMismatch = vectorCount !== totalChunks;
  if (vectorCount > 0 && !dimsMismatch && !countMismatch) {
    return { shouldReindex: false, clearFirst: false, reason: "up_to_date" };
  }
  if (dimsMismatch) {
    return { shouldReindex: true, clearFirst: vectorCount > 0, reason: "dimension_mismatch" };
  }
  if (countMismatch) {
    return { shouldReindex: true, clearFirst: vectorCount > 0, reason: "count_mismatch" };
  }
  return { shouldReindex: true, clearFirst: vectorCount > 0, reason: "missing_vectors" };
}

async function reindexChunkBatch(rows) {
  if (!rows.length) return;
  const texts = rows.map(r => r.text);
  const { vectors } = await embedTexts(texts);
  const commands = rows.map((row, index) => buildVset(row.chunk_id, vectors[index]));
  const results = await runBatchedCommandSet(commands, {
    batchSize: VECTOR_WRITE_BATCH_SIZE,
    concurrency: VECTOR_WRITE_BATCH_CONCURRENCY
  });
  const failed = countFailedBatchCommands(results);
  if (failed > 0) {
    throw new Error(`Failed to reindex ${failed} vector(s)`);
  }
}

async function resolveExpectedEmbedVectorDim() {
  const { vectors } = await embedTexts(["supavector vector dimension probe"]);
  const dim = Array.isArray(vectors) && vectors[0] ? Number(vectors[0].length || 0) : 0;
  return Number.isFinite(dim) && dim > 0 ? dim : 0;
}

async function reindexAllChunks() {
  const mode = normalizeReindexMode(REINDEX_MODE);
  if (mode === "off") return;

  if (!process.env.OPENAI_API_KEY) {
    console.warn("[reindex] OPENAI_API_KEY not set; skipping auto reindex.");
    return;
  }

  const totalChunks = await countChunks();
  if (!totalChunks) {
    console.log("[reindex] No stored chunks found; skipping.");
    return;
  }

  await waitForVectorStore();
  const expectedVectorDim = await resolveExpectedEmbedVectorDim();
  let decision = shouldReindexStoredVectors({
    mode,
    totalChunks,
    vectorCount: 0,
    vectorDims: 0,
    expectedVectorDim
  });

  if (mode === "auto") {
    try {
      const { vectors, vectorDims } = await getVectorStats();
      decision = shouldReindexStoredVectors({
        mode,
        totalChunks,
        vectorCount: vectors,
        vectorDims,
        expectedVectorDim
      });
      if (!decision.shouldReindex) {
        console.log(`[reindex] Vector store already has ${vectors} vectors with dim ${vectorDims}; skipping auto reindex.`);
        return;
      }
      if (decision.reason === "dimension_mismatch") {
        console.log(`[reindex] Vector dimension mismatch detected (store=${vectorDims}, expected=${expectedVectorDim}); rebuilding vectors.`);
      } else if (decision.reason === "count_mismatch") {
        console.log(`[reindex] Vector count mismatch detected (store=${vectors}, chunks=${totalChunks}); rebuilding vectors.`);
      }
    } catch (err) {
      console.warn("[reindex] Failed to read vector stats; continuing with reindex.");
      decision = { shouldReindex: true, clearFirst: true, reason: "stats_unavailable" };
    }
  }

  const batchSize = Number.isFinite(REINDEX_BATCH_SIZE) && REINDEX_BATCH_SIZE > 0 ? REINDEX_BATCH_SIZE : 64;
  const fetchSize = Number.isFinite(REINDEX_FETCH_SIZE) && REINDEX_FETCH_SIZE > 0 ? REINDEX_FETCH_SIZE : 256;
  const logEvery = Number.isFinite(REINDEX_LOG_EVERY) && REINDEX_LOG_EVERY > 0 ? REINDEX_LOG_EVERY : 500;
  const sleepMs = Number.isFinite(REINDEX_SLEEP_MS) && REINDEX_SLEEP_MS > 0 ? REINDEX_SLEEP_MS : 0;

  if (decision.clearFirst) {
    console.log("[reindex] Clearing vector store before rebuild...");
    await clearVectorStore();
  }

  console.log(`[reindex] Starting reindex of ${totalChunks} chunks...`);
  let processed = 0;
  let lastId = null;
  let buffer = [];

  while (true) {
    const rows = await listChunksAfter({ afterId: lastId, limit: fetchSize });
    if (!rows.length) break;

    for (const row of rows) {
      buffer.push(row);
      if (buffer.length >= batchSize) {
        await reindexChunkBatch(buffer);
        processed += buffer.length;
        buffer = [];
        if (processed % logEvery === 0 || processed >= totalChunks) {
          console.log(`[reindex] Progress ${processed}/${totalChunks} chunks`);
        }
        if (sleepMs) {
          await sleep(sleepMs);
        }
      }
    }
    lastId = rows[rows.length - 1].chunk_id;
  }

  if (buffer.length) {
    await reindexChunkBatch(buffer);
    processed += buffer.length;
  }

  console.log(`[reindex] Completed: ${processed}/${totalChunks} chunks indexed.`);
}

function scheduleAutoReindex() {
  if (reindexStarted) return;
  reindexStarted = true;
  setTimeout(() => {
    reindexAllChunks().catch((err) => {
      console.warn("[reindex] Failed:", err?.message || err);
    });
  }, 1500);
}

async function runTtlSweepOnce() {
  if (ttlSweepRunning) return;
  ttlSweepRunning = true;
  const batchSize = Number.isFinite(TTL_SWEEP_BATCH_SIZE) && TTL_SWEEP_BATCH_SIZE > 0 ? TTL_SWEEP_BATCH_SIZE : 200;
  let totalDeleted = 0;
  let vectorsDeleted = 0;
  let vectorFailures = 0;
  let queuedDeletes = 0;
  const cutoff = new Date();
  try {
    while (true) {
      const items = await listExpiredMemoryItemsGlobal({ before: cutoff, limit: batchSize });
      if (!items.length) break;
      let batchDeleted = 0;
      for (const item of items) {
        const result = await deleteMemoryItemFully(item, { reason: "ttl_sweep" });
        if (result?.deleted) {
          vectorsDeleted += result.vectorsDeleted || 0;
          totalDeleted += 1;
          batchDeleted += 1;
        } else if (result?.failed) {
          vectorFailures += result.failed;
        }
        if (result?.queued) {
          queuedDeletes += 1;
        }
      }
      if (batchDeleted === 0) break;
      if (items.length < batchSize) break;
    }
    if (totalDeleted || vectorFailures || queuedDeletes) {
      console.log(`[ttl] sweep deleted=${totalDeleted} vectors=${vectorsDeleted} failures=${vectorFailures} queuedDeletes=${queuedDeletes}`);
    }
  } catch (err) {
    console.warn("[ttl] sweep failed:", err?.message || err);
  } finally {
    ttlSweepRunning = false;
  }
}

function scheduleTtlSweep() {
  if (!TTL_SWEEP_ENABLED) return;
  if (!Number.isFinite(TTL_SWEEP_INTERVAL_MS) || TTL_SWEEP_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runTtlSweepOnce().catch(() => {});
    setInterval(() => {
      runTtlSweepOnce().catch(() => {});
    }, TTL_SWEEP_INTERVAL_MS);
  }, 2000);
}

async function runStorageBillingAccrualSweepOnce() {
  if (storageBillingAccrualRunning) return;
  storageBillingAccrualRunning = true;
  const startedAt = new Date();
  let processed = 0;
  try {
    let afterTenantId = null;
    while (true) {
      const tenantIds = await listTenantIdsWithStorageBillingState({
        afterTenantId,
        limit: 100
      });
      if (!tenantIds.length) break;
      for (const tenantId of tenantIds) {
        try {
          await accrueTenantStorageBillingState({ tenantId, now: startedAt });
          processed += 1;
        } catch (err) {
          console.warn(`[billing] storage accrual failed tenant=${tenantId}:`, err?.message || err);
        }
      }
      afterTenantId = tenantIds[tenantIds.length - 1];
      if (tenantIds.length < 100) break;
    }
    if (processed > 0) {
      console.log(`[billing] storage accrual updated=${processed}`);
    }
  } finally {
    storageBillingAccrualRunning = false;
  }
}

function scheduleStorageBillingAccrualSweep() {
  if (!Number.isFinite(STORAGE_BILLING_ACCRUAL_INTERVAL_MS) || STORAGE_BILLING_ACCRUAL_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runStorageBillingAccrualSweepOnce().catch(() => {});
    setInterval(() => {
      runStorageBillingAccrualSweepOnce().catch(() => {});
    }, STORAGE_BILLING_ACCRUAL_INTERVAL_MS);
  }, 2500);
}

async function sweepDueMemoryJobs() {
  if (jobSweepRunning) return;
  jobSweepRunning = true;
  const batchSize = Number.isFinite(JOB_SWEEP_BATCH_SIZE) && JOB_SWEEP_BATCH_SIZE > 0 ? JOB_SWEEP_BATCH_SIZE : 20;
  try {
    const jobs = await listDueMemoryJobs({ limit: batchSize });
    for (const job of jobs) {
      await dispatchMemoryJob(job.id, job.tenant_id, job.job_type);
    }
  } catch (err) {
    console.warn("[jobs] sweep failed:", err?.message || err);
  } finally {
    jobSweepRunning = false;
  }
}

function scheduleJobSweep() {
  if (!Number.isFinite(JOB_SWEEP_INTERVAL_MS) || JOB_SWEEP_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    sweepDueMemoryJobs().catch(() => {});
    setInterval(() => {
      sweepDueMemoryJobs().catch(() => {});
    }, JOB_SWEEP_INTERVAL_MS);
  }, 1500);
}

function extractIdempotencyKey(req) {
  const headerKey = req.header("Idempotency-Key");
  const bodyKey = req.body?.idempotencyKey;
  const key = String(headerKey || bodyKey || "").trim();
  return key || null;
}

function normalizeIdempotencyBody(body, tenantId, collection, principalId) {
  if (!body || typeof body !== "object") return body;
  const copy = Array.isArray(body) ? body.slice() : { ...body };
  delete copy.idempotencyKey;
  delete copy.tenantID;
  delete copy.principal_id;
  if (tenantId && copy.tenantId === undefined) {
    copy.tenantId = tenantId;
  }
  if (collection && copy.collection === undefined) {
    copy.collection = collection;
  }
  if (principalId && copy.principalId === undefined) {
    copy.principalId = principalId;
  }
  return copy;
}

async function handleIdempotentRequest({ req, res, tenantId, collection, principalId, endpoint, payloadForHash, handler }) {
  const key = extractIdempotencyKey(req);
  if (!key) {
    const payload = buildErrorPayload("Idempotency-Key is required", "IDEMPOTENCY_KEY_REQUIRED", tenantId, collection);
    return res.status(400).json(payload);
  }
  if (key.length > 200) {
    const payload = buildErrorPayload("Idempotency-Key too long", "IDEMPOTENCY_KEY_INVALID", tenantId, collection);
    return res.status(400).json(payload);
  }

  const normalized = normalizeIdempotencyBody(payloadForHash ?? req.body, tenantId, collection, principalId);
  const requestHash = hashPayload(normalized);

  const { inserted, record } = await beginIdempotencyKey({
    tenantId,
    endpoint,
    idempotencyKey: key,
    requestHash
  });

  if (!inserted && record) {
    if (record.request_hash && record.request_hash !== requestHash) {
      const payload = buildErrorPayload("Idempotency-Key already used with a different payload", "IDEMPOTENCY_KEY_REUSED", tenantId, collection);
      return res.status(409).json(payload);
    }

    if (record.status === "completed" && record.response_body) {
      const status = record.response_status || 200;
      return res.status(status).json(record.response_body);
    }

    const ttlMs = parseInt(process.env.IDEMPOTENCY_TTL_MS || "300000", 10);
    const updatedAt = record.updated_at ? new Date(record.updated_at).getTime() : 0;
    const ageMs = Date.now() - updatedAt;
    if (record.status === "in_progress" && ttlMs > 0 && ageMs < ttlMs) {
      const payload = buildErrorPayload("Request already in progress", "IDEMPOTENCY_IN_PROGRESS", tenantId, collection);
      return res.status(409).json(payload);
    }

    await touchIdempotencyKey({ tenantId, endpoint, idempotencyKey: key });
  }

  const { status, payload } = await handler();
  await completeIdempotencyKey({
    tenantId,
    endpoint,
    idempotencyKey: key,
    responseStatus: status,
    responseBody: payload
  });
  return res.status(status).json(payload);
}

function parseDocFilter(raw) {
  if (!raw) return [];
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    list = raw.split(",");
  } else {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item || "").trim();
    if (!clean || !isValidDocId(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function parseAnswerLength(raw) {
  if (raw === undefined || raw === null || raw === "") return "auto";
  const clean = String(raw).trim().toLowerCase();
  if (clean === "auto" || clean === "short" || clean === "medium" || clean === "long") {
    return clean;
  }
  return null;
}

function parseCitationMode(raw) {
  if (raw === undefined || raw === null || raw === "") return "inline";
  const clean = String(raw).trim().toLowerCase();
  if (clean === "inline" || clean === "metadata") {
    return clean;
  }
  return null;
}

function parseQuestionInput(input = {}) {
  return String(input?.question ?? input?.query ?? input?.q ?? "").trim();
}

function parseOptionalBooleanFlag(raw, label = "value") {
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === true || raw === false) return raw;
  const clean = String(raw).trim().toLowerCase();
  if (!clean || clean === "auto" || clean === "default") return null;
  if (clean === "true" || clean === "1" || clean === "yes" || clean === "on") return true;
  if (clean === "false" || clean === "0" || clean === "no" || clean === "off") return false;
  throw new Error(`${label} must be true, false, or auto`);
}

function resolveRequestedFavorRecency(input, fallback = null) {
  if (!input || typeof input !== "object") return fallback;
  if (Object.prototype.hasOwnProperty.call(input, "favorRecency")) {
    return parseOptionalBooleanFlag(input.favorRecency, "favorRecency");
  }
  if (Object.prototype.hasOwnProperty.call(input, "favor_recency")) {
    return parseOptionalBooleanFlag(input.favor_recency, "favorRecency");
  }
  return fallback;
}

function parseStringListInput(raw, { maxItems = 16, maxItemLength = 240, label = "value" } = {}) {
  if (raw === undefined || raw === null || raw === "") return [];
  let values = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "string") {
    values = raw.split(/[\n,]+/);
  } else {
    throw new Error(`${label} must be a string or array`);
  }

  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = parseOptionalString(value, { label, max: maxItemLength });
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseNamespaceFilter(raw) {
  const values = parseStringListInput(raw, {
    label: "namespaceIds",
    maxItems: 64,
    maxItemLength: 320
  });
  const out = [];
  for (const value of values) {
    if (!/^[a-z0-9._:@-]+$/i.test(value)) {
      throw new Error("namespaceIds contain unsupported characters");
    }
    out.push(value);
  }
  return out;
}

function parseSourceTypeFilter(raw) {
  const values = parseStringListInput(raw, {
    label: "sourceTypes",
    maxItems: 24,
    maxItemLength: 80
  });
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = normalizeDocumentSourceType(value, "");
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function parseDocumentTypeFilter(raw) {
  const values = parseStringListInput(raw, {
    label: "documentTypes",
    maxItems: 24,
    maxItemLength: 80
  });
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean) continue;
    if (!/^[a-z0-9._:/-]+$/i.test(clean)) {
      throw new Error("documentTypes contain unsupported characters");
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function parseRetrievalFilterInput(input = {}) {
  const rawNamespaceIds = input?.namespaceIds
    ?? input?.namespace_ids
    ?? input?.namespaceId
    ?? input?.namespace_id
    ?? input?.namespace;
  const rawSourceTypes = input?.sourceTypes
    ?? input?.source_types
    ?? input?.sourceType
    ?? input?.source_type
    ?? input?.source;
  const rawDocumentTypes = input?.documentTypes
    ?? input?.document_types
    ?? input?.documentType
    ?? input?.document_type
    ?? input?.docTypes
    ?? input?.doc_types
    ?? input?.docType
    ?? input?.doc_type;
  const rawTimeField = input?.timeField
    ?? input?.time_field
    ?? input?.timeRangeField
    ?? input?.time_range_field;
  return {
    namespaceIds: parseNamespaceFilter(rawNamespaceIds),
    tags: parseTagsInput(input?.tags),
    agentId: normalizeAgentId(input?.agentId ?? input?.agent_id),
    sourceTypes: parseSourceTypeFilter(rawSourceTypes),
    documentTypes: parseDocumentTypeFilter(rawDocumentTypes),
    since: parseTimeInput(input?.since, "since"),
    until: parseTimeInput(input?.until, "until"),
    timeField: normalizeRetrievalTimeField(rawTimeField, "created_at")
  };
}

function parseCodeRepositoryInput(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const name = parseOptionalString(raw, { label: "repository", max: 240 });
    return name ? { name, branch: null } : null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("repository must be a string or object");
  }
  const name = parseOptionalString(raw?.name ?? raw?.repo ?? raw?.repository ?? raw?.url, {
    label: "repository.name",
    max: 240
  });
  const branch = parseOptionalString(raw?.branch ?? raw?.ref, {
    label: "repository.branch",
    max: 120
  });
  if (!name && !branch) return null;
  if (!name) throw new Error("repository.name is required");
  return {
    name,
    branch: branch || null
  };
}

function parseCodeContextInput(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const notes = parseOptionalString(raw, { label: "context", max: 4000 });
    return notes ? { notes } : null;
  }
  return parseTenantMetadataInput(raw);
}

function parseCodeInput(body = {}) {
  const retrievalFilters = parseRetrievalFilterInput(body);
  return {
    question: parseQuestionInput(body),
    k: parseInt(body?.k || "5", 10),
    docIds: parseDocFilter(body?.docIds ?? body?.doc_ids),
    namespaceIds: retrievalFilters.namespaceIds,
    answerLength: parseAnswerLength(body?.answerLength || body?.responseLength),
    citationMode: parseCitationMode(body?.citationMode ?? body?.citation_mode),
    task: normalizeCodeTask(body?.task ?? body?.mode, "general"),
    language: parseOptionalString(body?.language ?? body?.lang, { label: "language", max: 80 }),
    deployment: parseOptionalString(body?.deployment, { label: "deployment", max: 120 }),
    paths: parseStringListInput(body?.paths ?? body?.path ?? body?.filePaths ?? body?.file_paths ?? body?.files, {
      label: "paths",
      maxItems: 20,
      maxItemLength: 320
    }),
    constraints: parseStringListInput(body?.constraints ?? body?.constraint, {
      label: "constraints",
      maxItems: 20,
      maxItemLength: 240
    }),
    repository: parseCodeRepositoryInput(body?.repository ?? body?.repo),
    errorMessage: parseOptionalString(body?.errorMessage ?? body?.error_message ?? body?.error, {
      label: "errorMessage",
      max: 2000
    }),
    stackTrace: parseOptionalString(body?.stackTrace ?? body?.stack_trace, {
      label: "stackTrace",
      max: 8000
    }),
    context: parseCodeContextInput(body?.context),
    provider: resolveAskProviderOverride(body),
    model: resolveAskModelOverride(body),
    policy: resolveRequestedMemoryPolicy(body),
    favorRecency: resolveRequestedFavorRecency(body),
    tags: retrievalFilters.tags,
    agentId: retrievalFilters.agentId,
    sourceTypes: retrievalFilters.sourceTypes,
    documentTypes: retrievalFilters.documentTypes,
    since: retrievalFilters.since,
    until: retrievalFilters.until,
    timeField: retrievalFilters.timeField
  };
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeTier(tier, fallback = "WARM") {
  const clean = String(tier || "").trim().toUpperCase();
  if (clean === "HOT" || clean === "WARM" || clean === "COLD") return clean;
  return fallback;
}

function resolveTierThresholds(policy = DEFAULT_MEMORY_POLICY) {
  const config = typeof policy === "object" && policy !== null
    ? policy
    : resolveMemoryPolicyConfig(policy);
  const hotUp = clampNumber(config.tierHotUp, 0, 1);
  let hotDown = clampNumber(config.tierHotDown, 0, 1);
  if (hotDown >= hotUp) {
    hotDown = Math.max(0, hotUp - 0.01);
  }

  const warmUp = clampNumber(config.tierWarmUp, 0, 1);
  let warmDown = clampNumber(config.tierWarmDown, 0, 1);
  if (warmDown >= warmUp) {
    warmDown = Math.max(0, warmUp - 0.01);
  }

  let evict = clampNumber(config.tierEvict, 0, 1);
  if (evict > warmDown) {
    evict = warmDown;
  }

  return { hotUp, hotDown, warmUp, warmDown, evict };
}

const MEMORY_TIER_THRESHOLDS = resolveTierThresholds();

function resolveInitialValueScore(policy = DEFAULT_MEMORY_POLICY) {
  const config = typeof policy === "object" && policy !== null
    ? policy
    : resolveMemoryPolicyConfig(policy);
  const thresholds = resolveTierThresholds(config);
  const warmFloor = thresholds.warmUp;
  const hotCeil = Math.max(warmFloor, thresholds.hotUp - 1e-6);
  return clampNumber(config.initValue, warmFloor, hotCeil);
}

function decayMemoryValue(currentValue, lastUpdateTs, nowTs, policy = DEFAULT_MEMORY_POLICY) {
  const config = typeof policy === "object" && policy !== null
    ? policy
    : resolveMemoryPolicyConfig(policy);
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  const last = Number.isFinite(lastUpdateTs) ? lastUpdateTs : now;
  const dtDays = Math.max(0, now - last) / 86400000;
  const lambda = Number.isFinite(config.valueDecayLambda) && config.valueDecayLambda >= 0
    ? config.valueDecayLambda
    : 0;
  return currentValue * Math.exp(-lambda * dtDays);
}

function resolveTierForValue(currentTier, valueScore, pinned, policy = DEFAULT_MEMORY_POLICY) {
  const config = typeof policy === "object" && policy !== null
    ? policy
    : resolveMemoryPolicyConfig(policy);
  const thresholds = resolveTierThresholds(config);
  const tier = normalizeTier(currentTier, "WARM");
  const value = clampNumber(valueScore, 0, Math.max(0, config.valueMax));
  if (tier === "HOT") {
    if (!pinned && value < thresholds.hotDown) return "WARM";
    return "HOT";
  }
  if (tier === "WARM") {
    if (value >= thresholds.hotUp) return "HOT";
    if (!pinned && value < thresholds.warmDown) return "COLD";
    return "WARM";
  }
  if (value >= thresholds.warmUp) return "WARM";
  return "COLD";
}

function tierRank(tier) {
  const clean = normalizeTier(tier, "WARM");
  if (clean === "HOT") return 2;
  if (clean === "WARM") return 1;
  return 0;
}

function emitTierTransitionTelemetry(item, fromTier, toTier, details = {}, context = {}) {
  const from = normalizeTier(fromTier, "WARM");
  const to = normalizeTier(toTier, from);
  if (from === to) return;
  const action = tierRank(to) > tierRank(from) ? "promote" : "demote";
  emitLifecycleActionTelemetry(action, item, {
    from_tier: from,
    to_tier: to,
    ...details
  }, {
    source: context.source || "tier_transition",
    requestId: context.requestId || null
  });
}

function buildChunkingOptions() {
  const maxChars = Number.isFinite(CHUNK_MAX_CHARS) && CHUNK_MAX_CHARS > 0 ? CHUNK_MAX_CHARS : 900;
  const maxTokens = Number.isFinite(CHUNK_MAX_TOKENS) && CHUNK_MAX_TOKENS > 0 ? CHUNK_MAX_TOKENS : 220;
  const rawOverlap = Number.isFinite(CHUNK_OVERLAP_TOKENS) && CHUNK_OVERLAP_TOKENS >= 0 ? CHUNK_OVERLAP_TOKENS : 40;
  const overlapTokens = Math.max(0, Math.min(rawOverlap, Math.max(0, maxTokens - 1)));
  return {
    strategy: CHUNK_STRATEGY,
    maxChars,
    maxTokens,
    overlapTokens
  };
}

function buildCodeChunkingOptions() {
  const maxChars = Number.isFinite(CHUNK_MAX_CHARS) && CHUNK_MAX_CHARS > 0 ? CHUNK_MAX_CHARS : 900;
  const maxTokens = Number.isFinite(CODE_CHUNK_MAX_TOKENS) && CODE_CHUNK_MAX_TOKENS > 0 ? CODE_CHUNK_MAX_TOKENS : 360;
  const rawOverlap = Number.isFinite(CODE_CHUNK_OVERLAP_TOKENS) && CODE_CHUNK_OVERLAP_TOKENS >= 0 ? CODE_CHUNK_OVERLAP_TOKENS : 72;
  const overlapTokens = Math.max(0, Math.min(rawOverlap, Math.max(0, maxTokens - 1)));
  return {
    strategy: "code",
    maxChars,
    maxTokens,
    overlapTokens
  };
}

const CHUNKING_OPTIONS = buildChunkingOptions();
const CODE_CHUNKING_OPTIONS = buildCodeChunkingOptions();

function resolveChunkingOptionsForSource(source = {}) {
  return normalizeDocumentSourceType(source?.type, "text") === "code"
    ? CODE_CHUNKING_OPTIONS
    : CHUNKING_OPTIONS;
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  const map = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };

  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    const lower = code.toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const num = parseInt(isHex ? lower.slice(2) : lower.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(num)) return m;
      try {
        return String.fromCodePoint(num);
      } catch {
        return m;
      }
    }
    return map[lower] ?? m;
  });
}

function extractTextFromHtml(html) {
  let out = String(html || "");
  out = out.replace(/<script[\s\S]*?<\/script>/gi, " ");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, " ");
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  out = out.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr|td|th|blockquote)>/gi, "\n");
  out = out.replace(/<li[^>]*>/gi, "- ");
  out = out.replace(/<[^>]+>/g, " ");
  out = decodeHtmlEntities(out);
  return out;
}

function readLocalDocsCorpusEntry({ id, title, routePath, filePath }) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const text = normalizeWhitespace(extractTextFromHtml(raw));
    if (!text) return null;
    return {
      id,
      title,
      routePath,
      text,
      textLower: text.toLowerCase(),
      titleLower: String(title || "").toLowerCase()
    };
  } catch (err) {
    console.warn(`[mcp] failed to read docs corpus entry ${id}:`, err?.message || err);
    return null;
  }
}

function buildMcpDocsCorpus() {
  const entries = [
    readLocalDocsCorpusEntry({
      id: "guide",
      title: "SupaVector Integration Guide",
      routePath: "/#pageDocsTop",
      filePath: path.join(UI_PARTIALS_DIR, "page-docs.html")
    }),
    readLocalDocsCorpusEntry({
      id: "api-reference",
      title: "SupaVector API Reference",
      routePath: "/docs",
      filePath: path.join(PUBLIC_DIR, "docs", "index.html")
    })
  ].filter(Boolean);

  if (entries.length === 0) {
    console.warn("[mcp] docs corpus is empty; /mcp search will return no matches.");
  }
  return entries;
}

const MCP_DOCS_CORPUS = buildMcpDocsCorpus();

function getMcpDocUrl(req, routePath) {
  const cleanPath = String(routePath || "/").trim() || "/";
  try {
    return new URL(cleanPath, `${resolvePublicBaseUrl(req)}/`).toString();
  } catch {
    return cleanPath;
  }
}

function scoreMcpDocCandidate(queryLower, queryTokens, doc) {
  if (!queryLower || !doc) return 0;
  const overlap = computeTokenOverlapScore(queryTokens, doc.textLower);
  const exact = doc.textLower.includes(queryLower) ? 0.55 : 0;
  const titleBoost = queryTokens.some((token) => token.length >= 3 && doc.titleLower.includes(token)) ? 0.2 : 0;
  return overlap + exact + titleBoost;
}

function buildMcpExcerpt(text, queryTokens, maxChars = 340) {
  const clean = normalizeWhitespace(text);
  if (!clean) return "";

  const lower = clean.toLowerCase();
  let hit = -1;
  for (const token of queryTokens) {
    if (!token || token.length < 3) continue;
    const index = lower.indexOf(token);
    if (index >= 0 && (hit === -1 || index < hit)) {
      hit = index;
    }
  }

  if (hit < 0) {
    return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars)}...`;
  }

  const start = Math.max(0, hit - Math.floor(maxChars / 3));
  const end = Math.min(clean.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

function searchMcpDocs(query, topK = 4) {
  const queryText = normalizeWhitespace(query).toLowerCase();
  if (!queryText) return [];

  const queryTokens = tokenizeForRerank(queryText);
  const limit = clampNumber(topK, 1, 8);

  return MCP_DOCS_CORPUS
    .map((doc) => ({
      doc,
      score: scoreMcpDocCandidate(queryText, queryTokens, doc)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({
      id: item.doc.id,
      title: item.doc.title,
      routePath: item.doc.routePath,
      score: Number(item.score.toFixed(4)),
      excerpt: buildMcpExcerpt(item.doc.text, queryTokens)
    }));
}

function findMcpResourceByUri(rawUri) {
  const uri = String(rawUri || "").trim();
  if (!uri.startsWith(MCP_RESOURCE_URI_PREFIX)) return null;
  const id = uri.slice(MCP_RESOURCE_URI_PREFIX.length);
  if (!id) return null;
  return MCP_DOCS_CORPUS.find((item) => item.id === id) || null;
}

function listMcpResources(req) {
  return MCP_DOCS_CORPUS.map((doc) => ({
    uri: `${MCP_RESOURCE_URI_PREFIX}${doc.id}`,
    name: doc.title,
    description: `SupaVector documentation resource: ${doc.title}`,
    mimeType: "text/plain",
    annotations: {
      url: getMcpDocUrl(req, doc.routePath)
    }
  }));
}

function listMcpTools() {
  return [
    {
      name: "search_docs",
      description: "Search SupaVector documentation for setup, APIs, auth, memory policy modes (amvl/ttl/lru), and lifecycle details.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language query for SupaVector docs." },
          top_k: { type: "integer", minimum: 1, maximum: 8, description: "Number of top results to return." }
        },
        required: ["query"]
      }
    },
    {
      name: "read_docs_page",
      description: "Read a full SupaVector docs resource by page id or resource URI.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Known page id: guide or api-reference." },
          uri: { type: "string", description: "Resource URI from resources/list." }
        }
      }
    }
  ];
}

function handleMcpToolCall(params, req) {
  const name = String(params?.name || "").trim();
  const args = (params && typeof params.arguments === "object" && params.arguments !== null)
    ? params.arguments
    : {};

  if (name === "search_docs") {
    const query = normalizeWhitespace(args.query || "");
    if (!query) {
      return {
        isError: true,
        content: [{ type: "text", text: "Missing required argument: query" }]
      };
    }

    const results = searchMcpDocs(query, args.top_k);
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No SupaVector docs matches found for: ${query}` }],
        structuredContent: { query, matches: [] }
      };
    }

    const lines = results.map((item, index) => {
      const url = getMcpDocUrl(req, item.routePath);
      return [
        `${index + 1}. ${item.title}`,
        `URL: ${url}`,
        `Score: ${item.score}`,
        `Excerpt: ${item.excerpt}`
      ].join("\n");
    }).join("\n\n");

    return {
      content: [{ type: "text", text: lines }],
      structuredContent: {
        query,
        matches: results.map((item) => ({
          id: item.id,
          title: item.title,
          url: getMcpDocUrl(req, item.routePath),
          score: item.score,
          excerpt: item.excerpt
        }))
      }
    };
  }

  if (name === "read_docs_page") {
    const uri = String(args.uri || "").trim();
    const pageId = String(args.page_id || "").trim();
    let resource = null;
    if (uri) {
      resource = findMcpResourceByUri(uri);
    } else if (pageId) {
      resource = MCP_DOCS_CORPUS.find((item) => item.id === pageId) || null;
    }

    if (!resource) {
      return {
        isError: true,
        content: [{ type: "text", text: "Unknown page. Use resources/list or pass page_id: guide or api-reference." }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          `${resource.title}`,
          `URL: ${getMcpDocUrl(req, resource.routePath)}`,
          "",
          resource.text
        ].join("\n")
      }],
      structuredContent: {
        id: resource.id,
        title: resource.title,
        url: getMcpDocUrl(req, resource.routePath)
      }
    };
  }

  throw { code: -32602, message: `Unknown tool: ${name}` };
}

async function handleMcpMethod(method, params, req) {
  const cleanMethod = String(method || "").trim();
  const cleanParams = (params && typeof params === "object" && !Array.isArray(params)) ? params : {};

  if (cleanMethod === "initialize") {
    return {
      protocolVersion: String(cleanParams.protocolVersion || MCP_PROTOCOL_VERSION),
      capabilities: {
        tools: {},
        resources: {}
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION
      },
      instructions: [
        "Use tools/search_docs to find SupaVector API and product guidance.",
        "Use resources/list and resources/read to access full docs pages.",
        "Memory policy values are amvl, ttl, and lru; amvl is the default when policy is omitted.",
        "For /v1/ask, answer length can be controlled with answerLength: auto, short, medium, or long.",
        "Use /v1/boolean_ask when you need a strict true, false, or invalid response."
      ].join(" ")
    };
  }

  if (cleanMethod === "ping") {
    return { ok: true, timestamp: new Date().toISOString() };
  }

  if (cleanMethod === "tools/list") {
    return { tools: listMcpTools() };
  }

  if (cleanMethod === "tools/call") {
    return handleMcpToolCall(cleanParams, req);
  }

  if (cleanMethod === "resources/list") {
    return { resources: listMcpResources(req) };
  }

  if (cleanMethod === "resources/read") {
    const uri = String(cleanParams.uri || "").trim();
    const resource = findMcpResourceByUri(uri);
    if (!resource) {
      throw { code: -32602, message: `Unknown resource URI: ${uri || "(empty)"}` };
    }
    return {
      contents: [{
        uri: `${MCP_RESOURCE_URI_PREFIX}${resource.id}`,
        mimeType: "text/plain",
        text: [
          `${resource.title}`,
          `URL: ${getMcpDocUrl(req, resource.routePath)}`,
          "",
          resource.text
        ].join("\n")
      }]
    };
  }

  if (cleanMethod === "notifications/initialized") {
    return { ok: true };
  }

  throw { code: -32601, message: `Method not found: ${cleanMethod}` };
}

function createJsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function createJsonRpcError(id, code, message, data) {
  const payload = {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: {
      code: Number.isInteger(code) ? code : -32603,
      message: String(message || "Internal error")
    }
  };
  if (data !== undefined) {
    payload.error.data = data;
  }
  return payload;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase();

  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (net.isIP(host)) {
    return isPrivateIpAddress(host);
  }
  return false;
}

function isPrivateIpAddress(address) {
  const clean = String(address || "").toLowerCase();
  const ipType = net.isIP(clean);
  if (!ipType) return true;

  if (ipType === 4) {
    const parts = clean.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }

  if (clean === "::1" || clean === "::") return true;
  if (clean.startsWith("fe80:")) return true;
  if (clean.startsWith("fc") || clean.startsWith("fd")) return true;
  return false;
}

async function assertPublicDnsHost(hostname) {
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("URL host resolution failed.");
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("URL host resolution failed.");
  }
  for (const record of records) {
    const ip = String(record?.address || "").trim();
    if (!ip) {
      throw new Error("URL host resolution failed.");
    }
    if (isPrivateIpAddress(ip)) {
      throw new Error("URL host resolves to a blocked address.");
    }
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Fetch timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextWithCap(response, capChars) {
  const cap = Number.isFinite(capChars) && capChars > 0 ? capChars : MAX_FETCH_CHARS;
  if (!response.body || typeof response.body.getReader !== "function") {
    let raw = await response.text();
    let truncated = false;
    if (raw.length > cap) {
      raw = raw.slice(0, cap);
      truncated = true;
    }
    return { raw, truncated };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.length > cap) {
      raw = raw.slice(0, cap);
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  raw += decoder.decode();
  return { raw, truncated };
}

function normalizeUrlFetchValidators(validators = null) {
  if (!validators || typeof validators !== "object" || Array.isArray(validators)) {
    return null;
  }
  const etag = String(validators.etag || "").trim();
  const lastModified = String(
    validators.lastModified
    ?? validators.last_modified
    ?? ""
  ).trim();
  if (!etag && !lastModified) return null;
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {})
  };
}

async function fetchUrlText(rawUrl, options = {}) {
  const deps = options.deps && typeof options.deps === "object" ? options.deps : {};
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http/https URLs are supported.");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error("URL host is blocked for safety.");
  }

  const headers = {
    "User-Agent": FETCH_USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8"
  };
  const validators = normalizeUrlFetchValidators(options.validators);
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  const fetchImpl = deps.fetchWithTimeout || fetchWithTimeout;
  const assertPublicDnsHostImpl = deps.assertPublicDnsHost || assertPublicDnsHost;
  const readResponseTextWithCapImpl = deps.readResponseTextWithCap || readResponseTextWithCap;
  const extractTextFromHtmlImpl = deps.extractTextFromHtml || extractTextFromHtml;
  const safeTimeout = Number.isFinite(FETCH_TIMEOUT_MS) && FETCH_TIMEOUT_MS > 0 ? FETCH_TIMEOUT_MS : 15000;
  const safeMaxRedirects = Number.isFinite(MAX_FETCH_REDIRECTS) && MAX_FETCH_REDIRECTS >= 0
    ? MAX_FETCH_REDIRECTS
    : 5;
  let current = url;

  for (let redirectCount = 0; redirectCount <= safeMaxRedirects; redirectCount += 1) {
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new Error("Only http/https URLs are supported.");
    }
    if (isPrivateHostname(current.hostname)) {
      throw new Error("URL host is blocked for safety.");
    }
    await assertPublicDnsHostImpl(current.hostname);

    const res = await fetchImpl(current.toString(), {
      redirect: "manual",
      headers
    }, safeTimeout);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect missing location header.");
      }
      if (redirectCount >= safeMaxRedirects) {
        throw new Error("Too many redirects.");
      }
      current = new URL(location, current);
      continue;
    }

    if (res.status === 304) {
      return {
        notModified: true,
        finalUrl: current.toString(),
        contentType: null,
        truncated: false,
        etag: res.headers.get("etag") || validators?.etag || null,
        lastModified: res.headers.get("last-modified") || validators?.lastModified || null
      };
    }

    if (!res.ok) {
      throw new Error(`Fetch failed with ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    const { raw, truncated } = await readResponseTextWithCapImpl(res, MAX_FETCH_CHARS);

    let text;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
      text = extractTextFromHtmlImpl(raw);
    } else if (contentType.startsWith("text/") || contentType.includes("application/json") || contentType.includes("application/xml")) {
      text = raw;
    } else {
      throw new Error(`Unsupported content-type: ${contentType || "unknown"}`);
    }

    text = normalizeWhitespace(text);
    if (!text.trim()) {
      throw new Error("No extractable text found at URL.");
    }

    return {
      text,
      contentType,
      truncated,
      finalUrl: current.toString(),
      etag: res.headers.get("etag") || null,
      lastModified: res.headers.get("last-modified") || null,
      notModified: false
    };
  }

  throw new Error("Too many redirects.");
}

async function indexDocument(tenantId, collection, docId, text, source, options = {}) {
  const startAt = Date.now();
  let cleanText = String(text || "");
  cleanText = cleanText.trim();
  if (!cleanText) {
    throw new Error("text produced no chunks");
  }

  const namespacedDocId = namespaceDocId(tenantId, collection, docId);
  const sourceType = normalizeDocumentSourceType(source?.type, "text");
  const sourceMetadata = sourceType === "code"
    ? enrichCodeSourceMetadata(source, cleanText, docId)
    : (source?.metadata || null);
  const principalId = source?.principalId || null;
  const resolvedVisibility = normalizeVisibility(source?.visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(source?.acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    throw new Error("acl list is required when visibility is acl");
  }

  const artifact = await upsertMemoryArtifact({
    tenantId,
    collection,
    externalId: docId,
    namespaceId: namespacedDocId,
    title: source?.title || docId,
    sourceType,
    sourceUrl: source?.url || null,
    metadata: sourceMetadata,
    expiresAt: source?.expiresAt || null,
    principalId,
    agentId: source?.agentId || null,
    tags: source?.tags || null,
    visibility: resolvedVisibility,
    acl: aclList
  });
  const activeNamespaceId = artifact?.namespace_id || namespacedDocId;

  let truncated = false;
  if (cleanText.length > MAX_DOC_CHARS) {
    cleanText = cleanText.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }

  logIndex(`start tenant=${tenantId} collection=${collection} docId=${docId} chars=${cleanText.length} truncated=${truncated}`);

  const chunks = chunkText(activeNamespaceId, cleanText, resolveChunkingOptionsForSource({ type: sourceType }));
  if (chunks.length === 0) {
    throw new Error("text produced no chunks");
  }

  logIndex(`chunked collection=${collection} docId=${docId} chunks=${chunks.length}`);

  const texts = chunks.map(c => c.text);
  const embedStart = Date.now();
  const effectiveModels = options?.models || await getEffectiveTenantModels(tenantId);
  const { vectors, usage } = await embedTexts(texts, {
    apiKey: options?.apiKey,
    embedProvider: options?.embedProvider || effectiveModels.embedProvider,
    embedModel: options?.embedModel || effectiveModels.embedModel,
    taskType: "RETRIEVAL_DOCUMENT"
  });
  recordEmbeddingUsage(tenantId, usage, buildTelemetryContext({
    requestId: options?.telemetry?.requestId,
    tenantId,
    collection,
    source: options?.telemetry?.source || "document_index"
  }));
  logIndex(`embedded collection=${collection} docId=${docId} vectors=${vectors.length} ms=${Date.now() - embedStart}`);

  const cleanup = await deleteVectorsForDoc(activeNamespaceId, { strict: true });
  if (cleanup.failed > 0) {
    throw new Error(`Failed to replace existing vectors for doc ${docId}`);
  }
  const chunkRows = buildChunkRows(activeNamespaceId, chunks);

  await saveChunks(chunkRows, { batchSize: CHUNK_UPSERT_BATCH_SIZE });

  const vsetStart = Date.now();
  const vectorResults = await runBatchedCommandSet(
    chunkRows.map((row, index) => buildVset(row.chunkId, vectors[index])),
    {
      batchSize: VECTOR_WRITE_BATCH_SIZE,
      concurrency: VECTOR_WRITE_BATCH_CONCURRENCY
    }
  );
  const failedWrites = countFailedBatchCommands(vectorResults);
  if (failedWrites > 0) {
    throw new Error(`Failed to store ${failedWrites} vector(s) for doc ${docId}`);
  }
  if (DEBUG_INDEX) {
    logIndex(`vset ${chunks.length}/${chunks.length} docId=${docId} ms=${Date.now() - vsetStart}`);
  }

  scheduleStorageUsageMeter(tenantId, buildTelemetryContext({
    requestId: options?.telemetry?.requestId,
    tenantId,
    collection,
    source: options?.telemetry?.source || "document_index"
  }), {
    operation: "document_index",
    docId,
    chunksIndexed: chunks.length,
    truncated,
    embedProvider: options?.embedProvider || effectiveModels.embedProvider,
    embedModel: options?.embedModel || effectiveModels.embedModel
  });
  logIndex(`done tenant=${tenantId} collection=${collection} docId=${docId} chunks=${chunks.length} totalMs=${Date.now() - startAt}`);
  return { chunksIndexed: chunks.length, truncated };
}

async function listDocsForTenant(tenantId, collection, principalId, privileges) {
  const rows = await listDocsByTenant(tenantId, principalId, privileges);
  const docs = [];
  for (const row of rows) {
    const parsed = parseNamespacedDocId(row.doc_id);
    if (!parsed || parsed.tenantId !== tenantId) continue;
    if (collection && parsed.collection !== collection) continue;
    docs.push({
      docId: parsed.docId,
      collection: parsed.collection,
      chunks: Number(row.chunks || 0)
    });
  }
  return docs;
}

function sampleItems(items, size) {
  const list = Array.isArray(items) ? items.slice() : [];
  const k = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  if (!k || list.length <= k) return list;
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list.slice(0, k);
}

function recencyTimestampMs(memory) {
  const lastUsed = memory?.last_used_at ? new Date(memory.last_used_at).getTime() : NaN;
  if (Number.isFinite(lastUsed)) return lastUsed;
  const created = memory?.created_at ? new Date(memory.created_at).getTime() : NaN;
  if (Number.isFinite(created)) return created;
  return 0;
}

function computeMemoryRetrievalRecencyScore(memory, now = Date.now(), halfLifeDays = MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS) {
  const freshnessTs = memoryFreshnessTimestampMs(memory);
  if (!Number.isFinite(freshnessTs) || freshnessTs <= 0) return 0;
  return computeRecencyDecay(
    null,
    new Date(freshnessTs),
    new Date(now),
    Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS
  );
}

function selectWarmCandidates(items, size, selection = MEMORY_RETRIEVAL_WARM_SELECTION) {
  const list = Array.isArray(items) ? items.slice() : [];
  const k = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  const requestedMode = String(selection || "").trim().toLowerCase();
  const sampleMode = requestedMode === "lru"
    ? "lru"
    : (requestedMode === "freshness" ? "freshness" : "random");
  const rankByRecency = sampleMode === "lru";
  const rankByFreshness = sampleMode === "freshness";
  const sortBySelectedRecency = (a, b) => {
    const diff = rankByFreshness
      ? (memoryFreshnessTimestampMs(b) - memoryFreshnessTimestampMs(a))
      : (recencyTimestampMs(b) - recencyTimestampMs(a));
    if (diff !== 0) return diff;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  };
  if (!k || list.length <= k) {
    if (!rankByRecency && !rankByFreshness) return list;
    return list.sort(sortBySelectedRecency);
  }
  if (rankByRecency || rankByFreshness) {
    list.sort(sortBySelectedRecency);
    return list.slice(0, k);
  }
  return sampleItems(list, k);
}

async function getTierBoundedRetrievalSet({
  tenantId,
  collection,
  principalId,
  privileges,
  namespaceIds,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  types,
  since,
  until,
  timeField = "created_at",
  preferFreshnessOrdering = false,
  warmSampleSize,
  docIds,
  policy
}) {
  const policyConfig = resolveMemoryPolicyConfig(policy);
  const warmK = Number.isFinite(warmSampleSize) && warmSampleSize > 0
    ? Math.floor(warmSampleSize)
    : (Number.isFinite(policyConfig.retrievalWarmSampleK) && policyConfig.retrievalWarmSampleK > 0 ? policyConfig.retrievalWarmSampleK : 8);
  const typeFilter = Array.isArray(types) && types.length ? types : null;
  const directNamespaceIds = Array.isArray(namespaceIds) && namespaceIds.length
    ? namespaceIds
    : (Array.isArray(docIds) && docIds.length && collection ? docIds.map((docId) => namespaceDocId(tenantId, collection, docId)) : []);
  const directExternalIds = Array.isArray(docIds) && docIds.length && !directNamespaceIds.length ? docIds : [];
  const warmSelectionMode = preferFreshnessOrdering ? "freshness" : policyConfig.retrievalWarmSelection;

  if (directNamespaceIds.length || directExternalIds.length) {
    const hot = await listMemoryItemsByTier({
      tenantId,
      collection,
      namespaceIds: directNamespaceIds.length ? directNamespaceIds : null,
      externalIds: directExternalIds.length ? directExternalIds : null,
      tier: "HOT",
      types: typeFilter,
      sourceTypes,
      documentTypes,
      since,
      until,
      timeField,
      excludeExpired: true,
      principalId,
      privileges,
      agentId,
      tags,
      sample: preferFreshnessOrdering ? "freshness" : null
    });
    const warm = await listMemoryItemsByTier({
      tenantId,
      collection,
      namespaceIds: directNamespaceIds.length ? directNamespaceIds : null,
      externalIds: directExternalIds.length ? directExternalIds : null,
      tier: "WARM",
      types: typeFilter,
      sourceTypes,
      documentTypes,
      since,
      until,
      timeField,
      excludeExpired: true,
      principalId,
      privileges,
      agentId,
      tags,
      sample: warmSelectionMode
    });
    const sampledWarm = selectWarmCandidates(warm, warmK, warmSelectionMode);
    return {
      hot,
      warm: sampledWarm,
      cold: [],
      hotCount: hot.length,
      warmCount: sampledWarm.length,
      coldCandidates: 0
    };
  }

  const baseFilters = {
    tenantId,
    collection,
    namespaceIds: null,
    externalIds: Array.isArray(docIds) && docIds.length ? docIds : null,
    types: typeFilter,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    excludeExpired: true,
    principalId,
    privileges,
    agentId,
    tags
  };
  const hot = await listMemoryItemsByTier({
    ...baseFilters,
    tier: "HOT",
    sample: preferFreshnessOrdering ? "freshness" : null
  });
  const warmPoolMultiplier = Number.isFinite(policyConfig.retrievalWarmSamplePoolMultiplier)
    ? Math.max(1, Math.floor(policyConfig.retrievalWarmSamplePoolMultiplier))
    : 4;
  const warmPoolLimit = warmSelectionMode === "lru"
    ? warmK
    : warmK * warmPoolMultiplier;
  const warmPool = await listMemoryItemsByTier({
    ...baseFilters,
    tier: "WARM",
    limit: warmPoolLimit,
    sample: warmSelectionMode
  });
  const warm = selectWarmCandidates(warmPool, warmK, warmSelectionMode);
  const coldProbe = Number.isFinite(policyConfig.retrievalColdProbeEpsilon) && policyConfig.retrievalColdProbeEpsilon > 0
    ? await listMemoryItemsByTier({
      ...baseFilters,
      tier: "COLD",
      limit: policyConfig.retrievalColdProbeEpsilon * warmPoolMultiplier,
      sample: preferFreshnessOrdering ? "freshness" : null
    })
    : [];
  const sampledColdProbe = sampleItems(coldProbe, policyConfig.retrievalColdProbeEpsilon);

  return {
    hot,
    warm,
    cold: sampledColdProbe,
    hotCount: hot.length,
    warmCount: warm.length,
    coldCandidates: sampledColdProbe.length
  };
}

async function searchChunks({
  tenantId,
  collection,
  query,
  k,
  docIds,
  namespaceIds,
  principalId,
  privileges,
  enforceArtifactVisibility,
  telemetry,
  candidateTypes,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  policy,
  favorRecency,
  apiKey,
  embedProvider,
  embedModel
}) {
  const telemetryContext = buildTelemetryContext({
    requestId: telemetry?.requestId,
    tenantId,
    collection,
    source: telemetry?.source || "search_query"
  });
  const policyConfig = resolveMemoryPolicyConfig(policy);
  const effectiveModels = (embedModel || embedProvider)
    ? {
        embedProvider: embedProvider || DEFAULT_EMBED_PROVIDER,
        embedModel: embedModel || DEFAULT_EMBED_MODEL
      }
    : await getEffectiveTenantModels(tenantId);
  const { vectors: [qvec], usage } = await embedTexts([query], {
    apiKey,
    embedProvider: effectiveModels.embedProvider,
    embedModel: effectiveModels.embedModel,
    taskType: "RETRIEVAL_QUERY"
  });
  recordEmbeddingUsage(tenantId, usage, telemetryContext);

  const cleanDocIds = Array.isArray(docIds) ? docIds : [];
  const cleanNamespaceIds = Array.isArray(namespaceIds) ? namespaceIds : [];
  const topK = Number.isFinite(k) && k > 0 ? k : 5;
  const retrievalPlan = buildRetrievalPlan({
    query,
    explicitFavorRecency: favorRecency,
    candidateTypes,
    timeField,
    queryRecencyAutoEnabled: RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED
  });
  const retrievalFilters = {
    collection,
    docIds: cleanDocIds,
    namespaceIds: cleanNamespaceIds,
    tags: Array.isArray(tags) ? tags : [],
    agentId: agentId || null,
    sourceTypes: Array.isArray(sourceTypes) ? sourceTypes : [],
    documentTypes: Array.isArray(documentTypes) ? documentTypes : [],
    since: since || null,
    until: until || null,
    timeField: retrievalPlan.timeField
  };
  const retrievalSet = await getTierBoundedRetrievalSet({
    tenantId,
    collection,
    principalId,
    privileges,
    namespaceIds: cleanNamespaceIds,
    tags,
    agentId,
    sourceTypes,
    documentTypes,
    types: Array.isArray(candidateTypes) ? candidateTypes : null,
    since,
    until,
    timeField: retrievalPlan.timeField,
    preferFreshnessOrdering: retrievalPlan.preferFreshnessOrdering,
    warmSampleSize: Math.max(topK, Number.isFinite(policyConfig.retrievalWarmSampleK) ? policyConfig.retrievalWarmSampleK : 0),
    docIds: cleanDocIds,
    policy: policyConfig.policy
  });
  if (policyConfig.retrievalColdProbeEpsilon <= 0 && (retrievalSet.coldCandidates || 0) !== 0) {
    throw new Error("retrieval invariant violated: cold candidates present with cold probe disabled");
  }
  const retrievalMemories = [
    ...(retrievalSet.hot || []),
    ...(retrievalSet.warm || []),
    ...(retrievalSet.cold || [])
  ];
  const memoryByNamespaceId = new Map();
  for (const memory of retrievalMemories) {
    if (memory?.namespace_id) {
      memoryByNamespaceId.set(memory.namespace_id, memory);
    }
  }
  const warmSampleBudget = Math.max(topK, Number.isFinite(policyConfig.retrievalWarmSampleK) ? policyConfig.retrievalWarmSampleK : 0);
  const seenNamespaceIds = new Set();
  const candidateNamespaceIds = [];
  for (const memory of retrievalMemories) {
    const namespaceId = memory?.namespace_id;
    if (!namespaceId || seenNamespaceIds.has(namespaceId)) continue;
    seenNamespaceIds.add(namespaceId);
    candidateNamespaceIds.push(namespaceId);
  }

  if (!candidateNamespaceIds.length) {
    emitTelemetry("memory_candidates", telemetryContext, {
      hot_count: retrievalSet.hotCount || 0,
      warm_count: retrievalSet.warmCount || 0,
      warm_sampled: retrievalSet.warmCount || 0,
      cold_count: retrievalSet.coldCandidates || 0,
      cold_candidates: retrievalSet.coldCandidates || 0,
      candidate_set_size_R: 0,
      retrieval_set_size: 0,
      retrieval_bound: (retrievalSet.hotCount || 0) + warmSampleBudget,
      vectors_scanned: 0,
      vector_search_scanned_count: 0
    });
    return [];
  }

  const candidateChunks = await getChunksByDocIds(candidateNamespaceIds);
  const candidateChunkIds = candidateChunks.map((row) => row.chunk_id).filter(Boolean);
  const denseChunkMap = new Map();
  for (const row of candidateChunks) {
    denseChunkMap.set(row.chunk_id, row);
  }
  const vectorSearchScannedCount = candidateChunkIds.length;
  if (!vectorSearchScannedCount) {
    emitTelemetry("memory_candidates", telemetryContext, {
      hot_count: retrievalSet.hotCount || 0,
      warm_count: retrievalSet.warmCount || 0,
      warm_sampled: retrievalSet.warmCount || 0,
      cold_count: retrievalSet.coldCandidates || 0,
      cold_candidates: retrievalSet.coldCandidates || 0,
      candidate_set_size_R: candidateNamespaceIds.length,
      retrieval_set_size: candidateNamespaceIds.length,
      vectors_scanned: 0,
      vector_search_scanned_count: 0
    });
    return [];
  }

  emitTelemetry("memory_candidates", telemetryContext, {
    hot_count: retrievalSet.hotCount || 0,
    warm_count: retrievalSet.warmCount || 0,
    warm_sampled: retrievalSet.warmCount || 0,
    cold_count: retrievalSet.coldCandidates || 0,
    cold_candidates: retrievalSet.coldCandidates || 0,
    candidate_set_size_R: candidateNamespaceIds.length,
    retrieval_set_size: candidateNamespaceIds.length,
    retrieval_bound: (retrievalSet.hotCount || 0) + warmSampleBudget,
    vectors_scanned: vectorSearchScannedCount,
    vector_search_scanned_count: vectorSearchScannedCount
  });
  if (candidateNamespaceIds.length > ((retrievalSet.hotCount || 0) + warmSampleBudget + (retrievalSet.coldCandidates || 0))) {
    console.warn(`[memory_candidates] retrieval bound exceeded set=${candidateNamespaceIds.length} hot=${retrievalSet.hotCount || 0} warm_budget=${warmSampleBudget}`);
  }
  if ((retrievalSet.coldCandidates || 0) > 0 && policyConfig.retrievalColdProbeEpsilon <= 0) {
    console.warn(`[memory_candidates] cold candidates should be zero; got=${retrievalSet.coldCandidates}`);
  }

  const multiplier = Number.isFinite(TENANT_SEARCH_MULTIPLIER) && TENANT_SEARCH_MULTIPLIER > 0 ? TENANT_SEARCH_MULTIPLIER : 5;
  const cap = Number.isFinite(TENANT_SEARCH_CAP) && TENANT_SEARCH_CAP > 0 ? TENANT_SEARCH_CAP : 50;
  const hasDocFilter = cleanDocIds.length > 0;
  const internalK = Math.min(topK * multiplier * (hasDocFilter ? 2 : 1), cap);
  const scopedK = Math.max(1, Math.min(internalK, vectorSearchScannedCount));
  const cmd = buildVsearchIn(scopedK, qvec, candidateChunkIds);
  const line = await sendCmd(cmd);

  const denseMatches = parseVsearchReply(line);
  const docFilter = hasDocFilter ? new Set(cleanDocIds) : null;
  const namespacedDocIds = candidateNamespaceIds;

  const lexicalMultiplier = Number.isFinite(HYBRID_LEXICAL_MULTIPLIER) && HYBRID_LEXICAL_MULTIPLIER > 0
    ? HYBRID_LEXICAL_MULTIPLIER
    : 2;
  const lexicalCap = Number.isFinite(HYBRID_LEXICAL_CAP) && HYBRID_LEXICAL_CAP > 0
    ? HYBRID_LEXICAL_CAP
    : 120;
  const lexicalK = Math.min(topK * lexicalMultiplier, lexicalCap);

  let lexicalRows = [];
  if (HYBRID_RETRIEVAL_ENABLED && lexicalK > 0) {
    try {
      lexicalRows = await searchChunksLexical({
        tenantId,
        collection,
        query,
        limit: lexicalK,
        namespacedDocIds
      });
    } catch (err) {
      console.warn("[search] lexical retrieval failed:", err?.message || err);
    }
  }

  const candidates = new Map();
  function addCandidate(row, vectorScore, lexicalScore, vectorRank, lexicalRank) {
    if (!row?.chunk_id || !row?.doc_id) return;
    const parsed = parseNamespacedDocId(row.doc_id);
    if (!parsed || parsed.tenantId !== tenantId) return;
    if (collection && parsed.collection !== collection) return;
    if (docFilter && !docFilter.has(parsed.docId)) return;

    const key = row.chunk_id;
    const existing = candidates.get(key) || {
      row,
      parsed,
      memory: null,
      vectorScore: null,
      lexicalScore: null,
      vectorRank: null,
      lexicalRank: null
    };
    existing.memory = memoryByNamespaceId.get(row.doc_id) || existing.memory;
    if (!matchesRetrievalFilters(existing, retrievalFilters)) return;
    existing.row = row;
    existing.parsed = parsed;
    if (Number.isFinite(vectorScore)) {
      existing.vectorScore = Number.isFinite(existing.vectorScore)
        ? Math.max(existing.vectorScore, vectorScore)
        : vectorScore;
    }
    if (Number.isFinite(vectorRank)) {
      existing.vectorRank = Number.isFinite(existing.vectorRank)
        ? Math.min(existing.vectorRank, vectorRank)
        : vectorRank;
    }
    if (Number.isFinite(lexicalScore)) {
      existing.lexicalScore = Number.isFinite(existing.lexicalScore)
        ? Math.max(existing.lexicalScore, lexicalScore)
        : lexicalScore;
    }
    if (Number.isFinite(lexicalRank)) {
      existing.lexicalRank = Number.isFinite(existing.lexicalRank)
        ? Math.min(existing.lexicalRank, lexicalRank)
        : lexicalRank;
    }
    candidates.set(key, existing);
  }

  for (let index = 0; index < denseMatches.length; index += 1) {
    const match = denseMatches[index];
    const row = denseChunkMap.get(match.id);
    if (!row) continue;
    addCandidate(row, match.score, null, index + 1, null);
  }
  for (let index = 0; index < lexicalRows.length; index += 1) {
    const row = lexicalRows[index];
    addCandidate(row, null, Number(row.lexical_score), null, index + 1);
  }

  const useHybrid = HYBRID_RETRIEVAL_ENABLED;
  const ranked = rankSearchCandidates(Array.from(candidates.values()), {
    query,
    useHybrid,
    fusionMode: HYBRID_FUSION_MODE,
    vectorWeight: HYBRID_VECTOR_WEIGHT,
    lexicalWeight: HYBRID_LEXICAL_WEIGHT,
    rankConstant: HYBRID_RRF_K,
    overlapBoostScale: HYBRID_RERANK_OVERLAP_BOOST,
    exactBoostScale: HYBRID_RERANK_EXACT_BOOST,
    favorRecency: retrievalPlan.effectiveFavorRecency,
    candidateTypes,
    recencyWeight: MEMORY_RETRIEVAL_RECENCY_WEIGHT,
    recencyHalfLifeDays: MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS,
    determineRecencyBoostMode,
    computeMemoryRetrievalRecencyScore
  });

  const results = ranked.slice(0, topK).map((candidate) => ({
    chunkId: stripChunkNamespace(candidate.row.chunk_id),
    score: candidate.finalScore,
    docId: candidate.parsed.docId,
    collection: candidate.parsed.collection,
    preview: buildSearchPreview(candidate.row.text, query, 180),
    _row: candidate.row
  }));

  if (enforceArtifactVisibility && (principalId || (privileges && privileges.length))) {
    const namespaceIds = results.map(r => r._row.doc_id);
    const artifactMap = await getMemoryItemsByNamespaceIds({
      tenantId,
      collection,
      namespaceIds,
      types: ["artifact"],
      excludeExpired: true,
      principalId,
      privileges
    });
    return results.filter(r => artifactMap.has(r._row.doc_id));
  }

  return results;
}

function normalizeCodeMetadataString(value, max = 320) {
  const clean = String(value || "").trim();
  if (!clean) return null;
  return clean.slice(0, max);
}

function extractCodeMemoryMetadata(memory) {
  const metadata = memory?.metadata && typeof memory.metadata === "object" && !Array.isArray(memory.metadata)
    ? memory.metadata
    : {};
  return {
    sourceType: normalizeCodeMetadataString(memory?.source_type, 80)?.toLowerCase() || null,
    repo: normalizeCodeMetadataString(metadata.repo ?? metadata.repository),
    branch: normalizeCodeMetadataString(metadata.branch ?? metadata.ref, 120),
    path: normalizeCodeMetadataString(metadata.path ?? metadata.filePath ?? metadata.file_path ?? memory?.title),
    language: normalizeCodeMetadataString(metadata.language ?? metadata.lang, 80)?.toLowerCase() || null,
    sourceUrl: normalizeCodeMetadataString(memory?.source_url ?? metadata.sourceUrl ?? metadata.source_url, 4000),
    title: normalizeCodeMetadataString(memory?.title, 240),
    functions: normalizeCodeMetadataList(metadata.functions, { maxItems: 28 }),
    classes: normalizeCodeMetadataList(metadata.classes, { maxItems: 20 }),
    exports: normalizeCodeMetadataList(metadata.exports, { maxItems: 20 }),
    imports: normalizeCodeMetadataList(metadata.imports, { maxItems: 20, maxItemLength: 160 }),
    modules: normalizeCodeMetadataList(metadata.modules, { maxItems: 20, maxItemLength: 160 }),
    calls: normalizeCodeMetadataList(metadata.calls, { maxItems: 28 }),
    routes: normalizeCodeMetadataList(metadata.routes, { maxItems: 16, maxItemLength: 200 }),
    envVars: normalizeCodeMetadataList(metadata.envVars ?? metadata.env_vars, { maxItems: 12, maxItemLength: 120 }),
    testTargets: normalizeCodeMetadataList(metadata.testTargets ?? metadata.test_targets, { maxItems: 10, maxItemLength: 200 }),
    scripts: normalizeCodeMetadataList(metadata.scripts, { maxItems: 12, maxItemLength: 120 }),
    services: normalizeCodeMetadataList(metadata.services, { maxItems: 10, maxItemLength: 120 }),
    workflowJobs: normalizeCodeMetadataList(metadata.workflowJobs ?? metadata.workflow_jobs, { maxItems: 10, maxItemLength: 120 }),
    workspacePackages: normalizeCodeMetadataList(metadata.workspacePackages ?? metadata.workspace_packages, { maxItems: 10, maxItemLength: 200 }),
    importedSymbols: normalizeCodeMetadataList(metadata.importedSymbols ?? metadata.imported_symbols, { maxItems: 28, maxItemLength: 200 }),
    reexports: normalizeCodeMetadataList(metadata.reexports, { maxItems: 20, maxItemLength: 160 }),
    definedSymbols: normalizeCodeMetadataList(metadata.definedSymbols ?? metadata.defined_symbols, { maxItems: 40, maxItemLength: 120 }),
    referencedSymbols: normalizeCodeMetadataList(metadata.referencedSymbols ?? metadata.referenced_symbols, { maxItems: 48, maxItemLength: 120 }),
    packageName: normalizeCodeMetadataString(metadata.packageName ?? metadata.package_name, 160),
    configKinds: normalizeCodeMetadataList(metadata.configKinds ?? metadata.config_kinds, { maxItems: 8, maxItemLength: 80 }),
    isTestFile: Boolean(metadata.isTestFile ?? metadata.is_test_file),
    isConfigFile: Boolean(metadata.isConfigFile ?? metadata.is_config_file),
    isEntrypoint: Boolean(metadata.isEntrypoint ?? metadata.is_entrypoint),
    metadata
  };
}

function buildCodeRetrievalQuery(question, input = {}) {
  const parts = [String(question || "").trim()];
  const sessionFocus = buildCodeSessionFocus(input);
  const lowerQuestion = [
    question,
    input?.errorMessage,
    input?.stackTrace,
    Array.isArray(input?.constraints) ? input.constraints.join(" ") : ""
  ].filter(Boolean).join(" ").toLowerCase();
  if (input?.task && input.task !== "general") parts.push(`task ${input.task}`);
  if (input?.language) parts.push(`language ${input.language}`);
  if (input?.deployment) parts.push(`deployment ${input.deployment}`);
  if (input?.repository?.name) parts.push(`repository ${input.repository.name}`);
  if (Array.isArray(input?.paths) && input.paths.length) parts.push(`paths ${input.paths.join(" ")}`);
  if (sessionFocus.repositories.length) parts.push(`working set repositories ${sessionFocus.repositories.join(" ")}`);
  if (sessionFocus.files.length) parts.push(`working set files ${sessionFocus.files.join(" ")}`);
  if (sessionFocus.languages.length) parts.push(`working set languages ${sessionFocus.languages.join(" ")}`);
  if (sessionFocus.symbols.length) parts.push(`working set symbols ${sessionFocus.symbols.join(" ")}`);
  if (sessionFocus.recentQuestions.length) parts.push(`recent code questions ${sessionFocus.recentQuestions.join(" || ")}`);
  const hintPaths = extractCodePathHints([
    question,
    input?.errorMessage,
    input?.stackTrace,
    Array.isArray(input?.paths) ? input.paths.join(" ") : "",
    sessionFocus.files.join(" ")
  ]);
  if (hintPaths.length) parts.push(`file hints ${hintPaths.join(" ")}`);
  const identifierHints = buildCodeIdentifierHints([
    question,
    input?.errorMessage,
    input?.stackTrace,
    Array.isArray(input?.paths) ? input.paths.join(" ") : "",
    Array.isArray(input?.constraints) ? input.constraints.join(" ") : "",
    sessionFocus.symbols.join(" "),
    input?.context && typeof input.context === "object" ? JSON.stringify(input.context) : ""
  ]);
  if (identifierHints.length) parts.push(`identifiers ${identifierHints.join(" ")}`);
  if (/\b(test|tests|spec|specs|coverage|fixture|mock|integration test|unit test|e2e)\b/.test(lowerQuestion)) {
    parts.push("focus tests specs coverage fixtures mocks");
  }
  if (/\b(config|configuration|env|environment|secret|secrets|deploy|deployment|docker|compose|workflow|ci|github actions|runtime|startup|bootstrap|build)\b/.test(lowerQuestion)) {
    parts.push("focus config runtime env docker workflow build");
  }
  if (/\b(package|packages|workspace|workspaces|monorepo|dependency|dependencies|module boundary|package boundary|turbo|lerna|pnpm|nx)\b/.test(lowerQuestion)) {
    parts.push("focus packages workspaces dependencies monorepo");
  }
  if (/\b(entry ?point|startup|boot|bootstrap|server start|app start|worker|cli)\b/.test(lowerQuestion)) {
    parts.push("focus entrypoints startup worker cli");
  }
  if (input?.errorMessage) parts.push(`error ${input.errorMessage}`);
  if (input?.stackTrace) parts.push(String(input.stackTrace).slice(0, 1200));
  // For debug: extract file/function identifiers from stack trace for better retrieval
  if (input?.task === "debug" && input?.stackTrace) {
    const trace = String(input.stackTrace).slice(0, 2000);
    const fileParts = [];
    for (const match of trace.matchAll(/(?:at\s+\S+\s+\(|at\s+)([\w./\\-]+\.\w+):\d+/g)) {
      const filePath = match[1];
      if (filePath && !fileParts.includes(filePath)) fileParts.push(filePath);
      if (fileParts.length >= 4) break;
    }
    if (fileParts.length) parts.push(`files ${fileParts.join(" ")}`);
    const fnParts = [];
    for (const match of trace.matchAll(/at\s+([\w$.<>]+)\s+\(/g)) {
      const fn = match[1];
      if (fn && fn !== "async" && fn !== "Object" && !fnParts.includes(fn)) fnParts.push(fn);
      if (fnParts.length >= 3) break;
    }
    if (fnParts.length) parts.push(`functions ${fnParts.join(" ")}`);
  }
  return parts.filter(Boolean).join("\n");
}

function extractCodePathHints(values) {
  const seen = new Set();
  const hints = [];
  const pattern = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9_.-]{1,12})/g;
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || "");
    for (const match of text.matchAll(pattern)) {
      const raw = String(match[0] || "").trim();
      if (!raw || raw.length < 3) continue;
      if (!/[A-Za-z]/.test(raw)) continue;
      const clean = raw.replace(/^["'`(]+|[)"'`,:;]+$/g, "");
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      hints.push(clean);
      if (hints.length >= 6) return hints;
    }
  }
  return hints;
}

function includesLower(haystack, needle) {
  const left = String(haystack || "").trim().toLowerCase();
  const right = String(needle || "").trim().toLowerCase();
  if (!left || !right) return false;
  return left.includes(right);
}

function buildCodeIdentifierHints(values) {
  const seen = new Set();
  const hints = [];
  const stopwords = new Set([
    "what", "where", "which", "when", "with", "does", "that", "this", "from", "into", "about", "through",
    "function", "functions", "class", "classes", "module", "modules", "file", "files", "repo", "repository",
    "debug", "write", "review", "improve", "structure", "connect", "connected", "connection", "calls", "called",
    "route", "routes", "handler", "handlers", "service", "services", "code", "stack", "trace", "error"
  ]);

  function pushHint(raw) {
    const clean = String(raw || "").trim().replace(/^["'`(]+|[)"'`,.:;]+$/g, "");
    if (!clean || clean.length < 3 || clean.length > 120) return;
    const lower = clean.toLowerCase();
    if (stopwords.has(lower) || seen.has(lower)) return;
    if (!/[A-Za-z]/.test(clean) || /^\d+$/.test(clean)) return;
    seen.add(lower);
    hints.push(clean);
  }

  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || "");
    for (const match of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g)) {
      const token = match[0];
      if (/[A-Z]/.test(token.slice(1)) || /_/.test(token) || /^[A-Z][A-Za-z0-9_$]+$/.test(token)) {
        pushHint(token);
      }
    }
    for (const match of text.matchAll(/at\s+([\w$.<>]+)\s+\(/g)) {
      const token = String(match[1] || "").split(".").pop();
      pushHint(token);
    }
  }

  return hints.slice(0, 10);
}

function normalizeCodeSessionContext(context = null) {
  const session = context && typeof context === "object" && !Array.isArray(context)
    ? context.codeSession
    : null;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return {
      currentTask: null,
      workingSet: {
        files: [],
        repositories: [],
        languages: [],
        symbols: []
      },
      recentTurns: []
    };
  }
  const workingSet = session.workingSet && typeof session.workingSet === "object" && !Array.isArray(session.workingSet)
    ? session.workingSet
    : {};
  const recentTurns = Array.isArray(session.recentTurns) ? session.recentTurns : [];
  return {
    currentTask: parseOptionalString(session.currentTask, { label: "context.codeSession.currentTask", max: 80 }),
    workingSet: {
      files: normalizeCodeMetadataList(workingSet.files, { maxItems: 14, maxItemLength: 320 }),
      repositories: normalizeCodeMetadataList(workingSet.repositories, { maxItems: 6, maxItemLength: 240 }),
      languages: normalizeCodeMetadataList(workingSet.languages, { maxItems: 6, maxItemLength: 80 }),
      symbols: normalizeCodeMetadataList(workingSet.symbols, { maxItems: 24, maxItemLength: 120 })
    },
    recentTurns: recentTurns.map((turn) => {
      const clean = turn && typeof turn === "object" && !Array.isArray(turn) ? turn : {};
      return {
        question: parseOptionalString(clean.question, { label: "context.codeSession.recentTurns.question", max: 280 }),
        task: normalizeCodeTask(clean.task, "general"),
        paths: normalizeCodeMetadataList(clean.paths, { maxItems: 12, maxItemLength: 320 }),
        files: normalizeCodeMetadataList(clean.files, { maxItems: 12, maxItemLength: 320 }),
        repositories: normalizeCodeMetadataList(clean.repositories, { maxItems: 6, maxItemLength: 240 }),
        languages: normalizeCodeMetadataList(clean.languages, { maxItems: 6, maxItemLength: 80 }),
        symbols: normalizeCodeMetadataList(clean.symbols, { maxItems: 18, maxItemLength: 120 }),
        answerSummary: parseOptionalString(clean.answerSummary, { label: "context.codeSession.recentTurns.answerSummary", max: 420 })
      };
    }).filter((turn) => turn.question || turn.answerSummary).slice(-6)
  };
}

function buildCodeSessionFocus(input = {}) {
  const session = normalizeCodeSessionContext(input?.context);
  const files = [...session.workingSet.files];
  const repositories = [...session.workingSet.repositories];
  const languages = [...session.workingSet.languages];
  const symbols = [...session.workingSet.symbols];
  const recentQuestions = [];
  for (const turn of session.recentTurns) {
    for (const filePath of turn.paths) pushUniqueCodeValue(files, filePath, 14, 320);
    for (const filePath of turn.files) pushUniqueCodeValue(files, filePath, 14, 320);
    for (const repo of turn.repositories) pushUniqueCodeValue(repositories, repo, 6, 240);
    for (const language of turn.languages) pushUniqueCodeValue(languages, language, 6, 80);
    for (const symbol of turn.symbols) pushUniqueCodeValue(symbols, symbol, 24, 120);
    if (turn.question) pushUniqueCodeValue(recentQuestions, turn.question, 5, 280);
  }
  return {
    currentTask: session.currentTask,
    files,
    repositories,
    languages,
    symbols,
    recentQuestions,
    recentTurns: session.recentTurns
  };
}

function metadataListIncludesHint(values, hint) {
  const cleanHint = String(hint || "").trim().toLowerCase();
  if (!cleanHint) return false;
  return normalizeCodeMetadataList(values, { maxItems: 40, maxItemLength: 200 })
    .some((value) => {
      const clean = String(value || "").trim().toLowerCase();
      return clean === cleanHint || clean.endsWith(`.${cleanHint}`) || clean.includes(cleanHint);
    });
}

function isConnectionFocusedCodeQuestion(question, input = {}) {
  const combined = [
    question,
    input?.errorMessage,
    input?.stackTrace,
    Array.isArray(input?.paths) ? input.paths.join(" ") : ""
  ].filter(Boolean).join(" ").toLowerCase();
  if (!combined) return false;
  return /\b(connect|connection|connected|flow|call graph|caller|callee|calls|called by|invoke|invoked|wired|wiring|route|routes|endpoint|handler|dependency|dependencies|import|imports|export|exports|module graph|what uses|where is|how does .* reach)\b/.test(combined);
}

function buildCodeScoreBoost(question, metadata, input = {}) {
  let boost = 0;
  const lowerQuestion = String(question || "").trim().toLowerCase();
  const combinedQuestion = [
    question,
    input?.errorMessage,
    input?.stackTrace,
    Array.isArray(input?.constraints) ? input.constraints.join(" ") : "",
    Array.isArray(input?.paths) ? input.paths.join(" ") : ""
  ].filter(Boolean).join(" ").toLowerCase();
  const lowerPath = String(metadata?.path || "").trim().toLowerCase();
  const lowerRepo = String(metadata?.repo || "").trim().toLowerCase();
  const lowerLanguage = String(metadata?.language || "").trim().toLowerCase();
  const sessionFocus = buildCodeSessionFocus(input);
  const requestedLanguage = String(input?.language || "").trim().toLowerCase();
  const requestedRepo = String(input?.repository?.name || "").trim().toLowerCase();
  const requestedPaths = Array.isArray(input?.paths) ? input.paths : [];
  const preferredPaths = [...requestedPaths, ...sessionFocus.files];
  const symbolHints = buildCodeIdentifierHints([
    question,
    input?.errorMessage,
    input?.stackTrace,
    Array.isArray(preferredPaths) ? preferredPaths.join(" ") : "",
    sessionFocus.symbols.join(" ")
  ]);
  const connectionFocused = isConnectionFocusedCodeQuestion(question, input);
  const asksAboutTests = /\b(test|tests|spec|specs|coverage|fixture|fixtures|mock|mocks|integration test|unit test|e2e)\b/.test(combinedQuestion);
  const asksAboutConfig = /\b(config|configuration|env|environment|secret|secrets|deploy|deployment|docker|compose|workflow|ci|github actions|runtime|startup|bootstrap|build)\b/.test(combinedQuestion);
  const asksAboutPackages = /\b(package|packages|workspace|workspaces|monorepo|dependency|dependencies|module boundary|package boundary|turbo|lerna|pnpm|nx)\b/.test(combinedQuestion);
  const asksAboutEntrypoints = /\b(entry ?point|startup|boot|bootstrap|server start|app start|worker|cli|where .* start)\b/.test(combinedQuestion);

  if (metadata?.sourceType === "code") boost += 0.32;
  if (requestedLanguage && lowerLanguage && requestedLanguage === lowerLanguage) boost += 0.14;
  if (requestedRepo && lowerRepo && includesLower(lowerRepo, requestedRepo)) boost += 0.18;
  if (!requestedRepo && lowerRepo && sessionFocus.repositories.some((repo) => includesLower(lowerRepo, repo))) boost += 0.12;
  if (!requestedLanguage && lowerLanguage && sessionFocus.languages.some((language) => lowerLanguage === String(language || "").trim().toLowerCase())) boost += 0.06;

  for (const requestedPath of preferredPaths) {
    const cleanRequested = String(requestedPath || "").trim().toLowerCase();
    if (!cleanRequested || !lowerPath) continue;
    if (lowerPath === cleanRequested) {
      boost += requestedPaths.includes(requestedPath) ? 0.28 : 0.24;
      continue;
    }
    if (lowerPath.endsWith(cleanRequested) || cleanRequested.endsWith(lowerPath) || lowerPath.includes(cleanRequested)) {
      boost += requestedPaths.includes(requestedPath) ? 0.18 : 0.14;
    }
  }

  if (lowerPath) {
    const baseName = path.basename(lowerPath).toLowerCase();
    if (baseName && lowerQuestion.includes(baseName)) boost += 0.08;
    if (/package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|pyproject\.toml|pom\.xml|build\.gradle|cargo\.toml/.test(lowerPath)
      && /\b(dependenc|package|import|module|library|version)\b/.test(lowerQuestion)) {
      boost += 0.08;
    }
  }

  if (lowerRepo) {
    const repoName = lowerRepo.split("/").pop();
    if (repoName && lowerQuestion.includes(repoName)) boost += 0.06;
  }

  for (const hint of symbolHints) {
    if (metadataListIncludesHint(metadata?.functions, hint)) boost += 0.18;
    if (metadataListIncludesHint(metadata?.classes, hint)) boost += 0.16;
    if (metadataListIncludesHint(metadata?.exports, hint)) boost += 0.16;
    if (metadataListIncludesHint(metadata?.definedSymbols, hint)) boost += 0.2;
    if (metadataListIncludesHint(metadata?.calls, hint)) boost += 0.1;
    if (metadataListIncludesHint(metadata?.imports, hint) || metadataListIncludesHint(metadata?.modules, hint)) boost += 0.08;
    if (metadataListIncludesHint(metadata?.importedSymbols, hint)) boost += 0.1;
    if (metadataListIncludesHint(metadata?.referencedSymbols, hint)) boost += 0.08;
    if (metadataListIncludesHint(metadata?.reexports, hint)) boost += 0.08;
    if (metadataListIncludesHint(metadata?.envVars, hint)) boost += 0.1;
    if (metadataListIncludesHint(metadata?.scripts, hint)) boost += 0.08;
    if (metadataListIncludesHint(metadata?.services, hint) || metadataListIncludesHint(metadata?.workflowJobs, hint)) boost += 0.08;
    if (metadataListIncludesHint(metadata?.workspacePackages, hint)) boost += 0.08;
    if (String(metadata?.packageName || "").toLowerCase() === String(hint || "").trim().toLowerCase()) boost += 0.1;
  }

  if (/\b(route|router|endpoint|handler|middleware)\b/.test(lowerQuestion) && Array.isArray(metadata?.routes) && metadata.routes.length) {
    boost += 0.08;
  }
  if (/\b(connect|flow|call|invoke|used by|wired|wiring|dependency|import)\b/.test(lowerQuestion)) {
    if ((metadata?.imports?.length || 0) > 0) boost += 0.06;
    if ((metadata?.calls?.length || 0) > 0) boost += 0.06;
  }
  if (connectionFocused) {
    if ((metadata?.imports?.length || 0) > 0) boost += 0.08;
    if ((metadata?.exports?.length || 0) > 0) boost += 0.05;
    if ((metadata?.calls?.length || 0) > 0) boost += 0.08;
    if ((metadata?.routes?.length || 0) > 0) boost += 0.06;
  }
  if (asksAboutTests) {
    if (metadata?.isTestFile) boost += 0.18;
    if ((metadata?.testTargets?.length || 0) > 0) boost += 0.08;
  }
  if (asksAboutConfig) {
    if (metadata?.isConfigFile) boost += 0.18;
    if ((metadata?.envVars?.length || 0) > 0) boost += 0.08;
    if ((metadata?.services?.length || 0) > 0) boost += 0.08;
    if ((metadata?.workflowJobs?.length || 0) > 0) boost += 0.08;
    if ((metadata?.scripts?.length || 0) > 0) boost += 0.06;
  }
  if (asksAboutPackages) {
    if (String(metadata?.packageName || "").trim()) boost += 0.12;
    if ((metadata?.workspacePackages?.length || 0) > 0) boost += 0.12;
    if (Array.isArray(metadata?.configKinds) && metadata.configKinds.some((kind) => kind === "package" || kind === "workspace")) {
      boost += 0.08;
    }
  }
  if (asksAboutEntrypoints && metadata?.isEntrypoint) {
    boost += 0.18;
  }

  return boost;
}

function buildCodeFilesFromRanked(ranked, limit = 12) {
  const seen = new Set();
  const files = [];
  for (const candidate of ranked) {
    const file = candidate?.file || {};
    const key = [
      file.repo || "",
      file.path || "",
      file.docId || "",
      file.language || ""
    ].join("::");
    if (!key.replace(/:+/g, "").trim() || seen.has(key)) continue;
    seen.add(key);
    files.push({
      docId: file.docId || null,
      collection: file.collection || null,
      path: file.path || null,
      repo: file.repo || null,
      branch: file.branch || null,
      language: file.language || null,
      sourceType: file.sourceType || null,
      title: file.title || null,
      sourceUrl: file.sourceUrl || null,
      functions: Array.isArray(file.functions) ? file.functions.slice(0, 8) : [],
      classes: Array.isArray(file.classes) ? file.classes.slice(0, 6) : [],
      exports: Array.isArray(file.exports) ? file.exports.slice(0, 8) : [],
      imports: Array.isArray(file.imports) ? file.imports.slice(0, 6) : [],
      modules: Array.isArray(file.modules) ? file.modules.slice(0, 8) : [],
      calls: Array.isArray(file.calls) ? file.calls.slice(0, 12) : [],
      routes: Array.isArray(file.routes) ? file.routes.slice(0, 6) : [],
      envVars: Array.isArray(file.envVars) ? file.envVars.slice(0, 8) : [],
      testTargets: Array.isArray(file.testTargets) ? file.testTargets.slice(0, 8) : [],
      scripts: Array.isArray(file.scripts) ? file.scripts.slice(0, 8) : [],
      services: Array.isArray(file.services) ? file.services.slice(0, 8) : [],
      workflowJobs: Array.isArray(file.workflowJobs) ? file.workflowJobs.slice(0, 8) : [],
      workspacePackages: Array.isArray(file.workspacePackages) ? file.workspacePackages.slice(0, 8) : [],
      importedSymbols: Array.isArray(file.importedSymbols) ? file.importedSymbols.slice(0, 10) : [],
      reexports: Array.isArray(file.reexports) ? file.reexports.slice(0, 8) : [],
      definedSymbols: Array.isArray(file.definedSymbols) ? file.definedSymbols.slice(0, 14) : [],
      referencedSymbols: Array.isArray(file.referencedSymbols) ? file.referencedSymbols.slice(0, 16) : [],
      packageName: file.packageName || null,
      configKinds: Array.isArray(file.configKinds) ? file.configKinds.slice(0, 6) : [],
      isTestFile: Boolean(file.isTestFile),
      isConfigFile: Boolean(file.isConfigFile),
      isEntrypoint: Boolean(file.isEntrypoint),
      score: Number(candidate?.score ?? 0)
    });
    if (files.length >= limit) break;
  }
  return files;
}

function buildCodeCandidateFileKey(candidate) {
  const file = candidate?.file || {};
  return [
    file.repo || "",
    file.path || "",
    file.docId || "",
    file.language || ""
  ].join("::");
}

function resolveVectorSearchWindow(topK, { hasDocFilter = false, multiplier = null, cap = null } = {}) {
  const fallbackMultiplier = Number.isFinite(TENANT_SEARCH_MULTIPLIER) && TENANT_SEARCH_MULTIPLIER > 0 ? TENANT_SEARCH_MULTIPLIER : 5;
  const fallbackCap = Number.isFinite(TENANT_SEARCH_CAP) && TENANT_SEARCH_CAP > 0 ? TENANT_SEARCH_CAP : 50;
  const effectiveMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : fallbackMultiplier;
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? cap : fallbackCap;
  return Math.min(topK * effectiveMultiplier * (hasDocFilter ? 2 : 1), effectiveCap);
}

function resolveCodeSelectionSize(topK, task) {
  const base = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;
  const mode = normalizeCodeTask(task, "general");
  if (mode === "structure") return Math.max(12, Math.min(base, 16));
  if (mode === "debug" || mode === "write" || mode === "review" || mode === "improve") return Math.max(10, Math.min(base, 12));
  if (mode === "understand") return Math.max(8, Math.min(base, 10));
  return Math.max(6, Math.min(base, 8));
}

function selectCodeCandidatesForPrompt(ranked, limit, options = {}) {
  const candidates = Array.isArray(ranked) ? ranked : [];
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  const mode = normalizeCodeTask(options?.task, "general");
  const selected = [];
  const selectedChunkIds = new Set();
  const fileCounts = new Map();
  const uniqueFirstTarget = mode === "structure"
    ? Math.min(cleanLimit, 8)
    : (mode === "debug" || mode === "write" || mode === "review" || mode === "improve")
      ? Math.min(cleanLimit, 5)
      : Math.min(cleanLimit, 4);
  const maxPerFile = mode === "structure" ? 3 : (mode === "debug" || mode === "write" ? 4 : 3);

  function addCandidate(candidate) {
    const chunkId = candidate?.result?.chunkId || candidate?.result?.chunk_id || candidate?.result?._row?.chunk_id || null;
    if (!chunkId || selectedChunkIds.has(chunkId)) return false;
    const fileKey = buildCodeCandidateFileKey(candidate);
    const fileCount = fileCounts.get(fileKey) || 0;
    selected.push(candidate);
    selectedChunkIds.add(chunkId);
    fileCounts.set(fileKey, fileCount + 1);
    return true;
  }

  for (const candidate of candidates) {
    if (selected.length >= uniqueFirstTarget) break;
    const fileKey = buildCodeCandidateFileKey(candidate);
    if (!fileKey.replace(/:+/g, "").trim()) continue;
    if ((fileCounts.get(fileKey) || 0) > 0) continue;
    addCandidate(candidate);
  }

  for (const candidate of candidates) {
    if (selected.length >= cleanLimit) break;
    const fileKey = buildCodeCandidateFileKey(candidate);
    if (fileKey.replace(/:+/g, "").trim() && (fileCounts.get(fileKey) || 0) >= maxPerFile) continue;
    addCandidate(candidate);
  }

  for (const candidate of candidates) {
    if (selected.length >= cleanLimit) break;
    addCandidate(candidate);
  }

  return selected;
}

function buildCodeSourceSummary(files = []) {
  const repositories = [];
  const languages = [];
  const repoSeen = new Set();
  const langSeen = new Set();
  let codeHits = 0;
  let nonCodeHits = 0;
  let testFiles = 0;
  let configFiles = 0;
  let entryPoints = 0;
  const packageNames = [];
  const packageSeen = new Set();
  const configKinds = [];
  const configKindSeen = new Set();
  let symbolDenseFiles = 0;
  for (const file of files) {
    if (file?.sourceType === "code") codeHits += 1;
    else nonCodeHits += 1;
    if (file?.isTestFile) testFiles += 1;
    if (file?.isConfigFile) configFiles += 1;
    if (file?.isEntrypoint) entryPoints += 1;
    if ((Array.isArray(file?.definedSymbols) ? file.definedSymbols.length : 0) > 0) symbolDenseFiles += 1;
    if (file?.repo && !repoSeen.has(file.repo)) {
      repoSeen.add(file.repo);
      repositories.push(file.repo);
    }
    if (file?.language && !langSeen.has(file.language)) {
      langSeen.add(file.language);
      languages.push(file.language);
    }
    if (file?.packageName && !packageSeen.has(file.packageName)) {
      packageSeen.add(file.packageName);
      packageNames.push(file.packageName);
    }
    for (const kind of Array.isArray(file?.configKinds) ? file.configKinds : []) {
      const clean = String(kind || "").trim();
      if (!clean || configKindSeen.has(clean)) continue;
      configKindSeen.add(clean);
      configKinds.push(clean);
    }
  }
  return {
    codeHits,
    nonCodeHits,
    testFiles,
    configFiles,
    entryPoints,
    symbolDenseFiles,
    repositories,
    languages,
    packageNames,
    configKinds
  };
}

function buildCodeWorkingSet(files = [], options = {}) {
  const sessionFocus = buildCodeSessionFocus({ context: options?.context });
  const workingSet = {
    files: [...sessionFocus.files],
    repositories: [...sessionFocus.repositories],
    languages: [...sessionFocus.languages],
    symbols: [...sessionFocus.symbols]
  };
  for (const file of Array.isArray(files) ? files : []) {
    pushUniqueCodeValue(workingSet.files, file?.path, 14, 320);
    pushUniqueCodeValue(workingSet.repositories, file?.repo, 6, 240);
    pushUniqueCodeValue(workingSet.languages, file?.language, 6, 80);
    for (const symbol of [
      ...(Array.isArray(file?.definedSymbols) ? file.definedSymbols : []),
      ...(Array.isArray(file?.exports) ? file.exports : []),
      ...(Array.isArray(file?.functions) ? file.functions : []),
      ...(Array.isArray(file?.classes) ? file.classes : [])
    ]) {
      pushUniqueCodeValue(workingSet.symbols, symbol, 24, 120);
    }
  }
  return workingSet;
}

function buildCodeRelationshipSummary(files = [], options = {}) {
  const fileList = Array.isArray(files) ? files.filter(Boolean) : [];
  const focusHints = buildCodeIdentifierHints([
    options?.question,
    Array.isArray(options?.paths) ? options.paths.join(" ") : "",
    options?.errorMessage,
    options?.stackTrace
  ]);
  const focusSet = new Set(focusHints.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const fileByPath = new Map();
  const symbolOwners = new Map();
  const symbolReferences = new Map();
  const symbolDisplayNames = new Map();
  const relationships = [];
  const relationshipKeys = new Set();
  const entryPoints = [];
  const packageBoundaries = [];
  const runtimeSignals = [];
  const testLinks = [];

  function addRelationship(kind, line, score = 0) {
    const cleanLine = String(line || "").trim();
    if (!cleanLine) return;
    const key = `${kind}::${cleanLine.toLowerCase()}`;
    if (relationshipKeys.has(key)) return;
    relationshipKeys.add(key);
    relationships.push({ kind, line: cleanLine, score });
  }

  function normalizePathLike(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.(jsx?|tsx?|py|go|java|rb|php|rs|swift|c|cc|cpp|cxx|kt|mjs|cjs)$/i, "")
      .replace(/\/index$/i, "");
  }

  function scoreLine(line) {
    const lower = String(line || "").toLowerCase();
    let score = 0;
    for (const hint of focusSet) {
      if (lower.includes(hint)) score += 2;
    }
    return score;
  }

  for (const file of fileList) {
    const cleanPath = String(file?.path || file?.docId || "").trim();
    if (cleanPath) {
      fileByPath.set(cleanPath, file);
      fileByPath.set(normalizePathLike(cleanPath), file);
      fileByPath.set(path.basename(cleanPath), file);
      fileByPath.set(normalizePathLike(path.basename(cleanPath)), file);
    }
    for (const symbol of [
      ...(Array.isArray(file?.definedSymbols) ? file.definedSymbols : []),
      ...(Array.isArray(file?.exports) ? file.exports : []),
      ...(Array.isArray(file?.functions) ? file.functions : []),
      ...(Array.isArray(file?.classes) ? file.classes : [])
    ]) {
      const clean = String(symbol || "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (!symbolOwners.has(key)) symbolOwners.set(key, []);
      if (!symbolDisplayNames.has(key)) symbolDisplayNames.set(key, clean);
      symbolOwners.get(key).push(file);
    }
    for (const symbol of [
      ...(Array.isArray(file?.referencedSymbols) ? file.referencedSymbols : []),
      ...(Array.isArray(file?.calls) ? file.calls : [])
    ]) {
      const clean = String(symbol || "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (!symbolReferences.has(key)) symbolReferences.set(key, []);
      if (!symbolDisplayNames.has(key)) symbolDisplayNames.set(key, clean);
      symbolReferences.get(key).push(file);
    }
    for (const route of Array.isArray(file?.routes) ? file.routes : []) {
      const line = `${cleanPath || file?.docId || "unknown file"} exposes ${route}`;
      entryPoints.push(line);
      addRelationship("route", line, scoreLine(line) + 1);
    }
    if (file?.isEntrypoint && cleanPath) {
      const line = `${cleanPath} acts as an entrypoint`;
      entryPoints.push(line);
      addRelationship("entrypoint", line, scoreLine(line) + 1);
    }
    if (file?.packageName && cleanPath) {
      const line = `${cleanPath} defines package ${file.packageName}`;
      packageBoundaries.push(line);
      addRelationship("package", line, scoreLine(line) + 1);
    }
    for (const workspacePattern of Array.isArray(file?.workspacePackages) ? file.workspacePackages : []) {
      const line = `${cleanPath || file?.docId || "unknown file"} declares workspace ${workspacePattern}`;
      packageBoundaries.push(line);
      addRelationship("workspace", line, scoreLine(line) + 1);
    }
    for (const scriptName of Array.isArray(file?.scripts) ? file.scripts : []) {
      const line = `${cleanPath || file?.docId || "unknown file"} exposes script ${scriptName}`;
      runtimeSignals.push(line);
      addRelationship("script", line, scoreLine(line));
    }
    for (const serviceName of Array.isArray(file?.services) ? file.services : []) {
      const line = `${cleanPath || file?.docId || "unknown file"} defines service ${serviceName}`;
      runtimeSignals.push(line);
      addRelationship("service", line, scoreLine(line) + 1);
    }
    for (const jobName of Array.isArray(file?.workflowJobs) ? file.workflowJobs : []) {
      const line = `${cleanPath || file?.docId || "unknown file"} defines workflow job ${jobName}`;
      runtimeSignals.push(line);
      addRelationship("workflow", line, scoreLine(line) + 1);
    }
    for (const envVar of Array.isArray(file?.envVars) ? file.envVars.slice(0, 6) : []) {
      const line = `${cleanPath || file?.docId || "unknown file"} references env ${envVar}`;
      runtimeSignals.push(line);
      addRelationship("env", line, scoreLine(line));
    }
  }

  for (const file of fileList) {
    const fromPath = String(file?.path || file?.docId || "").trim() || "unknown file";
    const imports = [
      ...(Array.isArray(file?.imports) ? file.imports : []),
      ...(Array.isArray(file?.modules) ? file.modules : [])
    ];
    for (const importRef of imports) {
      const cleanImport = String(importRef || "").trim();
      if (!cleanImport) continue;
      const target = fileByPath.get(cleanImport)
        || fileByPath.get(normalizePathLike(cleanImport))
        || fileByPath.get(path.basename(cleanImport))
        || fileByPath.get(normalizePathLike(path.basename(cleanImport)));
      const targetPath = String(target?.path || cleanImport).trim();
      const line = `${fromPath} imports ${targetPath}`;
      addRelationship("import", line, scoreLine(line) + (target ? 2 : 0));
    }
    for (const call of Array.isArray(file?.calls) ? file.calls : []) {
      const owners = symbolOwners.get(String(call || "").trim().toLowerCase()) || [];
      for (const owner of owners) {
        const ownerPath = String(owner?.path || owner?.docId || "").trim();
        if (!ownerPath || ownerPath === fromPath) continue;
        const line = `${fromPath} calls ${call} from ${ownerPath}`;
        addRelationship("call", line, scoreLine(line) + 3);
      }
    }
    for (const imported of Array.isArray(file?.importedSymbols) ? file.importedSymbols : []) {
      const cleanImported = String(imported || "").trim();
      if (!cleanImported) continue;
      const symbolName = cleanImported.split(/\s+from\s+/i)[0].trim();
      const owners = symbolOwners.get(symbolName.toLowerCase()) || [];
      for (const owner of owners) {
        const ownerPath = String(owner?.path || owner?.docId || "").trim();
        if (!ownerPath || ownerPath === fromPath) continue;
        const line = `${fromPath} imports symbol ${symbolName} from ${ownerPath}`;
        addRelationship("symbol-import", line, scoreLine(line) + 3);
      }
    }
    for (const testTarget of Array.isArray(file?.testTargets) ? file.testTargets : []) {
      const cleanTarget = String(testTarget || "").trim();
      if (!cleanTarget) continue;
      const target = fileByPath.get(cleanTarget)
        || fileByPath.get(normalizePathLike(cleanTarget))
        || fileByPath.get(path.basename(cleanTarget))
        || fileByPath.get(normalizePathLike(path.basename(cleanTarget)));
      const targetPath = String(target?.path || cleanTarget).trim();
      const line = `${fromPath} tests ${targetPath}`;
      testLinks.push(line);
      addRelationship("test", line, scoreLine(line) + (target ? 2 : 0));
    }
  }

  for (const [symbolKey, owners] of symbolOwners.entries()) {
    const refs = symbolReferences.get(symbolKey) || [];
    const displaySymbol = symbolDisplayNames.get(symbolKey) || symbolKey;
    const ownerPaths = owners
      .map((owner) => String(owner?.path || owner?.docId || "").trim())
      .filter(Boolean);
    if (!ownerPaths.length) continue;
    for (const refFile of refs) {
      const refPath = String(refFile?.path || refFile?.docId || "").trim();
      if (!refPath || ownerPaths.includes(refPath)) continue;
      const line = `${refPath} references symbol ${displaySymbol} defined in ${ownerPaths[0]}`;
      addRelationship("symbol-reference", line, scoreLine(line) + 2);
    }
  }

  relationships.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.line.localeCompare(b.line);
  });

  return {
    entryPoints: entryPoints.slice(0, 8),
    connections: relationships.slice(0, 12).map((item) => item.line),
    packageBoundaries: packageBoundaries.slice(0, 8),
    runtimeSignals: runtimeSignals.slice(0, 8),
    testLinks: testLinks.slice(0, 8)
  };
}

async function buildAnswerContext({
  tenantId,
  collection,
  question,
  k,
  docIds,
  namespaceIds,
  principalId,
  privileges,
  telemetry,
  policy,
  favorRecency,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  apiKey,
  operation,
  retrievalSource,
  embedProvider,
  embedModel
}) {
  const telemetryContext = buildTelemetryContext({
    requestId: telemetry?.requestId,
    tenantId,
    collection,
    source: telemetry?.source || operation
  });

  const results = await searchChunks({
    tenantId,
    collection,
    query: question,
    k,
    docIds,
    namespaceIds,
    principalId,
    privileges,
    enforceArtifactVisibility: true,
    candidateTypes: ["artifact"],
    tags,
    agentId,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    policy,
    favorRecency,
    apiKey,
    embedProvider,
    embedModel,
    telemetry: buildTelemetryContext({
      requestId: telemetryContext.requestId,
      tenantId,
      collection,
      source: retrievalSource || "answer_retrieval_query"
    })
  });

  let memoryMap = new Map();
  const usedItems = [];
  const retrievedNamespaceIds = results.map(r => r._row.doc_id);
  if (retrievedNamespaceIds.length) {
    try {
      memoryMap = await getMemoryItemsByNamespaceIds({
        tenantId,
        collection,
        namespaceIds: retrievedNamespaceIds,
        types: ["artifact"],
        excludeExpired: true,
        principalId,
        privileges
      });

      const retrieved = [];
      const seen = new Set();
      for (const result of results) {
        const mem = memoryMap.get(result._row.doc_id);
        if (!mem) continue;
        retrieved.push({
          memory_id: mem.id,
          namespace_id: mem.namespace_id,
          item_type: mem.item_type,
          chunk_id: result.chunkId,
          score: result.score,
          value_score: mem.value_score ?? null
        });
        if (seen.has(mem.id)) continue;
        seen.add(mem.id);
        usedItems.push(mem);
      }

      emitTelemetry("memory_retrieval", telemetryContext, {
        operation,
        query_chars: String(question || "").length,
        retrieved_top_n: retrieved.length,
        retrieved_count: retrieved.length,
        retrieved
      });
    } catch (err) {
      console.warn("[memory_events] Failed to resolve retrieved memory rows:", err?.message || err);
      emitTelemetry("memory_retrieval", telemetryContext, {
        operation,
        query_chars: String(question || "").length,
        retrieved_top_n: results.length,
        retrieved_count: results.length,
        retrieved: results.map((result) => ({
          memory_id: null,
          namespace_id: result?._row?.doc_id || null,
          chunk_id: result?.chunkId || null,
          score: result?.score ?? null
        })),
        warning: "memory_lookup_failed"
      });
    }
  }

  const chunks = results.map((result) => {
    const memory = memoryMap.get(result._row.doc_id);
    return {
      ...result._row,
      _retrieval_score: result.score,
      memory_id: memory?.id || null,
      memory_type: memory?.item_type || null
    };
  }).filter(Boolean);

  return {
    telemetryContext,
    usedItems,
    chunks
  };
}

async function buildCodeAnswerContext({
  tenantId,
  collection,
  question,
  k,
  docIds,
  namespaceIds,
  principalId,
  privileges,
  telemetry,
  policy,
  favorRecency,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  apiKey,
  operation,
  retrievalSource,
  embedProvider,
  embedModel,
  task,
  language,
  deployment,
  repository,
  paths,
  errorMessage,
  stackTrace,
  constraints,
  context
}) {
  const telemetryContext = buildTelemetryContext({
    requestId: telemetry?.requestId,
    tenantId,
    collection,
    source: telemetry?.source || operation
  });
  const topK = Number.isFinite(k) && k > 0 ? k : 5;
  const connectionFocused = isConnectionFocusedCodeQuestion(question, {
    errorMessage,
    stackTrace,
    paths
  });
  const selectionK = resolveCodeSelectionSize(
    topK,
    connectionFocused && (!task || task === "general") ? "structure" : task
  );
  const retrievalQuery = buildCodeRetrievalQuery(question, {
    task,
    language,
    deployment,
    repository,
    paths,
    errorMessage,
    stackTrace,
    constraints,
    context
  });
  const complexTask = task === "debug" || task === "write";
  const retrievalMultiplier = complexTask ? 7 : (connectionFocused ? 6 : 5);
  const retrievalFloor = complexTask ? 32 : (connectionFocused ? 28 : 20);
  const retrievalK = Math.max(selectionK * retrievalMultiplier, retrievalFloor);
  const results = await searchChunks({
    tenantId,
    collection,
    query: retrievalQuery,
    k: retrievalK,
    docIds,
    namespaceIds,
    principalId,
    privileges,
    enforceArtifactVisibility: true,
    candidateTypes: ["artifact"],
    tags,
    agentId,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    policy,
    favorRecency,
    apiKey,
    embedProvider,
    embedModel,
    telemetry: buildTelemetryContext({
      requestId: telemetryContext.requestId,
      tenantId,
      collection,
      source: retrievalSource || "code_retrieval_query"
    })
  });

  let memoryMap = new Map();
  const usedItems = [];
  const retrievedNamespaceIds = results.map((result) => result._row.doc_id);
  if (retrievedNamespaceIds.length) {
    try {
      memoryMap = await getMemoryItemsByNamespaceIds({
        tenantId,
        collection,
        namespaceIds: retrievedNamespaceIds,
        types: ["artifact"],
        excludeExpired: true,
        principalId,
        privileges
      });
    } catch (err) {
      console.warn("[memory_events] Failed to resolve retrieved code memory rows:", err?.message || err);
    }
  }

  const ranked = results.map((result) => {
    const memory = memoryMap.get(result._row.doc_id) || null;
    const metadata = extractCodeMemoryMetadata(memory);
    const boost = buildCodeScoreBoost(question, metadata, {
      task,
      language,
      deployment,
      repository,
      paths,
      errorMessage,
      stackTrace,
      constraints,
      context
    });
    return {
      result,
      memory,
      file: {
        docId: result.docId,
        collection: result.collection,
        path: metadata.path,
        repo: metadata.repo,
        branch: metadata.branch,
        language: metadata.language,
        sourceType: metadata.sourceType,
        title: metadata.title,
        sourceUrl: metadata.sourceUrl,
        functions: metadata.functions,
        classes: metadata.classes,
        exports: metadata.exports,
        imports: metadata.imports,
        modules: metadata.modules,
        calls: metadata.calls,
        routes: metadata.routes,
        envVars: metadata.envVars,
        testTargets: metadata.testTargets,
        scripts: metadata.scripts,
        services: metadata.services,
        workflowJobs: metadata.workflowJobs,
        workspacePackages: metadata.workspacePackages,
        importedSymbols: metadata.importedSymbols,
        reexports: metadata.reexports,
        definedSymbols: metadata.definedSymbols,
        referencedSymbols: metadata.referencedSymbols,
        packageName: metadata.packageName,
        configKinds: metadata.configKinds,
        isTestFile: metadata.isTestFile,
        isConfigFile: metadata.isConfigFile,
        isEntrypoint: metadata.isEntrypoint
      },
      score: Number(result.score || 0) + boost
    };
  });
  const hasCodeCandidate = ranked.some((candidate) => candidate.file.sourceType === "code");
  const reranked = ranked
    .map((candidate) => ({
      ...candidate,
      score: candidate.score + (hasCodeCandidate && candidate.file.sourceType !== "code" ? -0.05 : 0)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.result?.score || 0) - (a.result?.score || 0);
    });

  const selected = selectCodeCandidatesForPrompt(reranked, selectionK, { task });
  const seen = new Set();
  const retrieved = [];
  for (const candidate of selected) {
    const mem = candidate.memory;
    if (!mem) continue;
    retrieved.push({
      memory_id: mem.id,
      namespace_id: mem.namespace_id,
      item_type: mem.item_type,
      chunk_id: candidate.result.chunkId,
      score: candidate.score,
      value_score: mem.value_score ?? null,
      source_type: mem.source_type || null,
      path: candidate.file.path || null,
      language: candidate.file.language || null,
      repo: candidate.file.repo || null
    });
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    usedItems.push(mem);
  }
  emitTelemetry("memory_retrieval", telemetryContext, {
    operation,
    response_mode: "code",
    task: task || "general",
    query_chars: String(question || "").length,
    retrieved_top_n: retrieved.length,
    retrieved_count: retrieved.length,
    retrieved
  });

  const chunks = selected.map((candidate) => ({
    ...candidate.result._row,
    _retrieval_score: candidate.score,
    memory_id: candidate.memory?.id || null,
    memory_type: candidate.memory?.item_type || null,
    source_type: candidate.file.sourceType || candidate.memory?.source_type || null,
    source_url: candidate.file.sourceUrl || candidate.memory?.source_url || null,
    title: candidate.file.title || candidate.memory?.title || null,
    metadata: candidate.memory?.metadata && typeof candidate.memory.metadata === "object" && !Array.isArray(candidate.memory.metadata)
      ? candidate.memory.metadata
      : {}
  })).filter(Boolean);
  const files = buildCodeFilesFromRanked(selected, Math.max(12, selectionK + 2));
  const workingSet = buildCodeWorkingSet(files, { context });
  const relationshipSummary = buildCodeRelationshipSummary(files, {
    question,
    paths,
    errorMessage,
    stackTrace
  });

  return {
    telemetryContext,
    usedItems,
    chunks,
    files,
    workingSet,
    sourceSummary: buildCodeSourceSummary(files),
    relationshipSummary
  };
}

function collectInjectedMemoryItems(usedItems, injectedMemoryIds) {
  const injectedItems = [];
  if (!(injectedMemoryIds instanceof Set) || injectedMemoryIds.size === 0) {
    return injectedItems;
  }
  const seen = new Set();
  for (const item of usedItems || []) {
    if (!item?.id) continue;
    if (!injectedMemoryIds.has(item.id)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    injectedItems.push(item);
  }
  return injectedItems;
}

function mapAnswerCitations(citations) {
  return citations.map((c) => {
    const parsed = parseChunkId(c);
    if (!parsed) {
      return { chunkId: c, docId: null, collection: null };
    }
    return {
      chunkId: stripChunkNamespace(c),
      docId: parsed.docId,
      collection: parsed.collection
    };
  });
}

function buildSearchPreview(text, query, maxChars = 180) {
  const cleanText = normalizeWhitespace(String(text || ""));
  if (!cleanText) return "";

  const cap = Number.isFinite(maxChars) && maxChars >= 40 ? Math.floor(maxChars) : 180;
  const cleanQuery = normalizeWhitespace(String(query || "")).trim().toLowerCase();
  const lowerText = cleanText.toLowerCase();

  let matchIndex = cleanQuery ? lowerText.indexOf(cleanQuery) : -1;
  if (matchIndex < 0 && cleanQuery) {
    const tokens = cleanQuery.split(/[^a-z0-9]+/i).filter((token) => token.length >= 4);
    for (const token of tokens) {
      const idx = lowerText.indexOf(token);
      if (idx >= 0 && (matchIndex < 0 || idx < matchIndex)) {
        matchIndex = idx;
      }
    }
  }

  if (matchIndex < 0 || cleanText.length <= cap) {
    return cleanText.length <= cap ? cleanText : `${cleanText.slice(0, cap).trim()}…`;
  }

  const lead = Math.max(0, Math.floor(cap * 0.35));
  let start = Math.max(0, matchIndex - lead);
  let end = Math.min(cleanText.length, start + cap);
  if ((end - start) < cap) {
    start = Math.max(0, end - cap);
  }

  let preview = cleanText.slice(start, end).trim();
  if (start > 0) preview = `…${preview}`;
  if (end < cleanText.length) preview = `${preview}…`;
  return preview;
}

function mapSupportingChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : []).map((chunk, index) => {
    const parsedChunk = parseChunkId(chunk?.chunk_id);
    const parsedDoc = parseNamespacedDocId(chunk?.doc_id);
    return {
      rank: index + 1,
      chunkId: chunk?.chunk_id ? stripChunkNamespace(chunk.chunk_id) : null,
      docId: parsedChunk?.docId || parsedDoc?.docId || null,
      collection: parsedChunk?.collection || parsedDoc?.collection || null,
      score: Number.isFinite(Number(chunk?._retrieval_score))
        ? Number(chunk._retrieval_score)
        : null,
      text: String(chunk?.text || "")
    };
  }).filter((chunk) => chunk.chunkId || chunk.text);
}

async function answerQuestion({
  tenantId,
  collection,
  question,
  k,
  docIds,
  namespaceIds,
  principalId,
  privileges,
  answerLength,
  citationMode = "inline",
  telemetry,
  policy,
  favorRecency,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  generationApiKey,
  generationBillable = true,
  embedApiKey,
  model,
  provider,
  models
}) {
  const effectiveModels = models || await getEffectiveTenantModels(tenantId);
  const requestedAnswerConfig = resolveRequestedGenerationConfig({
    provider,
    model,
    fallbackProvider: effectiveModels.answerProvider,
    fallbackModel: effectiveModels.answerModel
  });
  const {
    telemetryContext,
    usedItems,
    chunks
  } = await buildAnswerContext({
    tenantId,
    collection,
    question,
    k,
    docIds,
    namespaceIds,
    principalId,
    privileges,
    telemetry,
    policy,
    favorRecency,
    tags,
    agentId,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    apiKey: embedApiKey,
    embedModel: effectiveModels.embedModel,
    embedProvider: effectiveModels.embedProvider,
    operation: "answer_question",
    retrievalSource: "answer_retrieval_query"
  });

  const injectedMemoryIds = new Set();
  const { answer, citations, usage, answerLength: resolvedAnswerLength, selectedChunks } = await generateAnswer(question, chunks, {
    apiKey: generationApiKey,
    provider: requestedAnswerConfig.provider,
    model: requestedAnswerConfig.model,
    answerLength,
    citationMode,
    onPromptBuilt: (promptStats) => {
      const memoryIds = [];
      const seen = new Set();
      const chunkIds = [];
      for (const chunk of promptStats?.chunks || []) {
        if (chunk?.chunkId) {
          chunkIds.push(chunk.chunkId);
        }
        const memoryId = chunk?.memoryId;
        if (!memoryId || seen.has(memoryId)) continue;
        seen.add(memoryId);
        memoryIds.push(memoryId);
        injectedMemoryIds.add(memoryId);
      }
      emitTelemetry("prompt_constructed", telemetryContext, {
        operation: "answer_question",
        answer_length: promptStats?.answerLength || answerLength || "auto",
        requested_answer_length: promptStats?.requestedAnswerLength || answerLength || "auto",
        question_chars: String(question || "").length,
        prompt_chars: Number(promptStats?.promptChars || 0),
        prompt_tokens: Number(promptStats?.promptTokensEst || 0),
        prompt_tokens_est: Number(promptStats?.promptTokensEst || 0),
        memory_tokens_est: Number(promptStats?.memoryTokensEst || 0),
        total_tokens_est: Number(promptStats?.totalTokensEst || promptStats?.promptTokensEst || 0),
        injected_chunks_count: chunkIds.length,
        chunk_count: chunkIds.length,
        memory_count: memoryIds.length || Number(promptStats?.memoriesIncluded || 0),
        chunk_ids: chunkIds,
        memory_ids: memoryIds
      });
    }
  });

  const injectedItems = collectInjectedMemoryItems(usedItems, injectedMemoryIds);
  if (injectedItems.length) {
    await recordMemoryEventsForItems(injectedItems, "used_in_answer");
    emitTelemetry("memory_used", telemetryContext, {
      operation: "answer_question",
      answer_length: resolvedAnswerLength || answerLength || "auto",
      memory_count: injectedItems.length,
      memory_ids: injectedItems.map((mem) => mem.id)
    });
  }

  recordGenerationUsage(tenantId, usage, buildTelemetryContext({
    requestId: telemetryContext.requestId,
    tenantId,
    collection,
    source: "answer_generation",
    billable: generationBillable
  }));

  return {
    answer,
    citations: mapAnswerCitations(citations),
    chunksUsed: Array.isArray(selectedChunks) ? selectedChunks.length : chunks.length,
    supportingChunks: mapSupportingChunks(Array.isArray(selectedChunks) ? selectedChunks : chunks),
    answerLength: resolvedAnswerLength || answerLength || "auto",
    provider: requestedAnswerConfig.provider,
    model: requestedAnswerConfig.model
  };
}

async function answerCodeQuestion({
  tenantId,
  collection,
  question,
  k,
  docIds,
  namespaceIds,
  principalId,
  privileges,
  answerLength,
  citationMode = "inline",
  telemetry,
  policy,
  favorRecency,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  generationApiKey,
  generationBillable = true,
  embedApiKey,
  model,
  provider,
  models,
  task,
  language,
  deployment,
  repository,
  paths,
  errorMessage,
  stackTrace,
  constraints,
  context
}) {
  const effectiveModels = models || await getEffectiveTenantModels(tenantId);
  const requestedAnswerConfig = resolveRequestedGenerationConfig({
    provider,
    model,
    fallbackProvider: effectiveModels.answerProvider,
    fallbackModel: effectiveModels.answerModel
  });
  const {
    telemetryContext,
    usedItems,
    chunks,
    files,
    workingSet,
    sourceSummary,
    relationshipSummary
  } = await buildCodeAnswerContext({
    tenantId,
    collection,
    question,
    k,
    docIds,
    namespaceIds,
    principalId,
    privileges,
    telemetry,
    policy,
    favorRecency,
    tags,
    agentId,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    apiKey: embedApiKey,
    embedModel: effectiveModels.embedModel,
    embedProvider: effectiveModels.embedProvider,
    operation: "answer_code",
    retrievalSource: "answer_code_retrieval_query",
    task,
    language,
    deployment,
    repository,
    paths,
    errorMessage,
    stackTrace,
    constraints,
    context
  });

  const injectedMemoryIds = new Set();
  const { answer, citations, usage, answerLength: resolvedAnswerLength, answerConfidence, selectedChunks } = await generateCodeAnswer(question, chunks, {
    apiKey: generationApiKey,
    provider: requestedAnswerConfig.provider,
    model: requestedAnswerConfig.model,
    answerLength,
    citationMode,
    files,
    workingSet,
    sourceSummary,
    relationshipSummary,
    task,
    language,
    deployment,
    repository,
    paths,
    errorMessage,
    stackTrace,
    constraints,
    context,
    onPromptBuilt: (promptStats) => {
      const memoryIds = [];
      const seen = new Set();
      const chunkIds = [];
      for (const chunk of promptStats?.chunks || []) {
        if (chunk?.chunkId) {
          chunkIds.push(chunk.chunkId);
        }
        const memoryId = chunk?.memoryId;
        if (!memoryId || seen.has(memoryId)) continue;
        seen.add(memoryId);
        memoryIds.push(memoryId);
        injectedMemoryIds.add(memoryId);
      }
      emitTelemetry("prompt_constructed", telemetryContext, {
        operation: "answer_code",
        response_mode: "code",
        task: promptStats?.task || task || "general",
        answer_length: promptStats?.answerLength || answerLength || "auto",
        requested_answer_length: promptStats?.requestedAnswerLength || answerLength || "auto",
        question_chars: String(question || "").length,
        prompt_chars: Number(promptStats?.promptChars || 0),
        prompt_tokens: Number(promptStats?.promptTokensEst || 0),
        prompt_tokens_est: Number(promptStats?.promptTokensEst || 0),
        memory_tokens_est: Number(promptStats?.memoryTokensEst || 0),
        total_tokens_est: Number(promptStats?.totalTokensEst || promptStats?.promptTokensEst || 0),
        injected_chunks_count: chunkIds.length,
        chunk_count: chunkIds.length,
        memory_count: memoryIds.length || Number(promptStats?.memoriesIncluded || 0),
        chunk_ids: chunkIds,
        memory_ids: memoryIds
      });
    }
  });

  const injectedItems = collectInjectedMemoryItems(usedItems, injectedMemoryIds);
  if (injectedItems.length) {
    await recordMemoryEventsForItems(injectedItems, "used_in_answer");
    emitTelemetry("memory_used", telemetryContext, {
      operation: "answer_code",
      response_mode: "code",
      task: task || "general",
      answer_length: resolvedAnswerLength || answerLength || "auto",
      memory_count: injectedItems.length,
      memory_ids: injectedItems.map((mem) => mem.id)
    });
  }

  recordGenerationUsage(tenantId, usage, buildTelemetryContext({
    requestId: telemetryContext.requestId,
    tenantId,
    collection,
    source: "answer_code_generation",
    billable: generationBillable
  }));

  return {
    answer,
    citations: mapAnswerCitations(citations),
    chunksUsed: Array.isArray(selectedChunks) ? selectedChunks.length : chunks.length,
    supportingChunks: mapSupportingChunks(Array.isArray(selectedChunks) ? selectedChunks : chunks),
    answerLength: resolvedAnswerLength || answerLength || "auto",
    provider: requestedAnswerConfig.provider,
    model: requestedAnswerConfig.model,
    files,
    workingSet,
    sourceSummary,
    relationshipSummary,
    answerConfidence: answerConfidence || "high"
  };
}

async function answerBooleanAskQuestion({
  tenantId,
  collection,
  question,
  k,
  docIds,
  namespaceIds,
  principalId,
  privileges,
  telemetry,
  policy,
  favorRecency,
  tags,
  agentId,
  sourceTypes,
  documentTypes,
  since,
  until,
  timeField = "created_at",
  generationApiKey,
  generationBillable = true,
  embedApiKey,
  model,
  provider,
  models
}) {
  const effectiveModels = models || await getEffectiveTenantModels(tenantId);
  const requestedAnswerConfig = resolveRequestedGenerationConfig({
    provider,
    model,
    fallbackProvider: effectiveModels.booleanAskProvider,
    fallbackModel: effectiveModels.booleanAskModel
  });
  const {
    telemetryContext,
    usedItems,
    chunks
  } = await buildAnswerContext({
    tenantId,
    collection,
    question,
    k,
    docIds,
    namespaceIds,
    principalId,
    privileges,
    telemetry,
    policy,
    favorRecency,
    tags,
    agentId,
    sourceTypes,
    documentTypes,
    since,
    until,
    timeField,
    apiKey: embedApiKey,
    embedModel: effectiveModels.embedModel,
    embedProvider: effectiveModels.embedProvider,
    operation: "answer_boolean_ask",
    retrievalSource: "answer_boolean_ask_retrieval_query"
  });

  const injectedMemoryIds = new Set();
  const { answer, citations, usage, selectedChunks } = await generateBooleanAskAnswer(question, chunks, {
    apiKey: generationApiKey,
    provider: requestedAnswerConfig.provider,
    model: requestedAnswerConfig.model,
    onPromptBuilt: (promptStats) => {
      const memoryIds = [];
      const seen = new Set();
      const chunkIds = [];
      for (const chunk of promptStats?.chunks || []) {
        if (chunk?.chunkId) {
          chunkIds.push(chunk.chunkId);
        }
        const memoryId = chunk?.memoryId;
        if (!memoryId || seen.has(memoryId)) continue;
        seen.add(memoryId);
        memoryIds.push(memoryId);
        injectedMemoryIds.add(memoryId);
      }
      emitTelemetry("prompt_constructed", telemetryContext, {
        operation: "answer_boolean_ask",
        response_mode: "boolean_ask",
        question_chars: String(question || "").length,
        prompt_chars: Number(promptStats?.promptChars || 0),
        prompt_tokens: Number(promptStats?.promptTokensEst || 0),
        prompt_tokens_est: Number(promptStats?.promptTokensEst || 0),
        memory_tokens_est: Number(promptStats?.memoryTokensEst || 0),
        total_tokens_est: Number(promptStats?.totalTokensEst || promptStats?.promptTokensEst || 0),
        injected_chunks_count: chunkIds.length,
        chunk_count: chunkIds.length,
        memory_count: memoryIds.length || Number(promptStats?.memoriesIncluded || 0),
        chunk_ids: chunkIds,
        memory_ids: memoryIds
      });
    }
  });

  const injectedItems = collectInjectedMemoryItems(usedItems, injectedMemoryIds);
  if (injectedItems.length) {
    await recordMemoryEventsForItems(injectedItems, "used_in_answer");
    emitTelemetry("memory_used", telemetryContext, {
      operation: "answer_boolean_ask",
      response_mode: "boolean_ask",
      answer,
      memory_count: injectedItems.length,
      memory_ids: injectedItems.map((mem) => mem.id)
    });
  }

  recordGenerationUsage(tenantId, usage, buildTelemetryContext({
    requestId: telemetryContext.requestId,
    tenantId,
    collection,
    source: "answer_boolean_ask_generation",
    billable: generationBillable
  }));

  return {
    answer,
    citations: mapAnswerCitations(citations),
    chunksUsed: Array.isArray(selectedChunks) ? selectedChunks.length : chunks.length,
    supportingChunks: mapSupportingChunks(Array.isArray(selectedChunks) ? selectedChunks : chunks),
    provider: requestedAnswerConfig.provider,
    model: requestedAnswerConfig.model
  };
}

async function indexMemoryText(namespaceId, text, options = {}) {
  const startAt = Date.now();
  let cleanText = String(text || "");
  cleanText = cleanText.trim();
  if (!cleanText) {
    throw new Error("text produced no chunks");
  }

  let truncated = false;
  if (cleanText.length > MAX_DOC_CHARS) {
    cleanText = cleanText.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }

  logIndex(`start memory namespace=${namespaceId} chars=${cleanText.length} truncated=${truncated}`);

  const chunks = chunkText(namespaceId, cleanText, CHUNKING_OPTIONS);
  if (chunks.length === 0) {
    throw new Error("text produced no chunks");
  }

  const texts = chunks.map(c => c.text);
  const parsed = parseNamespacedDocId(namespaceId);
  const effectiveModels = options?.models || await getEffectiveTenantModels(parsed?.tenantId);
  const { vectors, usage } = await embedTexts(texts, {
    apiKey: options?.apiKey,
    embedProvider: options?.embedProvider || effectiveModels.embedProvider,
    embedModel: options?.embedModel || effectiveModels.embedModel,
    taskType: "RETRIEVAL_DOCUMENT"
  });
  recordEmbeddingUsage(parsed?.tenantId, usage, buildTelemetryContext({
    requestId: options?.telemetry?.requestId,
    tenantId: parsed?.tenantId,
    collection: parsed?.collection || null,
    source: options?.telemetry?.source || "memory_index"
  }));

  const cleanup = await deleteVectorsForDoc(namespaceId, { strict: true });
  if (cleanup.failed > 0) {
    throw new Error(`Failed to replace existing vectors for memory namespace ${namespaceId}`);
  }
  const chunkRows = buildChunkRows(namespaceId, chunks);

  await saveChunks(chunkRows, { batchSize: CHUNK_UPSERT_BATCH_SIZE });

  const vectorResults = await runBatchedCommandSet(
    chunkRows.map((row, index) => buildVset(row.chunkId, vectors[index])),
    {
      batchSize: VECTOR_WRITE_BATCH_SIZE,
      concurrency: VECTOR_WRITE_BATCH_CONCURRENCY
    }
  );
  const failedWrites = countFailedBatchCommands(vectorResults);
  if (failedWrites > 0) {
    throw new Error(`Failed to store ${failedWrites} vector(s) for memory namespace ${namespaceId}`);
  }

  scheduleStorageUsageMeter(parsed?.tenantId, buildTelemetryContext({
    requestId: options?.telemetry?.requestId,
    tenantId: parsed?.tenantId,
    collection: parsed?.collection || null,
    source: options?.telemetry?.source || "memory_index"
  }), {
    operation: "memory_index",
    namespaceId,
    chunksIndexed: chunks.length,
    truncated,
    embedProvider: options?.embedProvider || effectiveModels.embedProvider,
    embedModel: options?.embedModel || effectiveModels.embedModel
  });
  logIndex(`done memory namespace=${namespaceId} chunks=${chunks.length} totalMs=${Date.now() - startAt}`);
  return { chunksIndexed: chunks.length, truncated };
}

function scheduleRedundancyUpdate(item) {
  if (!item || !item.id) return;
  if (item.item_type === "artifact") return;
  if (!resolveMemoryPolicyConfig(getMemoryPolicy(item)).redundancyEnabled) return;
  if (redundancyPending.has(item.id)) return;
  redundancyPending.add(item.id);
  setImmediate(async () => {
    try {
      await computeRedundancyForItem(item);
    } catch (err) {
      console.warn("[redundancy] async update failed:", err?.message || err);
    } finally {
      redundancyPending.delete(item.id);
    }
  });
}

async function deleteVectorsForDoc(namespaceId, options = {}) {
  const strict = options.strict === true;
  const rows = await getChunksByDocId(namespaceId);
  const results = await runBatchedCommandSet(
    rows.map((row) => buildVdel(row.chunk_id)),
    {
      batchSize: VECTOR_DELETE_BATCH_SIZE,
      concurrency: VECTOR_DELETE_BATCH_CONCURRENCY
    }
  );
  const deleted = results.reduce((total, item) => total + (item?.ok ? 1 : 0), 0);
  const failed = countFailedBatchCommands(results);
  if (strict && failed > 0) {
    return { deleted, failed, removedDoc: false };
  }
  await deleteDoc(namespaceId);
  return { deleted, failed, removedDoc: true };
}

async function memoryWriteCore(req) {
  const { text, type, title, externalId, metadata, sourceType, sourceUrl, createdAt, visibility, acl } = req.body || {};
  const tenantId = resolveTenantId(req);
  const principalId = resolvePrincipalId(req);
  const collection = resolveCollection(req);
  const policy = resolveRequestedMemoryPolicy(req.body);
  const itemType = normalizeItemType(type);
  const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
  const tags = parseTagsInput(req.body?.tags);
  const createdTime = createdAt ? parseTimeInput(createdAt, "createdAt") : null;
  const expiresAt = resolveExpiresAt(req.body);
  const resolvedVisibility = normalizeVisibility(visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    throw new Error("acl list is required when visibility is acl");
  }
  const importanceRaw = req.body?.importanceHint ?? req.body?.importance_hint;
  const importanceHint = importanceRaw === undefined || importanceRaw === null || importanceRaw === ""
    ? undefined
    : Number(importanceRaw);
  if (importanceRaw !== undefined && importanceRaw !== null && importanceRaw !== "" && !Number.isFinite(importanceHint)) {
    throw new Error("importanceHint must be a number");
  }
  let pinned = req.body?.pinned;
  if (pinned !== undefined) {
    if (typeof pinned === "string") {
      const clean = pinned.trim().toLowerCase();
      if (clean === "true") pinned = true;
      else if (clean === "false") pinned = false;
    }
    if (pinned !== true && pinned !== false) {
      throw new Error("pinned must be a boolean");
    }
  }
  const memoryId = crypto.randomUUID();
  const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);
  const nowMs = Date.now();
  const initialValueScore = resolveInitialValueScore(policy);
  const embedConfig = await getRequestEmbeddingConfig(req, tenantId);

  const metadataWithTokens = buildStoredMemoryMetadata(metadata, text, policy);
  const memory = await upsertMemoryItem({
    tenantId,
    collection,
    itemType,
    externalId,
    namespaceId,
    itemId: memoryId,
    title,
    sourceType,
    sourceUrl,
    metadata: metadataWithTokens,
    createdAt: createdTime,
    expiresAt,
    principalId,
    agentId,
    tags,
    visibility: resolvedVisibility,
    acl: aclList,
    importanceHint,
    pinned,
    initialValueScore,
    initialTier: "WARM",
    valueLastUpdateTs: nowMs,
    tierLastUpdateTs: nowMs
  });

  const { chunksIndexed, truncated } = await indexMemoryText(memory.namespace_id, text, {
    apiKey: embedConfig.apiKey,
    embedProvider: embedConfig.embedProvider,
    embedModel: embedConfig.embedModel,
    telemetry: buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "memory_write_index"
    })
  });
  scheduleRedundancyUpdate(memory);

  return {
    tenantId,
    principalId,
    collection,
    memory,
    chunksIndexed,
    truncated,
    policy
  };
}

function parseJsonPayload(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function computeJobBackoff(attempt) {
  const base = Number.isFinite(JOB_RETRY_BASE_MS) && JOB_RETRY_BASE_MS > 0 ? JOB_RETRY_BASE_MS : 2000;
  const max = Number.isFinite(JOB_RETRY_MAX_MS) && JOB_RETRY_MAX_MS > 0 ? JOB_RETRY_MAX_MS : 30000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(exp * (Math.random() * 0.2));
  return exp + jitter;
}

function resolveMemoryJobRunner(type, deps = {}) {
  if (type === "reflect") {
    return deps.runReflectionJob || runReflectionJob;
  }
  if (type === "ttl_cleanup") {
    return deps.runTtlCleanupJob || runTtlCleanupJob;
  }
  if (type === "compaction") {
    return deps.runCompactionJob || runCompactionJob;
  }
  if (type === "delete_reconcile") {
    return deps.runDeleteReconcileJob || runDeleteReconcileJob;
  }
  if (type === "conversation_wiki_update") {
    return deps.runConversationWikiUpdateJob || runConversationWikiUpdateJob;
  }
  if (type === CONVERSATION_WIKI_CLEAR_COLLECTION_JOB_TYPE) {
    return deps.runConversationMemoryClearJob || runConversationMemoryClearJob;
  }
  return null;
}

async function dispatchMemoryJobWithDeps(deps = {}, jobId, tenantId, jobType) {
  const type = jobType || null;
  const runner = resolveMemoryJobRunner(type, deps);
  if (runner) {
    await runner(jobId, tenantId);
    return;
  }
  if (!type) {
    const getJobById = deps.getMemoryJobById || getMemoryJobById;
    const job = await getJobById(jobId, tenantId);
    if (!job) return;
    await dispatchMemoryJobWithDeps(deps, jobId, tenantId, job.job_type);
    return;
  }
  console.warn(`[jobs] Unknown job type ${type} for job ${jobId}`);
}

async function dispatchMemoryJob(jobId, tenantId, jobType) {
  return dispatchMemoryJobWithDeps({}, jobId, tenantId, jobType);
}

async function finalizeJobFailure(job, err, options = {}) {
  const retryable = options.retryable !== false;
  const message = String(err?.message || err);
  const maxAttempts = Number.isFinite(job.max_attempts) && job.max_attempts > 0
    ? job.max_attempts
    : (Number.isFinite(JOB_MAX_ATTEMPTS) && JOB_MAX_ATTEMPTS > 0 ? JOB_MAX_ATTEMPTS : 3);
  const attempts = Number.isFinite(job.attempts) ? job.attempts + 1 : 1;

  if (!retryable || attempts >= maxAttempts) {
    await updateMemoryJob({ id: job.id, status: "failed", error: message, attempts });
    return { retried: false, attempts };
  }

  const delay = computeJobBackoff(attempts);
  const nextRunAt = new Date(Date.now() + delay);
  await updateMemoryJob({ id: job.id, status: "queued", error: message, attempts, nextRunAt });
  setTimeout(() => {
    dispatchMemoryJob(job.id, job.tenant_id, job.job_type).catch(() => {});
  }, delay);
  return { retried: true, attempts, nextRunAt };
}

async function cleanupJobDerivedItems({ jobId, tenantId, collection, expectedExternalIds }) {
  const items = await listMemoryItemsByExternalPrefix({
    tenantId,
    collection,
    prefix: `job:${jobId}:`
  });
  const expected = new Set(expectedExternalIds || []);
  for (const item of items) {
    if (expected.size > 0 && item.external_id && expected.has(item.external_id)) {
      continue;
    }
    const result = await deleteMemoryItemFully(item, { reason: "job_cleanup" });
    if (result?.queued) {
      console.warn(`[delete] queued reconcile for job cleanup item id=${item.id}`);
    }
  }
}

async function cleanupExternalItems({ tenantId, collection, prefix, expectedExternalIds }) {
  const items = await listMemoryItemsByExternalPrefix({
    tenantId,
    collection,
    prefix
  });
  const expected = new Set(expectedExternalIds || []);
  for (const item of items) {
    if (expected.size > 0 && item.external_id && expected.has(item.external_id)) {
      continue;
    }
    const result = await deleteMemoryItemFully(item, { reason: "external_cleanup" });
    if (result?.queued) {
      console.warn(`[delete] queued reconcile for external cleanup item id=${item.id}`);
    }
  }
}

async function enqueueDeleteReconcileJob(item, reason, failedCount) {
  if (!item?.tenant_id || !item?.id) return null;
  const existing = await findActiveDeleteJob({ tenantId: item.tenant_id, memoryId: item.id });
  if (existing) return existing;
  return createMemoryJob({
    tenantId: item.tenant_id,
    jobType: "delete_reconcile",
    status: "queued",
    input: {
      memoryId: item.id,
      namespaceId: item.namespace_id || null,
      collection: item.collection || null,
      reason: reason || "vdel_failed",
      failed: Number.isFinite(failedCount) ? failedCount : null
    },
    maxAttempts: JOB_MAX_ATTEMPTS
  });
}

async function loadArtifactText(namespaceId) {
  const rows = await getChunksByDocId(namespaceId);
  if (!rows.length) return "";
  return rows.map(r => r.text).join("\n\n");
}

async function loadConversationWikiPageRecords({ tenantId, collection, conversationId, pages, principalId }) {
  const items = await listConversationWikiItems({
    tenantId,
    collection,
    conversationId,
    pages,
    principalId
  });
  if (!items.length) return [];
  const texts = await Promise.all(items.map((item) => loadArtifactText(item.namespace_id)));
  return items.map((item, index) => formatConversationWikiItem(item, texts[index]));
}

function buildConversationWikiPromptState(records = []) {
  const previousArticle = buildConversationWikiArticle(records);
  return {
    previousWiki: {
      title: previousArticle.title,
      note: previousArticle.note,
      paragraphs: previousArticle.paragraphs
    },
    previousWikiSourceExchanges: mergeConversationWikiStoredExchanges(
      ...(Array.isArray(records)
        ? records.map((record) => record?.sourceExchanges ?? record?.memory?.metadata?.sourceExchanges ?? [])
        : [])
    ),
    previousWikiPages: Array.isArray(records)
      ? records.map((record) => ({
        page: record?.page || null,
        title: record?.title ?? record?.metadata?.title ?? null,
        note: record?.note ?? record?.metadata?.note ?? record?.metadata?.summary ?? null,
        paragraphs: Array.isArray(record?.paragraphs) ? record.paragraphs : []
      })).filter((record) => record.page || record.paragraphs.length)
      : []
  };
}

function getConversationWikiCheckpoint(records = []) {
  for (const record of records) {
    const checkpoint = String(record?.checkpointTurnExternalId || "").trim();
    if (checkpoint) return checkpoint;
  }
  return null;
}

function buildConversationWikiTurnExchangeSpans(recentTurns = []) {
  const exchanges = [];
  let current = null;
  for (let turnIndex = 0; turnIndex < (Array.isArray(recentTurns) ? recentTurns.length : 0); turnIndex += 1) {
    const turn = recentTurns[turnIndex];
    const role = String(turn?.role || turn?.metadata?.role || "").trim().toLowerCase();
    const text = extractConversationMessageBody(turn?.text);
    if (!text) continue;
    if (role === "user") {
      current = {
        startIndex: turnIndex,
        endIndex: turnIndex,
        question: text,
        askedAt: turn?.createdAt || null,
        questionExternalId: turn?.externalId || null,
        responses: []
      };
      exchanges.push(current);
      continue;
    }
    if (!current) {
      current = {
        startIndex: turnIndex,
        endIndex: turnIndex,
        question: null,
        askedAt: null,
        questionExternalId: null,
        responses: []
      };
      exchanges.push(current);
    }
    current.endIndex = turnIndex;
    current.responses.push({
      role: role || "assistant",
      text,
      createdAt: turn?.createdAt || null,
      externalId: turn?.externalId || null
    });
  }
  return exchanges.map((exchange, index) => ({
    index: index + 1,
    startIndex: exchange.startIndex,
    endIndex: exchange.endIndex,
    question: exchange.question || null,
    askedAt: exchange.askedAt || null,
    questionExternalId: exchange.questionExternalId || null,
    responseCount: Array.isArray(exchange.responses) ? exchange.responses.length : 0,
    responses: Array.isArray(exchange.responses) ? exchange.responses : []
  }));
}

function buildConversationWikiPromptTurnKey(turn) {
  const externalId = String(turn?.externalId || "").trim();
  if (externalId) return `external:${externalId}`;
  return stableJson({
    id: turn?.id || null,
    createdAt: turn?.createdAt || null,
    role: turn?.role || turn?.memory?.role || null,
    text: String(turn?.text || "").trim()
  });
}

function countConversationWikiTurnExchanges(recentTurns = []) {
  return buildConversationWikiTurnExchangeSpans(recentTurns).length;
}

function sliceConversationWikiTurnsToRecentExchanges(recentTurns = [], keepRecentExchanges = 4) {
  const safeTurns = Array.isArray(recentTurns) ? recentTurns.slice() : [];
  const safeKeepRecentExchanges = Math.max(0, Math.floor(Number(keepRecentExchanges) || 0));
  if (!safeTurns.length || !safeKeepRecentExchanges) return [];
  const spans = buildConversationWikiTurnExchangeSpans(safeTurns);
  if (!spans.length || spans.length <= safeKeepRecentExchanges) return safeTurns;
  const startIndex = spans[spans.length - safeKeepRecentExchanges]?.startIndex ?? 0;
  return safeTurns.slice(Math.max(0, startIndex));
}

function mergeConversationWikiPromptTurns(deltaTurns = [], overlapTurns = [], keepRecentExchanges = 4, maxTurns = CONVERSATION_WIKI_MAX_SOURCE_TURNS) {
  const safeMaxTurns = Math.max(1, Math.floor(Number(maxTurns) || 0));
  const overlapWindow = sliceConversationWikiTurnsToRecentExchanges(overlapTurns, keepRecentExchanges);
  const deltaList = Array.isArray(deltaTurns) ? deltaTurns.filter(Boolean) : [];
  if (deltaList.length >= safeMaxTurns) return deltaList.slice(-safeMaxTurns);
  const merged = [];
  const seen = new Set();
  const deltaKeys = new Set(deltaList.map((turn) => buildConversationWikiPromptTurnKey(turn)));
  for (const turn of overlapWindow) {
    if (!turn || typeof turn !== "object") continue;
    const stableKey = buildConversationWikiPromptTurnKey(turn);
    if (seen.has(stableKey) || deltaKeys.has(stableKey)) continue;
    seen.add(stableKey);
    merged.push(turn);
  }
  const overlapBudget = Math.max(0, safeMaxTurns - deltaList.length);
  const trimmedOverlap = overlapBudget ? merged.slice(-overlapBudget) : [];
  return [...trimmedOverlap, ...deltaList];
}

function getConversationWikiRevision(records = []) {
  return records.reduce((max, record) => {
    const revision = Number(record?.revision || 0);
    return Number.isFinite(revision) && revision > max ? revision : max;
  }, 0);
}

function buildConversationWikiPageTags(baseTags, page) {
  const tags = parseTagsInput(baseTags);
  if (!tags.includes("wiki")) tags.push("wiki");
  const pageTag = `wiki_page:${String(page || "").trim()}`;
  if (pageTag && !tags.includes(pageTag)) tags.push(pageTag);
  return tags;
}

async function loadConversationTurnTexts(items = []) {
  const texts = await Promise.all(items.map((item) => loadArtifactText(item.namespace_id)));
  return items.map((item, index) => ({
    id: item.id,
    externalId: item.external_id || null,
    role: item?.metadata?.role || null,
    createdAt: item.created_at || null,
    text: texts[index],
    memory: formatMemoryItem(item)
  })).filter((item) => String(item.text || "").trim());
}

async function loadConversationTurnsForWikiUpdate({
  tenantId,
  collection,
  conversationId,
  principalId,
  checkpointTurnExternalId,
  keepRecentTurns = 0
}, deps = {}) {
  const getByExternalId = deps.getMemoryItemByExternalId || getMemoryItemByExternalId;
  const listTurns = deps.listConversationTurnItems || listConversationTurnItems;
  const listRecentTurns = deps.listRecentConversationTurnItems || listRecentConversationTurnItems;
  const loadTurnTexts = deps.loadConversationTurnTexts || loadConversationTurnTexts;
  const safeKeepRecentExchanges = Math.max(0, Math.floor(Number(keepRecentTurns) || 0));
  if (checkpointTurnExternalId) {
    const checkpoint = await getByExternalId({
      tenantId,
      collection,
      externalId: checkpointTurnExternalId,
      principalId
    });
    const since = checkpoint?.created_at || null;
    if (since) {
      const recent = await listTurns({
        tenantId,
        collection,
        conversationId,
        afterCreatedAt: since,
        limit: CONVERSATION_WIKI_MAX_SOURCE_TURNS,
        principalId
      });
      const newTurns = await loadTurnTexts(recent);
      if (!safeKeepRecentExchanges) {
        return {
          newTurns,
          promptTurns: newTurns
        };
      }
      const overlapExchangeTurnBudget = Math.max(
        CONVERSATION_WIKI_TURNS_PER_EXCHANGE,
        safeKeepRecentExchanges * CONVERSATION_WIKI_TURNS_PER_EXCHANGE
      );
      const overlapTurnLimit = Math.min(
        CONVERSATION_WIKI_MAX_SOURCE_TURNS,
        Math.max(overlapExchangeTurnBudget, newTurns.length + overlapExchangeTurnBudget)
      );
      const overlap = await listRecentTurns({
        tenantId,
        collection,
        conversationId,
        limit: overlapTurnLimit,
        principalId
      });
      const overlapTurns = await loadTurnTexts(overlap);
      return {
        newTurns,
        promptTurns: mergeConversationWikiPromptTurns(
          newTurns,
          overlapTurns,
          safeKeepRecentExchanges,
          CONVERSATION_WIKI_MAX_SOURCE_TURNS
        )
      };
    }
  }
  const recent = await listRecentTurns({
    tenantId,
    collection,
    conversationId,
    limit: CONVERSATION_WIKI_MAX_SOURCE_TURNS,
    principalId
  });
  const turns = await loadTurnTexts(recent);
  return {
    newTurns: turns,
    promptTurns: turns
  };
}

function resolveConversationWikiSourceCheckpoint(records = [], { force = false } = {}) {
  return force ? null : getConversationWikiCheckpoint(records);
}

async function upsertConversationWikiPage({
  tenantId,
  collection,
  conversationId,
  page,
  title,
  note,
  paragraphs,
  sections,
  sourceExchanges,
  checkpointTurnExternalId,
  revision,
  pageMaxChars,
  principalId,
  visibility,
  acl,
  agentId,
  sourceType,
  policy,
  baseTags
}) {
  const built = buildConversationWikiPageText(page, {
    id: page,
    title,
    note,
    paragraphs,
    sections
  }, pageMaxChars);
  if (!Array.isArray(built.paragraphs) || built.paragraphs.length === 0) {
    const error = new Error("Conversation wiki page must include at least one readable paragraph.");
    error.code = "CONVERSATION_WIKI_EMPTY_PAGE";
    throw error;
  }
  const memoryId = crypto.randomUUID();
  const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);
  const updatedAt = new Date().toISOString();
  const normalizedSections = sections && typeof sections === "object"
    ? normalizeConversationWikiSections(sections)
    : undefined;
  const memory = await upsertMemoryItem({
    tenantId,
    collection,
    itemType: "summary",
    externalId: buildConversationWikiExternalId(conversationId, page),
    namespaceId,
    itemId: memoryId,
    title: built.title,
    sourceType: sourceType || "conversation_wiki",
    sourceUrl: null,
    metadata: buildStoredMemoryMetadata({
      kind: "conversation_wiki_page",
      conversationId,
      page,
      title: built.title,
      note: built.note,
      paragraphs: built.paragraphs,
      position: 0,
      revision,
      checkpointTurnExternalId: checkpointTurnExternalId || null,
      sourceExchanges: normalizeConversationWikiStoredExchanges(sourceExchanges),
      updatedAt,
      updatedBySource: sourceType || "conversation_wiki",
      itemCount: built.itemCount,
      sections: normalizedSections
    }, built.text, policy),
    principalId: principalId || null,
    agentId: agentId || null,
    tags: buildConversationWikiPageTags(baseTags, page),
    visibility: visibility || "tenant",
    acl: Array.isArray(acl) ? acl : []
  });

  const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
  if (cleanup.failed > 0) {
    throw new Error(`Failed to delete vectors for wiki page ${page}`);
  }

  await indexMemoryText(memory.namespace_id, built.text, {
    telemetry: buildTelemetryContext({
      requestId: `conversation-wiki:${conversationId}:${page}`,
      tenantId,
      collection,
      source: "conversation_wiki_index"
    })
  });
  scheduleRedundancyUpdate(memory);
  return formatConversationWikiItem(memory, built.text);
}

async function deleteConversationWikiPages({ tenantId, collection, conversationId, principalId, requestId, source }) {
  const prefix = buildConversationWikiExternalId(conversationId, "");
  const items = await listMemoryItemsByExternalPrefix({ tenantId, collection, prefix });
  const deleted = [];
  for (const item of items) {
    if (principalId) {
      const full = await getMemoryItemById(item.id, tenantId, principalId);
      if (!full) continue;
      const result = await deleteMemoryItemFully(full, {
        reason: "conversation_wiki_delete",
        requestId,
        source: source || "conversation_wiki"
      });
      deleted.push({ id: item.id, deleted: Boolean(result?.deleted), queued: Boolean(result?.queued) });
      continue;
    }
    const result = await deleteMemoryItemFully(item, {
      reason: "conversation_wiki_delete",
      requestId,
      source: source || "conversation_wiki"
    });
    deleted.push({ id: item.id, deleted: Boolean(result?.deleted), queued: Boolean(result?.queued) });
  }
  return deleted;
}

function collectConversationIdsForCollectionClear(memoryItems = [], jobs = []) {
  const ids = new Set();
  for (const item of Array.isArray(memoryItems) ? memoryItems : []) {
    const conversationId = String(item?.metadata?.conversationId || "").trim();
    if (conversationId) ids.add(conversationId);
  }
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const input = parseJsonPayload(job?.input) || {};
    const conversationId = String(input?.conversationId || "").trim();
    if (conversationId) ids.add(conversationId);
  }
  return Array.from(ids).sort((left, right) => left.localeCompare(right));
}

async function waitForConversationWikiLockWithDeps(deps, {
  tenantId,
  collection,
  conversationId,
  waitMs = CONVERSATION_WIKI_CLEAR_LOCK_WAIT_MS,
  retryMs = CONVERSATION_WIKI_CLEAR_LOCK_RETRY_MS
}) {
  const acquireLock = deps.acquireConversationWikiLock || acquireConversationWikiLock;
  const sleepFn = deps.sleep || sleep;
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const retryDelay = Math.max(25, Number(retryMs) || 0);
  while (true) {
    const lock = await acquireLock({ tenantId, collection, conversationId });
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await sleepFn(retryDelay);
  }
}

async function clearConversationMemoryCollectionWithDeps(deps, {
  tenantId,
  collection,
  requestId,
  source
}) {
  const listItems = deps.listMemoryItemsByCollection || listMemoryItemsByCollection;
  const listJobs = deps.listMemoryJobsByCollection || listMemoryJobsByCollection;
  const deleteJobs = deps.deleteMemoryJobsByCollection || deleteMemoryJobsByCollection;
  const releaseLock = deps.releaseConversationWikiLock || releaseConversationWikiLock;
  const deleteItem = deps.deleteMemoryItemFully || deleteMemoryItemFully;
  const jobTypes = ["conversation_wiki_update", "delete_reconcile"];
  const items = await listItems({ tenantId, collection });
  const jobs = await listJobs({ tenantId, collection, jobTypes });
  const conversationIds = collectConversationIdsForCollectionClear(items, jobs);
  const locks = [];
  try {
    for (const conversationId of conversationIds) {
      const lock = await waitForConversationWikiLockWithDeps(deps, {
        tenantId,
        collection,
        conversationId
      });
      if (!lock) {
        const err = new Error(`Conversation wiki is currently being updated for ${conversationId}`);
        err.status = 409;
        err.code = "CONVERSATION_WIKI_LOCKED";
        err.conversationId = conversationId;
        throw err;
      }
      locks.push(lock);
    }
    const deletedJobCount = await deleteJobs({ tenantId, collection, jobTypes });
    let deletedCount = 0;
    let queuedCount = 0;
    let deletedVectors = 0;
    for (const item of items) {
      const result = await deleteItem(item, {
        reason: "conversation_memory_clear_all",
        requestId,
        source: source || "conversation_wiki"
      });
      if (result?.deleted) deletedCount += 1;
      if (result?.queued) queuedCount += 1;
      deletedVectors += Number(result?.vectorsDeleted || 0);
    }
    return {
      collection,
      conversationCount: conversationIds.length,
      conversationIds,
      memoryItemCount: items.length,
      deletedCount,
      queuedCount,
      deletedJobCount,
      deletedVectors,
      note: "Cleared stored conversation memory, wiki articles, and collection-scoped conversation jobs."
    };
  } finally {
    await Promise.all(locks.reverse().map((lock) => releaseLock(lock).catch(() => null)));
  }
}

async function clearConversationMemoryCollection(args) {
  return clearConversationMemoryCollectionWithDeps({}, args);
}

async function pruneConversationTurnsForWikiWithDeps(deps, { tenantId, collection, conversationId, principalId, checkpointTurnExternalId, keepRecentTurns, requestId }) {
  const getByExternalId = deps.getMemoryItemByExternalId || getMemoryItemByExternalId;
  const listForPrune = deps.listConversationTurnItemsForPrune || listConversationTurnItemsForPrune;
  const deleteItem = deps.deleteMemoryItemFully || deleteMemoryItemFully;
  if (!checkpointTurnExternalId) return { pruned: 0, queued: 0 };
  const checkpoint = await getByExternalId({
    tenantId,
    collection,
    externalId: checkpointTurnExternalId,
    principalId
  });
  if (!checkpoint?.created_at) return { pruned: 0, queued: 0 };
  const items = await listForPrune({
    tenantId,
    collection,
    conversationId,
    beforeCreatedAt: checkpoint.created_at,
    keepRecentTurns: Math.max(
      0,
      Math.floor(Number(keepRecentTurns) || 0) * CONVERSATION_WIKI_TURNS_PER_EXCHANGE
    ),
    principalId
  });
  let pruned = 0;
  let queued = 0;
  for (const item of items) {
    const result = await deleteItem(item, {
      reason: "conversation_wiki_prune",
      requestId,
      source: "conversation_wiki"
    });
    if (result?.deleted) pruned += 1;
    if (result?.queued) queued += 1;
  }
  return { pruned, queued };
}

async function pruneConversationTurnsForWiki(args) {
  return pruneConversationTurnsForWikiWithDeps({}, args);
}

async function enqueueConversationWikiUpdateJobWithDeps(deps, {
  tenantId,
  collection,
  conversationId,
  principalId,
  agentId,
  provider,
  model,
  policy,
  visibility,
  acl,
  pages,
  pageMaxChars,
  keepRecentTurns,
  updateEveryTurns,
  force = false,
  sourceType = "conversation_wiki",
  baseTags = []
}) {
  const findActiveJob = deps.findActiveConversationWikiJob || findActiveConversationWikiJob;
  const createJob = deps.createMemoryJob || createMemoryJob;
  const active = await findActiveJob({ tenantId, collection, conversationId });
  if (active) return active;
  return createJob({
    tenantId,
    jobType: "conversation_wiki_update",
    status: "queued",
    maxAttempts: JOB_MAX_ATTEMPTS,
    input: {
      tenantId,
      collection,
      conversationId,
      principalId: principalId || null,
      agentId: agentId || null,
      provider: provider || null,
      model: model || null,
      policy: policy || null,
      visibility: visibility || null,
      acl: Array.isArray(acl) ? acl : null,
      pages: normalizeConversationWikiPagesInput(pages),
      pageMaxChars: Number.isFinite(pageMaxChars) ? pageMaxChars : CONVERSATION_WIKI_MAX_PAGE_CHARS,
      keepRecentTurns: Number.isFinite(keepRecentTurns) ? keepRecentTurns : 4,
      updateEveryTurns: Number.isFinite(updateEveryTurns) ? updateEveryTurns : 4,
      force: Boolean(force),
      sourceType,
      baseTags: parseTagsInput(baseTags)
    }
  });
}

async function enqueueConversationWikiUpdateJob(args) {
  return enqueueConversationWikiUpdateJobWithDeps({}, args);
}

async function enqueueConversationMemoryClearJobWithDeps(deps, {
  tenantId,
  collection,
  requestId,
  source
}) {
  const listJobs = deps.listMemoryJobsByCollection || listMemoryJobsByCollection;
  const createJob = deps.createMemoryJob || createMemoryJob;
  const activeJobs = await listJobs({
    tenantId,
    collection,
    jobTypes: [CONVERSATION_WIKI_CLEAR_COLLECTION_JOB_TYPE],
    statuses: ["queued", "running"]
  });
  if (Array.isArray(activeJobs) && activeJobs.length) {
    return activeJobs[0];
  }
  return createJob({
    tenantId,
    jobType: CONVERSATION_WIKI_CLEAR_COLLECTION_JOB_TYPE,
    status: "queued",
    maxAttempts: JOB_MAX_ATTEMPTS,
    input: {
      tenantId,
      collection,
      requestId: requestId || null,
      source: source || "conversation_wiki_api"
    }
  });
}

async function enqueueConversationMemoryClearJob(args) {
  return enqueueConversationMemoryClearJobWithDeps({}, args);
}

async function runConversationWikiUpdateJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  let conversationId = null;
  let collection = null;
  let wikiLock = null;
  try {
    const input = parseJsonPayload(job.input) || {};
    collection = normalizeCollection(input.collection);
    conversationId = String(input.conversationId || "").trim();
    if (!conversationId) {
      recordConversationWikiMetrics(tenantId, { failed: 1 });
      await finalizeJobFailure(job, "conversationId is required", { retryable: false });
      return;
    }
    wikiLock = await acquireConversationWikiLock({ tenantId, collection, conversationId });
    if (!wikiLock) {
      recordConversationWikiMetrics(tenantId, { skipped: 1 });
      emitConversationWikiTelemetry("skipped_locked", {
        requestId: `job:${jobId}`,
        tenantId,
        collection,
        conversationId,
        source: "conversation_wiki_job"
      });
      await updateMemoryJob({
        id: job.id,
        status: "succeeded",
        output: {
          collection,
          conversationId,
          updated: false,
          skipped: "conversation_locked"
        }
      });
      return;
    }
    const pages = normalizeConversationWikiPagesInput(input.pages);
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;
    const updateEveryTurns = Number.isFinite(Number(input.updateEveryTurns)) ? Math.max(1, Math.floor(Number(input.updateEveryTurns))) : 4;
    const keepRecentTurns = Number.isFinite(Number(input.keepRecentTurns)) ? Math.max(0, Math.floor(Number(input.keepRecentTurns))) : 4;
    const pageMaxChars = Number.isFinite(Number(input.pageMaxChars)) ? Math.max(200, Math.floor(Number(input.pageMaxChars))) : CONVERSATION_WIKI_MAX_PAGE_CHARS;
    const force = Boolean(input.force);
    const baseTags = parseTagsInput(input.baseTags);

    const existingPages = await loadConversationWikiPageRecords({
      tenantId,
      collection,
      conversationId,
      pages,
      principalId
    });
    const checkpointTurnExternalId = getConversationWikiCheckpoint(existingPages);
    const sourceCheckpointTurnExternalId = resolveConversationWikiSourceCheckpoint(existingPages, { force });
    const { newTurns, promptTurns } = await loadConversationTurnsForWikiUpdate({
      tenantId,
      collection,
      conversationId,
      principalId,
      checkpointTurnExternalId: sourceCheckpointTurnExternalId,
      keepRecentTurns
    });
    const newExchangeCount = countConversationWikiTurnExchanges(newTurns);
    const promptExchangeCount = countConversationWikiTurnExchanges(promptTurns);

    if (!force && newExchangeCount < updateEveryTurns) {
      recordConversationWikiMetrics(tenantId, {
        skipped: 1,
        lastPageCount: existingPages.length,
        lastUpdatedAt: getConversationWikiLastUpdatedAt(existingPages)
      });
      emitConversationWikiTelemetry("skipped_not_due", {
        requestId: `job:${jobId}`,
        tenantId,
        collection,
        conversationId,
        source: "conversation_wiki_job"
      }, {
        recent_turn_count: newTurns.length,
        recent_exchange_count: newExchangeCount,
        page_count: existingPages.length
      });
      await updateMemoryJob({
        id: job.id,
        status: "succeeded",
        output: {
          collection,
          conversationId,
          updated: false,
          skipped: "not_due",
          recentTurnCount: newTurns.length,
          recentExchangeCount: newExchangeCount,
          pageCount: existingPages.length
        }
      });
      return;
    }

    if (!promptTurns.length && !existingPages.length) {
      recordConversationWikiMetrics(tenantId, { skipped: 1, lastPageCount: 0 });
      emitConversationWikiTelemetry("skipped_no_source_turns", {
        requestId: `job:${jobId}`,
        tenantId,
        collection,
        conversationId,
        source: "conversation_wiki_job"
      });
      await updateMemoryJob({
        id: job.id,
        status: "succeeded",
        output: {
          collection,
          conversationId,
          updated: false,
          skipped: "no_source_turns",
          recentTurnCount: 0,
          recentExchangeCount: 0,
          pageCount: 0
        }
      });
      return;
    }

    const existingWikiState = buildConversationWikiPromptState(existingPages);
    const currentTurnExchanges = normalizeConversationWikiStoredExchanges(buildConversationWikiTurnExchanges(promptTurns));
    const nextSourceExchanges = mergeConversationWikiStoredExchanges(
      existingWikiState.previousWikiSourceExchanges,
      currentTurnExchanges
    );
    const fallbackSourceExchanges = mergeConversationWikiStoredExchanges(
      currentTurnExchanges,
      existingWikiState.previousWikiSourceExchanges
    );
    const answeredRecentExchangeCount = countConversationWikiAnsweredStoredExchanges(currentTurnExchanges);
    const prompt = buildConversationWikiUpdatePrompt({
      conversationId,
      pages,
      existingWikiState,
      recentTurns: promptTurns
    });
    const tenantModels = await getEffectiveTenantModels(tenantId);
    const requestedGeneration = resolveRequestedGenerationConfig({
      provider: input.provider || null,
      model: input.model || null,
      fallbackProvider: tenantModels.compactProvider || tenantModels.answerProvider,
      fallbackModel: tenantModels.compactModel || tenantModels.answerModel
    });
    const generated = await generateProviderText({
      provider: requestedGeneration.provider,
      model: requestedGeneration.model,
      input: prompt,
      temperature: 0,
      jsonMode: true,
      maxTokens: 3600
    });
    recordGenerationUsage(tenantId, generated?.usage, buildTelemetryContext({
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      source: "job_conversation_wiki_generation"
    }));
    const draftArticle = repairConversationWikiArticleDraft(
      parseConversationWikiResponse(generated?.text, pages),
      {
        sourceExchanges: fallbackSourceExchanges,
        previousWiki: existingWikiState.previousWiki,
        minAnsweredExchanges: answeredRecentExchangeCount,
        fallbackTitle: "Conversation wiki"
      }
    );
    const revision = getConversationWikiRevision(existingPages) + 1;
    const nextCheckpoint = newTurns[newTurns.length - 1]?.externalId || checkpointTurnExternalId || null;
    const visibility = input.visibility ? normalizeVisibility(input.visibility) : (existingPages[0]?.memory?.visibility || "tenant");
    const acl = visibility === "acl"
      ? normalizeAclList(input.acl || existingPages[0]?.memory?.acl || [], principalId)
      : [];
    const policy = resolveRequestedMemoryPolicy(input, existingPages[0]?.memory?.policy || DEFAULT_MEMORY_POLICY);
    const writes = [];
    const currentRecordMap = new Map(existingPages.map((record) => [record.page, record]));
    const nextPageIds = new Set();
    const built = buildConversationWikiPageText(CONVERSATION_WIKI_ARTICLE_PAGE, draftArticle, pageMaxChars);
    const existing = currentRecordMap.get(built.page) || null;
    nextPageIds.add(built.page);
    const currentPageState = stableJson({
      title: existing?.title ?? existing?.metadata?.title ?? null,
      note: existing?.note ?? existing?.metadata?.note ?? existing?.metadata?.summary ?? null,
      paragraphs: existing?.paragraphs ?? existing?.metadata?.paragraphs ?? []
    });
    const nextPageState = stableJson({
      title: built.title,
      note: built.note,
      paragraphs: built.paragraphs
    });
    const sameText = String(existing?.text || "").trim() === built.text;
    const sameCheckpoint = String(existing?.checkpointTurnExternalId || "") === String(nextCheckpoint || "");
    if (
      !(sameText && sameCheckpoint && currentPageState === nextPageState && Number(existing?.metadata?.position) === 0)
    ) {
      writes.push(await upsertConversationWikiPage({
        tenantId,
        collection,
        conversationId,
        page: built.page,
        title: built.title,
        note: built.note,
        paragraphs: built.paragraphs,
        sourceExchanges: nextSourceExchanges,
        checkpointTurnExternalId: nextCheckpoint,
        revision,
        pageMaxChars,
        principalId: principalId || existing?.memory?.principalId || null,
        visibility,
        acl,
        agentId: input.agentId || existing?.memory?.agentId || null,
        sourceType: input.sourceType || "conversation_wiki",
        policy,
        baseTags
      }));
    }
    const staleRecords = existingPages.filter((record) => !nextPageIds.has(record.page));
    if (staleRecords.length) {
      await Promise.all(staleRecords.map(async (record) => {
        const rawItem = await getMemoryItemByExternalId({
          tenantId,
          collection,
          externalId: buildConversationWikiExternalId(conversationId, record.page),
          principalId
        });
        if (!rawItem) return null;
        return deleteMemoryItemFully(rawItem, {
          reason: "conversation_wiki_rebuild_cleanup",
          requestId: `job:${jobId}`,
          source: "conversation_wiki_job"
        });
      }));
    }

    const pruneResult = await pruneConversationTurnsForWiki({
      tenantId,
      collection,
      conversationId,
      principalId,
      checkpointTurnExternalId: nextCheckpoint,
      keepRecentTurns,
      requestId: `job:${jobId}`
    });

    const effectivePageCount = nextPageIds.size;
    const writtenLastUpdatedAt = writes.reduce((latest, page) => {
      const timestamp = page?.updatedAt || page?.memory?.createdAt || null;
      if (!timestamp) return latest;
      if (!latest) return timestamp;
      return Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest;
    }, null) || getConversationWikiLastUpdatedAt(existingPages) || new Date().toISOString();
    recordConversationWikiMetrics(tenantId, {
      succeeded: 1,
      pagesUpdated: writes.length,
      turnsPruned: pruneResult.pruned,
      queuedDeletes: pruneResult.queued,
      lastPageCount: effectivePageCount,
      lastUpdatedAt: writtenLastUpdatedAt
    });
    emitConversationWikiTelemetry("succeeded", {
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      conversationId,
      source: "conversation_wiki_job"
    }, {
      updated: writes.length > 0,
      updated_pages: writes.map((page) => page.page),
      recent_turn_count: promptTurns.length,
      pruned_turns: pruneResult.pruned,
      queued_deletes: pruneResult.queued
    });

    await updateMemoryJob({
      id: job.id,
      status: "succeeded",
      output: {
        collection,
        conversationId,
        updated: writes.length > 0,
        updatedPages: writes.map((page) => page.page),
        pageCount: effectivePageCount,
        lastUpdatedAt: writtenLastUpdatedAt,
        checkpointTurnExternalId: nextCheckpoint,
        recentTurnCount: promptTurns.length,
        recentExchangeCount: promptExchangeCount,
        prunedTurns: pruneResult.pruned,
        queuedDeletes: pruneResult.queued
      }
    });
  } catch (err) {
    recordConversationWikiMetrics(tenantId, { failed: 1 });
    emitConversationWikiTelemetry("failed", {
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      conversationId,
      source: "conversation_wiki_job"
    }, {
      error: String(err?.message || err)
    });
    await finalizeJobFailure(job, err);
  } finally {
    if (wikiLock) {
      await releaseConversationWikiLock(wikiLock).catch(() => null);
    }
  }
}

async function runConversationMemoryClearJobWithDeps(deps, jobId, tenantId) {
  const claimJob = deps.claimMemoryJob || claimMemoryJob;
  const clearCollection = deps.clearConversationMemoryCollection || clearConversationMemoryCollection;
  const updateJob = deps.updateMemoryJob || updateMemoryJob;
  const finalizeFailure = deps.finalizeJobFailure || finalizeJobFailure;
  const createAudit = deps.createAuditLog || createAuditLog;
  const job = await claimJob({ id: jobId, tenantId });
  if (!job) return;
  let collection = null;
  try {
    const input = parseJsonPayload(job.input) || {};
    collection = normalizeCollection(input.collection);
    if (!collection) {
      recordConversationWikiMetrics(tenantId, { failed: 1 });
      await finalizeJobFailure(job, "collection is required", { retryable: false });
      return;
    }
    const requestId = String(input.requestId || "").trim() || `job:${jobId}`;
    const source = String(input.source || "").trim() || "conversation_wiki_job";
    const cleared = await clearCollection({
      tenantId,
      collection,
      requestId,
      source
    });
    recordConversationWikiMetrics(tenantId, {
      lastPageCount: 0,
      lastUpdatedAt: new Date().toISOString()
    });
    emitConversationWikiTelemetry("cleared_collection", {
      requestId,
      tenantId,
      collection,
      source
    }, {
      conversation_count: cleared.conversationCount,
      memory_item_count: cleared.memoryItemCount,
      deleted_count: cleared.deletedCount,
      queued_count: cleared.queuedCount,
      deleted_job_count: cleared.deletedJobCount
    });
    await createAudit({
      tenantId,
      actorId: "system",
      actorType: "system",
      action: "conversation_wiki.cleared",
      targetType: "collection",
      targetId: collection,
      metadata: {
        conversationCount: cleared.conversationCount,
        memoryItemCount: cleared.memoryItemCount,
        deletedCount: cleared.deletedCount,
        queuedCount: cleared.queuedCount,
        deletedJobCount: cleared.deletedJobCount,
        deletedVectors: cleared.deletedVectors
      },
      requestId,
      ip: null
    });
    await updateJob({
      id: job.id,
      status: "succeeded",
      output: cleared
    });
  } catch (err) {
    recordConversationWikiMetrics(tenantId, { failed: 1 });
    emitConversationWikiTelemetry("clear_collection_failed", {
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      source: "conversation_wiki_job"
    }, {
      error: String(err?.message || err)
    });
    await finalizeFailure(job, err, {
      retryable: err?.status !== 400
    });
  }
}

async function runConversationMemoryClearJob(jobId, tenantId) {
  return runConversationMemoryClearJobWithDeps({}, jobId, tenantId);
}

async function runReflectionJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  try {

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const types = Array.isArray(input.types) ? input.types : [];
    const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : undefined;
    const requestedPolicy = resolveRequestedMemoryPolicy(input, null);
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;
    const requestedVisibility = input.visibility ? normalizeVisibility(input.visibility) : null;
    const requestedAcl = input.acl;

    let sourceItem = null;
    let sourceType = null;
    if (input.conversationId) {
      sourceItem = await getMemoryItemById(input.conversationId, tenantId, principalId);
      sourceType = "conversation";
    } else if (input.artifactId) {
      sourceItem = await getMemoryItemById(input.artifactId, tenantId, principalId);
      sourceType = "artifact";
    } else if (input.docId) {
      sourceItem = await getArtifactByExternalId(tenantId, collection, input.docId, principalId);
      sourceType = "artifact";
    }

    if (!sourceItem) {
      const message = sourceType === "conversation" ? "Conversation not found" : "Artifact not found";
      await finalizeJobFailure(job, message, { retryable: false });
      return;
    }
    if (sourceType === "artifact" && sourceItem.item_type !== "artifact") {
      await finalizeJobFailure(job, "Item is not an artifact", { retryable: false });
      return;
    }
    if (sourceType === "conversation" && sourceItem.item_type !== "conversation") {
      await finalizeJobFailure(job, "Item is not a conversation", { retryable: false });
      return;
    }

    const derivedAgentId = sourceItem.agent_id || null;
    const derivedTags = Array.isArray(sourceItem.tags) && sourceItem.tags.length ? sourceItem.tags : null;

    let text = await loadArtifactText(sourceItem.namespace_id);
    if (!text.trim()) {
      const message = sourceType === "conversation"
        ? "Conversation has no text chunks"
        : "Artifact has no text chunks";
      await finalizeJobFailure(job, message, { retryable: false });
      return;
    }

    if (text.length > MAX_REFLECT_CHARS) {
      text = text.slice(0, MAX_REFLECT_CHARS);
    }

    const tenantModels = await getEffectiveTenantModels(tenantId);
    const reflection = await reflectMemories({
      text,
      types,
      maxItems,
      reflectProvider: tenantModels.reflectProvider,
      reflectModel: tenantModels.reflectModel
    });
    recordGenerationUsage(tenantId, reflection?.usage, buildTelemetryContext({
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      source: "job_reflection_generation"
    }));

    const expectedExternalIds = [];
    const typeMap = {
      semantic: reflection.semantic || [],
      procedural: reflection.procedural || [],
      summary: reflection.summary || []
    };
    for (const [type, items] of Object.entries(typeMap)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      for (let i = 0; i < items.length; i += 1) {
        expectedExternalIds.push(`job:${jobId}:${type}:${i + 1}`);
      }
    }
    await cleanupJobDerivedItems({ jobId, tenantId, collection, expectedExternalIds });

    const ownerId = principalId || sourceItem.principal_id || null;
    const derivedPolicy = requestedPolicy || getMemoryPolicy(sourceItem);
    const resolvedVisibility = requestedVisibility || sourceItem.visibility || "tenant";
    const aclList = resolvedVisibility === "acl"
      ? normalizeAclList(requestedAcl || sourceItem.acl_principals || [], ownerId)
      : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const created = [];

    for (const [type, items] of Object.entries(typeMap)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] || {};
        const content = String(item.content || "").trim();
        if (!content) continue;

        const memoryId = crypto.randomUUID();
        const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);
        const externalId = `job:${jobId}:${type}:${i + 1}`;

        const memory = await upsertMemoryItem({
          tenantId,
          collection,
          itemType: type,
          externalId,
          namespaceId,
          itemId: memoryId,
          title: item.title || null,
          sourceType: "reflection",
          sourceUrl: null,
          metadata: buildStoredMemoryMetadata({
            origin: "reflect",
            artifactId: sourceType === "artifact" ? sourceItem.id : null,
            conversationId: sourceType === "conversation" ? sourceItem.id : null,
            jobId,
            type
          }, content, derivedPolicy),
          principalId: ownerId,
          agentId: derivedAgentId,
          tags: derivedTags,
          visibility: resolvedVisibility,
          acl: aclList
        });

        const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
        if (cleanup.failed > 0) {
          throw new Error(`Failed to delete vectors for memory ${memory.id}`);
        }

        await indexMemoryText(memory.namespace_id, content, {
          telemetry: buildTelemetryContext({
            requestId: `job:${jobId}`,
            tenantId,
            collection,
            source: "job_reflection_index"
          })
        });
        scheduleRedundancyUpdate(memory);
        await createMemoryLink({
          tenantId,
          fromItemId: memory.id,
          toItemId: sourceItem.id,
          relation: "derived_from",
          metadata: { jobId, type }
        });

        created.push({
          id: memory.id,
          namespaceId: memory.namespace_id,
          type: memory.item_type,
          title: memory.title || null
        });
      }
    }

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        artifactId: sourceType === "artifact" ? sourceItem.id : null,
        conversationId: sourceType === "conversation" ? sourceItem.id : null,
        createdCount: created.length,
        created
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

async function runTtlCleanupJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;

  try {
    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const before = parseTimeInput(input.before || new Date().toISOString(), "before");
    const limit = parseInt(input.limit || "200", 10);
    const dryRun = Boolean(input.dryRun);
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("limit must be a positive number");
    }

    const items = await listExpiredMemoryItems({
      tenantId,
      collection,
      before,
      limit,
      principalId
    });

    let vectorsDeleted = 0;
    let itemsDeleted = 0;
    let vectorFailures = 0;
    let queuedDeletes = 0;

    if (!dryRun) {
      for (const item of items) {
        const result = await deleteMemoryItemFully(item, { reason: "ttl_cleanup" });
        if (result?.deleted) {
          itemsDeleted += 1;
          vectorsDeleted += result.vectorsDeleted || 0;
        } else if (result?.failed) {
          vectorFailures += result.failed;
        }
        if (result?.queued) {
          queuedDeletes += 1;
        }
      }
    }

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        collection,
        before,
        dryRun,
        matched: items.length,
        itemsDeleted,
        vectorsDeleted,
        vectorFailures,
        queuedDeletes
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

async function runCompactionJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  try {

    const input = parseJsonPayload(job.input) || {};
    const collection = normalizeCollection(input.collection);
    const typeFilter = parseTypeFilter(input.types);
    const types = typeFilter.length
      ? typeFilter
      : ["semantic", "procedural", "summary", "episodic", "conversation", "memory"];
    const since = input.since ? parseTimeInput(input.since, "since") : null;
    const until = input.until ? parseTimeInput(input.until, "until") : null;
    const limit = parseInt(input.maxItems || "25", 10);
    const summaryType = normalizeItemType(input.summaryType || "summary");
    const deleteOriginals = Boolean(input.deleteOriginals);
    const requestedPolicy = resolveRequestedMemoryPolicy(input, null);
    const principalId = input.principalId && PRINCIPAL_RE.test(String(input.principalId).trim())
      ? String(input.principalId).trim()
      : null;
    const requestedVisibility = input.visibility ? normalizeVisibility(input.visibility) : null;
    const requestedAcl = input.acl;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("maxItems must be a positive number");
    }

    const items = await listMemoryItemsForCompaction({
      tenantId,
      collection,
      types,
      since,
      until,
      limit,
      principalId
    });

    if (!items.length) {
      await updateMemoryJob({
        id: jobId,
        status: "succeeded",
        output: { createdCount: 0, sourceCount: 0, collection }
      });
      return;
    }

    const parts = [];
    const included = [];
    let total = 0;
    for (const item of items) {
      const text = await loadArtifactText(item.namespace_id);
      if (!text.trim()) continue;
      const header = item.title ? `${item.title}` : `${item.item_type}:${item.id}`;
      const block = `# ${header}\n${text}`;
      if (total + block.length > MAX_COMPACT_CHARS) break;
      parts.push(block);
      included.push(item);
      total += block.length;
    }

    if (!parts.length) {
      await finalizeJobFailure(job, "No memory text available for compaction", { retryable: false });
      return;
    }

    const combined = parts.join("\n\n---\n\n");
    const tenantModels = await getEffectiveTenantModels(tenantId);
    const summary = await summarizeMemories({
      text: combined,
      reflectProvider: tenantModels.reflectProvider,
      reflectModel: tenantModels.reflectModel,
      compactProvider: tenantModels.compactProvider,
      compactModel: tenantModels.compactModel
    });
    recordGenerationUsage(tenantId, summary?.usage, buildTelemetryContext({
      requestId: `job:${jobId}`,
      tenantId,
      collection,
      source: "job_compaction_generation"
    }));
    if (!summary.content) {
      await finalizeJobFailure(job, "Compaction produced empty summary", { retryable: false });
      return;
    }

    await cleanupJobDerivedItems({
      jobId,
      tenantId,
      collection,
      expectedExternalIds: [`job:${jobId}:compaction`]
    });

    const ownerId = principalId || (included[0]?.principal_id || null);
    let summaryPolicy = requestedPolicy;
    if (!summaryPolicy && included.length) {
      const basePolicy = getMemoryPolicy(included[0]);
      const samePolicy = included.every((item) => getMemoryPolicy(item) === basePolicy);
      summaryPolicy = samePolicy ? basePolicy : DEFAULT_MEMORY_POLICY;
    }
    let resolvedVisibility = requestedVisibility;
    let resolvedAcl = requestedAcl;
    if (!resolvedVisibility && included.length) {
      const baseVisibility = included[0].visibility || "tenant";
      const sameVisibility = included.every(item => (item.visibility || "tenant") === baseVisibility);
      if (sameVisibility) {
        resolvedVisibility = baseVisibility;
        if (baseVisibility === "acl") {
          const baseAcl = (included[0].acl_principals || []).slice().sort().join(",");
          const sameAcl = included.every(item => (item.acl_principals || []).slice().sort().join(",") === baseAcl);
          if (sameAcl) {
            resolvedAcl = included[0].acl_principals || [];
          } else {
            resolvedVisibility = "private";
            resolvedAcl = [];
          }
        }
      } else {
        resolvedVisibility = "private";
        resolvedAcl = [];
      }
    }

    resolvedVisibility = normalizeVisibility(resolvedVisibility);
    const aclList = resolvedVisibility === "acl" ? normalizeAclList(resolvedAcl || [], ownerId) : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const memoryId = crypto.randomUUID();
    const namespaceId = namespaceDocId(tenantId, collection, `mem_${memoryId}`);
    const externalId = `job:${jobId}:compaction`;

    const memory = await upsertMemoryItem({
      tenantId,
      collection,
      itemType: summaryType,
      externalId,
      namespaceId,
      itemId: memoryId,
      title: summary.title || "Compacted memory",
      sourceType: "compaction",
      sourceUrl: null,
      metadata: buildStoredMemoryMetadata({
        origin: "compaction",
        jobId,
        sourceCount: included.length,
        types
      }, summary.content, summaryPolicy),
      principalId: ownerId,
      visibility: resolvedVisibility,
      acl: aclList
    });

    const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
    if (cleanup.failed > 0) {
      throw new Error(`Failed to delete vectors for memory ${memory.id}`);
    }

    await indexMemoryText(memory.namespace_id, summary.content, {
      telemetry: buildTelemetryContext({
        requestId: `job:${jobId}`,
        tenantId,
        collection,
        source: "job_compaction_index"
      })
    });
    scheduleRedundancyUpdate(memory);

    for (const item of included) {
      await createMemoryLink({
        tenantId,
        fromItemId: memory.id,
        toItemId: item.id,
        relation: "compacted_from",
        metadata: { jobId }
      });
    }

    let vectorsDeleted = 0;
    let deletedCount = 0;
    let vectorFailures = 0;
    let queuedDeletes = 0;
    if (deleteOriginals) {
      for (const item of included) {
        const result = await deleteMemoryItemFully(item, {
          reason: "compaction_job",
          requestId: `job:${jobId}`,
          source: "job_compaction"
        });
        if (result?.deleted) {
          vectorsDeleted += result.vectorsDeleted || 0;
          deletedCount += 1;
        } else if (result?.failed) {
          vectorFailures += result.failed;
        }
        if (result?.queued) {
          queuedDeletes += 1;
        }
      }
    }

    emitLifecycleActionTelemetry("compact", memory, {
      status: "created",
      reason: "compaction_job",
      source_count: included.length,
      source_memory_ids: included.map((item) => item.id),
      deleted_originals: deletedCount,
      vector_failures: vectorFailures,
      queued_delete_reconciles: queuedDeletes
    }, {
      requestId: `job:${jobId}`,
      source: "job_compaction"
    });

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        collection,
        summaryId: memory.id,
        createdCount: 1,
        sourceCount: included.length,
        deletedCount,
        vectorsDeleted,
        vectorFailures,
        queuedDeletes
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

async function runDeleteReconcileJob(jobId, tenantId) {
  const job = await claimMemoryJob({ id: jobId, tenantId });
  if (!job) return;
  try {
    const input = parseJsonPayload(job.input) || {};
    const memoryId = input.memoryId || null;
    let namespaceId = input.namespaceId || null;

    let memory = null;
    if (!namespaceId && memoryId) {
      memory = await getMemoryItemById(memoryId, tenantId, null);
      namespaceId = memory?.namespace_id || null;
    }

    if (!namespaceId) {
      throw new Error("Missing namespaceId for delete reconcile");
    }

    const result = await deleteVectorsForDoc(namespaceId, { strict: true });
    if (result.failed > 0) {
      throw new Error(`Failed to delete vectors for memory ${memoryId || namespaceId}`);
    }

    let dbDeleted = 0;
    if (memoryId) {
      await deleteMemoryItemById(memoryId);
      dbDeleted = 1;
    }
    scheduleStorageUsageMeter(tenantId, buildTelemetryContext({
      requestId: `job:${jobId}`,
      tenantId,
      collection: input.collection || memory?.collection || null,
      source: "delete_reconcile_job"
    }), {
      operation: "delete_reconcile",
      memoryId,
      namespaceId,
      vectorsDeleted: result.deleted,
      dbDeleted
    });

    await updateMemoryJob({
      id: jobId,
      status: "succeeded",
      output: {
        memoryId,
        namespaceId,
        vectorsDeleted: result.deleted,
        dbDeleted
      }
    });
  } catch (err) {
    await finalizeJobFailure(job, err);
  }
}

function isExpiredMemory(item, now = new Date()) {
  if (!item?.expires_at) return false;
  return new Date(item.expires_at) <= now;
}

function visibilitySignature(item) {
  const visibility = item?.visibility || "tenant";
  if (visibility === "tenant") return "tenant";
  const acl = Array.isArray(item?.acl_principals) ? item.acl_principals.slice().sort().join(",") : "";
  const principal = item?.principal_id || "";
  return `${visibility}|${principal}|${acl}`;
}

async function deleteMemoryItemFully(item, options = {}) {
  if (!item?.id || !item?.namespace_id) {
    return { deleted: false, queued: false, skipped: "missing" };
  }
  const result = await deleteVectorsForDoc(item.namespace_id, { strict: true });
  if (result.failed > 0) {
    const job = await enqueueDeleteReconcileJob(item, options.reason, result.failed);
    console.warn(`[delete] vdel failed memory=${item.id} failed=${result.failed} job=${job?.id || "none"}`);
    emitLifecycleActionTelemetry("delete", item, {
      status: "queued_reconcile",
      reason: options.reason || null,
      vectors_deleted: result.deleted || 0,
      vector_failures: result.failed || 0,
      reconcile_job_id: job?.id || null
    }, {
      requestId: options.requestId || null,
      source: options.source || "delete"
    });
    return {
      deleted: false,
      queued: Boolean(job),
      failed: result.failed,
      vectorsDeleted: result.deleted,
      jobId: job?.id || null
    };
  }
  await deleteDoc(item.namespace_id);
  await deleteMemoryItemById(item.id);
  scheduleStorageUsageMeter(item.tenant_id, buildTelemetryContext({
    requestId: options.requestId || null,
    tenantId: item.tenant_id,
    collection: item.collection || null,
    source: options.source || "delete"
  }), {
    operation: "memory_delete",
    memoryId: item.id,
    namespaceId: item.namespace_id,
    reason: options.reason || null,
    vectorsDeleted: result.deleted || 0
  });
  emitLifecycleActionTelemetry("delete", item, {
    status: "deleted",
    reason: options.reason || null,
    vectors_deleted: result.deleted || 0
  }, {
    requestId: options.requestId || null,
    source: options.source || "delete"
  });
  return { deleted: true, queued: false, failed: 0, vectorsDeleted: result.deleted };
}

async function ensureValueScore(item) {
  if (!item) return null;
  const policy = getMemoryPolicy(item);
  const nowMs = Date.now();
  const previousTier = normalizeTier(item.tier, "WARM");
  const existingValue = Number(item.value_score);
  if (!Number.isFinite(existingValue)) {
    item.value_score = resolveInitialValueScore(policy);
    item.tier = normalizeTier(item.tier, "WARM");
    item.value_last_update_ts = nowMs;
    item.tier_last_update_ts = nowMs;
  }
  const valueUpdate = buildValueUpdateForMemory(item, "retrieved", 0, nowMs, {
    policy,
    decayOnly: true
  });
  const updated = await updateMemoryItemMetrics({
    id: item.id,
    tenantId: item.tenant_id,
    valueScore: valueUpdate.valueScore,
    tier: valueUpdate.tier,
    valueLastUpdateTs: valueUpdate.valueLastUpdateTs,
    tierLastUpdateTs: valueUpdate.tierLastUpdateTs
  });
  if (updated) {
    item.value_score = updated.value_score;
    item.tier = updated.tier;
    item.value_last_update_ts = updated.value_last_update_ts;
    item.tier_last_update_ts = updated.tier_last_update_ts;
  } else {
    item.value_score = valueUpdate.valueScore;
    item.tier = valueUpdate.tier;
    item.value_last_update_ts = valueUpdate.valueLastUpdateTs;
    item.tier_last_update_ts = valueUpdate.tierLastUpdateTs;
  }
  emitTierTransitionTelemetry(item, previousTier, item.tier, {
    reason: "value_decay",
    value_score: item.value_score
  }, {
    source: "lifecycle_value_decay"
  });
  return item.value_score;
}

async function loadMemoryTextSnippet(item, limit) {
  const text = await loadArtifactText(item.namespace_id);
  if (!text || !text.trim()) return "";
  const cap = Number.isFinite(limit) && limit > 0 ? limit : MAX_COMPACT_CHARS;
  return text.length > cap ? text.slice(0, cap) : text;
}

async function isRecentExternalPrefix({ tenantId, collection, prefix, cooldownHours }) {
  const items = await listMemoryItemsByExternalPrefix({ tenantId, collection, prefix });
  if (!items.length) return false;
  const maxAgeMs = Number.isFinite(cooldownHours) && cooldownHours > 0 ? cooldownHours * 3600000 : 0;
  if (!maxAgeMs) return false;
  const now = Date.now();
  return items.some(item => item.created_at && now - new Date(item.created_at).getTime() < maxAgeMs);
}

async function promoteMemoryItem(item, options = {}) {
  if (!item) return { created: 0 };
  const policy = getMemoryPolicy(item);
  const cooldownHit = await isRecentExternalPrefix({
    tenantId: item.tenant_id,
    collection: item.collection,
    prefix: `promote:${item.id}:`,
    cooldownHours: MEMORY_PROMOTION_COOLDOWN_HOURS
  });
  if (cooldownHit) return { created: 0, skipped: "cooldown" };

  let text = await loadMemoryTextSnippet(item, MAX_REFLECT_CHARS);
  if (!text.trim()) return { created: 0, skipped: "empty" };

  const tenantModels = await getEffectiveTenantModels(item.tenant_id);
  const reflection = await reflectMemories({
    text,
    types: ["semantic", "procedural"],
    maxItems: MEMORY_PROMOTION_MAX_ITEMS,
    reflectProvider: tenantModels.reflectProvider,
    reflectModel: tenantModels.reflectModel
  });
  recordGenerationUsage(item.tenant_id, reflection?.usage, buildTelemetryContext({
    requestId: options.requestId || null,
    tenantId: item.tenant_id,
    collection: item.collection,
    source: "promotion_generation"
  }));

  const expectedExternalIds = [];
  const typeMap = {
    semantic: reflection.semantic || [],
    procedural: reflection.procedural || []
  };
  for (const [type, items] of Object.entries(typeMap)) {
    for (let i = 0; i < items.length; i += 1) {
      expectedExternalIds.push(`promote:${item.id}:${type}:${i + 1}`);
    }
  }

  await cleanupExternalItems({
    tenantId: item.tenant_id,
    collection: item.collection,
    prefix: `promote:${item.id}:`,
    expectedExternalIds
  });

  const created = [];
  for (const [type, items] of Object.entries(typeMap)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i] || {};
      const content = String(entry.content || "").trim();
      if (!content) continue;

      const memoryId = crypto.randomUUID();
      const namespaceId = namespaceDocId(item.tenant_id, item.collection, `mem_${memoryId}`);
      const externalId = `promote:${item.id}:${type}:${i + 1}`;

      const memory = await upsertMemoryItem({
        tenantId: item.tenant_id,
        collection: item.collection,
        itemType: type,
        externalId,
        namespaceId,
        itemId: memoryId,
        title: entry.title || null,
        sourceType: "promotion",
        sourceUrl: null,
        metadata: buildStoredMemoryMetadata({
          origin: "promotion",
          sourceId: item.id,
          type
        }, content, policy),
        principalId: item.principal_id || null,
        agentId: item.agent_id || null,
        tags: Array.isArray(item.tags) ? item.tags : null,
        visibility: item.visibility || "tenant",
        acl: Array.isArray(item.acl_principals) ? item.acl_principals : []
      });

      const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
      if (cleanup.failed > 0) {
        throw new Error(`Failed to delete vectors for memory ${memory.id}`);
      }

      await indexMemoryText(memory.namespace_id, content, {
        telemetry: buildTelemetryContext({
          requestId: options.requestId || null,
          tenantId: item.tenant_id,
          collection: item.collection,
          source: "promotion_index"
        })
      });
      scheduleRedundancyUpdate(memory);
      await createMemoryLink({
        tenantId: item.tenant_id,
        fromItemId: memory.id,
        toItemId: item.id,
        relation: "promoted_from",
        metadata: { origin: "promotion" }
      });
      created.push(memory.id);
    }
  }

  if (created.length > 0) {
    emitLifecycleActionTelemetry("promote", item, {
      status: "created",
      reason: options.reason || "value_threshold",
      created_count: created.length,
      created_memory_ids: created
    }, {
      requestId: options.requestId || null,
      source: options.source || "promotion"
    });
  }

  return { created: created.length };
}

async function compactLowValueGroup(seed, options = {}) {
  if (!seed) return { created: 0 };
  const policy = getMemoryPolicy(seed);
  const cooldownHit = await isRecentExternalPrefix({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    prefix: `compact:${seed.id}:`,
    cooldownHours: MEMORY_COMPACT_COOLDOWN_HOURS
  });
  if (cooldownHit) return { created: 0, skipped: "cooldown" };

  const seedText = await loadMemoryTextSnippet(seed, MEMORY_REDUNDANCY_QUERY_CHARS);
  if (!seedText.trim()) return { created: 0, skipped: "empty" };

  const results = await searchChunks({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    query: seedText,
    k: MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE,
    docIds: [],
    principalId: null,
    privileges: null,
    candidateTypes: MEMORY_TYPES.filter(t => t !== "artifact"),
    tags: seed.tags || null,
    agentId: seed.agent_id || null,
    policy,
    telemetry: buildTelemetryContext({
      requestId: options.requestId || null,
      tenantId: seed.tenant_id,
      collection: seed.collection,
      source: "lifecycle_compaction_search"
    })
  });

  const namespaceIds = results.map(r => r._row.doc_id);
  const memoryMap = await getMemoryItemsByNamespaceIds({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    namespaceIds,
    types: MEMORY_TYPES.filter(t => t !== "artifact"),
    excludeExpired: true
  });

  const signature = visibilitySignature(seed);
  const group = [];
  const seen = new Set();

  for (const r of results) {
    const mem = memoryMap.get(r._row.doc_id);
    if (!mem) continue;
    if (seen.has(mem.id)) continue;
    if (mem.pinned) continue;
    if (mem.value_score !== null && mem.value_score !== undefined) {
      const score = Number(mem.value_score);
      if (Number.isFinite(score) && score >= MEMORY_LIFECYCLE_SUMMARY_THRESHOLD) continue;
    }
    if (visibilitySignature(mem) !== signature) continue;
    seen.add(mem.id);
    group.push(mem);
    if (group.length >= MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE) break;
  }

  if (group.length === 0) {
    group.push(seed);
  }

  const parts = [];
  const included = [];
  let total = 0;
  for (const item of group) {
    const text = await loadArtifactText(item.namespace_id);
    if (!text.trim()) continue;
    const header = item.title ? `${item.title}` : `${item.item_type}:${item.id}`;
    const block = `# ${header}\n${text}`;
    if (total + block.length > MAX_COMPACT_CHARS) break;
    parts.push(block);
    included.push(item);
    total += block.length;
  }

  if (!parts.length) return { created: 0, skipped: "empty" };

  const combined = parts.join("\n\n---\n\n");
  const tenantModels = await getEffectiveTenantModels(seed.tenant_id);
  const summary = await summarizeMemories({
    text: combined,
    reflectProvider: tenantModels.reflectProvider,
    reflectModel: tenantModels.reflectModel,
    compactProvider: tenantModels.compactProvider,
    compactModel: tenantModels.compactModel
  });
  recordGenerationUsage(seed.tenant_id, summary?.usage, buildTelemetryContext({
    requestId: options.requestId || null,
    tenantId: seed.tenant_id,
    collection: seed.collection,
    source: "lifecycle_compaction_generation"
  }));
  if (!summary.content) return { created: 0, skipped: "empty" };

  await cleanupExternalItems({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    prefix: `compact:${seed.id}:`,
    expectedExternalIds: [`compact:${seed.id}:summary`]
  });

  const ownerId = seed.principal_id || null;
  const visibility = seed.visibility || "tenant";
  const aclList = visibility === "acl" ? (seed.acl_principals || []) : [];

  const memoryId = crypto.randomUUID();
  const namespaceId = namespaceDocId(seed.tenant_id, seed.collection, `mem_${memoryId}`);
  const externalId = `compact:${seed.id}:summary`;

  const memory = await upsertMemoryItem({
    tenantId: seed.tenant_id,
    collection: seed.collection,
    itemType: "summary",
    externalId,
    namespaceId,
    itemId: memoryId,
    title: summary.title || "Compacted memory",
    sourceType: "lifecycle_compaction",
    sourceUrl: null,
    metadata: buildStoredMemoryMetadata({
      origin: "lifecycle_compaction",
      sourceCount: included.length,
      seedId: seed.id
    }, summary.content, policy),
    principalId: ownerId,
    visibility,
    acl: aclList
  });

  const cleanup = await deleteVectorsForDoc(memory.namespace_id, { strict: true });
  if (cleanup.failed > 0) {
    throw new Error(`Failed to delete vectors for memory ${memory.id}`);
  }

  await indexMemoryText(memory.namespace_id, summary.content, {
    telemetry: buildTelemetryContext({
      requestId: options.requestId || null,
      tenantId: seed.tenant_id,
      collection: seed.collection,
      source: "lifecycle_compaction_index"
    })
  });
  scheduleRedundancyUpdate(memory);

  for (const item of included) {
    await createMemoryLink({
      tenantId: seed.tenant_id,
      fromItemId: memory.id,
      toItemId: item.id,
      relation: "compacted_from",
      metadata: { origin: "lifecycle_compaction" }
    });
  }

  let deletedOriginals = 0;
  let queuedOriginalDeletes = 0;
  if (MEMORY_LIFECYCLE_COMPACT_DELETE_ORIGINALS) {
    const deleteBudget = options.deleteBudget || null;
    if (deleteBudget && !canConsumeDeleteBudget(deleteBudget, included.length)) {
      console.warn(`[lifecycle] delete cap reached; skipping delete of compacted originals count=${included.length}`);
    } else {
      if (deleteBudget) consumeDeleteBudget(deleteBudget, included.length);
      for (const item of included) {
        const result = await deleteMemoryItemFully(item, {
          reason: "compaction_original",
          requestId: options.requestId || null,
          source: "lifecycle_compaction"
        });
        if (result?.deleted) {
          deletedOriginals += 1;
        }
        if (result?.queued) {
          queuedOriginalDeletes += 1;
          console.warn(`[lifecycle] queued delete reconcile for compacted item id=${item.id}`);
        }
      }
    }
  }

  emitLifecycleActionTelemetry("compact", seed, {
    status: "created",
    reason: options.reason || "low_value",
    summary_memory_id: memory.id,
    source_count: included.length,
    source_memory_ids: included.map((item) => item.id),
    deleted_originals: deletedOriginals,
    queued_delete_reconciles: queuedOriginalDeletes
  }, {
    requestId: options.requestId || null,
    source: options.source || "lifecycle_compaction"
  });

  return { created: 1, sourceCount: included.length };
}

async function runValueDecayOnce() {
  if (valueDecayRunning) return;
  valueDecayRunning = true;
  const batchSize = Number.isFinite(MEMORY_VALUE_BATCH_SIZE) && MEMORY_VALUE_BATCH_SIZE > 0 ? MEMORY_VALUE_BATCH_SIZE : 200;
  const maxItems = Number.isFinite(MEMORY_VALUE_MAX_ITEMS) && MEMORY_VALUE_MAX_ITEMS > 0 ? MEMORY_VALUE_MAX_ITEMS : 0;
  let processed = 0;
  let afterId = null;
  let updated = 0;
  try {
    while (true) {
      const items = await listMemoryItemsForValueDecay({ limit: batchSize, afterId });
      if (!items.length) break;
      for (const item of items) {
        const policy = getMemoryPolicy(item);
        if (!resolveMemoryPolicyConfig(policy).valueDecayLoopEnabled) {
          processed += 1;
          if (maxItems && processed >= maxItems) break;
          continue;
        }
        const previousTier = normalizeTier(item.tier, "WARM");
        const nowMs = Date.now();
        const valueUpdate = buildValueUpdateForMemory(item, "retrieved", 0, nowMs, {
          policy,
          decayOnly: true
        });
        await updateMemoryItemMetrics({
          id: item.id,
          tenantId: item.tenant_id,
          valueScore: valueUpdate.valueScore,
          tier: valueUpdate.tier,
          valueLastUpdateTs: valueUpdate.valueLastUpdateTs,
          tierLastUpdateTs: valueUpdate.tierLastUpdateTs
        });
        emitTierTransitionTelemetry(item, previousTier, valueUpdate.tier, {
          reason: "value_decay",
          value_score: valueUpdate.valueScore
        }, {
          source: "value_decay"
        });
        updated += 1;
        processed += 1;
        if (maxItems && processed >= maxItems) break;
      }
      afterId = items[items.length - 1].id;
      if (items.length < batchSize) break;
      if (maxItems && processed >= maxItems) break;
    }
    if (updated) {
      console.log(`[value] decay updated=${updated}`);
    }
  } catch (err) {
    console.warn("[value] decay failed:", err?.message || err);
  } finally {
    valueDecayRunning = false;
  }
}

function scheduleValueDecay() {
  if (!Number.isFinite(MEMORY_VALUE_DECAY_INTERVAL_MS) || MEMORY_VALUE_DECAY_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runValueDecayOnce().catch(() => {});
    setInterval(() => {
      runValueDecayOnce().catch(() => {});
    }, MEMORY_VALUE_DECAY_INTERVAL_MS);
  }, 2500);
}

async function computeRedundancyForItem(item) {
  if (!item || !item.id) return { updated: false, skipped: "missing" };
  if (item.item_type === "artifact") return { updated: false, skipped: "artifact" };
  if (isExpiredMemory(item)) return { updated: false, skipped: "expired" };
  const policy = getMemoryPolicy(item);
  if (!resolveMemoryPolicyConfig(policy).redundancyEnabled) {
    return { updated: false, skipped: "policy" };
  }

  const queryText = await loadMemoryTextSnippet(item, MEMORY_REDUNDANCY_QUERY_CHARS);
  if (!queryText.trim()) return { updated: false, skipped: "empty" };

  const results = await searchChunks({
    tenantId: item.tenant_id,
    collection: item.collection,
    query: queryText,
    k: MEMORY_REDUNDANCY_TOP_K + 1,
    docIds: [],
    principalId: null,
    privileges: null,
    candidateTypes: MEMORY_TYPES.filter(t => t !== "artifact"),
    tags: item.tags || null,
    agentId: item.agent_id || null,
    policy
  });

  const namespaceIds = results.map(r => r._row.doc_id);
  const memoryMap = await getMemoryItemsByNamespaceIds({
    tenantId: item.tenant_id,
    collection: item.collection,
    namespaceIds,
    types: MEMORY_TYPES.filter(t => t !== "artifact"),
    excludeExpired: true
  });

  const seen = new Set([item.id]);
  const scores = [];
  for (const r of results) {
    const mem = memoryMap.get(r._row.doc_id);
    if (!mem || seen.has(mem.id)) continue;
    seen.add(mem.id);
    scores.push(r.score);
    if (scores.length >= MEMORY_REDUNDANCY_TOP_K) break;
  }

  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const redundancyScore = clampNumber(avg, 0, 1);
  const updated = await updateMemoryItemMetrics({
    id: item.id,
    tenantId: item.tenant_id,
    redundancyScore
  });
  return { updated: Boolean(updated), redundancyScore };
}

async function runRedundancyOnce() {
  if (redundancyRunning) return;
  redundancyRunning = true;
  const batchSize = Number.isFinite(MEMORY_REDUNDANCY_BATCH_SIZE) && MEMORY_REDUNDANCY_BATCH_SIZE > 0 ? MEMORY_REDUNDANCY_BATCH_SIZE : 100;
  let afterId = null;
  let updated = 0;
  try {
    while (true) {
      const items = await listMemoryItemsForRedundancy({ limit: batchSize, afterId });
      if (!items.length) break;
      for (const item of items) {
        const result = await computeRedundancyForItem(item);
        if (result?.updated) updated += 1;
      }
      afterId = items[items.length - 1].id;
      if (items.length < batchSize) break;
    }
    if (updated) {
      console.log(`[redundancy] updated=${updated}`);
    }
  } catch (err) {
    console.warn("[redundancy] sweep failed:", err?.message || err);
  } finally {
    redundancyRunning = false;
  }
}

function scheduleRedundancySweep() {
  if (!Number.isFinite(MEMORY_REDUNDANCY_INTERVAL_MS) || MEMORY_REDUNDANCY_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runRedundancyOnce().catch(() => {});
    setInterval(() => {
      runRedundancyOnce().catch(() => {});
    }, MEMORY_REDUNDANCY_INTERVAL_MS);
  }, 3000);
}

async function runLifecycleOnce() {
  if (lifecycleRunning) return;
  lifecycleRunning = true;
  const lifecycleRequestId = isTelemetryEnabled() ? createTelemetryRequestId("lifecycle") : null;
  const batchSize = Number.isFinite(MEMORY_LIFECYCLE_BATCH_SIZE) && MEMORY_LIFECYCLE_BATCH_SIZE > 0 ? MEMORY_LIFECYCLE_BATCH_SIZE : 50;
  const now = new Date();
  const deleteBudget = createDeleteBudget(MEMORY_LIFECYCLE_MAX_DELETES);
  let afterId = null;
  let deleted = 0;
  let queuedDeletes = 0;
  let summarized = 0;
  let promoted = 0;
  try {
    while (true) {
      const items = await listMemoryItemsForLifecycle({ limit: batchSize, afterId });
      if (!items.length) break;
      for (const item of items) {
        const policy = getMemoryPolicy(item);
        const policyConfig = resolveMemoryPolicyConfig(policy);
        if (!policyConfig.lifecycleEnabled) {
          emitLifecycleActionTelemetry("retain", item, {
            reason: "policy_disabled",
            policy
          }, {
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          continue;
        }
        if (isExpiredMemory(item, now)) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=delete id=${item.id} reason=expired`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "delete_expired"
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          if (!consumeDeleteBudget(deleteBudget, 1)) {
            console.warn(`[lifecycle] delete cap reached; skipping expired delete id=${item.id}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "delete_budget_exhausted",
              attempted_action: "delete_expired"
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          const result = await deleteMemoryItemFully(item, {
            reason: "expired",
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          if (result?.deleted) deleted += 1;
          if (result?.queued) queuedDeletes += 1;
          continue;
        }
        if (item.pinned) {
          emitLifecycleActionTelemetry("retain", item, {
            reason: "pinned"
          }, {
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          continue;
        }

        const valueScore = await ensureValueScore(item);
        const tier = normalizeTier(item.tier, "WARM");
        if (isBelowMinAgeForLifecycle(item, now, MEMORY_LIFECYCLE_MIN_AGE_HOURS)) {
          emitLifecycleActionTelemetry("retain", item, {
            reason: "below_min_age",
            tier,
            value_score: Number.isFinite(valueScore) ? valueScore : null
          }, {
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          continue;
        }
        if (tier === "HOT" && valueScore >= MEMORY_TIER_THRESHOLDS.hotUp) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=promote id=${item.id} value=${valueScore.toFixed(4)}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "promote",
              tier,
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
          } else {
            const result = await promoteMemoryItem(item, {
              reason: "value_threshold",
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            if (result?.created) promoted += 1;
          }
          continue;
        }
        if (tier === "COLD" && valueScore < MEMORY_TIER_THRESHOLDS.evict) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=delete id=${item.id} reason=value value=${valueScore.toFixed(4)}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "evict_cold",
              tier,
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          if (!consumeDeleteBudget(deleteBudget, 1)) {
            console.warn(`[lifecycle] delete cap reached; skipping low-value delete id=${item.id}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "delete_budget_exhausted",
              attempted_action: "evict_cold",
              tier,
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            continue;
          }
          const result = await deleteMemoryItemFully(item, {
            reason: "cold_eviction",
            requestId: lifecycleRequestId,
            source: "lifecycle_sweep"
          });
          if (result?.deleted) deleted += 1;
          if (result?.queued) queuedDeletes += 1;
          continue;
        }
        if (tier === "COLD" && valueScore < MEMORY_LIFECYCLE_SUMMARY_THRESHOLD) {
          if (MEMORY_LIFECYCLE_DRY_RUN) {
            console.log(`[lifecycle] dry_run action=compact id=${item.id} value=${valueScore.toFixed(4)}`);
            emitLifecycleActionTelemetry("retain", item, {
              reason: "dry_run",
              attempted_action: "compact",
              tier,
              value_score: valueScore
            }, {
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
          } else {
            const result = await compactLowValueGroup(item, {
              deleteBudget,
              reason: "low_value_group",
              requestId: lifecycleRequestId,
              source: "lifecycle_sweep"
            });
            if (result?.created) summarized += 1;
          }
          continue;
        }
        emitLifecycleActionTelemetry("retain", item, {
          reason: "tier_band",
          tier,
          value_score: valueScore
        }, {
          requestId: lifecycleRequestId,
          source: "lifecycle_sweep"
        });
      }
      afterId = items[items.length - 1].id;
      if (items.length < batchSize) break;
    }
    emitTelemetry("lifecycle_actions", buildTelemetryContext({
      requestId: lifecycleRequestId,
      tenantId: "all",
      collection: null,
      source: "lifecycle_sweep"
    }), {
      promote_count: promoted,
      demote_count: 0,
      evict_count: deleted,
      compact_count: summarized,
      queued_delete_count: queuedDeletes
    });
    if (deleted || summarized || promoted || queuedDeletes) {
      console.log(`[lifecycle] deleted=${deleted} summarized=${summarized} promoted=${promoted} queuedDeletes=${queuedDeletes}`);
    }
  } catch (err) {
    console.warn("[lifecycle] sweep failed:", err?.message || err);
  } finally {
    lifecycleRunning = false;
  }
}

function scheduleLifecycleSweep() {
  if (!Number.isFinite(MEMORY_LIFECYCLE_INTERVAL_MS) || MEMORY_LIFECYCLE_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runLifecycleOnce().catch(() => {});
    setInterval(() => {
      runLifecycleOnce().catch(() => {});
    }, MEMORY_LIFECYCLE_INTERVAL_MS);
  }, 3500);
}

async function runMemorySnapshotOnce() {
  if (!isTelemetryEnabled()) return;
  if (memorySnapshotRunning) return;
  memorySnapshotRunning = true;
  try {
    const snapshot = await getMemoryStateSnapshot(null);
    emitTelemetry("memory_snapshot", buildTelemetryContext({
      requestId: createTelemetryRequestId("snapshot"),
      tenantId: "all",
      collection: null,
      source: "periodic_snapshot"
    }), {
      scope: "global",
      total_items: snapshot.total_items,
      approx_tokens: snapshot.approx_tokens,
      type_distribution: snapshot.type_distribution || {},
      tier_distribution: snapshot.tier_distribution || {},
      value_distribution: snapshot.value_distribution || {}
    });
  } catch (err) {
    console.warn("[telemetry] memory snapshot failed:", err?.message || err);
  } finally {
    memorySnapshotRunning = false;
  }
}

function scheduleMemorySnapshots() {
  if (!isTelemetryEnabled()) return;
  if (!Number.isFinite(MEMORY_SNAPSHOT_INTERVAL_MS) || MEMORY_SNAPSHOT_INTERVAL_MS <= 0) return;
  setTimeout(() => {
    runMemorySnapshotOnce().catch(() => {});
    setInterval(() => {
      runMemorySnapshotOnce().catch(() => {});
    }, MEMORY_SNAPSHOT_INTERVAL_MS);
  }, 2000);
}

// --------------------------
// Health check (public)
// --------------------------
app.get("/health", async (req, res) => {
  try {
    const reply = await sendCmd("PING");
    res.json({ ok: true, tcp: reply, tenantId: null, collection: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), tenantId: null, collection: null });
  }
});

app.get("/v1/health", async (req, res) => {
  try {
    const reply = await sendCmd("PING");
    sendOk(res, { status: "ok", tcp: reply }, null, null);
  } catch (e) {
    sendError(res, 500, e, "HEALTH_CHECK_FAILED", null, null);
  }
});

app.get(["/models", "/v1/models"], async (req, res) => {
  sendOk(res, {
    presets: buildPublicModelCatalog(),
    defaults: {
      instance: resolveEnvModelDefaults(process.env)
    }
  }, null, null);
});

app.get("/v1/runtime", async (req, res) => {
  const hosted = DEPLOYMENT_MODE === "hosted";
  const baseUrl = resolvePublicBaseUrl(req);
  const dashboardUrl = hosted
    ? (DASHBOARD_URL || (portalPluginMounted ? `${baseUrl}/portal` : null))
    : null;
  sendOk(res, {
    deploymentMode: DEPLOYMENT_MODE,
    capabilities: {
      dashboardControlPlane: hosted,
      localGatewayAdmin: !hosted,
      hostedBilling: hosted,
      portalEnabled: portalPluginMounted
    },
    links: {
      dashboardUrl
    }
  }, null, null);
});

app.get("/v1/register/options", async (req, res) => {
  try {
    const state = await resolvePublicRegistrationState();
    sendOk(res, {
      enabled: Boolean(state.enabled),
      reason: state.reason || null,
      note: describePublicRegistrationState(state),
      deploymentMode: DEPLOYMENT_MODE,
      baseUrl: resolvePublicBaseUrl(req),
      projectLabel: "project"
    }, null, null);
  } catch (err) {
    sendError(res, 500, "Failed to load registration options", "REGISTRATION_OPTIONS_FAILED", null, null);
  }
});

// --------------------------
// OpenAPI (public)
// --------------------------
app.get("/openapi.json", (req, res) => {
  res.json(buildOpenApiDoc(req));
});

app.get("/openapi.public.json", (req, res) => {
  res.json(buildOpenApiDoc(req, { publicView: true }));
});

// --------------------------
// LLMs + MCP docs access (public)
// --------------------------
app.get("/llms.txt", (req, res) => {
  const baseUrl = resolvePublicBaseUrl(req);
  const uiDocsUrl = `${baseUrl}/#pageDocsTop`;
  const docsUrl = `${baseUrl}/docs`;
  const llmsUrl = `${baseUrl}/llms.txt`;
  const mcpUrl = `${baseUrl}/mcp`;
  const lines = [
    "# SupaVector documentation endpoints",
    "",
    "SupaVector provides durable memory APIs and multi-tenant retrieval infrastructure for production AI agents.",
    "Memory policy values are amvl, ttl, and lru. If policy is omitted, SupaVector uses amvl.",
    "",
    "## Primary links",
    `- Product docs UI: ${uiDocsUrl}`,
    `- API documentation: ${docsUrl}`,
    `- OpenAPI (public): ${baseUrl}/openapi.public.json`,
    `- LLM index: ${llmsUrl}`,
    `- MCP server: ${mcpUrl}`,
    "",
    "## Suggested usage",
    "- Use the MCP server to search current docs for endpoint behavior, auth setup, and lifecycle controls.",
    "- If working on a local computer with this repo, prefer the supavector CLI: run `supavector doctor`, then `supavector onboard` if not configured.",
    "- On the local CLI path, `supavector onboard` creates the first admin and first service token and stores them in local CLI config.",
    "- Use `--collection` explicitly on write/search/ask/boolean_ask when scope matters. `supavector write --folder ./name` uses the folder name as the default collection.",
    "- For memory, ask, and boolean_ask APIs, policy can be set to amvl, ttl, or lru; the default is amvl.",
    "- For /v1/ask, use answerLength (auto|short|medium|long) to control response depth.",
    "- Use /v1/boolean_ask when you need a grounded response constrained to true, false, or invalid.",
    "- Use llms.txt for quick discovery of docs and MCP entrypoints."
  ];
  res.type("text/plain; charset=utf-8").send(lines.join("\n"));
});

app.get("/mcp", (req, res) => {
  const baseUrl = resolvePublicBaseUrl(req);
  const uiDocsUrl = `${baseUrl}/#pageDocsTop`;
  res.json({
    ok: true,
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "http-jsonrpc",
    endpoint: `${baseUrl}/mcp`,
    llms: `${baseUrl}/llms.txt`,
    uiDocs: uiDocsUrl,
    docs: `${baseUrl}/docs`,
    note: "Send JSON-RPC 2.0 requests with POST /mcp"
  });
});

app.post("/mcp", async (req, res) => {
  const payload = req.body;
  const isBatch = Array.isArray(payload);
  const requests = isBatch ? payload : [payload];

  if (!requests.length) {
    return res.status(400).json(createJsonRpcError(null, -32600, "Invalid Request"));
  }

  const responses = [];

  for (const message of requests) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      responses.push(createJsonRpcError(null, -32600, "Invalid Request"));
      continue;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = hasId ? message.id : null;
    const isJsonRpc = message.jsonrpc === "2.0";
    const method = typeof message.method === "string" ? message.method : "";

    if (!isJsonRpc || !method) {
      if (hasId) {
        responses.push(createJsonRpcError(id, -32600, "Invalid Request"));
      } else {
        responses.push(createJsonRpcError(null, -32600, "Invalid Request"));
      }
      continue;
    }

    try {
      const result = await handleMcpMethod(method, message.params, req);
      if (hasId) {
        responses.push(createJsonRpcResult(id, result));
      }
    } catch (err) {
      if (!hasId) continue;
      const code = Number.isInteger(err?.code) ? err.code : -32603;
      const errorMessage = err?.message ? String(err.message) : "Internal error";
      responses.push(createJsonRpcError(id, code, errorMessage, err?.data));
    }
  }

  if (responses.length === 0) {
    return res.status(204).end();
  }

  if (isBatch) {
    return res.json(responses);
  }
  return res.json(responses[0]);
});

// --------------------------
// Login (public)
// --------------------------
app.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "").trim();

  if (!cleanUser || !cleanPass) {
    return res.status(400).json({ error: "username and password required", tenantId: null, collection: null });
  }

  const maxAttempts = parseInt(process.env.AUTH_MAX_ATTEMPTS || "5", 10);
  const lockMinutes = parseInt(process.env.AUTH_LOCK_MINUTES || "15", 10);

  const result = await verifyCredentials(cleanUser, cleanPass);
  if (!result.ok) {
    if (result.reason === "locked") {
      return res.status(423).json({ error: "Account locked. Try later.", tenantId: null, collection: null });
    }
    if (result.reason === "disabled") {
      return res.status(403).json({ error: "Account disabled.", tenantId: null, collection: null });
    }
    if (result.reason === "sso_only") {
      return res.status(403).json({ error: "Account requires SSO login.", tenantId: null, collection: null });
    }
    if (result.user) {
      await recordFailedLogin(cleanUser, maxAttempts, lockMinutes);
    }
    return res.status(401).json({ error: "Invalid credentials", tenantId: null, collection: null });
  }

  try {
    await recordSuccessfulLogin(result.user.id);
    const token = issueToken(result.user);
    res.json({
      ok: true,
      token,
      tenant: result.user.tenant || result.user.username,
      tenantId: result.user.tenant || result.user.username,
      collection: DEFAULT_COLLECTION
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), tenantId: null, collection: null });
  }
});

app.post("/v1/register", loginLimiter, async (req, res) => {
  let tenantId = null;
  try {
    const state = await resolvePublicRegistrationState();
    if (!state.enabled) {
      return sendError(res, 403, describePublicRegistrationState(state), "REGISTRATION_DISABLED", null, null);
    }

    const username = normalizePublicRegistrationUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      return sendError(res, 400, "password must be at least 8 characters", "INVALID_INPUT", null, null);
    }
    const confirmPassword = String(req.body?.confirmPassword ?? req.body?.confirm_password ?? "");
    if (confirmPassword && confirmPassword !== password) {
      return sendError(res, 400, "password confirmation does not match", "INVALID_INPUT", null, null);
    }

    const email = parseOptionalString(req.body?.email, { label: "email", max: 240 }) || null;
    const fullName = parseOptionalString(req.body?.fullName ?? req.body?.full_name, { label: "fullName", max: 120 }) || null;
    const projectName = buildPublicRegistrationProjectName({
      projectName: req.body?.projectName ?? req.body?.project_name ?? req.body?.project,
      fullName,
      username
    });

    tenantId = buildPublicRegistrationTenantId({
      projectName,
      username
    });
    const passwordHash = await bcrypt.hash(password, 12);
    const rawServiceToken = `supav_${crypto.randomBytes(24).toString("base64url")}`;
    const created = await createTenantWithBootstrap({
      tenant: {
        tenantId,
        name: projectName,
        metadata: {
          createdVia: "browser_register",
          projectLabel: "project"
        }
      },
      bootstrapUser: {
        username,
        passwordHash,
        roles: SELF_SERVICE_REGISTRATION_ROLES,
        email,
        fullName,
        ssoOnly: false
      },
      bootstrapServiceToken: {
        name: `${tenantId}-default`,
        principalId: username,
        roles: SELF_SERVICE_REGISTRATION_ROLES,
        keyHash: hashToken(rawServiceToken),
        expiresAt: null
      }
    });

    const jwtToken = issueToken({
      username,
      tenant: tenantId,
      roles: SELF_SERVICE_REGISTRATION_ROLES
    });

    await recordAudit(req, tenantId, {
      action: "self_service.register",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        username,
        projectName,
        reason: state.reason || null
      }
    });
    if (created?.bootstrapUser) {
      await recordAudit(req, tenantId, {
        action: "tenant.user.create",
        targetType: "user",
        targetId: String(created.bootstrapUser.id || ""),
        metadata: {
          username,
          roles: created.bootstrapUser.roles || [],
          bootstrap: true,
          source: "self_service_register"
        }
      });
    }
    if (created?.bootstrapServiceToken) {
      await recordAudit(req, tenantId, {
        action: "service_token.created",
        targetType: "service_token",
        targetId: String(created.bootstrapServiceToken.id || ""),
        metadata: {
          name: created.bootstrapServiceToken.name || null,
          principalId: created.bootstrapServiceToken.principal_id || null,
          roles: created.bootstrapServiceToken.roles || [],
          bootstrap: true,
          source: "self_service_register"
        }
      });
    }

    sendOk(res, {
      auth: {
        token: jwtToken,
        type: "bearer",
        note: "Short-lived admin JWT for human browser actions."
      },
      project: {
        id: tenantId,
        name: projectName
      },
      tenant: formatTenantRecord(created?.tenant, {
        summary: {
          userCount: 1,
          serviceTokenCount: 1
        }
      }),
      user: formatTenantUser(created?.bootstrapUser),
      serviceToken: {
        token: rawServiceToken,
        tokenInfo: formatServiceToken(created?.bootstrapServiceToken),
        note: "Store this token now. It will not be shown again."
      },
      instructions: buildPublicRegistrationInstructions(resolvePublicBaseUrl(req))
    }, tenantId, null);
  } catch (err) {
    if (String(err.code || "") === "23505") {
      const detail = String(err.detail || "").toLowerCase();
      const constraint = String(err.constraint || "").toLowerCase();
      if (constraint.includes("users") || detail.includes("username")) {
        return sendError(res, 409, "username already exists", "CONFLICT", tenantId, null);
      }
      return sendError(res, 409, "Registration conflict. Try a different username or project name.", "CONFLICT", tenantId, null);
    }
    const message = String(err.message || err);
    const status = message.includes("required") || message.includes("must") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to create account", status === 400 ? "INVALID_INPUT" : "REGISTRATION_FAILED", tenantId, null);
  }
});

app.post("/v1/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "").trim();

  if (!cleanUser || !cleanPass) {
    return sendError(res, 400, "username and password required", "INVALID_INPUT", null, null);
  }

  const maxAttempts = parseInt(process.env.AUTH_MAX_ATTEMPTS || "5", 10);
  const lockMinutes = parseInt(process.env.AUTH_LOCK_MINUTES || "15", 10);

  const result = await verifyCredentials(cleanUser, cleanPass);
  if (!result.ok) {
    if (result.reason === "locked") {
      return sendError(res, 423, "Account locked. Try later.", "ACCOUNT_LOCKED", null, null);
    }
    if (result.reason === "disabled") {
      return sendError(res, 403, "Account disabled.", "ACCOUNT_DISABLED", null, null);
    }
    if (result.reason === "sso_only") {
      return sendError(res, 403, "Account requires SSO login.", "SSO_ONLY", null, null);
    }
    if (result.user) {
      await recordFailedLogin(cleanUser, maxAttempts, lockMinutes);
    }
    return sendError(res, 401, "Invalid credentials", "AUTH_INVALID", null, null);
  }

  try {
    await recordSuccessfulLogin(result.user.id);
    const token = issueToken(result.user);
    sendOk(res, {
      token,
      user: result.user,
      note: "Use this token in Authorization: Bearer <token>"
    }, result.user.tenant, DEFAULT_COLLECTION);
  } catch (err) {
    sendError(res, 500, "Failed to generate token", "TOKEN_FAILURE", null, null);
  }
});

// --------------------------
// SSO Login (public)
// --------------------------
app.get(["/auth/providers", "/v1/auth/providers"], async (req, res) => {
  try {
    const requestedTenantId = resolveRequestedTenantInput(req);
    const tenantRecord = requestedTenantId ? await getTenantById(requestedTenantId) : null;
    if (requestedTenantId && !tenantRecord) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    const authMode = normalizeAuthMode(tenantRecord?.auth_mode);
    const providers = {};
    for (const provider of ENTERPRISE_SSO_PROVIDERS) {
      if (!isSsoAllowed(authMode)) {
        providers[provider] = { enabled: false, source: null, provider, reason: "auth_mode_disabled" };
        continue;
      }
      const cfg = resolveSsoProviderConfig({ tenant: tenantRecord, provider, env: process.env });
      providers[provider] = formatAuthProviderAvailability(provider, cfg, tenantRecord);
    }
    return res.json({
      ok: true,
      tenantId: requestedTenantId || null,
      authMode,
      providers
    });
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
});

app.get(["/auth/:provider/login", "/v1/auth/:provider/login"], async (req, res) => {
  const provider = String(req.params.provider || "").trim();
  try {
    const requestedTenantId = resolveRequestedTenantInput(req);
    const tenantRecord = requestedTenantId ? await getTenantById(requestedTenantId) : null;
    if (requestedTenantId && !tenantRecord) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    if (requestedTenantId && !isSsoAllowed(tenantRecord?.auth_mode)) {
      return res.status(403).json({ error: "Tenant requires password login." });
    }
    if (requestedTenantId && !isSsoProviderAllowed(tenantRecord, provider)) {
      return res.status(403).json({ error: "SSO provider not allowed for tenant." });
    }

    const cfg = resolveSsoProviderConfig({ tenant: tenantRecord, provider, env: process.env });
    const { client } = await getClient(provider, cfg);
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    const cookieName = buildStateCookie(provider);
    const payload = JSON.stringify({ state, nonce, codeVerifier, tenantId: requestedTenantId || null });
    res.cookie(cookieName, payload, {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: 5 * 60 * 1000,
      signed: true
    });

    const redirectUri = getRedirectUri(provider);
    const authUrl = client.authorizationUrl({
      scope: cfg.scopes,
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    return res.redirect(authUrl);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
});

app.get(["/auth/:provider/callback", "/v1/auth/:provider/callback"], async (req, res) => {
  const provider = String(req.params.provider || "").trim();
  try {
    const cookieName = buildStateCookie(provider);
    const raw = req.signedCookies[cookieName];
    if (!raw) {
      return res.status(400).json({ error: "Missing login state" });
    }

    res.clearCookie(cookieName);

    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "Invalid login state" });
    }

    const requestedTenantId = String(saved?.tenantId || "").trim();
    const requestedTenant = requestedTenantId ? await getTenantById(requestedTenantId) : null;
    if (requestedTenantId && !requestedTenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    const cfg = resolveSsoProviderConfig({ tenant: requestedTenant, provider, env: process.env });
    const { client } = await getClient(provider, cfg);
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(
      getRedirectUri(provider),
      params,
      { state: saved.state, nonce: saved.nonce, code_verifier: saved.codeVerifier }
    );

    const claims = tokenSet.claims();
    const tenant = requestedTenantId || resolveTenant(claims, cfg);
    if (!tenant || !TENANT_RE.test(tenant)) {
      return res.status(400).json({ error: "Invalid tenant from IdP" });
    }
    const tenantRecord = await getTenantById(tenant);
    if (!tenantRecord) {
      return res.status(404).json({ error: "Tenant not provisioned for SSO" });
    }
    const tenantAuthMode = normalizeAuthMode(tenantRecord?.auth_mode);
    if (!isSsoAllowed(tenantAuthMode)) {
      return res.status(403).json({ error: "Tenant requires password login." });
    }
    if (!isSsoProviderAllowed(tenantRecord, provider)) {
      return res.status(403).json({ error: "SSO provider not allowed for tenant." });
    }

    const subject = String(claims.sub || "").trim();
    if (!subject) {
      return res.status(400).json({ error: "Invalid subject from IdP" });
    }

    const profile = getUserProfile(claims);
    if (!isEmailAllowedForProvider(profile.email, cfg.allowedDomains)) {
      return res.status(403).json({ error: "Email domain not allowed for tenant SSO." });
    }
    const randomPass = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPass, 12);

    let user = await upsertSsoUser({
      provider,
      subject,
      tenantId: tenant,
      email: profile.email,
      fullName: profile.name,
      passwordHash
    });
    if (user.disabled) {
      return res.status(403).json({ error: "Account is disabled." });
    }
    const finalRoles = deriveSsoRoles({
      claims,
      providerConfig: cfg,
      existingRoles: user.roles || []
    });
    const currentRoles = Array.isArray(user.roles) ? user.roles : [];
    if (JSON.stringify(currentRoles) !== JSON.stringify(finalRoles)) {
      user = await updateTenantUser(tenant, user.id, { roles: finalRoles }) || user;
    }

    const token = issueToken({
      username: user.username,
      tenant: user.tenant_id,
      roles: Array.isArray(user.roles) ? user.roles : finalRoles
    });

    await createAuditLog({
      tenantId: tenant,
      actorId: user.username,
      actorType: "user",
      action: "auth.sso_login",
      targetType: "user",
      targetId: String(user.id || ""),
      metadata: {
        provider,
        email: profile.email || null,
        roleSource: cfg.source || "instance"
      },
      requestId: req.requestId,
      ip: req.ip
    });

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>SSO Login</title></head>
  <body>
    <script>
      localStorage.setItem("supavectorJwt", ${JSON.stringify(token)});
      localStorage.setItem("supavectorAuthToken", ${JSON.stringify(token)});
      localStorage.setItem("supavectorAuthType", "bearer");
      window.location.href = "/";
    </script>
  </body>
</html>`;
    return res.status(200).send(html);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
});

// --------------------------
// Enterprise control plane (instance admin)
// --------------------------
app.get(["/admin/tenants", "/v1/admin/tenants"], requireJwt, requireInstanceAdmin, async (req, res) => {
  try {
    const limit = parseListLimit(req.query?.limit, { fallback: 100, max: 500 });
    const search = String(req.query?.search || "").trim();
    const tenants = (await listTenants({ limit, search })).map((tenant) => formatTenantRecord(tenant));
    sendOk(res, { tenants }, null, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message.includes("must be a positive number") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to list tenants", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_TENANT_LIST_FAILED", null, null);
  }
});

app.post(["/admin/tenants", "/v1/admin/tenants"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = normalizeTenantIdentifier(req.body?.tenantId ?? req.body?.tenantID, "tenantId");
    const name = req.body?.name === undefined ? null : (String(req.body.name || "").trim() || null);
    const externalId = req.body?.externalId === undefined && req.body?.external_id === undefined
      ? null
      : (String((req.body?.externalId ?? req.body?.external_id) || "").trim() || null);
    const metadata = parseTenantMetadataInput(req.body?.metadata);
    const rawMode = req.body?.authMode ?? req.body?.auth_mode;
    const rawProviders = req.body?.ssoProviders ?? req.body?.sso_providers;
    const rawSsoConfig = req.body?.ssoConfig ?? req.body?.sso_config;
    const authMode = rawMode === undefined ? null : parseAuthMode(rawMode);
    if (rawMode !== undefined && !authMode) {
      return sendError(res, 400, "authMode must be one of: sso_only, sso_plus_password, password_only", "INVALID_INPUT", tenantId, null);
    }

    let providersInput;
    try {
      providersInput = normalizeSsoProvidersInput(rawProviders);
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    let modelInput;
    try {
      modelInput = parseTenantModelSettingsInput(req.body || {});
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    let ssoConfigInput;
    try {
      ssoConfigInput = parseTenantSsoConfigInput(rawSsoConfig, {});
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    const effectiveProviders = providersInput.provided ? providersInput.value : null;
    if (authMode === "sso_only" && Array.isArray(effectiveProviders) && effectiveProviders.length === 0) {
      return sendError(res, 400, "ssoProviders cannot be empty when authMode is sso_only", "INVALID_INPUT", tenantId, null);
    }

    const bootstrapAdminRaw = req.body?.bootstrapAdmin ?? req.body?.bootstrapUser;
    if (bootstrapAdminRaw !== undefined && bootstrapAdminRaw !== null && (typeof bootstrapAdminRaw !== "object" || Array.isArray(bootstrapAdminRaw))) {
      return sendError(res, 400, "bootstrapAdmin must be an object", "INVALID_INPUT", tenantId, null);
    }
    const bootstrapTokenRaw = req.body?.bootstrapServiceToken;
    if (bootstrapTokenRaw !== undefined && bootstrapTokenRaw !== null && (typeof bootstrapTokenRaw !== "object" || Array.isArray(bootstrapTokenRaw))) {
      return sendError(res, 400, "bootstrapServiceToken must be an object", "INVALID_INPUT", tenantId, null);
    }

    let bootstrapAdmin = null;
    let generatedBootstrapPassword = null;
    if (bootstrapAdminRaw && typeof bootstrapAdminRaw === "object") {
      const username = String(bootstrapAdminRaw.username || "").trim();
      if (!username) {
        return sendError(res, 400, "bootstrapAdmin.username is required", "INVALID_INPUT", tenantId, null);
      }
      let roles;
      try {
        roles = bootstrapAdminRaw.roles === undefined
          ? ["admin", "indexer", "reader"]
          : normalizeRoles(bootstrapAdminRaw.roles, { allowInstanceAdmin: true, allowEmpty: false });
      } catch (err) {
        return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
      }
      const passwordInput = String(bootstrapAdminRaw.password || "");
      const ssoOnly = bootstrapAdminRaw.ssoOnly === true || bootstrapAdminRaw.sso_only === true;
      if (passwordInput && passwordInput.length < 8) {
        return sendError(res, 400, "bootstrapAdmin.password must be at least 8 characters", "INVALID_INPUT", tenantId, null);
      }
      const password = passwordInput || `supav_user_${crypto.randomBytes(18).toString("base64url")}`;
      if (!passwordInput && !ssoOnly) {
        generatedBootstrapPassword = password;
      }
      bootstrapAdmin = {
        username,
        passwordHash: await bcrypt.hash(password, 12),
        roles,
        email: bootstrapAdminRaw.email === undefined ? null : (String(bootstrapAdminRaw.email || "").trim() || null),
        fullName: bootstrapAdminRaw.fullName === undefined && bootstrapAdminRaw.full_name === undefined
          ? null
          : (String((bootstrapAdminRaw.fullName ?? bootstrapAdminRaw.full_name) || "").trim() || null),
        ssoOnly
      };
    }

    let bootstrapServiceToken = null;
    let bootstrapServiceTokenValue = null;
    if (bootstrapTokenRaw && typeof bootstrapTokenRaw === "object") {
      const nameValue = String(bootstrapTokenRaw.name || "").trim() || `${tenantId}-bootstrap`;
      const principalValue = String(
        bootstrapTokenRaw.principalId
        ?? bootstrapTokenRaw.principal_id
        ?? bootstrapAdmin?.username
        ?? tenantId
      ).trim();
      if (!PRINCIPAL_RE.test(principalValue)) {
        return sendError(res, 400, "bootstrapServiceToken.principalId is invalid", "INVALID_INPUT", tenantId, null);
      }
      let roles;
      try {
        roles = bootstrapTokenRaw.roles === undefined
          ? (bootstrapAdmin?.roles?.length ? bootstrapAdmin.roles : ["admin", "indexer", "reader"])
          : normalizeRoles(bootstrapTokenRaw.roles, { allowInstanceAdmin: true, allowEmpty: false });
      } catch (err) {
        return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
      }
      let expiresAt = bootstrapTokenRaw.expiresAt || bootstrapTokenRaw.expires_at || null;
      if (expiresAt) {
        try {
          expiresAt = parseTimeInput(expiresAt, "bootstrapServiceToken.expiresAt").toISOString();
        } catch (err) {
          return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
        }
      }
      bootstrapServiceTokenValue = `supav_${crypto.randomBytes(24).toString("base64url")}`;
      bootstrapServiceToken = {
        name: nameValue,
        principalId: principalValue,
        roles,
        keyHash: hashToken(bootstrapServiceTokenValue),
        expiresAt
      };
    }

    const created = await createTenantWithBootstrap({
      tenant: {
        tenantId,
        name,
        externalId,
        metadata: metadata === undefined ? {} : metadata,
        authMode,
        ssoProviders: providersInput.provided ? providersInput.value : undefined,
        ssoConfig: ssoConfigInput,
        answerProvider: modelInput.answerProvider,
        answerModel: modelInput.answerModel,
        booleanAskProvider: modelInput.booleanAskProvider,
        booleanAskModel: modelInput.booleanAskModel,
        reflectProvider: modelInput.reflectProvider,
        reflectModel: modelInput.reflectModel,
        compactProvider: modelInput.compactProvider,
        compactModel: modelInput.compactModel
      },
      bootstrapUser: bootstrapAdmin,
      bootstrapServiceToken
    });
    const summary = await buildEnterpriseTenantSummary(tenantId);
    await recordAudit(req, tenantId, {
      action: "enterprise.tenant.create",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        externalId,
        authMode: authMode || normalizeAuthMode(created?.tenant?.auth_mode),
        bootstrapAdmin: Boolean(created?.bootstrapUser),
        bootstrapServiceToken: Boolean(created?.bootstrapServiceToken)
      }
    });
    if (created?.bootstrapUser) {
      await recordAudit(req, tenantId, {
        action: "enterprise.user.create",
        targetType: "user",
        targetId: String(created.bootstrapUser.id || ""),
        metadata: {
          username: created.bootstrapUser.username || null,
          roles: created.bootstrapUser.roles || [],
          bootstrap: true
        }
      });
    }
    if (created?.bootstrapServiceToken) {
      await recordAudit(req, tenantId, {
        action: "enterprise.service_token.create",
        targetType: "service_token",
        targetId: String(created.bootstrapServiceToken.id || ""),
        metadata: {
          name: created.bootstrapServiceToken.name || null,
          principalId: created.bootstrapServiceToken.principal_id || null,
          roles: created.bootstrapServiceToken.roles || [],
          bootstrap: true
        }
      });
    }
    sendOk(res, {
      tenant: formatTenantRecord(created?.tenant, { summary }),
      bootstrapAdmin: created?.bootstrapUser
        ? {
            user: formatTenantUser(created.bootstrapUser),
            ...(generatedBootstrapPassword ? { generatedPassword: generatedBootstrapPassword } : {})
          }
        : null,
      bootstrapServiceToken: created?.bootstrapServiceToken
        ? {
            token: bootstrapServiceTokenValue,
            tokenInfo: formatServiceToken(created.bootstrapServiceToken),
            note: "Store this token now. It will not be shown again."
          }
        : null
    }, tenantId, null);
  } catch (err) {
    if (String(err.code || "") === "23505") {
      return sendError(res, 409, "tenantId, externalId, or bootstrap principal already exists", "CONFLICT", tenantId, null);
    }
    const message = String(err.message || err);
    const status = message.includes("must be") || message.includes("is required") || message === "tenantId mismatch" ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to create tenant", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_TENANT_CREATE_FAILED", tenantId, null);
  }
});

app.get(["/admin/tenants/:tenantId", "/v1/admin/tenants/:tenantId"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }
    const summary = await buildEnterpriseTenantSummary(tenantId);
    sendOk(res, { tenant: formatTenantRecord(tenant, { summary }) }, tenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("is required") || message.includes("must use only") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to load tenant", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_TENANT_GET_FAILED", tenantId, null);
  }
});

app.patch(["/admin/tenants/:tenantId", "/v1/admin/tenants/:tenantId"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const current = await getTenantById(tenantId);
    if (!current) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }

    const rawMode = req.body?.authMode ?? req.body?.auth_mode;
    const rawProviders = req.body?.ssoProviders ?? req.body?.sso_providers;
    const rawSsoConfig = req.body?.ssoConfig ?? req.body?.sso_config;
    const rawExternalId = req.body?.externalId ?? req.body?.external_id;
    const authMode = rawMode === undefined ? null : parseAuthMode(rawMode);
    if (rawMode !== undefined && !authMode) {
      return sendError(res, 400, "authMode must be one of: sso_only, sso_plus_password, password_only", "INVALID_INPUT", tenantId, null);
    }

    let providersInput;
    try {
      providersInput = normalizeSsoProvidersInput(rawProviders);
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    let modelInput;
    try {
      modelInput = parseTenantModelSettingsInput(req.body || {});
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    let ssoConfigInput;
    try {
      ssoConfigInput = parseTenantSsoConfigInput(rawSsoConfig, current?.sso_config || {});
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    let metadataInput;
    try {
      metadataInput = parseTenantMetadataInput(req.body?.metadata);
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    const nextAuthMode = authMode || normalizeAuthMode(current?.auth_mode);
    const nextProviders = providersInput.provided ? providersInput.value : current?.sso_providers ?? null;
    if (nextAuthMode === "sso_only" && Array.isArray(nextProviders) && nextProviders.length === 0) {
      return sendError(res, 400, "ssoProviders cannot be empty when authMode is sso_only", "INVALID_INPUT", tenantId, null);
    }

    const name = req.body?.name === undefined ? undefined : (String(req.body.name || "").trim() || null);
    const externalId = rawExternalId === undefined ? undefined : (String(rawExternalId || "").trim() || null);
    if (
      name === undefined
      && externalId === undefined
      && metadataInput === undefined
      && rawMode === undefined
      && !providersInput.provided
      && ssoConfigInput === undefined
      && !hasTenantModelSettingsInput(modelInput)
    ) {
      return sendError(res, 400, "Provide name, externalId, metadata, authMode, ssoProviders, ssoConfig, and/or models", "INVALID_INPUT", tenantId, null);
    }

    const before = buildTenantSettingsPayload(tenantId, current);
    const updated = await setTenantSettings(tenantId, {
      name,
      externalId,
      metadata: metadataInput,
      authMode: rawMode === undefined ? undefined : authMode,
      ssoProviders: providersInput.provided ? providersInput.value : undefined,
      ssoConfig: ssoConfigInput,
      answerProvider: modelInput.answerProvider,
      answerModel: modelInput.answerModel,
      booleanAskProvider: modelInput.booleanAskProvider,
      booleanAskModel: modelInput.booleanAskModel,
      reflectProvider: modelInput.reflectProvider,
      reflectModel: modelInput.reflectModel,
      compactProvider: modelInput.compactProvider,
      compactModel: modelInput.compactModel
    });
    const summary = await buildEnterpriseTenantSummary(tenantId);
    await recordAudit(req, tenantId, {
      action: "enterprise.tenant.update",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        before,
        after: buildTenantSettingsPayload(tenantId, updated)
      }
    });
    sendOk(res, { tenant: formatTenantRecord(updated, { summary }) }, tenantId, null);
  } catch (err) {
    if (String(err.code || "") === "23505") {
      return sendError(res, 409, "externalId already exists", "CONFLICT", tenantId, null);
    }
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must be") || message.includes("Provide ") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to update tenant", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_TENANT_UPDATE_FAILED", tenantId, null);
  }
});

app.get(["/admin/tenants/:tenantId/users", "/v1/admin/tenants/:tenantId/users"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }
    const users = (await listTenantUsers(tenantId)).map(formatTenantUser);
    sendOk(res, { users }, tenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must use only") || message.includes("is required") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to list tenant users", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_USERS_LIST_FAILED", tenantId, null);
  }
});

app.post(["/admin/tenants/:tenantId/users", "/v1/admin/tenants/:tenantId/users"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }
    const username = String(req.body?.username || "").trim();
    if (!username) {
      return sendError(res, 400, "username is required", "INVALID_INPUT", tenantId, null);
    }
    let roles;
    try {
      roles = normalizeRoles(req.body?.roles, { allowInstanceAdmin: true, allowEmpty: false });
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }
    const ssoOnly = req.body?.ssoOnly === true || req.body?.sso_only === true;
    const passwordInput = String(req.body?.password || "");
    if (passwordInput && passwordInput.length < 8) {
      return sendError(res, 400, "password must be at least 8 characters", "INVALID_INPUT", tenantId, null);
    }
    if (!passwordInput && !ssoOnly) {
      return sendError(res, 400, "password is required unless ssoOnly is true", "INVALID_INPUT", tenantId, null);
    }
    const password = passwordInput || `supav_user_${crypto.randomBytes(18).toString("base64url")}`;
    const user = await createTenantUser({
      tenantId,
      username,
      passwordHash: await bcrypt.hash(password, 12),
      roles,
      email: req.body?.email === undefined ? null : (String(req.body.email || "").trim() || null),
      fullName: req.body?.fullName === undefined && req.body?.full_name === undefined
        ? null
        : (String((req.body?.fullName ?? req.body?.full_name) || "").trim() || null),
      ssoOnly
    });
    await recordAudit(req, tenantId, {
      action: "enterprise.user.create",
      targetType: "user",
      targetId: String(user.id || ""),
      metadata: {
        username: user.username || null,
        roles: user.roles || [],
        ssoOnly
      }
    });
    sendOk(res, {
      user: formatTenantUser(user),
      ...(!passwordInput && !ssoOnly ? { generatedPassword: password } : {})
    }, tenantId, null);
  } catch (err) {
    if (String(err.code || "") === "23505") {
      return sendError(res, 409, "username already exists", "CONFLICT", tenantId, null);
    }
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must be") || message.includes("is required") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to create tenant user", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_USER_CREATE_FAILED", tenantId, null);
  }
});

app.patch(["/admin/tenants/:tenantId/users/:id", "/v1/admin/tenants/:tenantId/users/:id"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }
    const userId = parseInt(req.params.id || "0", 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendError(res, 400, "Invalid user id", "INVALID_INPUT", tenantId, null);
    }
    const existing = await getTenantUserById(tenantId, userId);
    if (!existing) {
      return sendError(res, 404, "User not found", "NOT_FOUND", tenantId, null);
    }

    let roles;
    try {
      roles = req.body?.roles === undefined
        ? undefined
        : normalizeRoles(req.body.roles, { allowInstanceAdmin: true, allowEmpty: true });
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }
    const disabled = req.body?.disabled === undefined ? undefined : Boolean(req.body.disabled);
    const email = req.body?.email === undefined ? undefined : (String(req.body.email || "").trim() || null);
    const fullName = req.body?.fullName === undefined && req.body?.full_name === undefined
      ? undefined
      : (String((req.body?.fullName ?? req.body?.full_name) || "").trim() || null);
    const ssoOnly = req.body?.ssoOnly === undefined && req.body?.sso_only === undefined
      ? undefined
      : Boolean(req.body?.ssoOnly ?? req.body?.sso_only);
    let passwordHash = undefined;
    if (req.body?.password !== undefined) {
      const password = String(req.body.password || "");
      if (!password || password.length < 8) {
        return sendError(res, 400, "password must be at least 8 characters", "INVALID_INPUT", tenantId, null);
      }
      passwordHash = await bcrypt.hash(password, 12);
    }

    if (roles === undefined && disabled === undefined && email === undefined && fullName === undefined && ssoOnly === undefined && passwordHash === undefined) {
      return sendError(res, 400, "Provide roles, disabled, email, fullName, ssoOnly, and/or password", "INVALID_INPUT", tenantId, null);
    }

    const updated = await updateTenantUser(tenantId, userId, {
      roles,
      disabled,
      passwordHash,
      email,
      fullName,
      ssoOnly
    });
    await recordAudit(req, tenantId, {
      action: "enterprise.user.update",
      targetType: "user",
      targetId: String(userId),
      metadata: {
        before: formatTenantUser(existing),
        after: formatTenantUser(updated)
      }
    });
    sendOk(res, { user: formatTenantUser(updated) }, tenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must be") || message.includes("Provide ") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to update tenant user", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_USER_UPDATE_FAILED", tenantId, null);
  }
});

app.get(["/admin/tenants/:tenantId/service-tokens", "/v1/admin/tenants/:tenantId/service-tokens"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }
    const tokens = (await listServiceTokens(tenantId)).map(formatServiceToken);
    sendOk(res, { tokens }, tenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must use only") || message.includes("is required") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to list service tokens", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_SERVICE_TOKEN_LIST_FAILED", tenantId, null);
  }
});

app.post(["/admin/tenants/:tenantId/service-tokens", "/v1/admin/tenants/:tenantId/service-tokens"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return sendError(res, 404, "Tenant not found", "NOT_FOUND", tenantId, null);
    }
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return sendError(res, 400, "name is required", "INVALID_INPUT", tenantId, null);
    }
    let principalId = req.body?.principalId ?? req.body?.principal_id ?? tenantId;
    principalId = String(principalId || "").trim();
    if (!principalId || !PRINCIPAL_RE.test(principalId)) {
      return sendError(res, 400, "Invalid principalId", "INVALID_INPUT", tenantId, null);
    }
    let roles;
    try {
      roles = normalizeRoles(req.body?.roles, { allowInstanceAdmin: true, allowEmpty: false });
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }
    let expiresAt = req.body?.expiresAt || req.body?.expires_at || null;
    if (expiresAt) {
      try {
        expiresAt = parseTimeInput(expiresAt, "expiresAt").toISOString();
      } catch (err) {
        return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
      }
    }

    const minted = await mintServiceTokenForTenant({
      tenantId,
      name,
      principalId,
      roles,
      expiresAt
    });
    await recordAudit(req, tenantId, {
      action: "enterprise.service_token.create",
      targetType: "service_token",
      targetId: String(minted.record?.id || ""),
      metadata: {
        name,
        principalId,
        roles,
        expiresAt
      }
    });
    sendOk(res, {
      token: minted.rawToken,
      tokenInfo: formatServiceToken(minted.record),
      note: "Store this token now. It will not be shown again."
    }, tenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must be") || message.includes("is required") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to create service token", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_SERVICE_TOKEN_CREATE_FAILED", tenantId, null);
  }
});

app.delete(["/admin/tenants/:tenantId/service-tokens/:id", "/v1/admin/tenants/:tenantId/service-tokens/:id"], requireJwt, requireInstanceAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveEnterpriseTenantId(req);
    const id = parseInt(req.params.id || "0", 10);
    if (!Number.isFinite(id) || id <= 0) {
      return sendError(res, 400, "Invalid token id", "INVALID_INPUT", tenantId, null);
    }
    const record = await revokeServiceToken(id, tenantId);
    if (!record) {
      return sendError(res, 404, "Token not found", "NOT_FOUND", tenantId, null);
    }
    await recordAudit(req, tenantId, {
      action: "enterprise.service_token.revoke",
      targetType: "service_token",
      targetId: String(record.id),
      metadata: {
        name: record.name || null,
        principalId: record.principal_id || null,
        roles: record.roles || [],
        revokedAt: record.revoked_at || null
      }
    });
    sendOk(res, { token: formatServiceToken(record) }, tenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must be") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to revoke service token", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_SERVICE_TOKEN_REVOKE_FAILED", tenantId, null);
  }
});

const enterpriseAuditHandler = async (req, res) => {
  let tenantId = null;
  try {
    tenantId = req.params?.tenantId ? resolveEnterpriseTenantId(req) : null;
    const queryTenantId = req.query?.tenantId || req.query?.tenantID;
    const filterTenantId = tenantId || (queryTenantId ? normalizeTenantIdentifier(queryTenantId, "tenantId") : null);
    const limit = parseListLimit(req.query?.limit, { fallback: 100, max: 500 });
    const action = req.query?.action ? String(req.query.action).trim() : null;
    const targetType = req.query?.targetType || req.query?.target_type
      ? String(req.query?.targetType ?? req.query?.target_type).trim()
      : null;
    const targetId = req.query?.targetId || req.query?.target_id
      ? String(req.query?.targetId ?? req.query?.target_id).trim()
      : null;
    const logs = (await listAuditLogs({
      tenantId: filterTenantId,
      action,
      targetType,
      targetId,
      limit
    })).map(formatAuditLogEntry);
    sendOk(res, { logs }, filterTenantId, null);
  } catch (err) {
    const message = String(err.message || err);
    const status = message === "tenantId mismatch" || message.includes("must be") || message.includes("must use only") || message.includes("is required") ? 400 : 500;
    sendError(res, status, status === 400 ? message : "Failed to list audit logs", status === 400 ? "INVALID_INPUT" : "ENTERPRISE_AUDIT_LIST_FAILED", tenantId, null);
  }
};

app.get(["/admin/audit", "/v1/admin/audit"], requireJwt, requireInstanceAdmin, enterpriseAuditHandler);
app.get(["/admin/tenants/:tenantId/audit", "/v1/admin/tenants/:tenantId/audit"], requireJwt, requireInstanceAdmin, enterpriseAuditHandler);

// --------------------------
// Tenant settings (admin)
// --------------------------
app.get(["/admin/tenant", "/v1/admin/tenant"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const tenant = await getTenantById(tenantId);
    sendOk(res, {
      tenant: buildTenantSettingsPayload(tenantId, tenant)
    }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to load tenant settings", "TENANT_SETTINGS_FAILED", tenantId, null);
  }
});

app.patch(["/admin/tenant", "/v1/admin/tenant"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const rawMode = req.body?.authMode ?? req.body?.auth_mode;
    const rawProviders = req.body?.ssoProviders ?? req.body?.sso_providers;
    const rawSsoConfig = req.body?.ssoConfig ?? req.body?.sso_config;
    const authMode = rawMode === undefined ? null : parseAuthMode(rawMode);
    if (rawMode !== undefined && !authMode) {
      return sendError(res, 400, "authMode must be one of: sso_only, sso_plus_password, password_only", "INVALID_INPUT", tenantId, null);
    }

    let providersInput;
    try {
      providersInput = normalizeSsoProvidersInput(rawProviders);
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    let modelInput;
    try {
      modelInput = parseTenantModelSettingsInput(req.body || {});
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    const current = await getTenantById(tenantId);
    let ssoConfigInput;
    try {
      ssoConfigInput = parseTenantSsoConfigInput(rawSsoConfig, current?.sso_config || {});
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }

    if (rawMode === undefined && !providersInput.provided && ssoConfigInput === undefined && !hasTenantModelSettingsInput(modelInput)) {
      return sendError(res, 400, "Provide authMode, ssoProviders, ssoConfig, and/or models", "INVALID_INPUT", tenantId, null);
    }

    const prevPayload = buildTenantSettingsPayload(tenantId, current);
    const prevAuthMode = prevPayload.authMode;
    const prevProviders = prevPayload.ssoProviders;
    const nextAuthMode = authMode || prevAuthMode;
    const nextProviders = providersInput.provided ? providersInput.value : current?.sso_providers ?? null;
    if (nextAuthMode === "sso_only" && Array.isArray(nextProviders) && nextProviders.length === 0) {
      return sendError(res, 400, "ssoProviders cannot be empty when authMode is sso_only", "INVALID_INPUT", tenantId, null);
    }

    const tenant = await setTenantSettings(tenantId, {
      authMode: rawMode === undefined ? undefined : authMode,
      ssoProviders: providersInput.provided ? providersInput.value : undefined,
      ssoConfig: ssoConfigInput,
      answerProvider: modelInput.answerProvider,
      answerModel: modelInput.answerModel,
      booleanAskProvider: modelInput.booleanAskProvider,
      booleanAskModel: modelInput.booleanAskModel,
      reflectProvider: modelInput.reflectProvider,
      reflectModel: modelInput.reflectModel,
      compactProvider: modelInput.compactProvider,
      compactModel: modelInput.compactModel
    });
    const nextPayload = buildTenantSettingsPayload(tenantId, tenant);
    const updatedAuthMode = nextPayload.authMode;
    const updatedProviders = nextPayload.ssoProviders;
    await recordAudit(req, tenantId, {
      action: "tenant.settings.update",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        before: {
          authMode: prevAuthMode,
          ssoProviders: prevProviders,
          ssoConfig: prevPayload.ssoConfig,
          models: prevPayload.models
        },
        after: {
          authMode: updatedAuthMode,
          ssoProviders: updatedProviders,
          ssoConfig: nextPayload.ssoConfig,
          models: nextPayload.models
        }
      }
    });
    sendOk(res, { tenant: nextPayload }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to update tenant settings", "TENANT_SETTINGS_UPDATE_FAILED", tenantId, null);
  }
});

// --------------------------
// Tenant users (admin)
// --------------------------
app.get(["/admin/users", "/v1/admin/users"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const users = (await listTenantUsers(tenantId)).map(formatTenantUser);
    sendOk(res, { users }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to list tenant users", "TENANT_USERS_LIST_FAILED", tenantId, null);
  }
});

app.post(["/admin/users", "/v1/admin/users"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const email = String(req.body?.email || "").trim();
    const fullName = String((req.body?.fullName ?? req.body?.full_name) || "").trim();
    const ssoOnly = req.body?.ssoOnly === true || req.body?.sso_only === true;
    const roles = normalizeRoleList(req.body?.roles, { allowEmpty: true }) || [];
    if (!username) {
      return sendError(res, 400, "username is required", "INVALID_INPUT", tenantId, null);
    }
    if (!password || password.length < 8) {
      return sendError(res, 400, "password must be at least 8 characters", "INVALID_INPUT", tenantId, null);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createTenantUser({
      tenantId,
      username,
      passwordHash,
      roles,
      email: email || null,
      fullName: fullName || null,
      ssoOnly
    });
    await recordAudit(req, tenantId, {
      action: "tenant.user.create",
      targetType: "user",
      targetId: String(user.id || ""),
      metadata: {
        username,
        roles,
        ssoOnly,
        authProvider: null
      }
    });
    sendOk(res, { user: formatTenantUser(user) }, tenantId, null);
  } catch (err) {
    if (String(err.code || "") === "23505") {
      return sendError(res, 409, "username already exists", "CONFLICT", tenantId, null);
    }
    sendError(res, 500, "Failed to create tenant user", "TENANT_USER_CREATE_FAILED", tenantId, null);
  }
});

app.patch(["/admin/users/:id", "/v1/admin/users/:id"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const userId = parseInt(req.params.id || "0", 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return sendError(res, 400, "Invalid user id", "INVALID_INPUT", tenantId, null);
    }
    const existing = await getTenantUserById(tenantId, userId);
    if (!existing) {
      return sendError(res, 404, "User not found", "NOT_FOUND", tenantId, null);
    }

    const roles = req.body?.roles === undefined ? undefined : (normalizeRoleList(req.body.roles, { allowEmpty: true }) || []);
    const disabled = req.body?.disabled === undefined ? undefined : Boolean(req.body.disabled);
    const email = req.body?.email === undefined ? undefined : String(req.body.email || "").trim();
    const fullName = req.body?.fullName === undefined && req.body?.full_name === undefined
      ? undefined
      : String((req.body?.fullName ?? req.body?.full_name) || "").trim();
    const ssoOnly = req.body?.ssoOnly === undefined && req.body?.sso_only === undefined
      ? undefined
      : Boolean(req.body?.ssoOnly ?? req.body?.sso_only);
    let passwordHash = undefined;
    if (req.body?.password !== undefined) {
      const password = String(req.body.password || "");
      if (!password || password.length < 8) {
        return sendError(res, 400, "password must be at least 8 characters", "INVALID_INPUT", tenantId, null);
      }
      passwordHash = await bcrypt.hash(password, 12);
    }

    if (roles === undefined && disabled === undefined && email === undefined && fullName === undefined && ssoOnly === undefined && passwordHash === undefined) {
      return sendError(res, 400, "Provide roles, disabled, email, fullName, ssoOnly, and/or password", "INVALID_INPUT", tenantId, null);
    }

    const updated = await updateTenantUser(tenantId, userId, {
      roles,
      disabled,
      passwordHash,
      email: email === undefined ? undefined : (email || null),
      fullName: fullName === undefined ? undefined : (fullName || null),
      ssoOnly
    });
    await recordAudit(req, tenantId, {
      action: "tenant.user.update",
      targetType: "user",
      targetId: String(userId),
      metadata: {
        before: formatTenantUser(existing),
        after: formatTenantUser(updated)
      }
    });
    sendOk(res, { user: formatTenantUser(updated) }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to update tenant user", "TENANT_USER_UPDATE_FAILED", tenantId, null);
  }
});

// --------------------------
// Service tokens (admin)
// --------------------------
app.get(["/admin/service-tokens", "/v1/admin/service-tokens"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const tokens = (await listServiceTokens(tenantId)).map(formatServiceToken);
    sendOk(res, { tokens }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to list service tokens", "SERVICE_TOKEN_LIST_FAILED", tenantId, null);
  }
});

app.post(["/admin/service-tokens", "/v1/admin/service-tokens"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return sendError(res, 400, "name is required", "INVALID_INPUT", tenantId, null);
    }

    let principalId = req.body?.principalId || req.body?.principal_id || req.user?.sub || req.user?.principal_id;
    principalId = String(principalId || "").trim();
    if (!principalId || !PRINCIPAL_RE.test(principalId)) {
      return sendError(res, 400, "Invalid principalId", "INVALID_INPUT", tenantId, null);
    }

    let roles;
    try {
      roles = normalizeRoles(req.body?.roles, { allowInstanceAdmin: false });
    } catch (err) {
      return sendError(res, 400, String(err.message || err), "INVALID_INPUT", tenantId, null);
    }
    let expiresAt = req.body?.expiresAt || req.body?.expires_at || null;
    if (expiresAt) {
      const dt = new Date(expiresAt);
      if (Number.isNaN(dt.getTime())) {
        return sendError(res, 400, "expiresAt must be a valid date", "INVALID_INPUT", tenantId, null);
      }
      expiresAt = dt.toISOString();
    }

    const rawToken = `supav_${crypto.randomBytes(24).toString("base64url")}`;
    const keyHash = hashToken(rawToken);
    const record = await createServiceToken({
      tenantId,
      name,
      principalId,
      roles,
      keyHash,
      expiresAt
    });

    sendOk(res, {
      token: rawToken,
      tokenInfo: formatServiceToken(record),
      note: "Store this token now. It will not be shown again."
    }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to create service token", "SERVICE_TOKEN_CREATE_FAILED", tenantId, null);
  }
});

app.delete(["/admin/service-tokens/:id", "/v1/admin/service-tokens/:id"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return sendError(res, 400, "Invalid token id", "INVALID_INPUT", tenantId, null);
    }
    const record = await revokeServiceToken(id, tenantId);
    if (!record) {
      return sendError(res, 404, "Token not found", "NOT_FOUND", tenantId, null);
    }
    await recordAudit(req, tenantId, {
      action: "service_token.revoked",
      targetType: "service_token",
      targetId: String(record.id),
      metadata: {
        name: record.name || null,
        principalId: record.principal_id || null,
        roles: record.roles || [],
        revokedAt: record.revoked_at || null
      }
    });
    sendOk(res, { token: formatServiceToken(record) }, tenantId, null);
  } catch (err) {
    sendError(res, 500, "Failed to revoke service token", "SERVICE_TOKEN_REVOKE_FAILED", tenantId, null);
  }
});

// --------------------------
// Stats (protected)
// --------------------------
app.get("/stats", requireJwt, requireRole("reader"), async (req, res) => {
  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req, { track: false });
  const reply = await sendCmd("STATS");
  const tcpStats = JSON.parse(reply);
  const gatewayStats = {
    latency: getLatencyStats(tenantId)
  };
  res.json({ ...tcpStats, gateway: gatewayStats, tenantId, collection });
});

app.get("/v1/stats", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req, { track: false });
    const reply = await sendCmd("STATS");
    const tcpStats = JSON.parse(reply);
    const gatewayStats = {
      latency: getLatencyStats(tenantId)
    };
    sendOk(res, { ...tcpStats, gateway: gatewayStats }, tenantId, collection);
  } catch (e) {
    sendError(res, 500, e, "STATS_FAILED", tenantId, collection);
  }
});

const metricsHandler = async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
  } catch (e) {
    return sendError(res, 400, e, "INVALID_INPUT", null, null);
  }

  const isAdmin = hasTokenAdminAccess(req);
  const lines = [
    "# HELP supavector_request_latency_ms Request latency in milliseconds (rolling window).",
    "# TYPE supavector_request_latency_ms summary",
    "# HELP supavector_requests_total Requests observed in rolling window.",
    "# TYPE supavector_requests_total gauge",
    "# HELP supavector_request_errors_total Error responses (>=500) observed in rolling window.",
    "# TYPE supavector_request_errors_total gauge",
    "# HELP supavector_request_error_rate Error rate observed in rolling window.",
    "# TYPE supavector_request_error_rate gauge"
  ];

  const emitGroup = (group, baseLabels) => {
    emitPromLatencySummary(lines, group.overall, { ...baseLabels, scope: "overall" });
    for (const [route, summary] of Object.entries(group.routes || {})) {
      emitPromLatencySummary(lines, summary, { ...baseLabels, scope: "route", route });
    }
  };

  if (isAdmin) {
    emitGroup(getLatencyStats(), { tenant_id: "__all__" });
  }

  const tenantStats = isAdmin ? getAllTenantLatencyStats() : { [tenantId]: getLatencyStats(tenantId) };
  for (const [tid, stats] of Object.entries(tenantStats)) {
    emitGroup(stats, { tenant_id: tid });
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(`${lines.join("\n")}\n`);
};

app.get(["/metrics", "/v1/metrics"], requireJwt, requireRole("reader"), metricsHandler);

app.get(["/admin/usage", "/v1/admin/usage"], requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    const now = new Date();
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req, { track: false });
    const reply = await sendCmd("STATS");
    const tcpStats = JSON.parse(reply);
    const gatewayStats = {
      latency: getLatencyStats(tenantId)
    };
    const [usageAll, usage24h, usage7d, billableAllRow, billable24hRow, billable7dRow, storageMeterRow, usageHistoryRows] = await Promise.all([
      getTenantUsage(tenantId),
      getTenantUsageWindow(tenantId, "24h"),
      getTenantUsageWindow(tenantId, "7d"),
      getTenantBillableGenerationUsageWindow(tenantId, "all"),
      getTenantBillableGenerationUsageWindow(tenantId, "24h"),
      getTenantBillableGenerationUsageWindow(tenantId, "7d"),
      getTenantStorageUsage(tenantId),
      listTenantUsageHistory(tenantId, { limit: 50 })
    ]);
    const storageMeter = storageMeterRow || (await syncTenantStorageUsage({
      tenantId,
      source: "admin_usage_seed",
      recordHistory: false,
      vectorDim: await resolveStorageVectorDim(tenantId)
    })).current;
    const storageBillingState = await accrueTenantStorageBillingState({
      tenantId,
      now
    });
    const [currentStoragePeriod, storageBillingPeriods] = await Promise.all([
      getCurrentTenantStorageBillingPeriod(tenantId, { now }),
      listTenantStorageBillingPeriods(tenantId, { limit: 7 })
    ]);

    const buildUsageWindow = (row) => ({
      tokens: {
        embedding: {
          total: Number(row?.embedding_tokens || 0),
          requests: Number(row?.embedding_requests || 0)
        },
        generation: {
          input: Number(row?.generation_input_tokens || 0),
          output: Number(row?.generation_output_tokens || 0),
          total: Number(row?.generation_total_tokens || 0),
          requests: Number(row?.generation_requests || 0)
        },
        total: Number(row?.embedding_tokens || 0) + Number(row?.generation_total_tokens || 0)
      }
    });

    const storageBytes = Number(storageMeter?.bytes || 0);
    const totalEmbedTokens = Number(usageAll?.embedding_tokens || 0);
    const totalGenTokens = Number(usageAll?.generation_total_tokens || 0);
    const totalAiTokens = totalEmbedTokens + totalGenTokens;
    const { storagePricePerGBMonth, includedGBMonth } = getStorageBillingRates();
    const aiTokenPricePer1K = parseFloat(process.env.BILLING_PRICE_PER_1K_AI_TOKENS || "0");
    const hasUsageHistory = Array.isArray(usageHistoryRows) && usageHistoryRows.length > 0;
    const billableAllTokens = hasUsageHistory
      ? Number(billableAllRow?.generation_total_tokens || 0)
      : totalGenTokens;
    const billable24hTokens = hasUsageHistory
      ? Number(billable24hRow?.generation_total_tokens || 0)
      : Number(usage24h?.generation_total_tokens || 0);
    const billable7dTokens = hasUsageHistory
      ? Number(billable7dRow?.generation_total_tokens || 0)
      : Number(usage7d?.generation_total_tokens || 0);
    const billingWindows = {
      all: computeUsageCosts({
        storageBytes,
        storagePricePerGB: storagePricePerGBMonth,
        totalAiTokens,
        billableAiTokens: billableAllTokens,
        aiTokenPricePer1K
      }),
      "24h": computeUsageCosts({
        storageBytes,
        storagePricePerGB: storagePricePerGBMonth,
        totalAiTokens: Number(usage24h?.embedding_tokens || 0) + Number(usage24h?.generation_total_tokens || 0),
        billableAiTokens: billable24hTokens,
        aiTokenPricePer1K
      }),
      "7d": computeUsageCosts({
        storageBytes,
        storagePricePerGB: storagePricePerGBMonth,
        totalAiTokens: Number(usage7d?.embedding_tokens || 0) + Number(usage7d?.generation_total_tokens || 0),
        billableAiTokens: billable7dTokens,
        aiTokenPricePer1K
      })
    };
    const storageMonthly = buildStorageBillingSummary({
      state: storageBillingState,
      currentPeriod: currentStoragePeriod,
      recentPeriods: storageBillingPeriods,
      now,
      storagePricePerGBMonth,
      includedGBMonth
    });

    const usage = {
      windows: {
        all: buildUsageWindow(usageAll),
        "24h": buildUsageWindow(usage24h),
        "7d": buildUsageWindow(usage7d)
      },
      storage: {
        bytes: storageBytes,
        chunks: Number(storageMeter?.chunks || 0),
        documents: Number(storageMeter?.documents || 0),
        memoryItems: Number(storageMeter?.memory_items || 0),
        collections: Number(storageMeter?.collections || 0),
        components: {
          chunkTextBytes: Number(storageMeter?.chunk_text_bytes || 0),
          metadataBytes: Number(storageMeter?.metadata_bytes || 0),
          vectorBytes: Number(storageMeter?.vector_bytes || 0),
          vectorDim: Number(storageMeter?.vector_dim || 0),
          formulaVersion: storageMeter?.formula_version || null
        }
      },
      billing: {
        rates: {
          storagePerGB: storagePricePerGBMonth || null,
          storageIncludedGBMonth: includedGBMonth || 0,
          aiTokensPer1K: aiTokenPricePer1K || null
        },
        costs: billingWindows.all,
        windows: billingWindows,
        storageMonthly
      },
      history: (usageHistoryRows || []).map((row) => buildUsageHistoryEntry(row, {
        storagePerGB: storagePricePerGBMonth,
        aiTokensPer1K: aiTokenPricePer1K
      })),
      updatedAt: storageMeter?.updated_at || usageAll?.updated_at || null
    };
    if (req.path.startsWith("/v1")) {
      return sendOk(res, { ...tcpStats, gateway: gatewayStats, usage }, tenantId, collection);
    }
    return res.json({ ...tcpStats, gateway: gatewayStats, usage, tenantId, collection });
  } catch (e) {
    if (req.path.startsWith("/v1")) {
      return sendError(res, 500, e, "USAGE_FAILED", tenantId, collection);
    }
    return res.status(500).json({ error: String(e), tenantId, collection });
  }
});

// =======================================================
// SEMANTIC / GENAI ENDPOINTS (protected)
// =======================================================

// GET /docs/list
// - list docs for the current tenant
app.get("/collections", requireJwt, requireRole("reader"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const overrideInput = hasAccessOverrideInput(req);
    const access = (hasTokenAdminAccess(req) && !overrideInput)
      ? { principalId: null, privileges: [] }
      : resolveAccessContext(req);
    const docs = await listDocsForTenant(tenantId, null, access.principalId, access.privileges);
    const collections = buildCollectionsFromDocs(docs);
    res.json({ collections, totalCollections: collections.length, tenantId, collection: null });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/collections", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const overrideInput = hasAccessOverrideInput(req);
    const access = (hasTokenAdminAccess(req) && !overrideInput)
      ? { principalId: null, privileges: [] }
      : resolveAccessContext(req);
    const docs = await listDocsForTenant(tenantId, null, access.principalId, access.privileges);
    const collections = buildCollectionsFromDocs(docs);
    sendOk(res, { collections, totalCollections: collections.length }, tenantId, null);
  } catch (e) {
    sendError(res, 400, e, "COLLECTIONS_LIST_FAILED", tenantId, null);
  }
});

app.delete("/collections/:collection", requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = normalizeCollection(req.params.collection);
    req.collection = collection;
    const docs = await listDocsForTenant(tenantId, collection, null, []);
    let deletedVectors = 0;
    let failedVectors = 0;
    for (const doc of docs) {
      const namespaced = namespaceDocId(tenantId, collection, doc.docId);
      const cleanup = await deleteVectorsForDoc(namespaced, { strict: true });
      deletedVectors += cleanup.deleted;
      failedVectors += cleanup.failed;
      if (collection === DEFAULT_COLLECTION) {
        const legacy = `${tenantId}::${doc.docId}`;
        if (legacy !== namespaced) {
          const legacyCleanup = await deleteVectorsForDoc(legacy, { strict: true });
          deletedVectors += legacyCleanup.deleted;
          failedVectors += legacyCleanup.failed;
        }
      }
    }
    if (failedVectors > 0) {
      throw new Error(`Failed to delete ${failedVectors} vectors while deleting collection ${collection}`);
    }
    const deletedMemoryItems = await deleteMemoryItemsByCollection(tenantId, collection);
    scheduleStorageUsageMeter(tenantId, buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "collection_delete_legacy"
    }), {
      operation: "collection_delete",
      deletedDocs: docs.length,
      deletedVectors,
      deletedMemoryItems
    });
    await recordAudit(req, tenantId, {
      action: "collection.deleted",
      targetType: "collection",
      targetId: collection,
      metadata: {
        deletedDocs: docs.length,
        deletedVectors,
        deletedMemoryItems
      }
    });
    res.json({
      ok: true,
      collection,
      deletedDocs: docs.length,
      deletedVectors,
      deletedMemoryItems,
      tenantId,
      note: "Deleted document text, vectors, and memory items."
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
});

app.delete("/v1/collections/:collection", requireJwt, requireAdmin, async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = normalizeCollection(req.params.collection);
    req.collection = collection;
    const docs = await listDocsForTenant(tenantId, collection, null, []);
    let deletedVectors = 0;
    let failedVectors = 0;
    for (const doc of docs) {
      const namespaced = namespaceDocId(tenantId, collection, doc.docId);
      const cleanup = await deleteVectorsForDoc(namespaced, { strict: true });
      deletedVectors += cleanup.deleted;
      failedVectors += cleanup.failed;
      if (collection === DEFAULT_COLLECTION) {
        const legacy = `${tenantId}::${doc.docId}`;
        if (legacy !== namespaced) {
          const legacyCleanup = await deleteVectorsForDoc(legacy, { strict: true });
          deletedVectors += legacyCleanup.deleted;
          failedVectors += legacyCleanup.failed;
        }
      }
    }
    if (failedVectors > 0) {
      throw new Error(`Failed to delete ${failedVectors} vectors while deleting collection ${collection}`);
    }
    const deletedMemoryItems = await deleteMemoryItemsByCollection(tenantId, collection);
    scheduleStorageUsageMeter(tenantId, buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "collection_delete_v1"
    }), {
      operation: "collection_delete",
      deletedDocs: docs.length,
      deletedVectors,
      deletedMemoryItems
    });
    await recordAudit(req, tenantId, {
      action: "collection.deleted",
      targetType: "collection",
      targetId: collection,
      metadata: {
        deletedDocs: docs.length,
        deletedVectors,
        deletedMemoryItems
      }
    });
    sendOk(res, {
      collection,
      deletedDocs: docs.length,
      deletedVectors,
      deletedMemoryItems,
      note: "Deleted document text, vectors, and memory items."
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "COLLECTION_DELETE_FAILED", tenantId, collection);
  }
});

app.get("/docs/list", requireJwt, requireRole("reader"), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection, access.principalId, access.privileges);
    res.json({ docs, totalDocs: docs.length, tenantId, collection });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/docs", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const docs = await listDocsForTenant(tenantId, collection, access.principalId, access.privileges);
    sendOk(res, { docs, totalDocs: docs.length }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "DOCS_LIST_FAILED", tenantId, collection);
  }
});

// POST /docs { docId, text }
// - chunk text
// - embed chunks
// - store vectors in C++ (VSET)
// - store chunk text in Postgres
app.post("/docs", requireJwt, requireRole("indexer"), async (req, res) => {
  const { docId, text } = req.body || {};

  const cleanDocId = String(docId || "").trim();

  if (!cleanDocId || !text) {
    return res.status(400).json({ error: "docId and text required" });
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)" });
  }

  try {
    const tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);
    const embedConfig = await getRequestEmbeddingConfig(req, tenantId);
    const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    const tags = parseTagsInput(req.body?.tags);
    const expiresAt = resolveExpiresAt(req.body);
    const sourceInput = parseDocumentSourceInput(req.body, { defaultType: "text" });
    const { chunksIndexed, truncated } = await indexDocument(
      tenantId,
      collection,
      cleanDocId,
      text,
      {
        type: sourceInput.sourceType,
        title: sourceInput.title,
        metadata: sourceInput.metadata,
        url: sourceInput.sourceUrl,
        expiresAt,
        principalId,
        agentId,
        tags,
        visibility: req.body?.visibility,
        acl: req.body?.acl
      },
      {
        apiKey: embedConfig.apiKey,
        embedProvider: embedConfig.embedProvider,
        embedModel: embedConfig.embedModel,
        telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_index_legacy" })
      }
    );
    res.json({ ok: true, docId: cleanDocId, collection, tenantId, chunksIndexed, truncated });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/docs", requireJwt, requireRole("indexer"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  let principalId = null;
  let embedConfig = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    embedConfig = await getRequestEmbeddingConfig(req, tenantId);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/docs",
    handler: async () => {
      try {
        const indexed = await indexDocumentRequestBody({
          tenantId,
          collection,
          principalId,
          embedConfig,
          body: req.body,
          telemetrySource: "docs_index_v1",
          requestId: req.requestId
        });
        return {
          status: 200,
          payload: buildOkPayload(indexed, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, e?.code || "INDEX_FAILED", tenantId, collection)
        };
      }
    }
  });
});

app.post("/v1/docs/bulk", requireJwt, requireRole("indexer"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  let principalId = null;
  let embedConfig = null;
  let documents = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    embedConfig = await getRequestEmbeddingConfig(req, tenantId);
    documents = parseBulkDocumentsInput(req.body);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/docs/bulk",
    handler: async () => {
      const results = [];
      let succeeded = 0;
      let failed = 0;
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        try {
          const indexed = await indexDocumentRequestBody({
            tenantId,
            collection,
            principalId,
            embedConfig,
            body: document,
            telemetrySource: "docs_bulk_index_v1",
            requestId: req.requestId ? `${req.requestId}:${index}` : null
          });
          results.push({
            index,
            ok: true,
            ...indexed
          });
          succeeded += 1;
        } catch (err) {
          results.push(buildBulkDocumentFailure(index, document, err, tenantId, collection));
          failed += 1;
        }
      }
      return {
        status: 200,
        payload: buildOkPayload({
          results,
          summary: {
            total: documents.length,
            succeeded,
            failed
          }
        }, tenantId, collection)
      };
    }
  });
});

// POST /docs/url { docId, url }
// - fetch URL
// - extract text
// - index like /docs
app.post("/docs/url", requireJwt, requireRole("indexer"), async (req, res) => {
  const { docId, url } = req.body || {};
  const cleanDocId = String(docId || "").trim();
  const cleanUrl = String(url || "").trim();
  const validators = normalizeUrlFetchValidators(req.body?.validators);

  if (!cleanDocId || !cleanUrl) {
    return res.status(400).json({ error: "docId and url required" });
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)" });
  }

  try {
    const tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const collection = resolveCollection(req);
    const embedConfig = await getRequestEmbeddingConfig(req, tenantId);
    const requestMetadata = parseTenantMetadataInput(req.body?.metadata) || {};
    const agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    const tags = parseTagsInput(req.body?.tags);
    const expiresAt = resolveExpiresAt(req.body);
    const fetched = await fetchUrlText(cleanUrl, { validators });
    if (fetched.notModified) {
      return res.json({
        ok: true,
        docId: cleanDocId,
        collection,
        tenantId,
        url: cleanUrl,
        finalUrl: fetched.finalUrl || cleanUrl,
        notModified: true,
        etag: fetched.etag || null,
        lastModified: fetched.lastModified || null,
        extractedChars: 0,
        fetchTruncated: false,
        docTruncated: false,
        chunksIndexed: 0
      });
    }
    const { chunksIndexed, truncated } = await indexDocument(
      tenantId,
      collection,
      cleanDocId,
      fetched.text,
      { type: "url", url: cleanUrl, metadata: { ...requestMetadata, contentType: fetched.contentType || null }, expiresAt, principalId, agentId, tags, visibility: req.body?.visibility, acl: req.body?.acl },
      {
        apiKey: embedConfig.apiKey,
        embedProvider: embedConfig.embedProvider,
        embedModel: embedConfig.embedModel,
        telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_url_index_legacy" })
      }
    );

    res.json({
      ok: true,
      docId: cleanDocId,
      collection,
      tenantId,
      url: cleanUrl,
      finalUrl: fetched.finalUrl || cleanUrl,
      notModified: false,
      contentType: fetched.contentType || null,
      etag: fetched.etag || null,
      lastModified: fetched.lastModified || null,
      extractedChars: fetched.text.length,
      fetchTruncated: fetched.truncated,
      docTruncated: truncated,
      chunksIndexed
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/docs/url", requireJwt, requireRole("indexer"), async (req, res) => {
  const { docId, url } = req.body || {};
  const cleanDocId = String(docId || "").trim();
  const cleanUrl = String(url || "").trim();
  const validators = normalizeUrlFetchValidators(req.body?.validators);

  if (!cleanDocId || !cleanUrl) {
    return res.status(400).json(buildErrorPayload("docId and url required", "INVALID_INPUT", null, null));
  }
  if (!isValidDocId(cleanDocId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  let agentId = null;
  let tags = [];
  let embedConfig = null;
  let requestMetadata = {};
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    embedConfig = await getRequestEmbeddingConfig(req, tenantId);
    requestMetadata = parseTenantMetadataInput(req.body?.metadata) || {};
    agentId = normalizeAgentId(req.body?.agentId ?? req.body?.agent_id);
    tags = parseTagsInput(req.body?.tags);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/docs/url",
    handler: async () => {
      try {
        const expiresAt = resolveExpiresAt(req.body);
        const fetched = await fetchUrlText(cleanUrl, { validators });
        if (fetched.notModified) {
          return {
            status: 200,
            payload: buildOkPayload({
              docId: cleanDocId,
              url: cleanUrl,
              finalUrl: fetched.finalUrl || cleanUrl,
              notModified: true,
              etag: fetched.etag || null,
              lastModified: fetched.lastModified || null,
              extractedChars: 0,
              fetchTruncated: false,
              docTruncated: false,
              chunksIndexed: 0
            }, tenantId, collection)
          };
        }
        const { chunksIndexed, truncated } = await indexDocument(
          tenantId,
          collection,
          cleanDocId,
          fetched.text,
          { type: "url", url: cleanUrl, metadata: { ...requestMetadata, contentType: fetched.contentType || null }, expiresAt, principalId, agentId, tags, visibility: req.body?.visibility, acl: req.body?.acl },
          {
            apiKey: embedConfig.apiKey,
            embedProvider: embedConfig.embedProvider,
            embedModel: embedConfig.embedModel,
            telemetry: buildTelemetryContext({ requestId: req.requestId, tenantId, collection, source: "docs_url_index_v1" })
          }
        );

        return {
          status: 200,
          payload: buildOkPayload({
            docId: cleanDocId,
            url: cleanUrl,
            finalUrl: fetched.finalUrl || cleanUrl,
            notModified: false,
            contentType: fetched.contentType || null,
            etag: fetched.etag || null,
            lastModified: fetched.lastModified || null,
            extractedChars: fetched.text.length,
            fetchTruncated: fetched.truncated,
            docTruncated: truncated,
            chunksIndexed
          }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "INDEX_URL_FAILED", tenantId, collection)
        };
      }
    }
  });
});


// POST /ask
// Body: { question, k? }
// Steps:
//  1) embed question
//  2) VSEARCH top-k
//  3) fetch chunks from Postgres
//  4) call OpenAI to generate answer using sources
app.post("/ask", requireJwt, requireRole("reader"), async (req, res) => {

  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "7", 10);
  const docIds = parseDocFilter(req.body?.docIds);
  const answerLength = parseAnswerLength(req.body?.answerLength || req.body?.responseLength);
  const citationMode = parseCitationMode(req.body?.citationMode ?? req.body?.citation_mode);

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }
  if (!answerLength) {
    return res.status(400).json({ error: "answerLength must be one of: auto, short, medium, long" });
  }
  if (!citationMode) {
    return res.status(400).json({ error: "citationMode must be one of: inline, metadata" });
  }

  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollectionScope(req, { defaultAll: true });
    const policy = resolveRequestedMemoryPolicy(req.body);
    const favorRecency = resolveRequestedFavorRecency(req.body);
    const retrievalFilters = parseRetrievalFilterInput(req.body || {});
    const effectiveModels = await getEffectiveTenantModels(tenantId);
    const provider = resolveAskProviderOverride(req.body);
    const model = resolveAskModelOverride(req.body);
    const generationConfig = resolveRequestedGenerationConfig({
      provider,
      model,
      fallbackProvider: effectiveModels.answerProvider,
      fallbackModel: effectiveModels.answerModel
    });
    const generationApiKey = resolveProviderApiKeyOverride(req, generationConfig.provider);

    const result = await answerQuestion({
      tenantId,
      collection,
      question,
      k,
      docIds,
      namespaceIds: retrievalFilters.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      answerLength,
      citationMode,
      policy,
      favorRecency,
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      model,
      provider,
      models: effectiveModels,
      generationApiKey,
      generationBillable: !isRequestScopedProviderUsage(generationApiKey),
      embedApiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider),
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "ask_legacy"
      })
    });
    const citationIds = result.citations.map(c => c.chunkId);

    res.json({
      question,
      answer: result.answer,
      citations: citationIds,
      sources: result.citations,
      answerLength: result.answerLength,
      provider: result.provider,
      model: result.model,
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/ask", requireJwt, requireRole("reader"), async (req, res) => {
  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "7", 10);
  const docIds = parseDocFilter(req.body?.docIds);
  const answerLength = parseAnswerLength(req.body?.answerLength || req.body?.responseLength);
  const citationMode = parseCitationMode(req.body?.citationMode ?? req.body?.citation_mode);

  if (!question || !question.trim()) {
    return sendError(res, 400, "question is required", "INVALID_INPUT", null, null);
  }
  if (!answerLength) {
    return sendError(res, 400, "answerLength must be one of: auto, short, medium, long", "INVALID_INPUT", null, null);
  }
  if (!citationMode) {
    return sendError(res, 400, "citationMode must be one of: inline, metadata", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollectionScope(req, { defaultAll: true });
    const policy = resolveRequestedMemoryPolicy(req.body);
    const favorRecency = resolveRequestedFavorRecency(req.body);
    const retrievalFilters = parseRetrievalFilterInput(req.body || {});
    const effectiveModels = await getEffectiveTenantModels(tenantId);
    const provider = resolveAskProviderOverride(req.body);
    const model = resolveAskModelOverride(req.body);
    const generationConfig = resolveRequestedGenerationConfig({
      provider,
      model,
      fallbackProvider: effectiveModels.answerProvider,
      fallbackModel: effectiveModels.answerModel
    });
    const generationApiKey = resolveProviderApiKeyOverride(req, generationConfig.provider);
    const result = await answerQuestion({
      tenantId,
      collection,
      question,
      k,
      docIds,
      namespaceIds: retrievalFilters.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      answerLength,
      citationMode,
      policy,
      favorRecency,
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      model,
      provider,
      models: effectiveModels,
      generationApiKey,
      generationBillable: !isRequestScopedProviderUsage(generationApiKey),
      embedApiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider),
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "ask_v1"
      })
    });
    sendOk(res, {
      question,
      answer: result.answer,
      citations: result.citations,
      chunksUsed: result.chunksUsed,
      supportingChunks: result.supportingChunks,
      answerLength: result.answerLength,
      provider: result.provider,
      model: result.model,
      k,
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "ASK_FAILED", tenantId, collection);
  }
});

app.post("/code", requireJwt, requireRole("reader"), async (req, res) => {
  const input = parseCodeInput(req.body || {});
  if (!input.question) {
    return res.status(400).json({ error: "question is required" });
  }
  if (!input.answerLength) {
    return res.status(400).json({ error: "answerLength must be one of: auto, short, medium, long" });
  }
  if (!input.citationMode) {
    return res.status(400).json({ error: "citationMode must be one of: inline, metadata" });
  }

  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollectionScope(req, { defaultAll: true });
    const effectiveModels = await getEffectiveTenantModels(tenantId);
    const generationConfig = resolveRequestedGenerationConfig({
      provider: input.provider,
      model: input.model,
      fallbackProvider: effectiveModels.answerProvider,
      fallbackModel: effectiveModels.answerModel
    });
    const generationApiKey = resolveProviderApiKeyOverride(req, generationConfig.provider);
    const result = await answerCodeQuestion({
      tenantId,
      collection,
      question: input.question,
      k: input.k,
      docIds: input.docIds,
      namespaceIds: input.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      answerLength: input.answerLength,
      citationMode: input.citationMode,
      policy: input.policy,
      favorRecency: input.favorRecency,
      tags: input.tags,
      agentId: input.agentId,
      sourceTypes: input.sourceTypes,
      documentTypes: input.documentTypes,
      since: input.since,
      until: input.until,
      timeField: input.timeField,
      task: input.task,
      language: input.language,
      deployment: input.deployment,
      repository: input.repository,
      paths: input.paths,
      errorMessage: input.errorMessage,
      stackTrace: input.stackTrace,
      constraints: input.constraints,
      context: input.context,
      model: input.model,
      provider: input.provider,
      models: effectiveModels,
      generationApiKey,
      generationBillable: !isRequestScopedProviderUsage(generationApiKey),
      embedApiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider),
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "code_legacy"
      })
    });
    const citationIds = result.citations.map((c) => c.chunkId);

    res.json({
      question: input.question,
      answer: result.answer,
      citations: citationIds,
      sources: result.citations,
      files: result.files,
      workingSet: result.workingSet,
      sourceSummary: result.sourceSummary,
      relationshipSummary: result.relationshipSummary,
      supportingChunks: result.supportingChunks,
      answerLength: result.answerLength,
      task: input.task,
      provider: result.provider,
      model: result.model,
      favorRecency: input.favorRecency === null ? undefined : input.favorRecency,
      timeField: input.timeField,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/v1/code", requireJwt, requireRole("reader"), async (req, res) => {
  const input = parseCodeInput(req.body || {});
  if (!input.question) {
    return sendError(res, 400, "question is required", "INVALID_INPUT", null, null);
  }
  if (!input.answerLength) {
    return sendError(res, 400, "answerLength must be one of: auto, short, medium, long", "INVALID_INPUT", null, null);
  }
  if (!input.citationMode) {
    return sendError(res, 400, "citationMode must be one of: inline, metadata", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollectionScope(req, { defaultAll: true });
    const effectiveModels = await getEffectiveTenantModels(tenantId);
    const generationConfig = resolveRequestedGenerationConfig({
      provider: input.provider,
      model: input.model,
      fallbackProvider: effectiveModels.answerProvider,
      fallbackModel: effectiveModels.answerModel
    });
    const generationApiKey = resolveProviderApiKeyOverride(req, generationConfig.provider);
    const result = await answerCodeQuestion({
      tenantId,
      collection,
      question: input.question,
      k: input.k,
      docIds: input.docIds,
      namespaceIds: input.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      answerLength: input.answerLength,
      citationMode: input.citationMode,
      policy: input.policy,
      favorRecency: input.favorRecency,
      tags: input.tags,
      agentId: input.agentId,
      sourceTypes: input.sourceTypes,
      documentTypes: input.documentTypes,
      since: input.since,
      until: input.until,
      timeField: input.timeField,
      task: input.task,
      language: input.language,
      deployment: input.deployment,
      repository: input.repository,
      paths: input.paths,
      errorMessage: input.errorMessage,
      stackTrace: input.stackTrace,
      constraints: input.constraints,
      context: input.context,
      model: input.model,
      provider: input.provider,
      models: effectiveModels,
      generationApiKey,
      generationBillable: !isRequestScopedProviderUsage(generationApiKey),
      embedApiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider),
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "code_v1"
      })
    });
    sendOk(res, {
      question: input.question,
      answer: result.answer,
      citations: result.citations,
      chunksUsed: result.chunksUsed,
      supportingChunks: result.supportingChunks,
      answerLength: result.answerLength,
      task: input.task,
      language: input.language,
      deployment: input.deployment,
      repository: input.repository,
      files: result.files,
      workingSet: result.workingSet,
      sourceSummary: result.sourceSummary,
      relationshipSummary: result.relationshipSummary,
      provider: result.provider,
      model: result.model,
      k: input.k,
      favorRecency: input.favorRecency === null ? undefined : input.favorRecency,
      timeField: input.timeField,
      answerConfidence: result.answerConfidence || "high"
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "CODE_FAILED", tenantId, collection);
  }
});

async function handleBooleanAskLegacy(req, res) {
  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "7", 10);
  const docIds = parseDocFilter(req.body?.docIds);

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollectionScope(req, { defaultAll: true });
    const policy = resolveRequestedMemoryPolicy(req.body);
    const favorRecency = resolveRequestedFavorRecency(req.body);
    const retrievalFilters = parseRetrievalFilterInput(req.body || {});
    const effectiveModels = await getEffectiveTenantModels(tenantId);
    const provider = resolveBooleanAskProviderOverride(req.body);
    const model = resolveBooleanAskModelOverride(req.body);
    const generationConfig = resolveRequestedGenerationConfig({
      provider,
      model,
      fallbackProvider: effectiveModels.booleanAskProvider,
      fallbackModel: effectiveModels.booleanAskModel
    });
    const generationApiKey = resolveProviderApiKeyOverride(req, generationConfig.provider);

    const result = await answerBooleanAskQuestion({
      tenantId,
      collection,
      question,
      k,
      docIds,
      namespaceIds: retrievalFilters.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      policy,
      favorRecency,
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      model,
      provider,
      models: effectiveModels,
      generationApiKey,
      generationBillable: !isRequestScopedProviderUsage(generationApiKey),
      embedApiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider),
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "boolean_ask_legacy"
      })
    });
    const citationIds = result.citations.map((c) => c.chunkId);

    res.json({
      question,
      answer: result.answer,
      citations: citationIds,
      sources: result.citations,
      supportingChunks: result.supportingChunks,
      provider: result.provider,
      model: result.model,
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
}

async function handleBooleanAskV1(req, res) {
  const { question } = req.body || {};
  const k = parseInt(req.body?.k || "7", 10);
  const docIds = parseDocFilter(req.body?.docIds);

  if (!question || !question.trim()) {
    return sendError(res, 400, "question is required", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollectionScope(req, { defaultAll: true });
    const policy = resolveRequestedMemoryPolicy(req.body);
    const favorRecency = resolveRequestedFavorRecency(req.body);
    const retrievalFilters = parseRetrievalFilterInput(req.body || {});
    const effectiveModels = await getEffectiveTenantModels(tenantId);
    const provider = resolveBooleanAskProviderOverride(req.body);
    const model = resolveBooleanAskModelOverride(req.body);
    const generationConfig = resolveRequestedGenerationConfig({
      provider,
      model,
      fallbackProvider: effectiveModels.booleanAskProvider,
      fallbackModel: effectiveModels.booleanAskModel
    });
    const generationApiKey = resolveProviderApiKeyOverride(req, generationConfig.provider);
    const result = await answerBooleanAskQuestion({
      tenantId,
      collection,
      question,
      k,
      docIds,
      namespaceIds: retrievalFilters.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      policy,
      favorRecency,
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      model,
      provider,
      models: effectiveModels,
      generationApiKey,
      generationBillable: !isRequestScopedProviderUsage(generationApiKey),
      embedApiKey: resolveProviderApiKeyOverride(req, effectiveModels.embedProvider),
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "boolean_ask_v1"
      })
    });
    sendOk(res, {
      question,
      answer: result.answer,
      citations: result.citations,
      supportingChunks: result.supportingChunks,
      chunksUsed: result.chunksUsed,
      provider: result.provider,
      model: result.model,
      k,
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "BOOLEAN_ASK_FAILED", tenantId, collection);
  }
}

app.post("/boolean_ask", requireJwt, requireRole("reader"), handleBooleanAskLegacy);
app.post("/yes-no", requireJwt, requireRole("reader"), handleBooleanAskLegacy);
app.post("/v1/boolean_ask", requireJwt, requireRole("reader"), handleBooleanAskV1);
app.post("/v1/yes-no", requireJwt, requireRole("reader"), handleBooleanAskV1);


// DELETE /docs/:docId
// - remove chunk text from Postgres
// - remove vectors from the vector store
app.delete("/docs/:docId", requireJwt, requireRole("indexer"), async (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return res.status(400).json({ error: "docId required" });
  if (!isValidDocId(docId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)" });
  }
  const tenantId = resolveTenantId(req);
  const collection = resolveCollection(req);
  const namespaced = namespaceDocId(tenantId, collection, docId);
  let deletedVectors = 0;
  let failedVectors = 0;
  const cleanup = await deleteVectorsForDoc(namespaced, { strict: true });
  deletedVectors += cleanup.deleted;
  failedVectors += cleanup.failed;
  if (collection === DEFAULT_COLLECTION) {
    const legacy = `${tenantId}::${docId}`;
    if (legacy !== namespaced) {
      const legacyCleanup = await deleteVectorsForDoc(legacy, { strict: true });
      deletedVectors += legacyCleanup.deleted;
      failedVectors += legacyCleanup.failed;
    }
  }
  if (failedVectors > 0) {
    return res.status(400).json({ error: `Failed to delete ${failedVectors} vectors`, tenantId, collection });
  }
  await deleteMemoryItemByNamespaceId(namespaced);
  if (collection === DEFAULT_COLLECTION) {
    const legacy = `${tenantId}::${docId}`;
    if (legacy !== namespaced) {
      await deleteMemoryItemByNamespaceId(legacy);
    }
  }
  scheduleStorageUsageMeter(tenantId, buildTelemetryContext({
    requestId: req.requestId,
    tenantId,
    collection,
    source: "docs_delete_legacy"
  }), {
    operation: "document_delete",
    docId,
    deletedVectors
  });
  await recordAudit(req, tenantId, {
    action: "doc.deleted",
    targetType: "doc",
    targetId: docId,
    metadata: {
      collection,
      namespaceId: namespaced,
      deletedVectors
    }
  });
  res.json({
    ok: true,
    docId,
    collection,
    tenantId,
    deletedVectors,
    note: "Deleted chunk text and vectors."
  });
});

app.delete("/v1/docs/:docId", requireJwt, requireRole("indexer"), async (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return sendError(res, 400, "docId required", "INVALID_INPUT", null, null);
  if (!isValidDocId(docId)) {
    return sendError(res, 400, "docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const namespaced = namespaceDocId(tenantId, collection, docId);
    let deletedVectors = 0;
    let failedVectors = 0;
    const cleanup = await deleteVectorsForDoc(namespaced, { strict: true });
    deletedVectors += cleanup.deleted;
    failedVectors += cleanup.failed;
    if (collection === DEFAULT_COLLECTION) {
      const legacy = `${tenantId}::${docId}`;
      if (legacy !== namespaced) {
        const legacyCleanup = await deleteVectorsForDoc(legacy, { strict: true });
        deletedVectors += legacyCleanup.deleted;
        failedVectors += legacyCleanup.failed;
      }
    }
    if (failedVectors > 0) {
      throw new Error(`Failed to delete ${failedVectors} vectors`);
    }
    await deleteMemoryItemByNamespaceId(namespaced);
    if (collection === DEFAULT_COLLECTION) {
      const legacy = `${tenantId}::${docId}`;
      if (legacy !== namespaced) {
        await deleteMemoryItemByNamespaceId(legacy);
      }
    }
    scheduleStorageUsageMeter(tenantId, buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "docs_delete_v1"
    }), {
      operation: "document_delete",
      docId,
      deletedVectors
    });
    await recordAudit(req, tenantId, {
      action: "doc.deleted",
      targetType: "doc",
      targetId: docId,
      metadata: {
        collection,
        namespaceId: namespaced,
        deletedVectors
      }
    });
    sendOk(res, {
      docId,
      deletedVectors,
      note: "Deleted chunk text and vectors."
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "DELETE_FAILED", tenantId, collection);
  }
});

// GET /search?q=...&k=5
// - embed query
// - VSEARCH top-k
// - fetch chunk texts from Postgres for previews
app.get("/search", requireJwt, requireRole("reader"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const k = parseInt(req.query.k || "5", 10);
  const docIds = parseDocFilter(req.query.docIds || req.query.docs);

  try {
    const tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    const collection = resolveCollectionScope(req, { defaultAll: true });
    if (!q) {
      return res.json({
        query: "",
        results: [],
        tenantId,
        collection
      });
    }
    const policy = resolveRequestedMemoryPolicy(req.query);
    const favorRecency = resolveRequestedFavorRecency(req.query);
    const retrievalFilters = parseRetrievalFilterInput(req.query || {});
    const embedConfig = await getRequestEmbeddingConfig(req, tenantId);

    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds,
      namespaceIds: retrievalFilters.namespaceIds,
      policy,
      favorRecency,
      apiKey: embedConfig.apiKey,
      embedProvider: embedConfig.embedProvider,
      embedModel: embedConfig.embedModel,
      principalId: access.principalId,
      privileges: access.privileges,
      enforceArtifactVisibility: true,
      candidateTypes: ["artifact"],
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "search_legacy"
      })
    });

    res.json({
      query: q,
      results: results.map(r => ({
        id: r.chunkId,
        score: r.score,
        docId: r.docId,
        collection: r.collection,
        preview: r.preview
      })),
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/v1/search", requireJwt, requireRole("reader"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const k = parseInt(req.query.k || "5", 10);
  const docIds = parseDocFilter(req.query.docIds || req.query.docs);

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollectionScope(req, { defaultAll: true });
    if (!q) {
      return sendOk(res, {
        query: "",
        results: []
      }, tenantId, collection);
    }
    const policy = resolveRequestedMemoryPolicy(req.query);
    const favorRecency = resolveRequestedFavorRecency(req.query);
    const retrievalFilters = parseRetrievalFilterInput(req.query || {});
    const embedConfig = await getRequestEmbeddingConfig(req, tenantId);
    const results = await searchChunks({
      tenantId,
      collection,
      query: q,
      k,
      docIds,
      namespaceIds: retrievalFilters.namespaceIds,
      policy,
      favorRecency,
      apiKey: embedConfig.apiKey,
      embedProvider: embedConfig.embedProvider,
      embedModel: embedConfig.embedModel,
      principalId: access.principalId,
      privileges: access.privileges,
      enforceArtifactVisibility: true,
      candidateTypes: ["artifact"],
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      telemetry: buildTelemetryContext({
        requestId: req.requestId,
        tenantId,
        collection,
        source: "search_v1"
      })
    });
    sendOk(res, {
      query: q,
      results: results.map(r => ({
        chunkId: r.chunkId,
        score: r.score,
        docId: r.docId,
        collection: r.collection,
        preview: r.preview
      })),
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "SEARCH_FAILED", tenantId, collection);
  }
});

// --------------------------
// Memory APIs (protected)
// --------------------------
const memoryWriteLegacy = async (req, res) => {
  const { text } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "text is required", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    const result = await memoryWriteCore(req);
    tenantId = result.tenantId;
    collection = result.collection;

    res.json({
      ok: true,
      memory: formatMemoryItem(result.memory),
      chunksIndexed: result.chunksIndexed,
      truncated: result.truncated,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryWriteV1 = async (req, res) => {
  const { text } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json(buildErrorPayload("text is required", "INVALID_INPUT", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/memory/write",
    handler: async () => {
      try {
        const result = await memoryWriteCore(req);
        return {
          status: 200,
          payload: buildOkPayload({
            memory: formatMemoryItem(result.memory),
            chunksIndexed: result.chunksIndexed,
            truncated: result.truncated
          }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "MEMORY_WRITE_FAILED", tenantId, collection)
        };
      }
    }
  });
};

app.post(["/memory", "/memory/write"], requireJwt, requireRole("indexer"), memoryWriteLegacy);
app.post(["/v1/memory", "/v1/memory/write"], requireJwt, requireRole("indexer"), memoryWriteV1);

app.post("/memory/recall", requireJwt, requireRole("reader"), async (req, res) => {
  const { query, k, types } = req.body || {};
  const limit = parseInt(k || "5", 10);

  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: "query is required", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const telemetryContext = buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "memory_recall_legacy"
    });
    const typeFilter = parseTypeFilter(types);
    const retrievalFilters = parseRetrievalFilterInput(req.body || {});
    const policy = resolveRequestedMemoryPolicy(req.body);
    const favorRecency = resolveRequestedFavorRecency(req.body);
    const embedConfig = await getRequestEmbeddingConfig(req, tenantId);

    const results = await searchChunks({
      tenantId,
      collection,
      query,
      k: limit,
      docIds: [],
      namespaceIds: retrievalFilters.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      candidateTypes: typeFilter.length ? typeFilter : MEMORY_TYPES,
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      policy,
      favorRecency,
      apiKey: embedConfig.apiKey,
      embedProvider: embedConfig.embedProvider,
      embedModel: embedConfig.embedModel,
      telemetry: telemetryContext
    });

    const namespaceIds = results.map(r => r._row.doc_id);
    const memoryMap = await getMemoryItemsByNamespaceIds({
      tenantId,
      collection,
      namespaceIds,
      types: typeFilter,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      excludeExpired: true,
      principalId: access.principalId,
      privileges: access.privileges,
      agentId: retrievalFilters.agentId,
      tags: retrievalFilters.tags
    });

    const recalled = [];
    const recalledItems = [];
    const seen = new Set();
    for (const r of results) {
      const mem = memoryMap.get(r._row.doc_id);
      if (!mem) continue;
      recalled.push({
        score: r.score,
        chunkId: r.chunkId,
        preview: r.preview,
        memory: formatMemoryItem(mem)
      });
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        recalledItems.push(mem);
      }
      if (recalled.length >= limit) break;
    }

    await recordMemoryEventsForItems(recalledItems, "retrieved");
    emitTelemetry("memory_retrieval", telemetryContext, {
      operation: "memory_recall",
      query_chars: String(query || "").length,
      retrieved_top_n: recalled.length,
      retrieved_count: recalled.length,
      retrieved: recalled.map((entry) => ({
        memory_id: entry?.memory?.id || null,
        item_type: entry?.memory?.type || null,
        chunk_id: entry?.chunkId || null,
        score: entry?.score ?? null,
        value_score: entry?.memory?.valueScore ?? null
      }))
    });

    res.json({
      ok: true,
      query,
      results: recalled,
      k: limit,
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField,
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
});

app.post("/v1/memory/recall", requireJwt, requireRole("reader"), async (req, res) => {
  const { query, k, types } = req.body || {};
  const limit = parseInt(k || "5", 10);

  if (!query || !String(query).trim()) {
    return sendError(res, 400, "query is required", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const access = resolveAccessContext(req);
    collection = resolveCollection(req);
    const telemetryContext = buildTelemetryContext({
      requestId: req.requestId,
      tenantId,
      collection,
      source: "memory_recall_v1"
    });
    const typeFilter = parseTypeFilter(types);
    const retrievalFilters = parseRetrievalFilterInput(req.body || {});
    const policy = resolveRequestedMemoryPolicy(req.body);
    const favorRecency = resolveRequestedFavorRecency(req.body);
    const embedConfig = await getRequestEmbeddingConfig(req, tenantId);

    const results = await searchChunks({
      tenantId,
      collection,
      query,
      k: limit,
      docIds: [],
      namespaceIds: retrievalFilters.namespaceIds,
      principalId: access.principalId,
      privileges: access.privileges,
      candidateTypes: typeFilter.length ? typeFilter : MEMORY_TYPES,
      tags: retrievalFilters.tags,
      agentId: retrievalFilters.agentId,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      policy,
      favorRecency,
      apiKey: embedConfig.apiKey,
      embedProvider: embedConfig.embedProvider,
      embedModel: embedConfig.embedModel,
      telemetry: telemetryContext
    });

    const namespaceIds = results.map(r => r._row.doc_id);
    const memoryMap = await getMemoryItemsByNamespaceIds({
      tenantId,
      collection,
      namespaceIds,
      types: typeFilter,
      sourceTypes: retrievalFilters.sourceTypes,
      documentTypes: retrievalFilters.documentTypes,
      since: retrievalFilters.since,
      until: retrievalFilters.until,
      timeField: retrievalFilters.timeField,
      excludeExpired: true,
      principalId: access.principalId,
      privileges: access.privileges,
      agentId: retrievalFilters.agentId,
      tags: retrievalFilters.tags
    });

    const recalled = [];
    const recalledItems = [];
    const seen = new Set();
    for (const r of results) {
      const mem = memoryMap.get(r._row.doc_id);
      if (!mem) continue;
      recalled.push({
        score: r.score,
        chunkId: r.chunkId,
        preview: r.preview,
        memory: formatMemoryItem(mem)
      });
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        recalledItems.push(mem);
      }
      if (recalled.length >= limit) break;
    }

    await recordMemoryEventsForItems(recalledItems, "retrieved");
    emitTelemetry("memory_retrieval", telemetryContext, {
      operation: "memory_recall",
      query_chars: String(query || "").length,
      retrieved_top_n: recalled.length,
      retrieved_count: recalled.length,
      retrieved: recalled.map((entry) => ({
        memory_id: entry?.memory?.id || null,
        item_type: entry?.memory?.type || null,
        chunk_id: entry?.chunkId || null,
        score: entry?.score ?? null,
        value_score: entry?.memory?.valueScore ?? null
      }))
    });

    sendOk(res, {
      query,
      results: recalled,
      k: limit,
      favorRecency: favorRecency === null ? undefined : favorRecency,
      timeField: retrievalFilters.timeField
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_RECALL_FAILED", tenantId, collection);
  }
});

app.get("/v1/memory/conversation_wiki", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const principalId = resolvePrincipalId(req);
    const conversationId = String(req.query?.conversationId || req.query?.conversation_id || "").trim();
    if (!conversationId) {
      return sendError(res, 400, "conversationId is required", "INVALID_INPUT", tenantId, collection);
    }
    const pages = normalizeConversationWikiPagesInput(req.query?.pages);
    const records = await loadConversationWikiPageRecords({
      tenantId,
      collection,
      conversationId,
      pages,
      principalId
    });
    const activeJob = await findActiveConversationWikiJob({ tenantId, collection, conversationId });
    sendOk(res, {
      conversationId,
      pages: records,
      pageCount: records.length,
      checkpointTurnExternalId: getConversationWikiCheckpoint(records),
      revision: getConversationWikiRevision(records),
      lastUpdatedAt: getConversationWikiLastUpdatedAt(records),
      activeJob: formatConversationWikiJob(activeJob)
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "CONVERSATION_WIKI_FETCH_FAILED", tenantId, collection);
  }
});

app.put("/v1/memory/conversation_wiki", requireJwt, requireRole("indexer"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const principalId = resolvePrincipalId(req);
    const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "").trim();
    const page = String(req.body?.page || CONVERSATION_WIKI_ARTICLE_PAGE).trim() || CONVERSATION_WIKI_ARTICLE_PAGE;
    if (!conversationId) {
      return sendError(res, 400, "conversationId is required", "INVALID_INPUT", tenantId, collection);
    }
    if (!CONVERSATION_WIKI_PAGE_SET.has(page)) {
      return sendError(res, 400, `page must be one of: ${Array.from(CONVERSATION_WIKI_PAGE_SET).join(", ")}`, "INVALID_INPUT", tenantId, collection);
    }
    const wikiLock = await acquireConversationWikiLock({ tenantId, collection, conversationId });
    if (!wikiLock) {
      return sendError(res, 409, "Conversation wiki is currently being updated", "CONVERSATION_WIKI_LOCKED", tenantId, collection);
    }
    try {
    const existing = await loadConversationWikiPageRecords({
      tenantId,
      collection,
      conversationId,
      pages: [page],
      principalId
    });
    const visibility = req.body?.visibility ? normalizeVisibility(req.body.visibility) : (existing[0]?.memory?.visibility || "tenant");
    const acl = visibility === "acl"
      ? normalizeAclList(req.body?.acl || existing[0]?.memory?.acl || [], principalId)
      : [];
    const policy = resolveRequestedMemoryPolicy(req.body, existing[0]?.memory?.policy || DEFAULT_MEMORY_POLICY);
    const revision = getConversationWikiRevision(existing) + 1;
      const updated = await upsertConversationWikiPage({
        tenantId,
        collection,
        conversationId,
        page,
        title: req.body?.title,
        note: req.body?.note,
        paragraphs: req.body?.paragraphs ?? req.body?.body ?? req.body?.text,
        sections: req.body?.sections || {},
        sourceExchanges: req.body?.sourceExchanges || existing[0]?.sourceExchanges || existing[0]?.memory?.metadata?.sourceExchanges || [],
        checkpointTurnExternalId: req.body?.checkpointTurnExternalId || req.body?.checkpoint_turn_external_id || existing[0]?.checkpointTurnExternalId || null,
        revision,
      pageMaxChars: Number(req.body?.pageMaxChars || req.body?.page_max_chars || CONVERSATION_WIKI_MAX_PAGE_CHARS),
      principalId,
      visibility,
      acl,
      agentId: normalizeAgentId(req.body?.agentId ?? req.body?.agent_id ?? existing[0]?.memory?.agentId),
      sourceType: "conversation_wiki_manual",
      policy,
      baseTags: req.body?.baseTags || req.body?.base_tags || existing[0]?.memory?.tags || []
    });
    recordConversationWikiMetrics(tenantId, {
      pagesUpdated: 1,
      lastPageCount: Math.max(existing.length, 1),
      lastUpdatedAt: updated.updatedAt || updated.memory?.createdAt || null
    });
    emitConversationWikiTelemetry("manual_update", {
      requestId: req.requestId,
      tenantId,
      collection,
      conversationId,
      source: "conversation_wiki_api"
    }, {
      page,
      revision: updated.revision
    });
    sendOk(res, { conversationId, page: updated }, tenantId, collection);
    } finally {
      await releaseConversationWikiLock(wikiLock).catch(() => null);
    }
  } catch (e) {
    sendError(res, 400, e, "CONVERSATION_WIKI_UPDATE_FAILED", tenantId, collection);
  }
});

async function handleConversationWikiJobEnqueue(req, res, { forceDefault = false } = {}) {
  let tenantId = null;
  let collection = null;
  try {
    assertNoOpenAiApiKeyOverride(req, forceDefault ? "/v1/memory/conversation_wiki/rebuild" : "/v1/memory/conversation_wiki/update");
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const principalId = resolvePrincipalId(req);
    const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "").trim();
    if (!conversationId) {
      return sendError(res, 400, "conversationId is required", "INVALID_INPUT", tenantId, collection);
    }
    const policy = resolveRequestedMemoryPolicy(req.body, DEFAULT_MEMORY_POLICY);
    const visibility = normalizeVisibility(req.body?.visibility);
    const acl = visibility === "acl" ? normalizeAclList(req.body?.acl, principalId) : [];
    if (visibility === "acl" && acl.length === 0) {
      return sendError(res, 400, "acl list is required when visibility is acl", "INVALID_INPUT", tenantId, collection);
    }
    const job = await enqueueConversationWikiUpdateJob({
      tenantId,
      collection,
      conversationId,
      principalId,
      agentId: normalizeAgentId(req.body?.agentId ?? req.body?.agent_id),
      provider: req.body?.provider || null,
      model: req.body?.model || null,
      policy,
      visibility,
      acl,
      pages: req.body?.pages,
      pageMaxChars: Number(req.body?.pageMaxChars || req.body?.page_max_chars || CONVERSATION_WIKI_MAX_PAGE_CHARS),
      keepRecentTurns: Number(req.body?.keepRecentTurns || req.body?.keep_recent_turns || 4),
      updateEveryTurns: Number(req.body?.updateEveryTurns || req.body?.update_every_turns || 4),
      force: forceDefault || Boolean(req.body?.force),
      sourceType: req.body?.sourceType || req.body?.source_type || "conversation_wiki",
      baseTags: req.body?.baseTags || req.body?.base_tags || []
    });
    setImmediate(() => {
      runConversationWikiUpdateJob(job.id, tenantId).catch(() => {});
    });
    sendOk(res, { job: { id: job.id, status: job.status } }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "CONVERSATION_WIKI_JOB_FAILED", tenantId, collection);
  }
}

app.post("/v1/memory/conversation_wiki/update", requireJwt, requireRole("indexer"), async (req, res) => {
  return handleConversationWikiJobEnqueue(req, res, { forceDefault: false });
});

app.post("/v1/memory/conversation_wiki/rebuild", requireJwt, requireRole("indexer"), async (req, res) => {
  return handleConversationWikiJobEnqueue(req, res, { forceDefault: true });
});

app.delete("/v1/memory/conversation_wiki/conversations", requireJwt, requireRole("indexer"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const job = await enqueueConversationMemoryClearJob({
      tenantId,
      collection,
      requestId: req.requestId || null,
      source: "conversation_wiki_api"
    });
    setImmediate(() => {
      runConversationMemoryClearJob(job.id, tenantId).catch(() => {});
    });
    sendOk(res, {
      job: formatConversationWikiJob(job),
      wiki: {
        job: formatConversationWikiJob(job)
      }
    }, tenantId, collection);
  } catch (e) {
    sendError(res, e?.status || 400, e, "CONVERSATION_WIKI_CLEAR_ALL_FAILED", tenantId, collection);
  }
});

app.delete("/v1/memory/conversation_wiki", requireJwt, requireRole("indexer"), async (req, res) => {
  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    const principalId = resolvePrincipalId(req);
    const conversationId = String(req.query?.conversationId || req.body?.conversationId || req.query?.conversation_id || req.body?.conversation_id || "").trim();
    if (!conversationId) {
      return sendError(res, 400, "conversationId is required", "INVALID_INPUT", tenantId, collection);
    }
    const wikiLock = await acquireConversationWikiLock({ tenantId, collection, conversationId });
    if (!wikiLock) {
      return sendError(res, 409, "Conversation wiki is currently being updated", "CONVERSATION_WIKI_LOCKED", tenantId, collection);
    }
    try {
    const deleted = await deleteConversationWikiPages({
      tenantId,
      collection,
      conversationId,
      principalId,
      requestId: req.requestId || null,
      source: "conversation_wiki_api"
    });
    if (deleted.some((item) => item.deleted)) {
      recordConversationWikiMetrics(tenantId, {
        lastPageCount: 0,
        lastUpdatedAt: new Date().toISOString()
      });
    }
    emitConversationWikiTelemetry("deleted", {
      requestId: req.requestId,
      tenantId,
      collection,
      conversationId,
      source: "conversation_wiki_api"
    }, {
      deleted_count: deleted.filter((item) => item.deleted).length,
      queued_count: deleted.filter((item) => item.queued).length
    });
    sendOk(res, { conversationId, deletedCount: deleted.filter((item) => item.deleted).length, deleted }, tenantId, collection);
    } finally {
      await releaseConversationWikiLock(wikiLock).catch(() => null);
    }
  } catch (e) {
    sendError(res, 400, e, "CONVERSATION_WIKI_DELETE_FAILED", tenantId, collection);
  }
});
app.post("/v1/feedback", requireJwt, requireRole("reader"), async (req, res) => {
  const { memoryId, feedback, eventValue } = req.body || {};
  if (!memoryId || !String(memoryId).trim()) {
    return sendError(res, 400, "memoryId is required", "INVALID_INPUT", null, null);
  }

  const choice = String(feedback || "").trim().toLowerCase();
  if (!choice || (choice !== "positive" && choice !== "negative")) {
    return sendError(res, 400, "feedback must be positive or negative", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const memory = await getMemoryItemById(memoryId, tenantId, principalId);
    if (!memory) {
      return sendError(res, 404, "memory not found", "NOT_FOUND", tenantId, null);
    }
    collection = memory.collection || null;
    const eventType = choice === "positive" ? "user_positive" : "user_negative";
    const updated = await recordMemoryEventForItem(memory, eventType, eventValue);
    sendOk(res, {
      memoryId: memory.id,
      eventType,
      valueScore: updated?.value_score ?? memory.value_score ?? null
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "FEEDBACK_FAILED", tenantId, collection);
  }
});

app.post("/v1/memory/event", requireJwt, requireRole("reader"), async (req, res) => {
  const { memoryId, eventType, eventValue } = req.body || {};
  if (!memoryId || !String(memoryId).trim()) {
    return sendError(res, 400, "memoryId is required", "INVALID_INPUT", null, null);
  }

  const cleanType = String(eventType || "").trim();
  if (!MEMORY_TASK_EVENT_TYPES.has(cleanType)) {
    return sendError(res, 400, "eventType must be task_success or task_fail", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    const memory = await getMemoryItemById(memoryId, tenantId, principalId);
    if (!memory) {
      return sendError(res, 404, "memory not found", "NOT_FOUND", tenantId, null);
    }
    collection = memory.collection || null;
    const normalizedValue = normalizeEventValue(cleanType, eventValue);
    const updated = await recordMemoryEventForItem(memory, cleanType, eventValue);
    sendOk(res, {
      memoryId: memory.id,
      eventType: cleanType,
      eventValue: normalizedValue,
      utilityEma: updated?.utility_ema ?? memory.utility_ema ?? 0,
      trustScore: updated?.trust_score ?? memory.trust_score ?? 0.5,
      valueScore: updated?.value_score ?? memory.value_score ?? null
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_EVENT_FAILED", tenantId, collection);
  }
});

const memoryReflectLegacy = async (req, res) => {
  const { docId, artifactId, conversationId, types, maxItems, visibility, acl } = req.body || {};

  if (!docId && !artifactId && !conversationId) {
    return res.status(400).json({ error: "docId, artifactId, or conversationId is required", tenantId: null, collection: null });
  }
  if (docId && !isValidDocId(docId)) {
    return res.status(400).json({ error: "docId must use only letters, numbers, dot, dash, or underscore (no spaces)", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    assertNoOpenAiApiKeyOverride(req, "/memory/reflect");
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
    const reflectTypes = normalizeReflectTypes(types);
    const policy = resolveRequestedMemoryPolicy(req.body);
    const limit = parseInt(maxItems || "5", 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("maxItems must be a positive number");
    }
    const resolvedVisibility = normalizeVisibility(visibility);
    const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
    if (resolvedVisibility === "acl" && aclList.length === 0) {
      throw new Error("acl list is required when visibility is acl");
    }

    const job = await createMemoryJob({
      tenantId,
      jobType: "reflect",
      status: "queued",
      maxAttempts: JOB_MAX_ATTEMPTS,
      input: {
        docId: docId || null,
        artifactId: artifactId || null,
        conversationId: conversationId || null,
        types: reflectTypes,
        maxItems: limit,
        collection,
        principalId,
        policy,
        visibility: resolvedVisibility,
        acl: aclList
      }
    });

    setImmediate(() => {
      runReflectionJob(job.id, tenantId).catch(() => {});
    });

    res.json({
      ok: true,
      job: {
        id: job.id,
        status: job.status
      },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryReflectV1 = async (req, res) => {
  const { docId, artifactId, conversationId, types, maxItems, visibility, acl } = req.body || {};

  if (!docId && !artifactId && !conversationId) {
    return res.status(400).json(buildErrorPayload("docId, artifactId, or conversationId is required", "INVALID_INPUT", null, null));
  }
  if (docId && !isValidDocId(docId)) {
    return res.status(400).json(buildErrorPayload("docId must use only letters, numbers, dot, dash, or underscore (no spaces)", "INVALID_DOC_ID", null, null));
  }

  let tenantId = null;
  let collection = null;
  let principalId = null;
  try {
    assertNoOpenAiApiKeyOverride(req, "/v1/memory/reflect");
    tenantId = resolveTenantId(req);
    collection = resolveCollection(req);
    principalId = resolvePrincipalId(req);
  } catch (e) {
    return res.status(400).json(buildErrorPayload(String(e.message || e), "INVALID_INPUT", null, null));
  }

  const reflectTypes = normalizeReflectTypes(types);
  const policy = resolveRequestedMemoryPolicy(req.body);
  const limit = parseInt(maxItems || "5", 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return res.status(400).json(buildErrorPayload("maxItems must be a positive number", "INVALID_INPUT", tenantId, collection));
  }
  const resolvedVisibility = normalizeVisibility(visibility);
  const aclList = resolvedVisibility === "acl" ? normalizeAclList(acl, principalId) : [];
  if (resolvedVisibility === "acl" && aclList.length === 0) {
    return res.status(400).json(buildErrorPayload("acl list is required when visibility is acl", "INVALID_INPUT", tenantId, collection));
  }

  return handleIdempotentRequest({
    req,
    res,
    tenantId,
    collection,
    principalId,
    endpoint: "v1/memory/reflect",
    payloadForHash: {
      docId: docId || null,
      artifactId: artifactId || null,
      conversationId: conversationId || null,
      types: reflectTypes,
      maxItems: limit,
      collection,
      tenantId,
      principalId,
      policy,
      visibility: resolvedVisibility,
      acl: aclList
    },
    handler: async () => {
      try {
        const job = await createMemoryJob({
          tenantId,
          jobType: "reflect",
          status: "queued",
          maxAttempts: JOB_MAX_ATTEMPTS,
          input: {
            docId: docId || null,
            artifactId: artifactId || null,
            conversationId: conversationId || null,
            types: reflectTypes,
            maxItems: limit,
            collection,
            principalId,
            policy,
            visibility: resolvedVisibility,
            acl: aclList
          }
        });

        setImmediate(() => {
          runReflectionJob(job.id, tenantId).catch(() => {});
        });

        return {
          status: 200,
          payload: buildOkPayload({
            job: {
              id: job.id,
              status: job.status
            }
          }, tenantId, collection)
        };
      } catch (e) {
        return {
          status: 400,
          payload: buildErrorPayload(e, "MEMORY_REFLECT_FAILED", tenantId, collection)
        };
      }
    }
  });
};

app.post("/memory/reflect", requireJwt, requireRole("indexer"), memoryReflectLegacy);
app.post("/v1/memory/reflect", requireJwt, requireRole("indexer"), memoryReflectV1);

const memoryCleanupLegacy = async (req, res) => {
  const { before, limit, dryRun } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    assertNoOpenAiApiKeyOverride(req, "/memory/compact");
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const cutoff = before ? parseTimeInput(before, "before") : new Date();
    const max = parseInt(limit || "200", 10);
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error("limit must be a positive number");
    }

    const job = await createMemoryJob({
      tenantId,
      jobType: "ttl_cleanup",
      status: "queued",
      maxAttempts: JOB_MAX_ATTEMPTS,
      input: {
        before: cutoff.toISOString(),
        limit: max,
        dryRun: Boolean(dryRun),
        collection,
        principalId
      }
    });

    setImmediate(() => {
      runTtlCleanupJob(job.id, tenantId).catch(() => {});
    });

    res.json({
      ok: true,
      job: { id: job.id, status: job.status },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryCleanupV1 = async (req, res) => {
  const { before, limit, dryRun } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    assertNoOpenAiApiKeyOverride(req, "/v1/memory/compact");
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const cutoff = before ? parseTimeInput(before, "before") : new Date();
    const max = parseInt(limit || "200", 10);
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error("limit must be a positive number");
    }

    const job = await createMemoryJob({
      tenantId,
      jobType: "ttl_cleanup",
      status: "queued",
      maxAttempts: JOB_MAX_ATTEMPTS,
      input: {
        before: cutoff.toISOString(),
        limit: max,
        dryRun: Boolean(dryRun),
        collection,
        principalId
      }
    });

    setImmediate(() => {
      runTtlCleanupJob(job.id, tenantId).catch(() => {});
    });

    sendOk(res, { job: { id: job.id, status: job.status } }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_CLEANUP_FAILED", tenantId, collection);
  }
};

const memoryCompactLegacy = async (req, res) => {
  const { types, since, until, maxItems, summaryType, deleteOriginals, visibility, acl } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    assertNoOpenAiApiKeyOverride(req, "/memory/compact");
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const policy = resolveRequestedMemoryPolicy(req.body);

    const job = await createMemoryJob({
      tenantId,
      jobType: "compaction",
      status: "queued",
      maxAttempts: JOB_MAX_ATTEMPTS,
      input: {
        types: types ?? null,
        since: since || null,
        until: until || null,
        maxItems: maxItems || null,
        summaryType: summaryType || null,
        deleteOriginals: Boolean(deleteOriginals),
        collection,
        principalId,
        policy,
        visibility: visibility || null,
        acl: acl || null
      }
    });

    setImmediate(() => {
      runCompactionJob(job.id, tenantId).catch(() => {});
    });

    res.json({
      ok: true,
      job: { id: job.id, status: job.status },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
};

const memoryCompactV1 = async (req, res) => {
  const { types, since, until, maxItems, summaryType, deleteOriginals, visibility, acl } = req.body || {};

  let tenantId = null;
  let collection = null;
  try {
    assertNoOpenAiApiKeyOverride(req, "/v1/memory/compact");
    tenantId = resolveTenantId(req);
    const principalId = resolvePrincipalId(req);
    collection = resolveCollection(req);
    const policy = resolveRequestedMemoryPolicy(req.body);

    const job = await createMemoryJob({
      tenantId,
      jobType: "compaction",
      status: "queued",
      maxAttempts: JOB_MAX_ATTEMPTS,
      input: {
        types: types ?? null,
        since: since || null,
        until: until || null,
        maxItems: maxItems || null,
        summaryType: summaryType || null,
        deleteOriginals: Boolean(deleteOriginals),
        collection,
        principalId,
        policy,
        visibility: visibility || null,
        acl: acl || null
      }
    });

    setImmediate(() => {
      runCompactionJob(job.id, tenantId).catch(() => {});
    });

    sendOk(res, { job: { id: job.id, status: job.status } }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "MEMORY_COMPACTION_FAILED", tenantId, collection);
  }
};

app.post("/memory/cleanup", requireJwt, requireRole("admin"), memoryCleanupLegacy);
app.post("/v1/memory/cleanup", requireJwt, requireRole("admin"), memoryCleanupV1);
app.post("/memory/compact", requireJwt, requireRole("admin"), memoryCompactLegacy);
app.post("/v1/memory/compact", requireJwt, requireRole("admin"), memoryCompactV1);

app.get("/jobs", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const limit = parseInt(req.query?.limit || "20", 10);
    const statusRaw = req.query?.status ? String(req.query.status).trim() : null;
    let status = statusRaw;
    if (statusRaw === "in_progress" || statusRaw === "active") {
      status = ["queued", "running"];
    }
    const jobType = req.query?.jobType ? String(req.query.jobType) : null;
    const rows = await listMemoryJobs({ tenantId, limit, status, jobType });
    const jobs = rows.map((job) => ({
      id: job.id,
      status: job.status,
      jobType: job.job_type,
      input: parseJsonPayload(job.input),
      output: parseJsonPayload(job.output),
      error: job.error || null,
      attempts: job.attempts ?? 0,
      maxAttempts: job.max_attempts ?? null,
      nextRunAt: job.next_run_at || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    res.json({ ok: true, jobs, tenantId, collection: null });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection: null });
  }
});

app.get("/v1/jobs", requireJwt, requireRole("reader"), async (req, res) => {
  let tenantId = null;
  try {
    tenantId = resolveTenantId(req);
    const limit = parseInt(req.query?.limit || "20", 10);
    const statusRaw = req.query?.status ? String(req.query.status).trim() : null;
    let status = statusRaw;
    if (statusRaw === "in_progress" || statusRaw === "active") {
      status = ["queued", "running"];
    }
    const jobType = req.query?.jobType ? String(req.query.jobType) : null;
    const rows = await listMemoryJobs({ tenantId, limit, status, jobType });
    const jobs = rows.map((job) => ({
      id: job.id,
      status: job.status,
      jobType: job.job_type,
      input: parseJsonPayload(job.input),
      output: parseJsonPayload(job.output),
      error: job.error || null,
      attempts: job.attempts ?? 0,
      maxAttempts: job.max_attempts ?? null,
      nextRunAt: job.next_run_at || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }));
    sendOk(res, { jobs }, tenantId, null);
  } catch (e) {
    sendError(res, 400, e, "JOBS_LIST_FAILED", tenantId, null);
  }
});

app.get("/jobs/:id", requireJwt, requireRole("reader"), async (req, res) => {
  const id = parseInt(req.params.id || "0", 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid job id", tenantId: null, collection: null });
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const job = await getMemoryJobById(id, tenantId);
    if (!job) {
      return res.status(404).json({ error: "job not found", tenantId, collection });
    }
    const input = parseJsonPayload(job.input);
    const output = parseJsonPayload(job.output);
    collection = input?.collection || null;

    res.json({
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        jobType: job.job_type,
        input,
        output,
        error: job.error || null,
        attempts: job.attempts ?? 0,
        maxAttempts: job.max_attempts ?? null,
        nextRunAt: job.next_run_at || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      },
      tenantId,
      collection
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e), tenantId, collection });
  }
});

app.get("/v1/jobs/:id", requireJwt, requireRole("reader"), async (req, res) => {
  const id = parseInt(req.params.id || "0", 10);
  if (!Number.isFinite(id) || id <= 0) {
    return sendError(res, 400, "invalid job id", "INVALID_INPUT", null, null);
  }

  let tenantId = null;
  let collection = null;
  try {
    tenantId = resolveTenantId(req);
    const job = await getMemoryJobById(id, tenantId);
    if (!job) {
      return sendError(res, 404, "job not found", "NOT_FOUND", tenantId, collection);
    }
    const input = parseJsonPayload(job.input);
    const output = parseJsonPayload(job.output);
    collection = input?.collection || null;

    sendOk(res, {
      job: {
        id: job.id,
        status: job.status,
        jobType: job.job_type,
        input,
        output,
        error: job.error || null,
        attempts: job.attempts ?? 0,
        maxAttempts: job.max_attempts ?? null,
        nextRunAt: job.next_run_at || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      }
    }, tenantId, collection);
  } catch (e) {
    sendError(res, 400, e, "JOB_FETCH_FAILED", tenantId, collection);
  }
});

async function start() {
  try {
    await runMigrations();
    if (typeof portalPluginReady === "function") {
      await portalPluginReady();
    }
    app.listen(3000, () => {
      console.log("HTTP gateway listening on http://localhost:3000");
      if (isTelemetryEnabled()) {
        const telemetryMeta = getTelemetryMeta();
        emitTelemetry("telemetry_session", buildTelemetryContext({
          requestId: createTelemetryRequestId("telemetry"),
          tenantId: "system",
          source: "startup"
        }), {
          file_path: telemetryMeta.filePath,
          run_id: telemetryMeta.runId,
          config_id: telemetryMeta.configId
        });
      }
      scheduleAutoReindex();
      scheduleTtlSweep();
      scheduleStorageBillingAccrualSweep();
      scheduleJobSweep();
      scheduleMemoryEventFlush();
      scheduleValueDecay();
      scheduleRedundancySweep();
      scheduleLifecycleSweep();
      scheduleMemorySnapshots();
    });
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = {
  __testHooks: {
    normalizeRuntimeRoleList,
    normalizeTenantIdentifier,
    parseTenantMetadataInput,
    buildPublicRegistrationProjectName,
    slugifyPublicRegistrationProjectBase,
    buildPublicRegistrationTenantId,
    buildPublicRegistrationInstructions,
    parseDocumentSourceInput,
    normalizeUrlFetchValidators,
    fetchUrlText,
    buildCodeRetrievalQuery,
    normalizeCodeSessionContext,
    buildCodeSessionFocus,
    extractCodeStructureMetadata,
    buildCodeWorkingSet,
    buildCodeRelationshipSummary,
    buildCodeScoreBoost,
    resolveVectorSearchWindow,
    resolveCodeSelectionSize,
    selectCodeCandidatesForPrompt,
    formatTenantRecord,
    normalizeMemoryPolicy,
    resolveRequestedFavorRecency,
    getMemoryPolicy,
    normalizeConversationWikiPagesInput,
    buildConversationWikiExternalId,
    buildConversationWikiPageTitle,
    buildConversationWikiPageText,
    buildConversationWikiTurnExchanges,
    countConversationWikiTurnExchanges,
    sliceConversationWikiTurnsToRecentExchanges,
    mergeConversationWikiPromptTurns,
    loadConversationTurnsForWikiUpdate,
    normalizeConversationWikiStoredExchanges,
    mergeConversationWikiStoredExchanges,
    resolveConversationWikiSourceCheckpoint,
    buildConversationWikiUpdatePrompt,
    recordConversationWikiMetrics,
    emitConversationWikiTelemetry,
    clearConversationMemoryCollectionWithDeps,
    enqueueConversationMemoryClearJobWithDeps,
    runConversationMemoryClearJobWithDeps,
    resolveMemoryJobRunner,
    dispatchMemoryJobWithDeps,
    formatConversationWikiItem,
    getConversationWikiLastUpdatedAt,
    formatConversationWikiJob,
    parseConversationWikiResponse,
    repairConversationWikiArticleDraft,
    enqueueConversationWikiUpdateJobWithDeps,
    pruneConversationTurnsForWikiWithDeps,
    resolveMemoryPolicyConfig,
    parseNamespaceFilter,
    parseSourceTypeFilter,
    parseDocumentTypeFilter,
    parseRetrievalFilterInput,
    buildRetrievalPlan,
    matchesRetrievalFilters,
    normalizeRetrievalTimeField,
    resolveMemoryKnowledgeType,
    resolveMemoryFavorRecencyPreference,
    memoryFreshnessTimestampMs,
    computeMemoryRetrievalRecencyScore,
    determineRecencyBoostMode,
    resolveChunkingOptionsForSource,
    shouldReindexStoredVectors,
    splitIntoBatches,
    isVectorCommandReplyOk,
    runBatchedCommandSet,
    buildSearchPreview,
    resolveHybridFusionMode,
    resolveHybridFusionWeights,
    reciprocalRankContribution,
    rankSearchCandidates,
    normalizeRangeScore,
    tokenizeForRerank,
    computeTokenOverlapScore,
    normalizeTier,
    resolveTierThresholds,
    resolveTierForValue,
    resolveInitialValueScore,
    decayMemoryValue,
    buildValueUpdateForMemory,
    computeUsageCosts,
    buildUsageHistoryEntry,
    buildStorageBillingSummary,
    computeStoragePeriodSummary,
    MEMORY_TIER_THRESHOLDS,
    MEMORY_VALUE_MAX,
    MEMORY_VALUE_DECAY_LAMBDA,
    MEMORY_ACCESS_ALPHA,
    MEMORY_CONTRIBUTION_BETA
  }
};
