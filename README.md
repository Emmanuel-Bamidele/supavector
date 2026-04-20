# SupaVector

SupaVector is the retrieval and memory backend behind AI apps, agents, and internal tools. It combines a C++ vector store, a Node.js gateway, and Postgres-backed metadata/auth/jobs so teams can ingest data, run hybrid vector plus lexical retrieval, ask grounded questions, and manage long-term memory through one API.

Open-source repo scope: self-hosted runtime, CLI, and SDKs. If you are using a running SupaVector deployment instead of operating the server yourself, start with the hosted/shared-deployment guides and the SDKs.

License: MIT

[Quickstart](QUICKSTART.md) · [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Good First Issues](docs/good-first-issues.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Support](SUPPORT.md)

## Start Here

Choose one path first:

- I want to run SupaVector myself: install the CLI and run `supavector onboard`.
- I already have a running SupaVector deployment: store `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY`, then call it from Python, Node, or plain HTTP.
- I am building in Python and just need a client: run `python3 -m pip install supavector`.

Read next:

- Self-hosted runtime: [Quickstart](QUICKSTART.md)
- Setup mode guide: [docs/setup-modes.md](docs/setup-modes.md)
- Hosted service: [docs/hosted.md](docs/hosted.md)
- App/backend/agent integration: [docs/agents.md](docs/agents.md)

## Main Surfaces

- `gateway/`: Node.js/Express gateway, auth, APIs, public docs UI, and background jobs.
- `supavector/`: C++ vector server used for embedding storage and similarity search.
- `sdk/node/`: small Node SDK for API consumers.
- `sdk/python/`: small Python SDK for API consumers.
- `docs/`: setup, deployment, and agent integration guides.
- `scripts/install.sh` and `scripts/install.ps1`: CLI installer entrypoints for local setup.
- `docker-compose.yml`: local/self-hosted stack.
- `docker-compose.external-postgres.yml`: self-hosted stack that uses your existing Postgres.
- `docker-compose.prod.yml`: production-oriented stack with proxy/TLS wiring.
- `docker-compose.portal.yml`: portal/enterprise overlay that swaps the gateway build to the private portal image when `supavector-portal` is cloned beside this repo.

## Architecture

- C++ vector core for fast vector operations.
- Node gateway for auth, API routing, grounded answer generation, memory workflows, and docs.
- Postgres for persistent metadata, auth records, jobs, tenant settings, and memory state.
- Optional provider-backed embeddings and answer generation with fallbacks when unavailable. OpenAI remains the default. Gemini is also supported for generation and embeddings, and Anthropic is supported for generation.

## Recommended Integration Model

- Human admins use username/password or SSO to manage the instance.
- Apps, backends, workers, and agents should use a service token.
- If you want SupaVector to keep its own Postgres/auth/runtime but use your own provider key for a request, send the matching request-scoped header on supported sync routes: `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key`.
- If you already have your own application auth, keep it there and let your backend call SupaVector server-to-server.
- SupaVector can run against your existing Postgres by wiring `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` into the gateway runtime environment or a custom Compose file.

## Developer And Agent Decision Matrix

If you are not sure which path to use, choose based on the kind of deployment and ownership model you want.

