# SupaVector benchmarks

Results from 14–15 October 2026. SupaVector 1.1 was measured against OpenAI file
search and against SupaVector 0.3, the previous release, and also run with
Claude as its answer model. Every system ran through one open harness (`eval/`)
on the same questions with the same metrics. Every answer was graded twice, by
judges from two vendors: OpenAI's `gpt-4o` and Anthropic's `claude-opus-5-5`.
Per-question results for every number here are in
[`eval/published/2026-10-15/`](eval/published/2026-10-15/), and the commands to
reproduce them are at the end.

## Summary

| | SupaVector 1.1 | OpenAI file search | SupaVector 0.3 |
|---|---|---|---|
| BEIR SciFact retrieval, nDCG@10 | **0.758**, 0.799 with reranker | 0.712 | 0.003 |
| MultiHop-RAG retrieval, nDCG@10 | **0.758**, 0.797 with reranker | 0.731 | 0.066 |
| MultiHop-RAG answer accuracy, Claude Opus 5.5 judge | **84.5%** | 77.5% | 41.0% |
| MultiHop-RAG answer accuracy, gpt-4o judge | **82.0%** | 77.5% | 44.5% |
| MultiHop-RAG questions about time order | **54.8%** | 40.5% | 11.9% |
| Answer latency, median / 95th percentile | **4.3 s / 6.7 s** | 6.6 s / 35.5 s | 18.4 s / 29.0 s |

Paired comparisons on the same questions:

- **Retrieval with the reranker beats OpenAI file search on both datasets.** SciFact:
  +0.087 nDCG@10 (95% CI +0.060 to +0.129; better on 76 queries, worse on 33).
  MultiHop-RAG: +0.067 (+0.033 to +0.098; better on 90, worse on 44).
- **The default (no reranker) beats it on SciFact**: +0.046 (+0.020 to +0.079), in
  0.4 s per search against 1.4 s. On MultiHop-RAG it is ahead, +0.028, but the
  interval (−0.004 to +0.060) includes zero.
- **Answers lead under both judges, and the Claude judge's interval excludes
  zero.** Graded by Claude Opus 5.5, SupaVector is 7.0 points ahead (95% CI +1.5
  to +12.0; better on 22 questions, worse on 8). Graded by gpt-4o it is 4.5
  points ahead (−0.5 to +9.5; better on 22, worse on 13). Most of the lead comes
  from questions about time order: +14.3 points under gpt-4o (0.0 to +28.6;
  better on 8, worse on 2).
- **OpenAI file search leads on inference questions**, 98.2% to 96.5% (paired −1.8
  points, −7.0 to +3.5; better on 1, worse on 2).
- **Latency:** median answer time is about a third lower, and the slowest 5% of
  answers come back about five times sooner.
- **Against SupaVector 0.3**, answer accuracy rises 37.5 points under gpt-4o
  (+30.0 to +44.5; better on 83 questions, worse on 8) and 43.5 under Claude Opus
  (+35.0 to +51.0).

## Systems

**SupaVector 1.1**, configured as the Supavector app runs it. Embeddings:
`text-embedding-3-large`. Search runs dense vectors and BM25 keyword search over a
stemmed index and fuses them with reciprocal rank fusion. Chunks follow the
document's headings, and each is indexed with a header (title, date, section) and
a generated line that places it in its document (`gpt-4.1-mini`). Before
searching, a planner (`gpt-4.1-mini`) rewrites follow-ups and splits multi-part
questions into one search per part. Each part keeps its best passage in the
answer context. The answer model (`gpt-5.2`) gets 20 passages, with neighbouring
chunks attached to the top hits: `k: 20`, which is what the Supavector app
requests. The API's default is 7 passages, which scored 79.5% (see "How we got
here"). No reranker. "With reranker" adds a `gpt-4.1-mini`
listwise reranker over the top 40 candidates (`RERANK_PROVIDER=openai`).

**OpenAI file search.** The Responses API with the `file_search` tool over one
vector store, using OpenAI's default chunking and ranking. Each corpus document
was uploaded as one file, and answers used up to 20 results (`max_num_results:
20`). The answer model was `gpt-5.2`, as for SupaVector, with the instruction
"Answer the question using only the attached files. Be concise. If the files do
not contain the answer, say you don't know." Retrieval was measured with the
vector store search endpoint. The adapter is
[`eval/systems/openai_file_search.js`](eval/systems/openai_file_search.js).

