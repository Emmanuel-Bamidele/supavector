# SupaVector Python SDK

A small, dependency-free Python client for the SupaVector API.

This SDK is for runtime integrations that already have a SupaVector server to call.
It is not a replacement for the `supavector` Node CLI that manages local onboarding and Docker flows.

## Install

From PyPI:

```bash
python3 -m pip install supavector
```

From this repository:

```bash
cd sdk/python
python3 -m pip install .
```

If you are installing from a local checkout in a restricted or offline environment, skip build isolation so pip can reuse the local `setuptools` already on the machine:

```bash
cd sdk/python
python3 -m pip install --no-build-isolation .
```

Editable install while developing:

```bash
cd sdk/python
python3 -m pip install -e .
```

Optional PDF ingest support:

```bash
cd sdk/python
python3 -m pip install --no-build-isolation ".[pdf]"
```

## Runtime Model

Use this SDK when you already have one of these:

- a local self-hosted SupaVector server running on your machine
- a self-hosted SupaVector deployment on another server
- a shared or hosted SupaVector deployment with a service token

The normal runtime inputs are:

```bash
export SUPAVECTOR_BASE_URL="http://localhost:3000"
export SUPAVECTOR_API_KEY="YOUR_SERVICE_TOKEN"
```

Optional request-scoped provider keys:

```bash
export OPENAI_API_KEY="YOUR_OPENAI_KEY"
export GEMINI_API_KEY="YOUR_GEMINI_KEY"
export ANTHROPIC_API_KEY="YOUR_ANTHROPIC_KEY"
```

If you pass a provider key, the SDK sends the matching request-scoped header so SupaVector can use your key while still using the same SupaVector deployment and its Postgres/auth state.

Current limitation:

- request-scoped provider-key override works on sync requests such as docs, search, ask, boolean_ask, memory write, and memory recall
- `memory_reflect()` and `memory_compact()` should keep using the server-side provider key today because those flows continue asynchronously after the request ends

## Quick Start

```python
from supavector import Client

client = Client.from_env(collection="default")

client.index_text(
    "welcome",
    "SupaVector stores memory for agents.",
    params={
        "idempotencyKey": "py-idx-001",
    },
)

answer = client.ask(
    "What does SupaVector store?",
    {
        "k": 7,
        "provider": "openai",
    },
)
print(answer["data"]["answer"])

decision = client.boolean_ask(
    "Does SupaVector store memory for agents?",
    {
        "k": 7,
        "provider": "openai",
    },
)
print(decision["data"]["answer"])
print(decision["data"]["supportingChunks"])
```

## Authentication

Use a JWT (`token`) or a service token (`api_key`). For apps, agents, workers, and backends, prefer a service token. If both are set, the SDK prefers the API key.

```python
from supavector import Client

client = Client(
    base_url="http://localhost:3000",
    api_key="YOUR_SERVICE_TOKEN",
    openai_api_key="YOUR_OPENAI_KEY",
    gemini_api_key="YOUR_GEMINI_KEY",
    anthropic_api_key="YOUR_ANTHROPIC_KEY",
)
```

Human admin login is still available when you need a JWT for the UI or admin setup:

```python
client.login("admin", "change_me")
```

## Methods

- `health()`
- `login(username, password)`
- `stats()`
- `vector_runtime()`
- `vector_reindex(params=None)`
- `get_models()`
- `models()`
- `list_docs(params=None)`
- `list_collections(params=None)`
- `index_text(doc_id, text, params=None)`
- `index_url(doc_id, url, params=None)`
- `index_file(file_path, doc_id=None, params=None, base_dir=None)`
- `index_folder(folder_path, params=None, recursive=True, include_hidden=False, continue_on_error=True)`
- `delete_doc(doc_id, params=None)`
- `delete_collection(collection, params=None)`
- `search(query, params=None)`
- `ask(question, params=None)`
- `code(question, params=None)`
- `boolean_ask(question, params=None)`
- `memory_write(data)`
- `memory_recall(data)`
- `memory_reflect(data)`
- `memory_cleanup(data)`
- `memory_compact(data)`
- `feedback(data)`
- `get_tenant_settings()`
- `update_tenant_settings(data)`
- `get_job(job_id)`

`vector_runtime()` and `vector_reindex({"mode": "always"})` call admin-only endpoints for ANN rollout inspection and vector rebuilds. Use them with an admin-capable token.

## Environment Helper

`Client.from_env()` loads the usual env vars:

- `SUPAVECTOR_BASE_URL` or `SUPAVECTOR_URL`
- `SUPAVECTOR_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY` or `GEMINI_API`
- `ANTHROPIC_API_KEY`
- `SUPAVECTOR_COLLECTION`
- `SUPAVECTOR_TENANT_ID`
- `SUPAVECTOR_PRINCIPAL_ID`

Example:

```python
from supavector import Client

client = Client.from_env()
```

## Parameters

Most methods accept `collection` and `tenantId` in `params` or `data`.
If you set them on the client with `set_collection()` and `set_tenant()`, they are sent automatically.
Write/index/reflect endpoints require `Idempotency-Key`. Pass `idempotencyKey` in params/data to have the SDK send it as a header.
Memory writes and reflect support access control via `visibility` (`tenant`, `private`, `acl`) and `acl` list (array of principal IDs). The principal is derived from the auth token subject; if you pass `principalId` it must match the token.
You can set a default principal on the client with `set_principal()`, but the server will validate it against the token.
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

Freshness-aware recall example:

```python
recall = client.memory_recall({
    "query": "current product pricing",
    "collection": "default",
    "types": ["semantic"],
    "sourceTypes": ["url"],
    "documentTypes": ["pricing-page"],
    "favorRecency": True,
    "timeField": "freshness",
    "k": 8,
})
```

## Local File And Folder Ingest

The Python SDK can ingest local files and folders before sending them to SupaVector:

- text and code-like files are read directly
- `.docx` files are extracted locally with the Python standard library
- `.pdf` files work when the optional `pypdf` dependency is installed
- code-like files automatically set `sourceType="code"` and attach path/language metadata
- folder ingest defaults the collection to the folder name when neither `params["collection"]` nor `client.collection` is set
- noisy paths such as `node_modules`, `.git`, `dist`, `build`, and `__pycache__` are skipped during folder ingest

Single file example:

```python
from supavector import Client

client = Client.from_env()

client.index_file(
    "./src/refunds.ts",
    params={
        "collection": "support-code",
        "idempotencyKey": "file-idx-001",
    },
    base_dir=".",
)
```

Folder example:

```python
from supavector import Client

client = Client.from_env()

result = client.index_folder(
    "./customer-support",
    params={
        "idempotencyKey": "folder-idx-001",
    },
)

print(result["indexedCount"])
print(result["errors"])
```

For folder ingest, a provided `idempotencyKey` acts as a stable batch prefix. The SDK derives one per-file key from that prefix plus the generated file doc id, so repeated folder ingests stay deterministic without reusing the exact same idempotency key across different files.

## Examples

Run the samples from the repository root or from `sdk/python`:

```bash
python3 sdk/python/examples/basic.py
python3 sdk/python/examples/ingest_folder.py
python3 sdk/python/examples/memory.py
```
