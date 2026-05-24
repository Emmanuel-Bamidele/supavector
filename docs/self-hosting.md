# SupaVector Self-Hosting Guide

This guide is for teams who want to fork or clone SupaVector and run it themselves without relying on a hosted SupaVector service.

If you are not yet sure whether you should self-host at all, start with [`setup-modes.md`](setup-modes.md) first.

## Scope

Current public scope is:

- single-node self-hosted deployment
- Docker Compose friendly
- bring your own provider keys
- Postgres-backed metadata and auth
- service-token-first runtime usage for apps and agents

This guide does not assume Kubernetes, managed control planes, or automatic multi-instance provisioning.

If you are running the private `supavector-portal` plugin, treat that as a different deployment path from plain OSS self-hosting. The stock `Dockerfile.node` image does not copy `supavector-portal/plugins`, so enterprise SSO, runtime placement, BYOC, sharding, Access Management, and portal billing surfaces will not exist unless you add the portal overlay.

If you already have your own Postgres and do not want to run the bundled database container, use:

- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
- [`enterprise.md`](enterprise.md) if this self-hosted deployment needs enterprise SSO rollout and tenant access controls
- [`../docker-compose.external-postgres.yml`](../docker-compose.external-postgres.yml)
- [`../.env.external-postgres.example`](../.env.external-postgres.example)

## What You Are Running

SupaVector has three core runtime pieces:

- `gateway/`
  Node.js API layer, auth, docs UI, jobs, and grounded answer orchestration
- `supavector/`
  the vector store used for embedding storage and retrieval
- Postgres
  persistent state for users, tenants, tokens, jobs, chunks, and memory metadata

In local Compose, the repo starts all of these for you.

When you need the private portal plugin, use the overlay file from this repo:

- [`../docker-compose.portal.yml`](../docker-compose.portal.yml)

That overlay changes the gateway build to the private `supavector-portal/Dockerfile.node.portal` image and loads gateway env from `${SUPAVECTOR_PORTAL_ENV_FILE:-.env}` so portal runtime settings and runtime control-plane tokens actually reach the container.

If you are using that overlay for `hosted_dedicated` or `customer_cloud` runtime placement, the target runtime also needs to register with the portal control plane and keep a fresh heartbeat.

Portal runtime control-plane contract:

- store a per-runtime bearer token in the env file used by the overlay as `PORTAL_RUNTIME_CONTROL_PLANE_TOKEN_<RUNTIME>`
- send `Authorization: Bearer <PORTAL_RUNTIME_CONTROL_PLANE_TOKEN_<RUNTIME>>` on portal runtime control-plane requests
- call `POST /portal/runtime/control-plane/register` with the runtime key, shard key, environment type, region, and any published base URLs
- call `POST /portal/runtime/control-plane/heartbeat` with the runtime status, health status, version, and any operator metadata you want surfaced in Runtime foundation
- send heartbeats every 60 to 120 seconds
- heartbeat freshness is evaluated against `PORTAL_RUNTIME_HEARTBEAT_STALE_MS`

Important:

- registration and heartbeat only make the runtime visible and eligible for validation
- tenant placement does not switch automatically
- cutover still happens from the portal admin runtime-move flow after validation passes
- `hosted_shared` placement does not require per-runtime registration or heartbeat work from you

The bundled Postgres path and the external-Postgres path are both still self-hosted SupaVector deployments. That choice only changes which database this SupaVector instance uses.

On self-hosted deployments, the gateway **Settings** page remains the main interactive admin surface. That is where you can manage browser auth, issue service tokens, configure tenant auth and SSO, and handle tenant users unless you choose to automate those flows through the admin APIs or CLI instead.

## Recommended Auth Model

Use SupaVector like this:

- humans use username/password or SSO for admin actions and the browser UI
- apps, backends, workers, and agents use a service token
- if a caller wants SupaVector to use its own provider key while still using this SupaVector deployment, it can send the matching request-scoped header on supported sync requests: `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key`

Service tokens created by this deployment are valid only for this deployment. They are not interchangeable with tokens from a different SupaVector instance, whether that other instance is local, remote, shared, or managed elsewhere.

That means your normal machine runtime should keep:

```bash
SUPAVECTOR_BASE_URL=http://localhost:3000
SUPAVECTOR_API_KEY=...
```

You should not design your runtime around repeated human login calls.

