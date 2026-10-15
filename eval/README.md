# SupaVector eval harness

Reproducible retrieval and answer benchmarks. Every system runs through the
same harness: the same query sample, the same metrics, and for answers the same
judge model and prompt. A score difference is then the systems, not the setup.

## Run it

```bash
export SUPAVECTOR_BASE_URL=http://localhost:3000
export SUPAVECTOR_API_KEY=<service token>
export OPENAI_API_KEY=<key>          # judge, and the openai-file-search system

# Retrieval quality (recall@k, nDCG@10, MRR) on a BEIR set
node eval/run.js --dataset beir:scifact --system supavector --mode retrieval --label v2

# Answer quality on MultiHop-RAG (same 200-question sample for every system)
node eval/run.js --dataset multihop-rag --system supavector --mode both --limit 200 --citation-mode numbered --label v2

# The same questions through OpenAI file search
node eval/run.js --dataset multihop-rag --system openai-file-search --mode both --limit 200 --label competitors
```

Results land in `eval/results/<label>/<dataset>--<system>--<mode>.json` with a
summary and every per-query row. Indexing is resumable; `--reindex` rebuilds.
Answer runs save each graded question as it lands, so an interrupted run
resumes under the same label instead of paying again; `--fresh` (or
`--reindex`) starts over.
`node eval/summarize.js [labels...]` prints one comparison table across labels.
`node eval/compare.js <runA.json> <runB.json>` gives a paired difference on
the shared queries with a 95% bootstrap interval.
`node eval/publish.js --out eval/published/<date> <name>=<run.json> ...` exports
runs for publication: summaries and per-question scores, without question or
answer text. Published results and the report built on them:
[`../BENCHMARKS.md`](../BENCHMARKS.md).

To check results with a judge from another vendor, grade finished runs again
without regenerating their answers:
`node eval/rejudge.js --judge-model claude-opus-5-5 --label judge-claude <run.json> ...`.
It prints how often the two judges agree, and a failed grade is never saved as
a verdict.

To check a change cheaply, run only the question types it targets with
`--types` (the same seeded sample, filtered), then run the remaining types
under another label and combine them:
`node eval/merge.js --label <out> <runA.json> <runB.json>`.

| Flag | Meaning |
|---|---|
| `--dataset` | `beir:<name>` (downloads the BEIR set), `multihop-rag`, `locomo` (long-conversation memory; categories 1–4, each question scoped to its conversation), or a `.json` set |
| `--system` | `supavector`, `openai-file-search`, or `gemini-file-search` (answers only: Gemini File Search has no retrieval-only endpoint; `--model` picks the Gemini model, default `gemini-4-argon`) |
| `--mode` | `retrieval`, `answer`, or `both` |
| `--limit` | Deterministic query sample (seeded), identical across systems |
| `--types` | Keep only these question types from the sample, comma-separated (e.g. `temporal_query,null_query`) |
| `--fresh` | Discard an interrupted answer run's saved progress |
| `--rerank 0` | SupaVector without the reranker (ablation) |
| `--citation-mode` | SupaVector answer citation mode (`metadata` or `numbered`) |
| `--judge-model` | Answer judge (default `gpt-4o`, or `EVAL_JUDGE_MODEL`). A `claude-*` model grades through the Anthropic API (`ANTHROPIC_EVAL_API_KEY` or `ANTHROPIC_API_KEY`). `none` skips grading, so a run with a cheap `--model` measures context recall alone |
| `--model` | SupaVector answer model override for the run |
| `--data-dir` | Where downloads go (default `~/.cache/supavector-eval`) |

## Metrics

- **Retrieval** is scored at the document level, as BEIR and MultiHop-RAG label
  relevance: chunk hits collapse to their first-ranked document. recall@5/10/20,
  nDCG@10 and MRR@10, each with a 95% bootstrap confidence interval.
- **Answers** are graded by an LLM judge against the reference answer
  (`lib/judge.js`). A question whose reference says the information is missing
  counts as correct only when the system declines. Also reported: context
  recall (did the relevant documents reach the answer model) and, for sets with
  gold passages, evidence hit (did the passage itself).

## Product-realistic sets

`supavector-one/scripts/build-eval-set.mjs` turns a folder of documents into a
set: files are read through the product's own document reader, and a model
writes visitor-style questions (single, follow-up with history, unanswerable),
each with the verbatim passage that answers it. Pass the resulting `.json` file
as `--dataset`.

## Notes

- Run the gateway on Node 20 or 22. Under Node 26 (undici 8.5) concurrent
  outbound provider calls were observed to serialize in one process, which
  slows indexing many-fold; production images use Node 20.
- Expect run-to-run variation. The question planner and the answer model are
  not deterministic: two runs of the same code flipped about 10% of MultiHop
  answers each way. Treat a difference whose paired interval includes zero as
  no difference, and compare runs made close together.
- Answers are generated by each system's own configured model. Compare systems
  with the same answer model where the system allows choosing it.