**SupaVector 1.1 with Claude Sonnet 5.5.** The same retrieval and passages, with
`claude-sonnet-5-5` writing the answers through the gateway's Anthropic provider
(`provider: "anthropic"` on `/v1/ask`).

**SupaVector 0.3**, the previous release, on the same embedding and answer model.

## Datasets and metrics

- **[BEIR SciFact](https://github.com/beir-cellar/beir):** 5,183 scientific
  abstracts and all 300 test queries. Retrieval only.
- **[MultiHop-RAG](https://github.com/yixuantt/MultiHop-RAG):** 609 news articles
  from 2023 and 200 of its 2,556 questions. The 200 come from a seeded shuffle
  (seed 42) that is identical for every system: 57 inference, 78 comparison, 42
  time-order and 23 unanswerable questions. Most need facts from two to four
  articles.
- **Retrieval:** nDCG@10 and recall@10, scored at the document level as both
  datasets label relevance, so chunk hits collapse to their document. MultiHop-RAG
  retrieval is scored on the 177 questions with labelled evidence.
- **Answers:** graded against the reference answer by two judges, `gpt-4o`
  (temperature 0) and `claude-opus-5-5`. Both use the same prompt for every
  system ([`eval/lib/judge.js`](eval/lib/judge.js)), and both grade the same
  stored answers; nothing is regenerated for the second judge
  ([`eval/rejudge.js`](eval/rejudge.js)).
  An unanswerable question counts as correct only when the system declines.
  "Relevant documents reaching the answer model" is the share of a question's
  evidence documents among the passages the answer model received.
- **Statistics:** 95% bootstrap intervals for single scores. Comparisons are
  paired: a 2,000-resample bootstrap over per-question differences on the same
  questions ([`eval/compare.js`](eval/compare.js)).
- **Latency:** wall-clock time per request, measured by the harness on one
  machine. SupaVector (gateway, Postgres and vector server) ran on that machine
  and called OpenAI's API for embeddings and generation. OpenAI file search ran in
  OpenAI's cloud.

## Retrieval

**BEIR SciFact** (300 queries)

| System | nDCG@10 (95% CI) | recall@10 | Median search time |
|---|---|---|---|
| SupaVector 1.1 with reranker | **0.799** (0.759–0.830) | **0.901** | 2.2 s |
| SupaVector 1.1 | 0.758 (0.711–0.797) | 0.882 | **0.4 s** |
| OpenAI file search | 0.712 (0.659–0.754) | 0.799 | 1.4 s |
| SupaVector 0.3 | 0.003 (0.000–0.010) | 0.003 | 7.5 s |

**MultiHop-RAG** (177 questions with labelled evidence)

| System | nDCG@10 (95% CI) | recall@10 | Median search time |
|---|---|---|---|
| SupaVector 1.1 with reranker | **0.797** (0.768–0.828) | 0.837 | 2.2 s |
| SupaVector 1.1 | 0.758 (0.723–0.793) | **0.840** | **0.5 s** |
| OpenAI file search | 0.731 (0.696–0.767) | 0.798 | 1.5 s |
| SupaVector 0.3 | 0.066 (0.042–0.090) | 0.053 | 6.6 s |

The reranker improves ordering on both datasets: +0.041 nDCG@10 on SciFact
(+0.017 to +0.073) and +0.039 on MultiHop-RAG (+0.011 to +0.065). It barely
changes which documents make the top 10.

## Answers (MultiHop-RAG, 200 questions)

| Question type | n | SupaVector 1.1 | OpenAI file search | SupaVector 0.3 |
|---|---|---|---|---|
| All | 200 | **82.0%** (77.0–87.5) | 77.5% (72.0–82.0) | 44.5% (37.5–51.0) |
| Time order | 42 | **54.8%** | 40.5% | 11.9% |
| Comparison | 78 | **80.8%** | 75.6% | 19.2% |
| Inference | 57 | 96.5% | **98.2%** | 80.7% |
| Unanswerable (must decline) | 23 | 100% | 100% | 100% |
| Relevant documents reaching the answer model | | 85.5% | 87.5% | 14.9% |
| Median / 95th percentile answer time | | **4.3 s / 6.7 s** | 6.6 s / 35.5 s | 18.4 s / 29.0 s |

Both systems got nearly the same share of relevant documents to their answer
model (paired −1.9 points, −4.2 to +0.8). The difference in accuracy comes from
what happens with those documents: combining facts across articles and comparing
their dates.

## Side by side: answer models and judges

MultiHop-RAG, 200 questions. Each cell gives the score from the gpt-4o judge,
then the score from the Claude Opus 5.5 judge.

| | SupaVector 1.1 (gpt-5.2) | SupaVector 1.1 (Claude Sonnet 5.5) | OpenAI file search (gpt-5.2) | SupaVector 0.3 (gpt-5.2) |
|---|---|---|---|---|
| All questions | **82.0% / 84.5%** | 77.5% / 81.0% | 77.5% / 77.5% | 44.5% / 41.0% |
| Time order (42) | 54.8% / 57.1% | **69.0% / 69.0%** | 40.5% / 40.5% | 11.9% / 7.1% |
| Comparison (78) | **80.8% / 84.6%** | 64.1% / 67.9% | 75.6% / 74.4% | 19.2% / 11.5% |
| Inference (57) | 96.5% / 98.2% | 93.0% / **100%** | **98.2% / 100%** | 80.7% / 82.5% |
| Unanswerable (23) | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 100% |
| Judges agree on | 95.5% of answers | 92.5% | 97.0% | 94.5% |
| Relevant documents reaching the answer model | 85.5% | 85.2% | 87.5% | 14.9% |
| Median / 95th percentile answer time | **4.3 s / 6.7 s** | 6.2 s / 11.3 s | 6.6 s / 35.5 s | 18.4 s / 29.0 s |

Paired, against OpenAI file search on the same questions:

| | gpt-4o judge | Claude Opus 5.5 judge |
|---|---|---|
| SupaVector 1.1 (gpt-5.2) | +4.5 points (−0.5 to +9.5) | **+7.0 points (+1.5 to +12.0)** |
| SupaVector 1.1 (Claude Sonnet 5.5) | 0.0 points (−6.0 to +6.5) | +3.5 points (−2.0 to +9.5) |

- **The two judges agree.** Each system's grades from the two judges match on
  92.5–97.0% of answers. Claude Opus grades SupaVector a little higher than
  gpt-4o does (84.5% vs 82.0%), and OpenAI file search exactly the same (77.5%).
  OpenAI's judge does not favour OpenAI's product, and Anthropic's judge does
  not favour Claude's answers over gpt-5.2's.
- **With Claude writing the answers, SupaVector is level with OpenAI file search**
  under gpt-4o and ahead under Claude Opus, though neither interval excludes
  zero. Claude gives the best time-order score of any system (69.0%) and trails
  on comparisons. Asked a two-part yes-or-no question, it answers each part
  separately and holds each to the letter, where the reference expects one
  overall answer. SupaVector's answer rules were tuned with gpt-5.2. With
  gpt-5.2 it scores 4.5 points higher under gpt-4o (−2.0 to +10.5) and 3.5 under
  Claude Opus (−2.0 to +9.5).

## How we got here

Each step was measured on the same questions. Answers are MultiHop-RAG accuracy
(200 questions). "Reaching the model" is the share of relevant documents among
the passages the answer model received.

| Step | Change | SciFact nDCG@10 | MultiHop answers | Reaching the model | Median answer time |
|---|---|---|---|---|---|
| 0 | SupaVector 0.3 | 0.003 | 44.5% | 14.9% | 18.4 s |
| 1 | First retrieval v2: every document searched, BM25 keyword search, structure-aware chunks with context, question planning, LLM reranker, neighbour expansion, numbered citations | 0.762 (reranked) | 79.5% | 77.0% | 5.3 s |
| 2 | Fusion boosts scaled to RRF (unscaled boosts outweighed both rankers) | 0.758, 0.794 reranked | 76.5% | 74.2% | 5.4 s |
| 3 | Reranker keeps slots for the best keyword matches | 0.796 reranked | — | — | — |
| 4 | 12 passages instead of 7 (reranked) | — | 73.5% | 77.4% | 5.5 s |
| 5 | Document dates in chunk headers (42 time-order questions only) | — | 50.0% (was 52.4%) | — | — |
| 6 | Answer rules, first draft: lead with the answer, answer the part the sources cover | — | 76.5% | 70.6% | 6.0 s |
| 7 | Answer rules, final: yes or no only for yes-or-no questions, no hedging on a supported answer; each part of a multi-part question keeps its best passage (reranked, 7 passages) | — | 81.0% | 73.9% | 5.8 s |
| 8 | Reranker off (7 passages) | 0.758 | 79.5% | 73.5% | 4.2 s |
| 9 | **20 passages, reranker off (SupaVector 1.1)** | **0.758** | **82.0%** | **85.5%** | **4.3 s** |

What the steps show:

- **Step 1 is most of the gain.** For each query, SupaVector 0.3 searched recently
  used documents plus about eight random others, not the whole collection. Its
  keyword search also required every word of a question to match. Searching
  everything, with keyword queries natural questions can match, moved SciFact
  from 0.003 to 0.762.
- **Answer accuracy moves less than run-to-run variation between neighbouring
  steps.** Two runs of the same code flip about 10% of answers each way, because
  the planner and the answer model are not deterministic. On 200 questions,
  differences under about 5 points are within that noise. Step 2 (−3.0) and step
  4 (−3.0) are examples. The final rules (step 7) scored +4.5 over the first draft
  (step 6), with a paired interval of +0.0 to +10.5.
- **The reranker didn't earn its cost on answers.** Steps 7 and 8 ran the same
  code at the same time, with the reranker on and off: −1.5 points without it
  (−6.5 to +4.5), the same evidence reaching the model, and 1.6 s faster.
- **More passages closed the evidence gap with OpenAI file search.** Going from 7
  to 20 passages (step 8 to step 9) raised relevant documents reaching the model
  by 12.0 points (+9.6 to +14.6; better on 56 questions, worse on none). Answers
  rose 2.5 points (−3.0 to +7.5) at the same latency. The cost is about 1.8× the
  answer model's input tokens: about 8.6k instead of 4.7k per answer.

## Ablations

**Fusion boost scale** (no reranker). The overlap and exact-match boosts are
added to reciprocal-rank scores. At scale 61 they are unscaled, as in SupaVector
0.3, and they outweigh both rankers on SciFact's semantic queries.

| Boost scale | 1 (default) | 4 | 12 | 30 | 61 (unscaled) |
|---|---|---|---|---|---|
| SciFact nDCG@10 | **0.758** | 0.741 | 0.716 | 0.674 | 0.641 |
| MultiHop-RAG nDCG@10 | 0.760 | **0.771** | 0.766 | 0.756 | 0.745 |

With the reranker, scale 4 scored 0.794 on SciFact and 0.782 on MultiHop-RAG.
Scale 1 with keyword slots for the reranker scored 0.796 and 0.800, so it is the
default.

**Retrieval legs on SciFact** (no reranker): dense only 0.768, hybrid without
boosts 0.765, hybrid with scaled boosts 0.758. The intervals overlap. SciFact's
queries are semantic, so keyword search adds little there. It is kept for the
exact names, numbers and identifiers people search their own documents for.
Dense-only search has not been measured on MultiHop-RAG.

## Product sets

Seven Supavector AIs, each answering 30 questions written from its own
documents: single questions, follow-ups that depend on the conversation, and
questions their documents can't answer. These sets are internal and not
published. They were measured on a development build (LLM reranker, 7
passages, earlier answer rules).

| AI | SupaVector 0.3 | SupaVector 1.1 (development build) |
|---|---|---|
| Bedtime Storyteller | 73.3% | 76.7% |
| Buy or Pass | 96.7% | 96.7% |
| Drive Buddy | 76.7% | 93.3% |
| Game Night Host | 63.3% | 76.7% |
| New Job Coach | 90.0% | 96.7% |
| Plant Pal | 76.7% | 96.7% |
| Study Buddy | 80.0% | 90.0% |
| **All 210 questions** | **79.5%** | **89.5%** |
| Follow-up questions (42) | 64.3% | 95.2% |
| Gold passage reaching the answer model, per AI | 44–96% | 81–100% |
| Median answer time, per AI | 12–28 s | 4–5 s |

## Limitations

- **One external system so far.** OpenAI file search is the only other system
  measured. We'll add others through the same harness. This report makes no
  claim about systems it hasn't run.
- **Sample size.** MultiHop-RAG answers use 200 of 2,556 questions. The answer
  lead over OpenAI file search is positive under both judges, but its interval
  excludes zero only under Claude Opus. The full question set would settle it.
- **Tuned on these sets.** SupaVector's fusion scale, passage count and answer
  rules were chosen from runs on SciFact and MultiHop-RAG, while OpenAI file
  search ran at its defaults. The product sets are an independent check on the
  pipeline, though not on the final settings.
- **LLM judges.** Answers were graded by `gpt-4o` and by `claude-opus-5-5`, with
  the same prompt for every system. The two agree on 92.5–97.0% of answers, but
  judges make mistakes. Some MultiHop-RAG labels are also noisy: for example,
  articles marked as evidence that don't bear on the question, and comparison
  references that a careful reading of the articles disputes.
- **The Claude answer run was completed in two parts.** The Anthropic account ran
  out of credit after 129 questions. The other 71 were asked again once credit
  was restored. Failed calls were retried, never scored.
- **One machine.** Latency was measured from a single machine. SupaVector ran
  locally and OpenAI file search ran in OpenAI's cloud; both used OpenAI's API
  for model calls.

## Reproduce

```bash
export SUPAVECTOR_BASE_URL=http://localhost:3000 SUPAVECTOR_API_KEY=<service token> OPENAI_API_KEY=<key>

# Retrieval
node eval/run.js --dataset beir:scifact --system supavector --mode retrieval --label mine
node eval/run.js --dataset multihop-rag --system supavector --mode retrieval --limit 200 --label mine
node eval/run.js --dataset beir:scifact --system openai-file-search --mode retrieval --label mine

# Answers: the same 200 MultiHop-RAG questions for every system
node eval/run.js --dataset multihop-rag --system supavector --mode answer --limit 200 --answer-k 20 --citation-mode numbered --label mine
node eval/run.js --dataset multihop-rag --system openai-file-search --mode both --limit 200 --label mine

# SupaVector with Claude writing the answers (gateway needs ANTHROPIC_API_KEY)
node eval/run.js --dataset multihop-rag --system supavector --mode answer --limit 200 --answer-k 20 --provider anthropic --model claude-sonnet-5-5 --citation-mode numbered --label mine-claude

# Grade finished runs again with the second judge (ANTHROPIC_API_KEY)
node eval/rejudge.js --judge-model claude-opus-5-5 --label mine-judge-claude eval/results/mine/*answer*.json

# Paired comparison, from your runs or from the published files
node eval/compare.js --answers \
  eval/published/2026-10-15/headline/multihop-rag-answers--supavector-v2.json \
  eval/published/2026-10-15/headline/multihop-rag--openai-file-search.json
```

Datasets download on first use. The harness is documented in
[`eval/README.md`](eval/README.md). Run the gateway on Node 20 or 22, the version
production images use.

## Published results

[`eval/published/2026-10-15/`](eval/published/2026-10-15/) holds one file per
run: the summary plus per-question scores. Retrieval files hold ranked document
ids, relevant ids and latency. Answer files hold question type, judged
correctness, context recall and latency. They contain no question or answer
text; the ids join back to the public datasets.

- `headline/`: the runs in the Summary, Retrieval and Answers sections. In file
  names, `supavector-v2` is SupaVector 1.1 and `supavector-0.3` is the previous
  release.
- `judge-claude-opus-5-5/`: the headline answer runs graded by Claude Opus 5.5.
  `supavector-v2-claude-sonnet-5-5` is SupaVector 1.1 with Claude writing the
  answers.
- `history/`: the earlier steps in "How we got here", numbered to match.
- `ablations/`: the boost-scale sweep and the retrieval-leg comparison.