## Prerequisites

Before you start, have:

- Docker with the Compose plugin
- at least one provider API key for normal embedding and answer quality. OpenAI remains the default quickstart path.
- a machine that can run Docker containers and persist volumes

Recommended baseline:

- 4 CPU cores
- 8 GB RAM
- persistent disk for Postgres and, if enabled, vector WAL data

## Quickstart Path

### 1. Clone Or Fork The Repo

```bash
git clone <your-fork-or-repo-url>
cd supavector
```

### 2. Create The Local Env File

```bash
cp .env.example .env
```

Edit at least these values:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `COOKIE_SECRET`
- one or more provider keys: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`

Model settings you can change in the env:

```env
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
ANSWER_PROVIDER=openai
ANSWER_MODEL=gpt-5.2
BOOLEAN_ASK_PROVIDER=
BOOLEAN_ASK_MODEL=
EMBED_PROVIDER=openai
EMBED_MODEL=text-embedding-3-large
REFLECT_PROVIDER=openai
REFLECT_MODEL=gpt-5-mini
COMPACT_PROVIDER=
COMPACT_MODEL=gpt-5-nano
```

`BOOLEAN_ASK_MODEL` falls back to `ANSWER_MODEL` when blank. `COMPACT_MODEL` falls back to `REFLECT_MODEL` when blank.
`EMBED_MODEL` is instance-wide. Because SupaVector stores all vectors in one embedding space, changing `EMBED_MODEL` requires a reindex. Fresh CLI-managed installs and the example env files pin `EMBED_MODEL=text-embedding-3-large`; older installs should pin it explicitly before changing it.
On startup, SupaVector also rebuilds vectors automatically if it detects that the live vector store count or dimension no longer matches the stored chunks for the current embedding model.
The default OSS profile keeps `VECTOR_WAL=0` and relies on reindex-from-Postgres on startup. Set `VECTOR_WAL=1` only if you want vector WAL durability across restart.
`ANSWER_PROVIDER`, `BOOLEAN_ASK_PROVIDER`, `REFLECT_PROVIDER`, and `COMPACT_PROVIDER` can be `openai`, `gemini`, or `anthropic`. `EMBED_PROVIDER` can be `openai` or `gemini`. Anthropic is generation-only today because SupaVector still needs a provider-native embedding endpoint for indexing and retrieval.
Common generation presets include:
- OpenAI: `gpt-5.2`, `gpt-5-mini`, `gpt-5-nano`
- Gemini: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`
- Anthropic: `claude-sonnet-4-20250514`, `claude-opus-4-20250514`, `claude-3-7-sonnet-latest`, `claude-3-5-haiku-latest`
The GPT-5 family is compatible with SupaVector. The gateway omits unsupported `temperature` parameters automatically for those models.
You can inspect the live preset catalog and instance defaults at `GET /v1/models`.

Retrieval defaults you can also tune in the env:

```env
HYBRID_RETRIEVAL_ENABLED=1
HYBRID_FUSION_MODE=rrf
HYBRID_RRF_K=60
HYBRID_VECTOR_WEIGHT=0.72
HYBRID_LEXICAL_WEIGHT=0.28
HYBRID_LEXICAL_MULTIPLIER=2
HYBRID_LEXICAL_CAP=120
HYBRID_RERANK_OVERLAP_BOOST=0.12
HYBRID_RERANK_EXACT_BOOST=0.08
```

Hybrid retrieval is on by default for search, ask, code, boolean_ask, and memory recall. `rrf` fuses dense vector rank from the vector store with lexical rank from Postgres full-text search. Set `HYBRID_RETRIEVAL_ENABLED=0` to keep vector-only ranking, or switch `HYBRID_FUSION_MODE=weighted` to use the legacy normalized score fusion.

Dense vector search defaults to exact scanning. For larger stores, you can enable the approximate side index and roll it out without changing application requests:

```env
VECTOR_SEARCH_MODE=exact
VECTOR_ANN_ENABLED=0
VECTOR_ANN_MIN_CANDIDATES=5000
VECTOR_ANN_OVERFETCH=5
VECTOR_ANN_EXACT_RESCORE=1
VECTOR_ANN_ROLLOUT_PERCENT=100
VECTOR_ANN_SHADOW_SAMPLE_RATE=1
VECTOR_ANN_MIN_SHADOW_OVERLAP=0.8
VECTOR_ANN_LOW_OVERLAP_LIMIT=3
VECTOR_ANN_CIRCUIT_OPEN_MS=300000
VECTOR_ANN_LSH_TABLES=8
VECTOR_ANN_LSH_BITS=12
```

