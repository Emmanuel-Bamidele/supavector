# Changelog

All notable changes to SupaVector will be documented in this file.

This project follows Keep a Changelog principles and uses semantic versioning for tagged releases.

## [Unreleased]

Retrieval v2. On BEIR SciFact (300 queries) nDCG@10 goes from 0.003 to 0.758
(0.799 with the optional reranker), against 0.712 for OpenAI file search on the
same harness. On MultiHop-RAG (200 questions, gpt-4o judge) answer accuracy goes
from 44.5% to 79.5% (OpenAI file search: 77.5%), with median answer latency
from 18.4 s to 4.2 s; with `k: 20` it reaches 82.0%. Full results:
`BENCHMARKS.md`.

### Fixed

- Document search no longer samples: every document in scope is searched. HOT/WARM/COLD tiering now applies to memories only; for documents it searched about 8 random documents per query and let unused ones decay out of reach (`DOCUMENT_RETRIEVAL_FULL_SCOPE=0` restores the old behaviour).
- Keyword search matches natural questions: BM25 over a stemmed English index with OR semantics replaces the AND-of-every-word query (`LEXICAL_MODE=legacy` restores it).
- Hybrid fusion boosts are scaled to RRF's magnitude (`HYBRID_RRF_BOOST_SCALE`); unscaled, word-overlap boosts outweighed both rankers on semantic queries. The reranker's pool keeps slots for the best keyword matches outside the fused head (`RERANK_LEXICAL_SLOTS`), so exact-term evidence still reaches it.
- Fallback hash embeddings are off unless `EMBED_FALLBACK_ON_ERROR=1`; they silently poisoned live indexes during provider outages.
- Citations are checked against the sources the model was shown; an explicit "I don't know" carries none.
- A long document title is shortened instead of rejecting the document.
- Vector reindex embeds chunk context with the configured model and checks the configured provider's key.
- `/v1/admin/vector/reindex` requires instance admin; it rebuilds every tenant's vectors.
- Vector rebuilds overwrite in place, so search keeps serving; only a change of embedding dimension clears the store first. Extra vectors no longer trigger a full paid rebuild, and a forced rebuild checks the dimension before it starts.
- The vector store records which embedding model built it (`provider:model:dimensions`). Switching to another model of the same dimension, which the dimension check can't see, now clears and rebuilds instead of silently mixing vectors from two models. Rebuilds retry failed embedding batches (`REINDEX_EMBED_ATTEMPTS`, default 5) instead of stopping halfway.
- A vector store that restarts empty is rebuilt automatically: the gateway checks every `VECTOR_STORE_WATCH_MS` (default 60 s).
- The vector WAL is synced to disk every `VECTOR_WAL_FSYNC_MS` (default 1 s) and compacted once it holds twice the live vectors; its rewrite is synced before it replaces the log. It is on by default in the production compose file.
- Every path resolves the embedding model the same way: reindex and the dimension probe match indexing, Gemini no longer receives OpenAI's model name under compose, and the gateway warns at startup when `EMBED_MODEL` is unset. Unpinned OpenAI installs keep their `text-embedding-3-small` fallback.
- Persona answers stay within the AI's own knowledge: a fact the sources don't contain is declined in the AI's voice, not supplied from general knowledge.
- Anthropic answers work with current Claude models. They reject `temperature` and assistant prefill; the gateway learns this from the API's error, once per model, and retries without the field.

### Added

- Structure-aware chunking (`CHUNK_STRATEGY=structured`, default): chunks follow headings and sections, carry their heading path, and never overlap.
- Chunk context: each chunk is embedded and keyword-indexed with a header (document title, date, section) and a generated line placing it in its document (`CHUNK_CONTEXT_*`). The date comes from metadata (`publishedAt`, `date`, `updatedAt`, …) or a labelled date line near the top of the text, so questions about time order can be answered.
- Follow-up rewriting and multi-part question planning before retrieval (`QUERY_REWRITE_*`).
- Optional reranking, off by default: Cohere, Voyage and Jina cross-encoders or an OpenAI listwise reranker (`RERANK_*`). It sharpens search ordering; on answers it made no measurable difference and added about 1.6 s.
- Neighbour expansion and an optional full-context mode for small scopes (`FULL_CONTEXT_MAX_CHARS`).
- `citationMode: "numbered"`: `[n]` markers in the answer index `citations[n-1]`, each with `title`, `url` and `snippet`.
- Streaming `/v1/ask` (`stream: true` or `Accept: text/event-stream`).
- `/v1/search`: `includeText`, `rerank`, `title`, `url`, and `similarity` (cosine; `score` is a ranking score).
- Original document text is stored; `GET /v1/docs?includeText=1` exports it in pages.
- `POST /v1/admin/reingest` moves existing documents onto the current pipeline one at a time.
- `/v1/health` reports `version` and `features`.
- `eval/`: a reproducible benchmark harness (BEIR, MultiHop-RAG, LoCoMo, product sets, OpenAI file search adapter) with paired comparisons, resumable answer runs, question-type subsets and merging.
- Multi-part questions keep each part's best passage in the answer context, so one part's many strong passages can't crowd out another part's only one.
- SDKs: `askStream` / `ask_stream` and re-ingest helpers.
- `reasoningEffort` on `/v1/ask` for OpenAI reasoning models (gpt-5 family, o-series): `lowest`, `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, with `ANSWER_REASONING_EFFORT` as the instance default. Unset keeps the model's API default (none for gpt-5.1 and later, medium for gpt-5, gpt-5-mini and gpt-5-nano); `lowest` picks the cheapest setting each family accepts, so a gpt-5-mini answer need not think at length before every reply. Other providers and non-reasoning models ignore it.

### Changed

- Answers lead with the answer: a yes-or-no question gets one overall yes or no first. The model combines and compares facts across sources, answers the part of a question the sources cover and names what is missing, and declines only when the sources hold none of the facts needed.
- Bulk indexing processes documents concurrently (`DOCS_BULK_CONCURRENCY`).
- `ATLASRAG_PORT` and `GATEWAY_PORT` override the vector server and gateway ports.
- `search_tsv` is maintained by a trigger, backfilled in batches and indexed concurrently, so upgrading never locks the chunks table for long.

## [0.3.0] - 2026-04-17

### Added

- Phase 2 retrieval correctness improvements: first-class retrieval filters for namespace, source type, document type, tags, agent-scoped sources, and configurable time windows across search-backed endpoints.
- A fixture-driven retrieval evaluation harness with recall@k, MRR, nDCG, latency, and evidence-hit reporting via `cd gateway && npm run eval:retrieval`.

### Changed

- Search, ask, code, boolean_ask, and memory recall now apply the same retrieval filter surface and can use metadata freshness timestamps for time-range filtering.
- Query-driven recency preference is now configurable with `RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED`, `MEMORY_RETRIEVAL_RECENCY_WEIGHT`, and `MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS`.

## [0.2.0] - 2026-04-17

### Fixed

- Made the CLI admin test harness independent from saved local CLI config so machine-specific `tenantId` values do not leak into test assertions.
- Pinned `@xmldom/xmldom` to a non-vulnerable version through the root override so public installs no longer report the known high-severity XML injection advisory.

### Added

- Public OSS community files for contributor onboarding, issue routing, ownership, and pull request hygiene.
- A root `test:prepush` command and a clearer contributor pre-push matrix so outside contributors know which validation to run before opening a pull request.
- Phase 1 hybrid retrieval: reciprocal-rank-fused vector plus lexical retrieval, fixture-driven quality tests for exact identifiers and mixed queries, and a gateway benchmark script for comparing `rrf` against the legacy weighted fusion mode.
