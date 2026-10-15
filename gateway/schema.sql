-- schema.sql
-- Stores chunk text so it survives restarts.

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,     -- e.g. "doc1#0"
  doc_id   TEXT NOT NULL,        -- e.g. "doc1"
  idx      INT  NOT NULL,        -- chunk index
  text     TEXT NOT NULL         -- original chunk text
);

CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS chunks_text_fts_idx ON chunks USING GIN (to_tsvector('simple', text));

-- Retrieval v2. `context` situates a chunk in its document (written at ingest,
-- fed to embedding and keyword search, never returned as the chunk's text:
-- callers rebuild documents by joining `text`). `search_tsv` is the stemmed
-- English vector BM25 keyword search reads, stored so queries never re-parse.
-- It is a plain column kept current by a trigger, never a generated column:
-- adding a generated column rewrites the whole table under an exclusive lock,
-- which would stall a large deployment at startup. Existing rows are filled
-- in the background in small batches and the GIN index is built concurrently
-- (db.js ensureSearchIndex).
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS search_tsv tsvector;
DO $$
BEGIN
  -- Early v2 builds made search_tsv a generated column; keep its values, drop the expression.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chunks' AND column_name = 'search_tsv' AND is_generated = 'ALWAYS'
  ) THEN
    ALTER TABLE chunks ALTER COLUMN search_tsv DROP EXPRESSION;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION sv_chunks_search_tsv() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english'::regconfig, coalesce(NEW.context, '') || ' ' || NEW.text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chunks_search_tsv_trg ON chunks;
CREATE TRIGGER chunks_search_tsv_trg
  BEFORE INSERT OR UPDATE OF text, context ON chunks
  FOR EACH ROW EXECUTE FUNCTION sv_chunks_search_tsv();