Use `VECTOR_SEARCH_MODE=shadow` first to keep exact results while comparing ANN overlap and latency. Move to `VECTOR_SEARCH_MODE=auto` after `/v1/admin/vector/search-runtime`, `/v1/stats`, and `/v1/metrics` show acceptable overlap, fallback reasons, dense latency, and circuit state. Admins can trigger a vector rebuild with `POST /v1/admin/vector/reindex` or `supavector vector reindex --mode always`.

For freshness-sensitive queries, you can also tune:

```env
RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED=1
MEMORY_RETRIEVAL_RECENCY_WEIGHT=0.3
MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS=14
```

Search-backed endpoints now accept the same filter surface: `docIds`, `namespaceIds`, `tags`, `agentId`, `sourceTypes`, `documentTypes`, `since`, `until`, and `timeField`.

Useful optional values:

- `PUBLIC_BASE_URL`
- `OPENAPI_BASE_URL`
- `GATEWAY_HOST_PORT`
- `POSTGRES_HOST_PORT`

### 3. Start The Stack

```bash
docker compose up -d --build
```

If you are running the private portal plugin and expect enterprise SSO, runtime placement, BYOC, sharding, or portal admin surfaces, use:

```bash
docker compose -f docker-compose.yml -f docker-compose.portal.yml up -d --build
```

If you keep portal-only settings or runtime control-plane tokens in a separate env file, point the overlay at it:

```bash
SUPAVECTOR_PORTAL_ENV_FILE=.env.portal \
docker compose -f docker-compose.yml -f docker-compose.portal.yml --env-file .env.portal up -d --build
```

This requires the `supavector-portal` repo to be cloned beside this repo under the same parent directory.

Check health:

```bash
curl -sS http://localhost:3000/health
```

Expected response:

```json
{"ok":true}
```

If you want the external-Postgres path instead, do not use the stock Compose file above. Use:

```bash
cp .env.external-postgres.example .env.external-postgres
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres up -d --build
```

If you are using the private portal plugin on the external-Postgres path, add the portal overlay:

```bash
docker compose \
  -f docker-compose.external-postgres.yml \
  -f docker-compose.portal.yml \
  --env-file .env.external-postgres up -d --build
```

### 4. Bootstrap The First Admin And Service Token

This is the recommended first-run step:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

What this does:

- ensures the tenant exists
- creates or updates the local admin user
- creates a fresh service token
- prints the runtime values your app or agent should store

Save the printed token immediately. The API does not show it again later.

### 5. Export Runtime Env For Your App Or Agent

```bash
export SUPAVECTOR_BASE_URL="http://localhost:3000"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
```

### 6. Index A Document

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "Idempotency-Key: demo-doc-1" \
  -H "Content-Type: application/json" \
  -d '{
    "docId":"welcome",
    "collection":"default",
    "text":"SupaVector stores memory for agents and returns grounded answers with citations."
  }'
```

`/v1/docs` stays text-first in self-hosted deployments. If you are indexing source code directly, you can also send optional `title`, `sourceUrl`, `metadata`, and `sourceType` fields. Set `"sourceType":"code"` only when the document payload is actual code.

### 7. Ask A Question

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"What does SupaVector store?",
    "k":7,
    "policy":"amvl",
    "provider":"openai",
    "model":"gpt-5.2"
  }'
```

`provider` and `model` are optional and override the tenant or instance ask provider/model for that single request.

Set `"favorRecency": true` when newer matching evidence should outrank older matches. This is useful for continuously updated facts such as product catalogs, changelogs, incident timelines, and conversation-like state. Synced sources attach `syncedAt` automatically, and direct writes can also provide timestamps such as `updatedAt`, `publishedAt`, `effectiveAt`, or `syncedAt` in `metadata`.

The default retrieval path is hybrid, not vector-only: semantic vector matches and lexical full-text matches are fused before recency is applied. This improves exact identifiers and mixed identifier-plus-natural-language lookups while keeping semantic-only queries working the same way.