| Usage mode | Best when | Read first |
| --- | --- | --- |
| Fork and self-deploy with the bundled stack | You want the fastest path from clone to a working SupaVector instance | [Self-hosting guide](docs/self-hosting.md) |
| Fork and self-deploy with your own Postgres and provider keys | You already have database/secrets infrastructure and want SupaVector inside your environment | [Bring your own Postgres](docs/bring-your-own-postgres.md) |
| Use a shared SupaVector deployment | SupaVector already has its own Postgres/auth/runtime and your app or agent just needs to call it | [Apps, backends, and agents](docs/agents.md) |
| Use a shared SupaVector deployment with your own provider key | SupaVector keeps the shared Postgres/auth/runtime, but each request should use your provider key | [Shared SupaVector, your provider key](docs/agents.md#shared-provider-key) |
| Keep your own product auth and place SupaVector behind your backend | End users should not log into SupaVector directly | [Backend-as-caller](docs/agents.md#backend-as-caller) |
| Use SupaVector mainly as a human admin or browser UI | You are managing tenant settings, keys, or interactive sessions | [Human JWT](docs/agents.md#human-jwt) |

If you are still deciding what you are actually setting up, start with [Setup Modes](docs/setup-modes.md) before choosing a self-hosted or shared-deployment path.

If you are deploying the private portal plugin and expect enterprise SSO, runtime placement, BYOC, sharding, Access Management, or portal billing surfaces, do not start from the plain `Dockerfile.node` path alone. Use the portal overlay described in [docs/self-hosting.md](docs/self-hosting.md) so the gateway image includes `supavector-portal/plugins`.

## Quickstart

### Prerequisites

- Docker with the Compose plugin
- Node.js 18+ if you want to use the SupaVector CLI
- Git if you want the installer to clone or refresh the repo for you
- At least one provider API key for normal retrieval and answer quality. OpenAI remains the default out of the box.

`OPENAI_API_KEY` is the default quickstart path. `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are also supported, and `GEMINI_API` is accepted as an alias for `GEMINI_API_KEY`.

### Python SDK

If SupaVector is already running and your Python app only needs a client, install the SDK from PyPI:

```bash
python3 -m pip install supavector
```

Then set:

```bash
export SUPAVECTOR_BASE_URL="https://YOUR_DOMAIN"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
```

Use this path for hosted deployments, existing shared deployments, notebooks, workers, and backend integrations that do not need to operate the SupaVector server itself.

### SupaVector CLI (recommended for self-hosting)

SupaVector ships with a CLI for onboarding, stack operations, and basic API usage.

### Install

Use the CLI when you want SupaVector to feel like one command surface: install it, run the local stack, point apps at it, maintain it over time, and keep a working command reference close by.

The CLI covers:

- install and update the local `supavector` command
- onboard the first local stack and bootstrap the first admin and service token
- start, stop, and diagnose the local Docker services
- run `write`, `search`, `ask`, and `boolean_ask` directly from the terminal

Install from a local checkout:

```bash
./scripts/install.sh
```

Install from a one-line remote command:

```bash
curl -fsSL https://raw.githubusercontent.com/Emmanuel-Bamidele/supavector/main/scripts/install.sh | bash
```

Install system-wide on macOS/Linux when you want `/usr/local/bin/supavector` and are comfortable using `sudo`:

```bash
sudo ./scripts/install.sh --system
```

Or the one-line remote system install:

```bash
curl -fsSL https://raw.githubusercontent.com/Emmanuel-Bamidele/supavector/main/scripts/install.sh | sudo bash -s -- --system
```

Install with npm if you prefer a package-managed global CLI instead of the managed git-checkout installer:

```bash
npm install -g .
```

Or install straight from GitHub with npm:

```bash
npm install -g github:Emmanuel-Bamidele/supavector
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Or the one-line remote version:

```powershell
irm https://raw.githubusercontent.com/Emmanuel-Bamidele/supavector/main/scripts/install.ps1 | iex
```

What the installer creates:

- macOS/Linux wrapper: `~/.supavector/bin/supavector`
- Windows wrappers: `%USERPROFILE%\.supavector\bin\supavector.ps1` and `supavector.cmd`
- a PATH update so new terminals can find `supavector`

For `--system`, the installer writes the wrapper to `/usr/local/bin/supavector`, uses `/usr/local/lib/supavector` as the managed install home, and skips shell profile edits because `/usr/local/bin` should already be on PATH.

For `npm install -g`, npm owns the wrapper location and upgrade lifecycle instead of the installer.

If your current terminal still says `supavector: command not found`, open a new shell or add the install bin directory to PATH manually.

### Container

On the local self-hosted path, the CLI manages the SupaVector container stack for you. The default path uses the bundled Postgres service from `docker-compose.yml`. If you already manage your own Postgres, use `supavector onboard --external-postgres` and the CLI will write `.env.external-postgres` and use `docker-compose.external-postgres.yml` instead.

That choice only changes which Postgres database this self-hosted SupaVector instance uses. It does not make the instance part of another SupaVector deployment or platform.

Start with the onboarding wizard:

```bash
supavector onboard
```

The wizard prompts for:

- gateway port
- admin username
- admin password
- tenant id
- default generation provider
- default generation model for that provider
- optional boolean_ask provider/model override
- embedding provider and embedding model
- reflect provider/model and optional compact provider/model override
- whichever provider API keys are needed for the providers you selected
- optional external Postgres values if you choose the BYO Postgres path

For the normal first-run path, you can usually press `Enter` at:

- `Gateway port [3000]:` to keep `3000`
- `Tenant id [default]:` to keep `default`

During onboarding, the CLI also:

- writes the local env file
- saves the local project/base URL context in `~/.supavector/config.json`
- starts the Docker stack
- runs the bootstrap helper for you
- creates the first admin and the first service token
- updates `~/.supavector/config.json` with the saved service token

If you want the external Postgres path directly:

```bash
supavector onboard --external-postgres
```

If the Docker stack is already up but setup has not finished yet, finish setup on that running stack with:

```bash
supavector bootstrap --username your-username --tenant default
```

Use the same admin username you entered during onboarding. If you pressed `Enter` at `Tenant id [default]:`, keep `default` here too. This finishes setup by saving the base URL and first service token for later CLI commands.

If onboarding stops early after the stack starts, `supavector doctor` will still show the saved base URL and will mark the API key as pending bootstrap instead of treating the local setup as completely unknown.

If you are using SupaVector from this same computer through the CLI, you do not need to copy the token anywhere. Later CLI commands use the saved service token automatically.

Useful local container commands:

```bash
supavector status
supavector start --build
supavector stop --down
supavector logs
supavector doctor
```

### Hosting

Once CLI setup is complete, SupaVector becomes a running local service your own app, backend, worker, or agent can call. The normal runtime inputs are the saved base URL and service token.

If you are wiring your own app, backend, worker, or agent on the same machine, export the saved values into your runtime env:

```bash
export SUPAVECTOR_BASE_URL="http://localhost:3000"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
export SUPAVECTOR_COLLECTION="default"
```

If you want request-scoped provider usage on supported sync routes, also export one or more of:

```bash
export OPENAI_API_KEY="YOUR_OPENAI_KEY"
export GEMINI_API_KEY="YOUR_GEMINI_KEY"
export ANTHROPIC_API_KEY="YOUR_ANTHROPIC_KEY"
```

The token is shown during onboarding. If you need to inspect it again locally, run:

```bash
supavector config show --show-secrets
```

Do not commit those values to git.

If SupaVector is already deployed online behind nginx or another public proxy, use the CLI as a remote client instead of onboarding locally:

```bash
export SUPAVECTOR_BASE_URL="https://YOUR_DOMAIN"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
supavector write --doc-id cli-test --collection cli-smoke --text "SupaVector CLI remote test."
supavector search --q "remote test" --collection cli-smoke --k 3
supavector ask --question "What does the CLI test document say?" --collection cli-smoke
supavector boolean_ask --question "Does the CLI test document mention SupaVector?" --collection cli-smoke
```

In that remote path, Docker is not required on the client machine. `supavector onboard` is for local self-hosting; `write`, `search`, `ask`, and `boolean_ask` are the main commands for testing a live deployment.

Service tokens are scoped to the SupaVector deployment that minted them. A token from your local self-hosted instance will not work against a different SupaVector deployment, and a token from a shared or hosted deployment will not work against your separate local instance unless that exact deployment issued it.

### Maintenance

Later, update an installed SupaVector CLI checkout with:

```bash
supavector update
supavector changemodel
```

For the managed install under `~/.supavector`, `supavector update` can recover from a force-pushed `origin/main` as long as the checkout is clean.

If you installed with `npm install -g`, update by reinstalling with npm instead of running `supavector update`.

To remove the managed CLI install later:

```bash
supavector uninstall
```

This removes the local wrapper, saved CLI config, installer PATH hook, the managed checkout under `~/.supavector` when that checkout exists, and for managed local self-hosted installs it also runs `docker compose down -v` to clear the local SupaVector containers and volumes.

To change local self-hosted model defaults later:

```bash
supavector changemodel

# non-interactive example
supavector changemodel \
  --answer-provider openai \
  --answer-model 2 \
  --boolean-ask-model inherit \
  --embed-provider openai \
  --embed-model text-embedding-3-large \
  --reflect-provider openai \
  --reflect-model gpt-5-mini \
  --compact-model inherit \
  --restart
```

`supavector changemodel` edits the local SupaVector env file. The CLI now prompts for the provider first, then shows the numbered model choices for that provider so users do not need to type common model ids manually. `--boolean-ask-model inherit` makes `boolean_ask` follow the answer provider/model, and `--compact-model inherit` makes compaction follow the reflect provider/model.

Provider picker choices are:
- generation providers: `1 = openai`, `2 = gemini`, `3 = anthropic`
- embedding providers: `1 = openai`, `2 = gemini`

When the provider is OpenAI, `supavector ask --model ...` and `supavector boolean_ask --model ...` use the current OpenAI catalog shortcuts (`1 = gpt-5.2`, `2 = gpt-5-mini`, `3 = gpt-5-nano`, `4 = custom`). When you also pass `--provider`, the same numbering becomes provider-specific for that provider's catalog. Explicit model ids still work anywhere.

Model env keys for self-hosted installs:

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

`ANSWER_PROVIDER`, `BOOLEAN_ASK_PROVIDER`, `REFLECT_PROVIDER`, and `COMPACT_PROVIDER` can be `openai`, `gemini`, or `anthropic`. `EMBED_PROVIDER` can be `openai` or `gemini`. Anthropic is generation-only today because SupaVector still needs a provider-native embedding endpoint for indexing and retrieval.

You can also discover the preset catalog over HTTP:

```bash
curl http://localhost:3000/v1/models
```

The response lists generation providers, embedding providers, provider-specific preset catalogs, and the current instance defaults. Model availability still depends on your provider account, enabled APIs, and region.

`EMBED_MODEL` is instance-wide, not tenant-specific. Because the vector store uses one embedding space for all stored chunks, changing `EMBED_MODEL` requires a reindex. `supavector changemodel` sets `REINDEX_ON_START=force` automatically when the embedding model changes so the next local restart rebuilds vectors from stored chunks.

Fresh CLI-managed installs write `EMBED_MODEL=text-embedding-3-large` by default. Existing self-hosted installs should pin `EMBED_MODEL` explicitly before changing it so updates do not silently switch embedding spaces.
On startup, SupaVector now also rebuilds vectors automatically when it detects a vector-count or vector-dimension mismatch against the stored chunks for the current embedding model.
The GPT-5 presets are supported for `ask`, `boolean_ask`, reflect, and compaction. SupaVector omits unsupported `temperature` parameters automatically for those models.

Hybrid retrieval defaults you can change in the env:

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
RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED=1
MEMORY_RETRIEVAL_RECENCY_WEIGHT=0.3
MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS=14
```

`rrf` is the default fusion mode for hybrid retrieval. It fuses dense vector rank with Postgres full-text rank and keeps exact identifiers more competitive without removing semantic recall. Set `HYBRID_RETRIEVAL_ENABLED=0` to preserve vector-only retrieval behavior, or switch `HYBRID_FUSION_MODE=weighted` to use the legacy normalized score blend. `RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED=1` lets obviously freshness-sensitive queries such as "latest incident status" or "current pricing" automatically opt into recency-aware ranking unless the caller explicitly turns it off.

For fixture-driven retrieval quality checks, run:

```bash
cd gateway
npm run eval:retrieval
```

That evaluation harness reports recall@k, MRR, nDCG, latency, and evidence-hit rate from `experiments/fixtures/retrieval_correctness_cases.json`.

Common maintenance checks:

```bash
supavector doctor
supavector status --json
supavector logs --service gateway
supavector config show
```

If `supavector` is not found, open a new terminal or add `~/.supavector/bin` to PATH manually. If the stack is running but setup was not saved yet, run `supavector bootstrap --username your-username --tenant default`. If gateway readiness times out, inspect `supavector logs --service gateway` and the written env file.

### Commands

After onboarding, you can run:

```bash
supavector write --doc-id welcome --collection local-demo --text "SupaVector stores memory for agents."
supavector search --q "memory for agents" --collection local-demo --k 5
supavector ask --question "What does SupaVector store?" --collection local-demo
supavector boolean_ask --question "Does SupaVector store memory for agents?" --collection local-demo
```

`search`, `ask`, `code`, `boolean_ask`, and memory recall now use hybrid retrieval by default: dense vector search from the C++ store plus lexical full-text search from Postgres, fused with reciprocal rank fusion. This especially helps short identifiers, SKUs, error codes, and mixed natural-language-plus-identifier queries.

The CLI now exposes the same first-class retrieval filters as the API. Use `--doc-ids`, `--namespace-ids`, `--tags`, `--agent-id`, `--source-type`, `--document-type`, `--since`, `--until`, `--time-field`, and `--favor-recency` on `search`, `ask`, `code`, and `boolean_ask` when retrieval scope matters.

You can also ingest a whole folder of supported files. The CLI reads plain text files directly and extracts text from `.pdf` and `.docx` files before indexing. If you omit `--collection`, the folder name becomes the collection name:

```bash
supavector write --folder ./customer-support
supavector search --q "refund policy" --collection customer-support --k 5
```

You can also inspect, update, and clean up indexed content from the CLI:

```bash
supavector collections list
supavector docs list --collection customer-support

# Replace one document after the source file changes
supavector docs replace \
  --doc-id handbook \
  --collection customer-support \
  --file ./customer-support/handbook.md \
  --yes

# Equivalent single-doc update flow
supavector write \
  --doc-id handbook \
  --collection customer-support \
  --file ./customer-support/handbook.md \
  --replace \
  --yes

# Reconcile a folder-backed collection to match local files exactly
supavector write --folder ./customer-support --sync --yes

# Delete one doc
supavector docs delete --doc-id handbook --collection customer-support --yes

# Delete an entire collection (admin-capable token required)
supavector collections delete --collection customer-support --yes
```

Use `docs replace` or `write --replace` when the content behind a single `docId` has changed. Use `write --folder --sync` when the local folder should become the source of truth for the whole collection, including deleting docs that are no longer present in that folder. There is not a separate collection-rename command; collection maintenance is done by listing, replacing, syncing, and deleting docs.

### Examples

Local bundled stack:

```bash
./scripts/install.sh
supavector onboard
supavector status
supavector write --doc-id welcome --collection local-demo --text "SupaVector stores memory for agents."
supavector ask --question "What does SupaVector store?" --collection local-demo
supavector boolean_ask --question "Does SupaVector store memory for agents?" --collection local-demo
```

Local external Postgres:

```bash
supavector onboard --external-postgres
supavector doctor
supavector write --doc-id policies --collection compliance --file ./docs/policies.md
supavector search --q "policies" --collection compliance --json
```

Remote live deployment:

```bash
export SUPAVECTOR_BASE_URL="https://YOUR_DOMAIN"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
supavector write --doc-id cli-test --collection cli-smoke --text "SupaVector CLI remote test."
supavector search --q "remote test" --collection cli-smoke --k 3
supavector ask --question "What does the CLI test document say?" --collection cli-smoke
supavector boolean_ask --question "Does the CLI test document mention SupaVector?" --collection cli-smoke
```

Use the CLI when you want the fastest path from install to a working local deployment. Use the manual Docker steps below if you want to see and control each setup step explicitly.

### 1. Configure Environment (manual path)

Copy the example env file and edit the small set of values you actually need:

```bash
cp .env.example .env
```

Update at least:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `COOKIE_SECRET`
- one or more provider keys: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`

### 2. Start The Stack

```bash
docker compose up -d --build
```

Check health:

```bash
curl -sS http://localhost:3000/health
```

Expected response:

```json
{"ok":true}
```

### 3. Bootstrap The First Admin And Service Token

Recommended path for developers and agents:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

That command ensures the admin user exists, creates a fresh service token, and prints the `SUPAVECTOR_BASE_URL` / `SUPAVECTOR_API_KEY` values your app or agent can use directly.

If you run the gateway directly from source instead of Docker:

```bash
cd gateway
npm run bootstrap:instance -- \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

Export the printed values:

```bash
export SUPAVECTOR_BASE_URL="http://localhost:3000"
export SUPAVECTOR_API_KEY="<paste service token here>"
```

### 3b. Optional Third Mode: Your Provider Key, Shared SupaVector Deployment

If you are using an SupaVector deployment that already has its own Postgres and auth, but you want requests to use your provider key instead of the server default, send the matching request-scoped header:

```bash
-H "X-OpenAI-API-Key: ${OPENAI_API_KEY}"
-H "X-Gemini-API-Key: ${GEMINI_API_KEY}"
-H "X-Anthropic-API-Key: ${ANTHROPIC_API_KEY}"
```

This is request-scoped. It does not create a tenant-level provider setting or store your provider key in Postgres.

Supported sync request paths:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/ask`
- `POST /v1/code`
- `POST /v1/boolean_ask`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`

Current limitation:

- `POST /v1/memory/reflect` and `POST /v1/memory/compact` reject request-scoped provider-key headers because those jobs continue asynchronously after the request ends.

`POST /v1/ask`, `POST /v1/code`, and `POST /v1/boolean_ask` also accept a `provider` field in the JSON body when one request should use a different generation provider than the tenant or instance default.

Embedding provider selection remains instance-wide today. Request-scoped provider headers for docs, search, memory write, and memory recall only override credentials for the embedding provider that the instance is already configured to use.

If you only want a human admin login and do not want a service token yet, use the older bootstrap command instead:

```bash
docker compose exec gateway node scripts/create_user.js \
  --username admin \
  --password change_me \
  --tenant default \
  --role admin
```

### 4. Index A Document From Your App Or Agent

Use the service token for normal machine-to-machine traffic:

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-doc-1' \
  -d '{
    "docId":"welcome",
    "text":"SupaVector stores memory for agents and returns grounded answers with citations."
  }'
```

`/v1/docs` stays text-first by default. If you are sending source code directly, you can also include optional fields such as `sourceType`, `title`, `sourceUrl`, and `metadata`. Set `"sourceType":"code"` only when the payload is actually code and you want code-aware chunking for that document.

`GET /v1/search` and the retrieval step behind `ask`, `code`, `boolean_ask`, and memory recall use hybrid retrieval by default. Exact identifiers and quoted terms can surface through Postgres lexical search even when the embedding signal is weak, while semantic-only queries still retain vector recall.

### 5. Ask A Question From Your App Or Agent

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{
    "question":"What does SupaVector store?",
    "k":3,
    "policy":"amvl",
    "provider":"openai",
    "model":"gpt-5.2"
  }'
```

`provider` and `model` are optional. Use them when one request should use a different generation provider/model without changing the tenant default.

Set `"favorRecency": true` when fresher matching evidence should outrank older matches. This is useful for continuously updated facts such as product catalogs, release notes, incident timelines, or chat-state-like memory. Synced Memory sources stamp `syncedAt` automatically, and direct writes can also provide timestamps such as `updatedAt`, `publishedAt`, `effectiveAt`, or `syncedAt` in `metadata`.

Search-backed endpoints also accept first-class retrieval filters: `docIds`, `namespaceIds`, `tags`, `agentId`, `sourceTypes`, `documentTypes`, `since`, `until`, and `timeField`. `timeField` defaults to `createdAt`; set it to `freshness` when the time window should use metadata freshness timestamps instead of original ingest time.

Hybrid retrieval configuration is documented in [docs/hybrid-retrieval.md](docs/hybrid-retrieval.md). Filtering, recency scoring, and the evaluation harness are documented in [docs/retrieval-correctness.md](docs/retrieval-correctness.md).

### 5a. Ask A Code Question

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/code" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{
    "question":"Why would newer product records rank above stale ones in this retrieval flow?",
    "k":6,
    "task":"debug",
    "answerLength":"medium",
    "policy":"amvl",
    "favorRecency":true
  }'
```

`/v1/code` uses the same retrieval controls as `/v1/ask`, including `policy` and `favorRecency`, but produces code-aware grounded answers for debugging, review, and implementation questions.

### 6. Ask A Strict True/False Question

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/boolean_ask" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{
    "question":"Does SupaVector store memory for agents?",
    "k":3,
    "policy":"amvl"
  }'
```

This endpoint returns only `true`, `false`, or `invalid`. `invalid` means the input was not a grounded true/false question for the retrieved sources. The response also includes `supportingChunks` when you need the exact chunk text used for the decision.

Admins can set tenant-level generation defaults through `GET/PATCH /v1/admin/tenant` with `models.answerProvider`, `models.answerModel`, `models.booleanAskProvider`, `models.booleanAskModel`, `models.reflectProvider`, `models.reflectModel`, `models.compactProvider`, and `models.compactModel`. `embedProvider` and `embedModel` stay instance-wide and should be changed in the self-hosted env or with `supavector changemodel`.

### 7. Optional: Log In As A Human Admin

```bash
curl -sS http://localhost:3000/v1/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"change_me"}'
```

Copy the JWT from `data.token` in the response and export it:

```bash
export TOKEN='<paste token here>'
```

Use JWTs for the browser UI, admin setup, or cases where a human is signing in interactively. For apps and agents, prefer the service token flow above.

## Local Endpoints

After startup, these are the main local URLs:

- App and public UI: `http://localhost:3000/`
- Health: `http://localhost:3000/health`
- API docs UI: `http://localhost:3000/docs`
- Public OpenAPI spec: `http://localhost:3000/openapi.public.json`
- MCP endpoint: `http://localhost:3000/mcp`
- LLM discovery file: `http://localhost:3000/llms.txt`

## Common Operations

Stop the stack:

```bash
docker compose down
```

Reset local data volumes:

```bash
docker compose down -v
```

View logs:

```bash
docker compose logs -f gateway
docker compose logs -f postgres
docker compose logs -f redis
```

## Development

The Docker path is the default way to run the project. If you want to work on the gateway directly:

```bash
cd gateway
npm ci
npm run test:unit
```

With the stack running, you can also run:

```bash
npm run test:integration
npm run test:e2e
npm run test:e2e:code
```

The Docker-backed CI harness in `./scripts/test_ci_local.sh` runs the standard gateway suite and the code API e2e suite by default. Set `RUN_DIAGNOSTIC_E2E=1` if you also want the heavier diagnostic e2e retrieval checks.

## Bring Your Own Postgres And Env

SupaVector does not require a bundled Postgres container in production. If your stack already has Postgres and secret management, point the gateway at your existing values:

- `PGHOST`
- `PGPORT`
- `PGDATABASE`
- `PGUSER`
- `PGPASSWORD`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `JWT_SECRET`
- `COOKIE_SECRET`

The stock `docker-compose.yml` is optimized for the bundled `postgres` service. If you want external Postgres, use the official `docker-compose.external-postgres.yml` path below or your own runtime wiring for the gateway.

SupaVector includes an official external-Postgres path:

```bash
cp .env.external-postgres.example .env.external-postgres
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres up -d --build
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres exec gateway \
  node scripts/bootstrap_instance.js --username admin --password change_me --tenant default --service-token-name app-bootstrap
```

Then run the bootstrap helper once to create the first admin and service token. After that, your backend or agent can call SupaVector with `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY` without repeated human login.

## Production Notes

The production compose file is available at `docker-compose.prod.yml` with example settings in `.env.prod.example`.

Before using it for any real deployment:

- set a real public domain and email
- use strong secrets
- review proxy and TLS settings
- set `STUNNEL_CERTS_DIR` to a server-only directory outside the repository
- replace any sample or development certificate material with your own

The production compose file now supports an external cert directory for the internal `stunnel` hop. If `STUNNEL_CERTS_DIR` is unset, it falls back to `./deploy/certs` for backward compatibility with existing deployments.

## SDK And Guides

- Node SDK: [`sdk/node/README.md`](sdk/node/README.md)
- Python SDK: [`sdk/python/README.md`](sdk/python/README.md)
- Guides index: [`docs/README.md`](docs/README.md)

## Project Docs

- Self-hosting guide: [`docs/self-hosting.md`](docs/self-hosting.md)
- Bring your own Postgres: [`docs/bring-your-own-postgres.md`](docs/bring-your-own-postgres.md)
- Agent integration guide: [`docs/agents.md`](docs/agents.md)
- External Postgres env template: [`.env.external-postgres.example`](.env.external-postgres.example)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security reporting: [`SECURITY.md`](SECURITY.md)
- Support expectations: [`SUPPORT.md`](SUPPORT.md)
- Stunnel cert layout: [`deploy/stunnel/README.md`](deploy/stunnel/README.md)

## Current Scope

SupaVector is currently documented for self-hosted use. It is not presented here as a managed hosted service.