CREATE OR REPLACE FUNCTION sv_try_timestamptz(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Tenants and users (production auth)
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT,
  external_id TEXT,
  metadata JSONB DEFAULT '{}'::JSONB,
  auth_mode TEXT DEFAULT 'sso_plus_password',
  sso_providers TEXT[],
  sso_config JSONB DEFAULT '{}'::JSONB,
  answer_provider TEXT,
  answer_model TEXT,
  boolean_ask_provider TEXT,
  boolean_ask_model TEXT,
  reflect_provider TEXT,
  reflect_model TEXT,
  compact_provider TEXT,
  compact_model TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Keep the external_id index in the migration section below so older deployments
-- add the column before attempting to create the index.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  roles TEXT[] DEFAULT ARRAY[]::TEXT[],
  disabled BOOLEAN DEFAULT FALSE,
  sso_only BOOLEAN DEFAULT FALSE,
  auth_provider TEXT,
  auth_subject TEXT,
  email TEXT,
  full_name TEXT,
  failed_attempts INT DEFAULT 0,
  lock_until TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users(tenant_id);

-- Memory items, links, and jobs
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  item_type TEXT NOT NULL,
  external_id TEXT,
  principal_id TEXT,
  agent_id TEXT,
  tags TEXT[],
  visibility TEXT DEFAULT 'tenant',
  acl_principals TEXT[],
  title TEXT,
  source_type TEXT,
  source_url TEXT,
  metadata JSONB,
  parent_id TEXT REFERENCES memory_items(id) ON DELETE CASCADE,
  namespace_id TEXT UNIQUE NOT NULL,
  value_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  tier TEXT NOT NULL DEFAULT 'WARM' CHECK (tier IN ('HOT', 'WARM', 'COLD')),
  value_last_update_ts BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  tier_last_update_ts BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  reuse_count BIGINT DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  utility_ema DOUBLE PRECISION DEFAULT 0,
  redundancy_score DOUBLE PRECISION DEFAULT 0,
  trust_score DOUBLE PRECISION DEFAULT 0.5,
  importance_hint DOUBLE PRECISION,
  pinned BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_items_tenant_collection_idx ON memory_items(tenant_id, collection);
CREATE INDEX IF NOT EXISTS memory_items_parent_idx ON memory_items(parent_id);
CREATE INDEX IF NOT EXISTS memory_items_expires_idx ON memory_items(tenant_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_artifact_unique_idx ON memory_items(tenant_id, collection, item_type, external_id);

CREATE TABLE IF NOT EXISTS memory_links (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  from_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_links_tenant_idx ON memory_links(tenant_id);
CREATE INDEX IF NOT EXISTS memory_links_from_idx ON memory_links(from_item_id);
CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links(to_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS memory_links_unique_idx
  ON memory_links(tenant_id, from_item_id, to_item_id, relation);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  actor_id TEXT,
  actor_type TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB,
  request_id TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  error TEXT,
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_jobs_tenant_idx ON memory_jobs(tenant_id);

-- Memory lifecycle events
CREATE TABLE IF NOT EXISTS memory_events (
  id SERIAL PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_value DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_events_tenant_idx ON memory_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_memory_idx ON memory_events(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_type_idx ON memory_events(tenant_id, event_type, created_at DESC);

-- Idempotency keys (hard guarantees for writes)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, endpoint, idem_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_tenant_idx ON idempotency_keys(tenant_id);

-- Service tokens (API keys) for server-to-server integrations
CREATE TABLE IF NOT EXISTS service_tokens (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  roles TEXT[] DEFAULT ARRAY[]::TEXT[],
  key_hash TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_tokens_tenant_idx ON service_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS service_tokens_principal_idx ON service_tokens(tenant_id, principal_id);

-- Tenant usage counters (billing-ready)
CREATE TABLE IF NOT EXISTS tenant_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  embedding_tokens BIGINT DEFAULT 0,
  embedding_requests BIGINT DEFAULT 0,
  generation_input_tokens BIGINT DEFAULT 0,
  generation_output_tokens BIGINT DEFAULT 0,
  generation_total_tokens BIGINT DEFAULT 0,
  generation_requests BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_usage_rollups (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  bucket_kind TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  embedding_tokens BIGINT DEFAULT 0,
  embedding_requests BIGINT DEFAULT 0,
  generation_input_tokens BIGINT DEFAULT 0,
  generation_output_tokens BIGINT DEFAULT 0,
  generation_total_tokens BIGINT DEFAULT 0,
  generation_requests BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, bucket_kind, bucket_start)
);

CREATE INDEX IF NOT EXISTS tenant_usage_rollups_idx
  ON tenant_usage_rollups(tenant_id, bucket_kind, bucket_start);

CREATE TABLE IF NOT EXISTS tenant_storage_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  bytes BIGINT DEFAULT 0,
  chunk_text_bytes BIGINT DEFAULT 0,
  metadata_bytes BIGINT DEFAULT 0,
  vector_bytes BIGINT DEFAULT 0,
  vector_dim INT DEFAULT 0,
  formula_version TEXT DEFAULT 'storage_v1',
  chunks BIGINT DEFAULT 0,
  documents BIGINT DEFAULT 0,
  memory_items BIGINT DEFAULT 0,
  collections BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_storage_billing_state (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  current_bytes BIGINT DEFAULT 0,
  current_chunk_text_bytes BIGINT DEFAULT 0,
  current_metadata_bytes BIGINT DEFAULT 0,
  current_vector_bytes BIGINT DEFAULT 0,
  current_vector_dim INT DEFAULT 0,
  formula_version TEXT DEFAULT 'storage_v1',
  last_accrued_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_storage_billing_periods (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  storage_byte_seconds DOUBLE PRECISION DEFAULT 0,
  closing_bytes BIGINT DEFAULT 0,
  closing_chunk_text_bytes BIGINT DEFAULT 0,
  closing_metadata_bytes BIGINT DEFAULT 0,
  closing_vector_bytes BIGINT DEFAULT 0,
  closing_vector_dim INT DEFAULT 0,
  formula_version TEXT DEFAULT 'storage_v1',
  last_event_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, period_start)
);

CREATE INDEX IF NOT EXISTS tenant_storage_billing_periods_tenant_end_idx
  ON tenant_storage_billing_periods(tenant_id, period_end DESC, period_start DESC);

CREATE TABLE IF NOT EXISTS tenant_usage_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  request_id TEXT,
  collection TEXT,
  source TEXT,
  estimated BOOLEAN DEFAULT FALSE,
  billable BOOLEAN DEFAULT TRUE,
  embedding_tokens BIGINT DEFAULT 0,
  generation_input_tokens BIGINT DEFAULT 0,
  generation_output_tokens BIGINT DEFAULT 0,
  generation_total_tokens BIGINT DEFAULT 0,
  storage_bytes_delta BIGINT DEFAULT 0,
  storage_bytes_total BIGINT DEFAULT 0,
  storage_chunks_delta BIGINT DEFAULT 0,
  storage_chunks_total BIGINT DEFAULT 0,
  storage_documents_delta BIGINT DEFAULT 0,
  storage_documents_total BIGINT DEFAULT 0,
  storage_memory_items_delta BIGINT DEFAULT 0,
  storage_memory_items_total BIGINT DEFAULT 0,
  storage_collections_delta BIGINT DEFAULT 0,
  storage_collections_total BIGINT DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_usage_history_tenant_created_idx
  ON tenant_usage_history(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tenant_usage_history_tenant_kind_created_idx
  ON tenant_usage_history(tenant_id, event_kind, created_at DESC, id DESC);

-- Idempotent migrations for existing databases
ALTER TABLE IF EXISTS tenant_storage_usage ADD COLUMN IF NOT EXISTS chunk_text_bytes BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS tenant_storage_usage ADD COLUMN IF NOT EXISTS metadata_bytes BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS tenant_storage_usage ADD COLUMN IF NOT EXISTS vector_bytes BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS tenant_storage_usage ADD COLUMN IF NOT EXISTS vector_dim INT DEFAULT 0;
ALTER TABLE IF EXISTS tenant_storage_usage ADD COLUMN IF NOT EXISTS formula_version TEXT DEFAULT 'storage_v1';
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS auth_mode TEXT DEFAULT 'sso_plus_password';
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::JSONB;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS sso_providers TEXT[];
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS sso_config JSONB DEFAULT '{}'::JSONB;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS answer_provider TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS answer_model TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS boolean_ask_provider TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS boolean_ask_model TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS reflect_provider TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS reflect_model TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS compact_provider TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS compact_model TEXT;
UPDATE tenants SET auth_mode = 'sso_plus_password' WHERE auth_mode IS NULL;
UPDATE tenants SET metadata = '{}'::JSONB WHERE metadata IS NULL;
UPDATE tenants SET sso_config = '{}'::JSONB WHERE sso_config IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_external_id_idx ON tenants(external_id) WHERE external_id IS NOT NULL;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS failed_attempts INT DEFAULT 0;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS lock_until TIMESTAMPTZ;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS sso_only BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS auth_provider TEXT;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS auth_subject TEXT;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS full_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_provider_subject_idx ON users(auth_provider, auth_subject);
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS principal_id TEXT;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'tenant';
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS acl_principals TEXT[];
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS value_score DOUBLE PRECISION;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS tier TEXT;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS value_last_update_ts BIGINT;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS tier_last_update_ts BIGINT;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS reuse_count BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS utility_ema DOUBLE PRECISION DEFAULT 0;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS redundancy_score DOUBLE PRECISION DEFAULT 0;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS trust_score DOUBLE PRECISION DEFAULT 0.5;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS importance_hint DOUBLE PRECISION;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
UPDATE memory_items SET visibility = 'tenant' WHERE visibility IS NULL;
UPDATE memory_items SET value_score = 0.5 WHERE value_score IS NULL;
UPDATE memory_items SET tier = 'WARM' WHERE tier IS NULL;
UPDATE memory_items
SET value_last_update_ts = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
WHERE value_last_update_ts IS NULL;
UPDATE memory_items
SET tier_last_update_ts = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
WHERE tier_last_update_ts IS NULL;
UPDATE memory_items SET reuse_count = 0 WHERE reuse_count IS NULL;
UPDATE memory_items SET utility_ema = 0 WHERE utility_ema IS NULL;
UPDATE memory_items SET redundancy_score = 0 WHERE redundancy_score IS NULL;
UPDATE memory_items SET trust_score = 0.5 WHERE trust_score IS NULL;
UPDATE memory_items SET pinned = FALSE WHERE pinned IS NULL;
ALTER TABLE IF EXISTS memory_items ALTER COLUMN value_score SET DEFAULT 0.5;
ALTER TABLE IF EXISTS memory_items ALTER COLUMN value_score SET NOT NULL;
ALTER TABLE IF EXISTS memory_items ALTER COLUMN tier SET DEFAULT 'WARM';
ALTER TABLE IF EXISTS memory_items ALTER COLUMN tier SET NOT NULL;
ALTER TABLE IF EXISTS memory_items ALTER COLUMN value_last_update_ts SET NOT NULL;
ALTER TABLE IF EXISTS memory_items ALTER COLUMN tier_last_update_ts SET NOT NULL;
ALTER TABLE IF EXISTS memory_jobs ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
ALTER TABLE IF EXISTS memory_jobs ADD COLUMN IF NOT EXISTS max_attempts INT DEFAULT 3;
ALTER TABLE IF EXISTS memory_jobs ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
UPDATE memory_jobs SET attempts = 0 WHERE attempts IS NULL;
UPDATE memory_jobs SET max_attempts = 3 WHERE max_attempts IS NULL;
DELETE FROM memory_links a
USING memory_links b
WHERE a.id > b.id
  AND a.tenant_id = b.tenant_id
  AND a.from_item_id = b.from_item_id
  AND a.to_item_id = b.to_item_id
  AND a.relation = b.relation;
CREATE UNIQUE INDEX IF NOT EXISTS memory_links_unique_idx
  ON memory_links(tenant_id, from_item_id, to_item_id, relation);
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  actor_id TEXT,
  actor_type TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB,
  request_id TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs(target_type, target_id);

-- Indexes added after migrations so columns always exist
CREATE INDEX IF NOT EXISTS memory_items_principal_idx ON memory_items(tenant_id, principal_id);
CREATE INDEX IF NOT EXISTS memory_items_agent_idx ON memory_items(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS memory_items_visibility_idx ON memory_items(tenant_id, visibility);
CREATE INDEX IF NOT EXISTS memory_items_tier_idx ON memory_items(tenant_id, tier);
CREATE INDEX IF NOT EXISTS memory_items_tier_value_idx ON memory_items(tenant_id, tier, value_score DESC, id);
CREATE INDEX IF NOT EXISTS memory_items_source_type_idx ON memory_items(tenant_id, collection, source_type);
CREATE INDEX IF NOT EXISTS memory_items_created_at_idx ON memory_items(tenant_id, collection, created_at DESC, id);
CREATE INDEX IF NOT EXISTS memory_items_acl_idx ON memory_items USING GIN (acl_principals);
CREATE INDEX IF NOT EXISTS memory_items_tags_idx ON memory_items USING GIN (tags);
CREATE INDEX IF NOT EXISTS memory_items_document_type_idx
  ON memory_items(tenant_id, collection, (LOWER(COALESCE(metadata->>'documentType', metadata->>'document_type', metadata->>'docType', metadata->>'doc_type', ''))));
CREATE INDEX IF NOT EXISTS memory_items_freshness_idx
  ON memory_items(
    tenant_id,
    collection,
    (
      COALESCE(
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'updatedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'updated_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'lastUpdatedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'last_updated_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'modifiedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'modified_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'publishedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'published_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'effectiveAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'effective_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'sourceUpdatedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'source_updated_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'syncedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'synced_at' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'lastSyncedAt' END),
        sv_try_timestamptz(CASE WHEN metadata IS NOT NULL THEN metadata->>'last_synced_at' END),
        created_at
      )
    ) DESC,
    id
  );
CREATE INDEX IF NOT EXISTS memory_jobs_status_next_run_idx ON memory_jobs(status, next_run_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'memory_items_tier_check'
      AND conrelid = 'memory_items'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE memory_items ADD CONSTRAINT memory_items_tier_check CHECK (tier IN (''HOT'', ''WARM'', ''COLD''))';
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'memory_items'
      AND column_name = 'value_score'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS memory_items_value_idx ON memory_items(tenant_id, value_score)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'memory_items'
      AND column_name = 'last_used_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS memory_items_last_used_idx ON memory_items(tenant_id, last_used_at)';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS memory_events (
  id SERIAL PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_value DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS memory_events_tenant_idx ON memory_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_memory_idx ON memory_events(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_type_idx ON memory_events(tenant_id, event_type, created_at DESC);

-- Original document text (artifacts), kept so a document can be exported
-- whole and re-ingested when chunking or context improve. It cascades from
-- the artifact row, so every path that deletes a document deletes its text.
CREATE TABLE IF NOT EXISTS doc_texts (
  namespace_id TEXT PRIMARY KEY REFERENCES memory_items(namespace_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