If you need the time range to follow freshness metadata instead of ingest time, send `"timeField":"freshness"` together with `since` / `until`.

### 7a. Ask A Code Question

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/code" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"Why would newer synced product records rank above stale ones here?",
    "k":6,
    "task":"debug",
    "answerLength":"medium",
    "policy":"amvl",
    "favorRecency":true
  }'
```

`/v1/code` accepts the same retrieval controls as `/v1/ask`, including first-class filters and `favorRecency`, but returns code-aware grounded answers for debugging, review, structure, and implementation guidance.

On the CLI, `supavector ask --model ...` and `supavector boolean_ask --model ...` also accept the same numbered shortcuts shown by `supavector changemodel`. The live preset catalog is available from `GET /v1/models`.

### 8. Ask A Strict True/False Question

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/boolean_ask" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"Does SupaVector store memory for agents?",
    "k":7,
    "policy":"amvl"
  }'
```

This returns only `true`, `false`, or `invalid`. Use it when the caller needs a grounded binary answer instead of a freeform response, and inspect `supportingChunks` when the caller needs the exact evidence text.

### 8a. Tenant-Level Generation Defaults

Admins can read or update tenant-level generation defaults with:

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/admin/tenant" \
  -H "Authorization: Bearer ${TOKEN}"

curl -sS -X PATCH "${SUPAVECTOR_BASE_URL}/v1/admin/tenant" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "models": {
      "answerProvider": "openai",
      "answerModel": "gpt-5.2",
      "booleanAskProvider": null,
      "booleanAskModel": null,
      "reflectProvider": "openai",
      "reflectModel": "gpt-5-mini",
      "compactProvider": null,
      "compactModel": null
    }
  }'
```

Those settings are tenant-scoped. `embedProvider` and `embedModel` are not part of this API because they remain instance-wide self-hosted env settings.

### 8b. CLI Setup And Admin Shortcuts

If you used `supavector onboard` or `supavector bootstrap`, the CLI already has the saved base URL and service token for the local deployment. That means you can handle common setup work without opening the browser UI.

Create a runtime service token for an app or worker:

```bash
supavector tokens create \
  --name worker-prod \
  --principal-id svc:worker-prod \
  --roles reader,indexer
```

List or revoke tenant service tokens:

```bash
supavector tokens list
supavector tokens revoke --id 12 --yes
```

Create or update tenant-local admins and operators:

```bash
supavector users create \
  --username ops-admin \
  --password 'change_me_now' \
  --roles admin,indexer,reader \
  --email ops@example.com \
  --full-name "Ops Admin"

supavector users update \
  --id 7 \
  --roles reader \
  --disabled false
```

Read or update tenant auth and SSO settings from the CLI:

```bash
supavector tenant get

supavector tenant update \
  --auth-mode sso_only \
  --sso-providers google,okta \
  --sso-config-file ./tenant-sso.json \
  --answer-provider openai \
  --answer-model gpt-5.2
```

For more complex payloads, pass the exact API body through a JSON string or file:

```bash
supavector tenant update --body-file ./tenant-settings.json
```

If you prefer a human admin JWT instead of the saved service token for a specific command, pass:

```bash
supavector tenant get --token "$SUPAVECTOR_JWT"
```

### 9. Optional: Bring Your Own Provider Key To A Shared SupaVector Deployment

If you are using an SupaVector instance that already has its own Postgres and auth, but you want your requests to use your own provider key, add the matching request-scoped header:

```bash
-H "X-OpenAI-API-Key: ${OPENAI_API_KEY}"
-H "X-Gemini-API-Key: ${GEMINI_API_KEY}"
-H "X-Anthropic-API-Key: ${ANTHROPIC_API_KEY}"
```

This works on supported sync request paths such as:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/ask`
- `POST /v1/code`
- `POST /v1/boolean_ask`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`

It is intentionally request-scoped. SupaVector does not persist that key for the tenant.

`POST /v1/ask`, `POST /v1/code`, and `POST /v1/boolean_ask` also accept a `provider` field in the JSON body when one request should use a different generation provider than the tenant or instance default.

Embedding provider selection remains instance-wide today. Request-scoped provider headers for docs, search, memory write, and memory recall only override credentials for the embedding provider that the instance is already configured to use.

Current limitation:

- `POST /v1/memory/reflect`
- `POST /v1/memory/compact`

Those endpoints continue work asynchronously after the request ends, so they reject request-scoped provider-key headers today.

## What Bootstrap Solves

Fork users often get stuck on first credentials. The bootstrap script exists so they do not need to:

- inspect the database manually
- hand-write SQL
- log in first just to create the first token

Bootstrap is intentionally optional and non-invasive. It does not change runtime behavior unless you invoke it.

If you only want a human admin user and do not want a service token yet, you can still use:

```bash
docker compose exec gateway node scripts/create_user.js \
  --username admin \
  --password change_me \
  --tenant default \
  --role admin
