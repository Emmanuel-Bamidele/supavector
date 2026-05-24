# SupaVector Node SDK

A small, dependency-free Node.js client for the SupaVector API.

## Install (local workspace)

```bash
cd sdk/node
npm install
```

## Bootstrap once (recommended)

Fastest local path:

```bash
supavector onboard
```

That creates the local env, starts Docker, bootstraps the first admin, and stores the service token for later CLI usage.

Manual path if you want to bootstrap the running gateway directly:

Create the first admin and a service token from the running SupaVector gateway:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name node-sdk
```

Store the printed values in your environment:

```bash
export SUPAVECTOR_BASE_URL="http://localhost:3000"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
export OPENAI_API_KEY="YOUR_OPENAI_KEY"
export GEMINI_API_KEY="YOUR_GEMINI_KEY"
export ANTHROPIC_API_KEY="YOUR_ANTHROPIC_KEY"
```

## Quick start

```js
const { SupaVectorClient } = require("@supavector/sdk");

const client = new SupaVectorClient({
  baseUrl: process.env.SUPAVECTOR_BASE_URL || process.env.SUPAVECTOR_URL || "http://localhost:3000",
  apiKey: process.env.SUPAVECTOR_API_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GEMINI_API,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY
});

async function main() {
  await client.indexText("welcome", "SupaVector stores memory for agents.", {
    collection: "default"
  });

  const answer = await client.ask("What does SupaVector store?", { k: 7, provider: "openai" });
  console.log(answer.data.answer);

  const booleanAsk = await client.booleanAsk("Does SupaVector store memory for agents?", { k: 7, provider: "openai" });
  console.log(booleanAsk.data.answer);
  console.log(booleanAsk.data.supportingChunks);
}

main().catch(console.error);
```

## Authentication

Use a JWT (Bearer) or a service token (API key). For apps, agents, workers, and backends, prefer a service token. If both are set, the SDK prefers the API key.

```js
const client = new SupaVectorClient({
  baseUrl: process.env.SUPAVECTOR_BASE_URL || "http://localhost:3000",
  apiKey: process.env.SUPAVECTOR_API_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GEMINI_API,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY
});
```

If `openAiApiKey`, `geminiApiKey`, or `anthropicApiKey` is set, the SDK sends `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key` so SupaVector can use your provider key while still using the shared SupaVector deployment and its Postgres/auth state.

Current limitation:

- request-scoped provider-key override works on sync requests such as docs, search, ask, boolean_ask, memory write, and memory recall
- `memoryReflect()` and `memoryCompact()` should keep using the server-side provider key today because those flows continue asynchronously after the request ends

Human admin login is still available when you need a JWT for the UI or admin setup:

```js
await client.login(process.env.SUPAVECTOR_USER, process.env.SUPAVECTOR_PASS);
```

## Methods

- `health()`
- `login(username, password)`
- `stats()`
- `vectorRuntime()`
- `vectorReindex(params)`
- `listDocs(params)`
- `indexText(docId, text, params)`
- `indexUrl(docId, url, params)`
- `deleteDoc(docId, params)`
- `search(query, params)`
- `ask(question, params)`
- `booleanAsk(question, params)`
- `boolean_ask(question, params)`
- `memoryWrite(data)`
- `memoryRecall(data)`
- `memoryReflect(data)`
- `memoryCleanup(data)`
- `memoryCompact(data)`
- `feedback(data)`
- `getTenantSettings()`
- `updateTenantSettings(data)`
- `getJob(id)`

`vectorRuntime()` and `vectorReindex({ mode: "always" })` call admin-only endpoints for ANN rollout inspection and vector rebuilds. Use them with an admin-capable token.

## Tenant settings (admin)

Admins can manage tenant auth settings and tenant-level generation-model defaults via `/v1/admin/tenant`:

```js
// Read current tenant settings
const settings = await client.getTenantSettings();

