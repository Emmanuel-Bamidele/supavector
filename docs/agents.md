# SupaVector For Apps, Backends, And Agents

This guide is for developers building:

- AI agents
- app backends
- worker processes
- internal tools
- CI or automation that talks to SupaVector

The goal is simple: make SupaVector feel like a service your runtime can depend on, not a manual UI-only tool.

## Fast Start For Developers

Use the smallest setup that matches your situation:

- Hosted or shared deployment: run `python3 -m pip install supavector`, store `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY`, then call SupaVector from your backend, worker, or agent.
- Self-hosted local/server deployment: install the CLI and run `supavector onboard` once, then reuse the saved base URL and service token.
- Backend-as-caller: keep the service token on your server side. Do not ship it to the browser.

## Decision Matrix

Use this if you need to choose the right usage mode quickly.

| Usage mode | Best when | Read next |
| --- | --- | --- |
| **Use SupaVector as a hosted service** | **No infrastructure to run — sign up, create a project, get an `supav_` token** | [**`hosted.md`**](hosted.md) |
| Fork and self-deploy with the bundled stack | You want the fastest path from clone to a working SupaVector instance | [`self-hosting.md`](self-hosting.md) |
| Fork and self-deploy with your own Postgres and provider keys | You already have database/secrets infrastructure and want SupaVector inside your environment | [`bring-your-own-postgres.md`](bring-your-own-postgres.md) |
| Use a shared SupaVector deployment | SupaVector already has its own Postgres/auth/runtime and your app or agent just needs to call it | [Direct service token](#direct-service-token) |
| Use a shared SupaVector deployment with your own provider key | SupaVector keeps the shared Postgres/auth/runtime, but each request should use your provider key | [Shared SupaVector, your provider key](#shared-provider-key) |
| Keep your own product auth and place SupaVector behind your backend | End users should not log into SupaVector directly | [Backend-as-caller](#backend-as-caller) |
| Use SupaVector mainly as a human admin or browser UI | You are managing tenant settings, keys, or interactive sessions | [Human JWT](#human-jwt) |

If you are still deciding what you are actually setting up, read [`setup-modes.md`](setup-modes.md) first. That guide explains the boundary between self-hosted, shared deployment, backend-held, and human-admin paths before you choose commands.

## Setup Mode Rule

Classify the setup mode before you give instructions:

- if the user is cloning the repo and running Docker themselves, use a self-hosted path
- if the user already has `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY`, use a shared-deployment path
- if their backend should be the only SupaVector caller, use backend-as-caller
- if they are signing in interactively to manage SupaVector itself, use the human-admin path

Important boundary rules:

- `--external-postgres` is still self-hosted SupaVector
- shared-deployment users normally do not edit SupaVector server env files on the client machine
- service tokens are deployment-scoped and do not carry across different SupaVector deployments

## Recommended Runtime Model

Use SupaVector like this:

1. a human admin bootstraps the instance once
2. SupaVector issues a service token
3. your app, backend, worker, or agent stores that token
4. runtime code calls SupaVector with `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY`

Optional variant:

5. if the runtime wants SupaVector to use its own provider key, it also sends `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key` on supported sync requests

Human login is still useful for:

- browser sessions
- admin setup
- tenant settings
- minting additional service tokens

It is not the preferred runtime path for autonomous agents.

## Minimum Runtime Env

For most runtimes, this is enough:

```bash
SUPAVECTOR_BASE_URL=http://localhost:3000
SUPAVECTOR_API_KEY=YOUR_SERVICE_TOKEN
```

If you are in Python, install the SDK first:

```bash
python3 -m pip install supavector
```

Optional app-level defaults you may also keep:

```bash
SUPAVECTOR_COLLECTION=default
SUPAVECTOR_AGENT_ID=agent:planner
```

## CLI Against A Live Deployment

If SupaVector is already online and you want to test it from your own machine with the CLI:

```bash
export SUPAVECTOR_BASE_URL="https://YOUR_DOMAIN"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
supavector write --doc-id cli-test --collection cli-smoke --text "SupaVector CLI remote test."
supavector search --q "remote test" --collection cli-smoke --k 3
supavector ask --question "What does the CLI test document say?" --collection cli-smoke
supavector boolean_ask --question "Does the CLI test document mention SupaVector?" --collection cli-smoke
```

Important distinction:

- `supavector onboard` is for local self-hosted setup
- `supavector write`, `supavector search`, `supavector ask`, and `supavector boolean_ask` are the normal commands for testing or using an already deployed SupaVector service
- Docker is not required on the client machine for this remote path
- service tokens are scoped to the SupaVector deployment that minted them; a token from one self-hosted or shared deployment will not authenticate against a different deployment

Model guidance:

- use `supavector changemodel` for local self-hosted defaults instead of editing the env file by hand
- `ask` and `boolean_ask` accept per-request `provider` and `model` overrides, and the CLI `--provider` / `--model` flags accept the same numbered shortcuts used during onboarding
- the preset list now includes OpenAI, Gemini, and Anthropic generation catalogs; custom model ids are still allowed
- use `GET /v1/models` when you need the live preset catalog and current instance defaults
- tenant admins can persist `answerProvider`, `answerModel`, `booleanAskProvider`, `booleanAskModel`, `reflectProvider`, `reflectModel`, `compactProvider`, and `compactModel` with `PATCH /v1/admin/tenant`
- `embedProvider` / `embedModel` stay instance-wide and require a reindex when they change

## Bootstrap Once

If the instance has not been bootstrapped yet:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name agent-runtime
```

Store the printed service token in your runtime secret store.

## What An Agent Can Do Today

With a valid service token, an agent can:

- index documents
- search retrieved chunks
- ask grounded questions
- write memories
- recall memories
- trigger reflection jobs
- poll job status
- send feedback and task outcome signals

What an agent cannot do from nothing:

- self-bootstrap from only a provider key
- create the first SupaVector credential anonymously
- create the first service token without an existing admin path

That is by design. SupaVector still needs one operator-controlled bootstrap step.

## Auth Choices

<a id="direct-service-token"></a>
### 1. Direct Service Token

Best when:

- one internal agent or backend talks directly to SupaVector
- you control the runtime environment

Send:

```http
X-API-Key: YOUR_SERVICE_TOKEN
```

This is the default recommendation.

<a id="human-jwt"></a>
### 2. Human JWT

Best when:

- a human is using the UI
- an admin is configuring the tenant
- you need a temporary interactive session

Send:

```http
Authorization: Bearer YOUR_JWT
```

<a id="backend-as-caller"></a>
### 3. Backend-As-Caller

Best when:

- your product already has its own end-user auth
- you do not want every user or agent to log into SupaVector separately

Pattern:

1. end user authenticates to your app
2. your backend calls SupaVector with a service token
3. your backend decides which user or privileges should be represented

This is usually the cleanest product architecture.

<a id="shared-provider-key"></a>
### 4. Shared SupaVector, Your Provider Key

Best when:

- SupaVector is already deployed and keeps its own Postgres/auth state
- you want a request to use your provider key instead of the server default
- you do not need SupaVector to persist your provider key server-side

Pattern:

1. authenticate with a service token or JWT as usual
2. also send `X-OpenAI-API-Key: YOUR_OPENAI_KEY`, `X-Gemini-API-Key: YOUR_GEMINI_KEY`, or `X-Anthropic-API-Key: YOUR_ANTHROPIC_KEY`
3. SupaVector uses that key for supported sync embedding/answer requests

On hosted or other portal-enabled shared deployments, this changes AI generation billing responsibility for that request, but it does not change who owns storage. The shared deployment still stores the data and still owns any shared-deployment storage billing.

`POST /v1/ask`, `POST /v1/code`, and `POST /v1/boolean_ask` also accept a `provider` field in the JSON body when one request should use a different generation provider than the tenant or instance default.

Embedding provider selection remains instance-wide today. For docs, search, memory write, and memory recall, request-scoped provider-key headers only override credentials for the embedding provider that the instance is already configured to use.

Supported today:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/ask`
- `POST /v1/code`
- `POST /v1/boolean_ask`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`

Current limitation:

- `POST /v1/memory/reflect`
- `POST /v1/memory/compact`

Those two endpoints reject request-scoped provider-key headers because the work continues asynchronously after the original request ends.

## Service Token Lifecycle

Treat the SupaVector service token like any internal API credential.

Recommended practices:

- store it in a secret manager
- keep it out of browser code
- rotate it on your own schedule
- mint separate tokens for separate runtimes when useful
- revoke tokens you no longer need

A common split is:

- one token for production app traffic
- one token for CI
- one token for internal admin tooling

## Core Runtime Calls

### Health

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/health"
```

### Index A Document

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Idempotency-Key: idx-001" \
  -H "Content-Type: application/json" \
  -d '{
    "docId":"welcome",
    "collection":"default",
    "text":"SupaVector stores memory for agents."
  }'
```

`/v1/docs` stays text-first by default. Direct callers can also send optional `title`, `sourceUrl`, `metadata`, and `sourceType` fields. Set `"sourceType":"code"` only when the payload is source code and you want code-aware chunking for that document.

### Search

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/search?q=memory&k=5&collection=default&policy=amvl" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}"
```

Search is hybrid by default: the gateway combines vector retrieval from the C++ store with lexical full-text retrieval from Postgres and fuses the rankings with reciprocal rank fusion. That gives better recall for exact identifiers, error codes, ticket ids, and mixed semantic-plus-exact queries without dropping semantic-only retrieval.

Search, ask, code, boolean_ask, and memory recall now share the same retrieval filter surface: `docIds`, `namespaceIds`, `tags`, `agentId`, `sourceTypes`, `documentTypes`, `since`, `until`, and `timeField`. Use `timeField: "freshness"` when the time window should follow metadata timestamps such as `updatedAt` or `syncedAt` instead of original ingest time.

### Ask

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
    "answerLength":"medium"
  }'
```

Add `"favorRecency": true` when newer matching evidence should rank ahead of older chunks. This is especially useful for continuously updated facts such as product catalogs, release notes, incident timelines, and conversation-like state. Synced sources attach `syncedAt` automatically, and direct writes can also include timestamps such as `updatedAt`, `publishedAt`, `effectiveAt`, or `syncedAt` in `metadata`.

If you operate the server yourself, the main hybrid retrieval flags are `HYBRID_RETRIEVAL_ENABLED`, `HYBRID_FUSION_MODE`, `HYBRID_RRF_K`, `HYBRID_VECTOR_WEIGHT`, and `HYBRID_LEXICAL_WEIGHT`. `HYBRID_RETRIEVAL_ENABLED=0` keeps the prior vector-only behavior.

Dense vector search defaults to exact scans. Operators can enable the ANN side index with `VECTOR_ANN_ENABLED=1`, observe it in `VECTOR_SEARCH_MODE=shadow`, and then use `VECTOR_SEARCH_MODE=auto` for large candidate sets once overlap and latency are acceptable. The admin runtime view is available at `GET /v1/admin/vector/search-runtime`, and the CLI equivalent is `supavector vector runtime`.

If you operate the server yourself, `RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED`, `MEMORY_RETRIEVAL_RECENCY_WEIGHT`, and `MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS` control automatic freshness-sensitive ranking. See [`retrieval-correctness.md`](retrieval-correctness.md) for the full filtering and evaluation workflow.

### Code

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/code" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"Why would recent catalog updates rank above stale records here?",
    "k":6,
    "task":"debug",
    "answerLength":"medium",
    "policy":"amvl",
    "favorRecency":true
  }'
```

`/v1/code` shares the same retrieval controls as `/v1/ask`, including the first-class filters and `favorRecency`, but shapes the answer for debugging, structure, review, and implementation guidance.

### True/False Only

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/boolean_ask" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"Does SupaVector store memory for agents?",
    "k":7,
    "provider":"openai",
    "policy":"amvl"
  }'
```

Read `data.supportingChunks` when the caller needs the exact chunk text that supported the boolean decision.

### Memory Write

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/memory/write" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Idempotency-Key: mem-001" \
  -H "Content-Type: application/json" \
  -d '{
    "text":"Customer prefers email updates on Fridays.",
    "type":"semantic",
    "collection":"default",
    "policy":"amvl",
    "agentId":"agent:support",
    "tags":["customer","preference"],
    "importanceHint":0.7,
    "pinned":false
  }'
```

### Memory Recall

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/memory/recall" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"email preference",
    "collection":"default",
    "policy":"amvl",
    "agentId":"agent:support",
    "types":["semantic"],
    "k":5
  }'
