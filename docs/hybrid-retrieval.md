# Hybrid Retrieval Design Note

## Current pipeline (retrieval v2)

1. **Ingest.** Text is split along its headings and sections (`CHUNK_STRATEGY=structured`), with no overlap. Each chunk gets a context: the document title, its section path and, when a model is configured, a generated line placing it in its document. Context and text are embedded together and indexed for keyword search; the chunk's own text is stored unchanged. The original document text is kept for export and re-ingestion.
2. **Plan.** A follow-up is rewritten into a standalone query using the conversation; a question about several things is split into parts (`QUERY_REWRITE_*`). Simple questions without history skip this step.
3. **Scope.** Every document the caller may see is a candidate. HOT/WARM/COLD tiering applies only to memories.
4. **Retrieve.** Dense search over the candidates in the C++ store, plus BM25 keyword search over a stemmed English index (`chunks.search_tsv`, OR semantics, per-term document frequency). Multi-part questions run one search per part.
5. **Fuse.** Reciprocal rank fusion. The overlap and exact-match boosts are tie-breakers scaled to RRF's magnitude.
6. **Rerank (optional, off by default).** With `RERANK_PROVIDER` set, the top `RERANK_CANDIDATES` go to a cross-encoder (Cohere, Voyage, Jina) or an LLM listwise reranker (`openai`). It improves search ordering (+0.04 nDCG@10 on SciFact and MultiHop-RAG) but made no measurable difference to answers, which read about ten passages whichever order they arrive in, and it adds about 1.6 s.
7. **Assemble.** The top `k` passages (default 7) get their neighbouring chunks attached. Multi-part questions get at least 10, and each part keeps its best passage. Small scopes can skip retrieval and send everything (`FULL_CONTEXT_MAX_CHARS`). On MultiHop-RAG, `k: 20` got 85.5% of relevant documents to the answer model (74% at 7) and scored 82.0% against 79.5%, at the same latency and about 1.8× the answer model's input tokens. The Supavector app sends `k: 20`.

Measured results, including the comparison with OpenAI file search: [`BENCHMARKS.md`](../BENCHMARKS.md).

The sections below describe the original Phase 1 change this pipeline builds on.

## Phase 1 note

This note describes the Phase 1 retrieval change shipped in SupaVector.

Phase 2 retrieval correctness work builds on this baseline with first-class filters, freshness-aware time windows, and a fixture-driven evaluation harness. See [`retrieval-correctness.md`](retrieval-correctness.md) for those additions.

## Flow

1. `searchChunks(...)` embeds the query and builds the tenant-scoped candidate set from memory policy gating.
2. The C++ vector store returns dense candidates for semantic recall.
3. Postgres full-text search returns lexical candidates from `chunks.text` using `to_tsvector('simple', text)` and `websearch_to_tsquery`.
4. SupaVector unions those candidates by chunk id, keeps both dense and lexical rank positions, then fuses them into one ranked list.
5. Recency bias is applied after fusion when `favorRecency` is on or auto-enabled for recency-sensitive memory types.

## Fusion Strategy

- Default mode: `HYBRID_FUSION_MODE=rrf`
- Fallback mode: `HYBRID_FUSION_MODE=weighted`

`rrf` uses reciprocal rank fusion across the dense and lexical result lists:

- dense contribution: `HYBRID_VECTOR_WEIGHT / (HYBRID_RRF_K + dense_rank)`
- lexical contribution: `HYBRID_LEXICAL_WEIGHT / (HYBRID_RRF_K + lexical_rank)`

After the base fused score is computed, SupaVector still applies the existing lightweight rerank signals:

- token overlap boost via `HYBRID_RERANK_OVERLAP_BOOST`
- exact substring boost via `HYBRID_RERANK_EXACT_BOOST`
- optional recency blending via `favorRecency`

The `weighted` fallback keeps the previous normalized score blend so operators can roll back the fusion behavior without disabling hybrid retrieval entirely.

## Config Flags

Main retrieval flags:

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

Dense vector search can also run with an approximate side index:

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

Operational meaning:

- `HYBRID_RETRIEVAL_ENABLED=0` disables lexical retrieval and keeps vector-only ranking behavior.
- `HYBRID_FUSION_MODE=rrf` is the default and is recommended for exact identifiers and mixed queries.
- `HYBRID_FUSION_MODE=weighted` preserves the prior score-normalized hybrid fusion.
- `HYBRID_RRF_K` controls how steeply reciprocal rank contributions decay.
- `VECTOR_SEARCH_MODE=exact` keeps the original exact vector scan.
- `VECTOR_SEARCH_MODE=shadow` returns exact results while emitting ANN/exact overlap telemetry.
- `VECTOR_SEARCH_MODE=auto` uses ANN for large candidate sets and exact search for small or insufficient approximate results.
- `VECTOR_ANN_ENABLED=1` enables the gateway to use the approximate side index.
- `VECTOR_ANN_MIN_CANDIDATES` controls when ANN is considered worth using.
- `VECTOR_ANN_OVERFETCH` controls how many approximate candidates are collected before exact rescoring.
- `VECTOR_ANN_EXACT_RESCORE=1` documents the current behavior: approximate candidates are always exact-rescored before ranking.
- `VECTOR_ANN_ROLLOUT_PERCENT` lets operators gradually enable auto-mode ANN by deterministic request sampling.
- `VECTOR_ANN_SHADOW_SAMPLE_RATE` controls how often shadow mode runs ANN beside exact search.
- `VECTOR_ANN_MIN_SHADOW_OVERLAP`, `VECTOR_ANN_LOW_OVERLAP_LIMIT`, and `VECTOR_ANN_CIRCUIT_OPEN_MS` open a temporary exact-only circuit breaker when shadow overlap drops repeatedly.

Operational endpoints:

- `/health` and `/v1/health` include vector ANN readiness and circuit state.
- `/stats` and `/v1/stats` include gateway vector-search runtime summaries.
- `/metrics` exposes Prometheus gauges/counters for vector search mode, fallback reason, p95 dense latency, p95 scanned candidates, shadow overlap, and ANN circuit state.
- `POST /v1/admin/vector/reindex` starts an admin-triggered vector rebuild from stored chunks.
- `GET /v1/admin/vector/search-runtime` returns the current ANN rollout, circuit, and reindex state.

## Backward Compatibility

- When hybrid retrieval is disabled, the ranking path stays vector-only.
- Existing API shapes do not change.
- Existing env weights still apply; `rrf` reuses the same vector and lexical weights instead of introducing a new weighting surface.
- The `weighted` fallback is kept specifically for safe rollback and evaluation.

## Quality Fixture

Curated fixture cases live in:

- `experiments/fixtures/hybrid_retrieval_cases.json`

They cover:

- exact-match identifiers
- semantic-only queries
- mixed semantic plus exact-match queries

Run the benchmark with:

```bash
cd gateway
npm run benchmark:hybrid
```