```

## Local URLs

Once the stack is running, the main local URLs are:

- app and UI: `http://localhost:3000/`
- health: `http://localhost:3000/health`
- API docs: `http://localhost:3000/docs`
- public OpenAPI schema: `http://localhost:3000/openapi.public.json`
- MCP endpoint: `http://localhost:3000/mcp`
- LLM discovery file: `http://localhost:3000/llms.txt`

## Daily Operations

### Stop The Stack

```bash
docker compose down
```

### Restart The Stack

```bash
docker compose up -d
```

### View Logs

```bash
docker compose logs -f gateway
docker compose logs -f postgres
docker compose logs -f redis
```

### Reset Local Volumes

Use this only when you want to wipe local state:

```bash
docker compose down -v
```

This removes:

- Postgres data
- vector store WAL / persisted vector data

## Upgrade Flow

For a self-hosted upgrade:

1. update the installed checkout with `supavector update`, or pull the new repo version manually
2. review changes to `.env.example`, `docker-compose.yml`, and `README.md`
3. confirm your secrets and runtime env are still correct
4. redeploy with:

```bash
docker compose up -d --build
```

5. verify health
6. run a smoke test: login or service token auth, one ingest, one ask

## Backups

SupaVector state lives in two places:

- Postgres
- vector store data volume

For serious self-hosting, back up both.

Recommended backup approach:

- Postgres logical dump or managed database backup
- filesystem or volume backup for vector data

Minimum rule:

- do not rely on container recreation alone
- do not treat Docker volumes as a backup strategy

## Security Checklist

Before exposing a public instance:

- replace all placeholder secrets
- keep `OPENAI_API_KEY`, `JWT_SECRET`, `COOKIE_SECRET`, and DB credentials outside version control
- never expose service tokens to browsers unless that is explicitly your design
- use service tokens for server-to-server traffic
- keep admin tokens scoped and rotated
- review `ALLOW_PRINCIPAL_OVERRIDE` before enabling it
- in production, externalize `stunnel` certs using `STUNNEL_CERTS_DIR`
- use real TLS and a real public base URL

## Production Notes

The stock `docker-compose.prod.yml` exists for production-style deployments, but it is still meant to be operated by the self-hosting team.

Important production details:

- `STUNNEL_CERTS_DIR` should point to a server-only path outside the repo
- `COOKIE_SECURE` should be enabled behind HTTPS
- `PUBLIC_BASE_URL` and `OPENAPI_BASE_URL` should match your external hostname
- strong secrets are mandatory

For more detail on internal TLS cert layout, see:

- [`../deploy/stunnel/README.md`](../deploy/stunnel/README.md)

## Troubleshooting

### Health Check Fails

Check:

- `docker compose ps`
- `docker compose logs gateway`
- `docker compose logs postgres`
- `docker compose logs redis`

Most common causes:

- invalid or missing env values
- Postgres not ready yet
- gateway container failed to boot

### Login Works But Agent Calls Fail

Usually one of:

- wrong `SUPAVECTOR_API_KEY`
- token expired or revoked
- using JWT where the runtime expects a service token
- missing `Idempotency-Key` on write endpoints

### Answers Are Weak Or Generic

Check:

- `OPENAI_API_KEY` is valid
- documents were actually indexed
- your query is hitting the right `collection`
- you are using the intended `policy` (`amvl`, `ttl`, or `lru`)

### UI Changes Do Not Appear

If you serve the UI from Docker, rebuild the gateway image:

```bash
docker compose up -d --build gateway
```

Then hard-refresh the browser.

## Next Guides

After this guide, use:

- [`bring-your-own-postgres.md`](bring-your-own-postgres.md) if you already have Postgres and secret management
- [`agents.md`](agents.md) if you are wiring SupaVector into an app backend or AI runtime