```

## Idempotency Rules

These write endpoints require an `Idempotency-Key`:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `POST /v1/memory/write`
- `POST /v1/memory/reflect`

Do not reuse the same idempotency key for different payloads.

Good practice:

- generate one unique key per logical write
- keep retries on the same key if the payload is identical

## Choosing A Retrieval Or Memory Policy

SupaVector supports three policies:

- `amvl`
- `ttl`
- `lru`

### `amvl`

Use when:

- you want the platform's main value-based memory behavior
- you want retrieval and lifecycle decisions tuned for longer-term usefulness
- you are using SupaVector as intended

This is the default and the recommended starting point.

### `ttl`

Use when:

- you want time-based expiration behavior
- your data has a known freshness window
- simple age-based lifecycle is enough

### `lru`

Use when:

- you want recency-of-use behavior
- you are comparing against a more traditional cache-like memory policy

## Direct Agent Versus Backend Proxy

### Let The Agent Call SupaVector Directly

Good when:

- the runtime is fully internal
- the environment is trusted
- the token can be stored securely

### Let Your Backend Call SupaVector

Good when:

- your application already has end-user auth
- you need more control over visibility
- you want one place to enforce policy and rate limits

This is the better default for most customer-facing products.

## Visibility Without SupaVector End-User Login

If your app has its own user auth and you still want per-user visibility:

- enable `ALLOW_PRINCIPAL_OVERRIDE=1`
- use an admin service token from your backend
- send `principalId` and optionally `privileges`

This lets your backend remain the caller of record while SupaVector enforces tenant, ACL, and visibility rules.

Do not expose an admin service token to the browser.

## Example Runtime Pattern In Node

```js
const BASE = process.env.SUPAVECTOR_BASE_URL;
const API_KEY = process.env.SUPAVECTOR_API_KEY;