// Update auth mode and tenant generation defaults
await client.updateTenantSettings({
  authMode: "sso_only",
  ssoProviders: ["google"],
  models: {
    answerProvider: "openai",
    answerModel: "gpt-5.2",
    booleanAskProvider: null,
    booleanAskModel: null,
    reflectProvider: "openai",
    reflectModel: "gpt-5-mini",
    compactProvider: null,
    compactModel: null
  }
});
```

## Parameters

Most methods accept `collection` and `tenantId` in `params` or `data`.
If you set them on the client via `setCollection()` / `setTenant()`, they are sent automatically.
Write/index/reflect endpoints require `Idempotency-Key`. Pass `idempotencyKey` in params/data to have the SDK send it as a header.
Memory writes and reflect support access control via `visibility` (`tenant`, `private`, `acl`) and `acl` list (array of principal IDs). The principal is derived from the auth token subject; if you pass `principalId` it must match the token.
You can set a default principal on the client with `setPrincipal()`, but the server will validate it against the token.
Reflection jobs accept `docId`, `artifactId`, or `conversationId` as the source.
Memory writes accept `agentId`, `tags` (array of strings), `importanceHint`, `pinned`, and `policy` (`amvl`, `ttl`, or `lru`; defaults to `amvl`).
Ask, code, and boolean_ask requests also accept `provider` and `model` for a per-request generation override. Search, ask, code, boolean_ask, and memory recall also accept `favorRecency` when fresher matching evidence should rank ahead of older matches. Memory recall requests accept `policy` to choose retrieval mode per request.

Search-backed endpoints use SupaVector hybrid retrieval by default: vector retrieval plus lexical full-text retrieval fused with reciprocal rank fusion. This improves exact identifiers and mixed natural-language-plus-identifier queries without requiring client changes.
Reflection and compaction requests accept `policy` for the memories they create.
Search-backed endpoints share the same retrieval filters: `docIds`, `namespaceIds`, `tags`, `agentId`, `sourceTypes`, `documentTypes`, `since`, `until`, and `timeField`. Memory recall also accepts `types`.
Job retries are idempotent: reruns replace derived memories instead of duplicating them.
Supported memory types: `artifact`, `semantic`, `procedural`, `episodic`, `conversation`, `summary`.
Supported memory policies: `amvl`, `ttl`, `lru`.
Feedback accepts `{ memoryId, feedback }` where `feedback` is `positive` or `negative` (optional `eventValue` to weight the signal).
Tenant settings accept `models.answerProvider`, `models.answerModel`, `models.booleanAskProvider`, `models.booleanAskModel`, `models.reflectProvider`, `models.reflectModel`, `models.compactProvider`, and `models.compactModel`. `embedProvider` and `embedModel` are instance-wide and should be changed in the self-hosted env or with `supavector changemodel`.
The live preset catalog is available from `client.getModels()` / `client.models()`. It returns provider-aware generation catalogs for OpenAI, Gemini, and Anthropic, plus embedding catalogs for OpenAI and Gemini.

For continuously updated data, pass timestamps such as `updatedAt`, `publishedAt`, `effectiveAt`, or `syncedAt` in document or memory `metadata` so freshness bias can make sensible decisions. Hosted synced sources stamp `syncedAt` automatically. `episodic` and `conversation` source types default to recency-friendly retrieval in the portal UI and API wrappers unless you override them.

Per-request model override example:

```js
const models = await client.getModels();

const answer = await client.ask("What does SupaVector store?", {
  collection: "default",
  provider: "gemini",
  model: "gemini-2.5-flash"
});

const answerWithOpenAI = await client.ask("What does SupaVector store?", {
  collection: "default",
  provider: "openai",
  model: "gpt-5.2"
});

const debugAnswer = await client.code("Why are newer product records ranking first?", {
  collection: "default",
  task: "debug",
  answerLength: "medium",
  favorRecency: true
});

const check = await client.booleanAsk("Does SupaVector store memory for agents?", {
  collection: "default",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514"
});

const recall = await client.memoryRecall({
  query: "current product pricing",
  collection: "default",
  types: ["semantic"],
  sourceTypes: ["url"],
  documentTypes: ["pricing-page"],
  favorRecency: true,
  timeField: "freshness",
  k: 8
});
```

## Examples

Run the samples in `examples/`:

```bash
node examples/basic.js
node examples/memory.js
```