async function supavector(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

await supavector("/v1/docs", {
  method: "POST",
  headers: { "Idempotency-Key": "idx-001" },
  body: {
    docId: "welcome",
    collection: "default",
    text: "SupaVector stores memory for agents."
  }
});

const answer = await supavector("/v1/ask", {
  method: "POST",
  body: {
    question: "What does SupaVector store?",
    k: 7,
    policy: "amvl"
  }
});

console.log(answer.data.answer);

const booleanAsk = await supavector("/v1/boolean_ask", {
  method: "POST",
  body: {
    question: "Does SupaVector store memory for agents?",
    k: 7,
    policy: "amvl"
  }
});

console.log(booleanAsk.data.answer);
console.log(booleanAsk.data.supportingChunks);
```

This direct `/v1/docs` example stays on the default text path. If you are indexing source code instead, add `"sourceType":"code"` to that document payload.

## When To Use The SDKs

If you do not want to hand-roll fetch calls, use:

- [`../sdk/node/README.md`](../sdk/node/README.md)
- [`../sdk/python/README.md`](../sdk/python/README.md)

The SDKs already understand:

- JWT or API key auth
- idempotency headers
- search, ask, docs, memory, and jobs endpoints

Use the Node SDK when your runtime is already in Node.js. Use the Python SDK when your app, worker, notebook, or agent runtime already lives in Python and should call SupaVector over HTTP with the same `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY` pattern.

## Hosted Service Tokens And Credits

If your token was issued from the SupaVector hosted Dashboard (it starts with `supav_`), generation endpoints require a positive credit balance unless the request supplies the matching request-scoped provider key for the effective generation provider.

Affected endpoints:

- `POST /ask`
- `POST /v1/ask`
- `POST /code`
- `POST /v1/code`
- `POST /boolean_ask`
- `POST /v1/boolean_ask`

Not affected (no credit check):

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`
- `POST /v1/memory/reflect`

Hosted storage is separate from prepaid AI credit. Hosted writes and retained data can still create monthly storage charges even when a request does not deduct AI credit.

### 402 — No Credits

```json
HTTP 402 Payment Required

{
  "error": "Insufficient credits. Add credit from the Dashboard to continue generating.",
  "code": "CREDIT_REQUIRED"
}
```

Handle this in code by checking `res.status === 402` and `data.code === "CREDIT_REQUIRED"`. Do not treat this as a generic server error — it means the account balance is zero and the user or operator needs to top up.

```js
const res = await fetch(`${BASE}/v1/ask`, { method: "POST", headers, body });
const data = await res.json();

if (res.status === 402 && data.code === "CREDIT_REQUIRED") {
  // Prompt user to add credit, queue for retry, or surface as a billing error
  throw new BillingError("No credits remaining. Top up at the Dashboard.");
}

if (!res.ok) throw new Error(data.error || "SupaVector error");
```

### 503 — Credit Check Failed

```json
HTTP 503 Service Unavailable

{
  "error": "Service temporarily unavailable. Please try again.",
  "code": "CREDIT_CHECK_FAILED"
}
```

This means the server encountered a transient error verifying the credit balance. It does not mean the account has no credit. Retry with exponential backoff. The server blocks generation rather than allowing an unverified request through.

### Self-Hosted Tokens Are Not Affected

If you are self-hosting SupaVector, tokens without the `supav_` prefix bypass the credit system entirely. The 402 and 503 responses above will never be returned for those tokens.

## Security Notes For Agent Teams

- prefer service tokens over stored human passwords
- keep tokens in server-side secrets, not client-side bundles
- mint different tokens for different runtimes if blast radius matters
- revoke tokens when an environment is retired
- audit any use of `ALLOW_PRINCIPAL_OVERRIDE`

## What To Build Around SupaVector

SupaVector is a good fit when your agent stack needs:

- document ingestion
- grounded retrieval
- reusable memory writes
- explicit memory policies
- tenant-aware visibility rules

It should usually sit behind or beside your orchestrator, not replace your orchestrator.

## Recommended Next Step

After you have a working service token:

1. wire `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY` into your runtime
2. add one ingest smoke test
3. add one ask smoke test
4. decide whether your app will call SupaVector directly or through your backend

For infrastructure setup details, go back to:

- [`self-hosting.md`](self-hosting.md)
- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
