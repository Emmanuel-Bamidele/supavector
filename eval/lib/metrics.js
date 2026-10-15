// Retrieval and answer metrics. Retrieval is scored at the DOCUMENT level:
// chunk hits are collapsed to their first-ranked document before scoring,
// which is how every public benchmark (BEIR, MultiHop-RAG) labels relevance.

function dedupeDocs(rankedDocIds) {
  const seen = new Set();
  const out = [];
  for (const id of rankedDocIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** relevance: Map docId -> graded relevance (>0 = relevant). */
function recallAtK(ranked, relevance, k) {
  const relevant = [...relevance.entries()].filter(([, g]) => g > 0).map(([id]) => id);
  if (!relevant.length) return null;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

function ndcgAtK(ranked, relevance, k) {
  const gains = [...relevance.values()].filter((g) => g > 0).sort((a, b) => b - a);
  if (!gains.length) return null;
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    const g = relevance.get(id) || 0;
    if (g > 0) dcg += (2 ** g - 1) / Math.log2(i + 2);
  });
  let idcg = 0;
  gains.slice(0, k).forEach((g, i) => { idcg += (2 ** g - 1) / Math.log2(i + 2); });
  return idcg > 0 ? dcg / idcg : 0;
}

function mrrAtK(ranked, relevance, k) {
  const index = ranked.slice(0, k).findIndex((id) => (relevance.get(id) || 0) > 0);
  return index < 0 ? 0 : 1 / (index + 1);
}

function mean(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function percentile(values, p) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const rank = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return clean[rank];
}

/** 95% bootstrap confidence interval of the mean, deterministic seed. */
function bootstrapCi(values, iterations = 1000) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < clean.length; j += 1) sum += clean[Math.floor(rand() * clean.length)];
    means.push(sum / clean.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iterations)], means[Math.floor(0.975 * iterations)]];
}

function summarizeRetrieval(rows, ks = [5, 10, 20]) {
  const out = { queries: rows.length };
  for (const k of ks) {
    const recalls = rows.map((r) => recallAtK(r.ranked, r.relevance, k));
    out[`recall@${k}`] = mean(recalls);
    out[`recall@${k}_ci95`] = bootstrapCi(recalls);
  }
  const ndcg = rows.map((r) => ndcgAtK(r.ranked, r.relevance, 10));
  out["ndcg@10"] = mean(ndcg);
  out["ndcg@10_ci95"] = bootstrapCi(ndcg);
  out["mrr@10"] = mean(rows.map((r) => mrrAtK(r.ranked, r.relevance, 10)));
  out.latency_ms_p50 = percentile(rows.map((r) => r.latencyMs), 50);
  out.latency_ms_p95 = percentile(rows.map((r) => r.latencyMs), 95);
  out.errors = rows.filter((r) => r.error).length;
  return out;
}

function summarizeAnswers(rows) {
  const correct = rows.map((r) => (r.correct === null ? NaN : r.correct ? 1 : 0));
  const byType = {};
  for (const r of rows) {
    const t = r.type || "all";
    (byType[t] ||= []).push(r.correct === null ? NaN : r.correct ? 1 : 0);
  }
  return {
    queries: rows.length,
    accuracy: mean(correct),
    accuracy_ci95: bootstrapCi(correct),
    accuracy_by_type: Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, { n: v.length, accuracy: mean(v) }])),
    context_recall: mean(rows.map((r) => r.contextRecall)),
    evidence_hit: mean(rows.map((r) => (r.evidenceHit === null ? NaN : r.evidenceHit ? 1 : 0))),
    // Answerable questions only: cites a document holding the answer; share of
    // cited documents that hold it; answers that cite nothing.
    citation_hit: mean(rows.map((r) => (r.citationHit === null || r.citationHit === undefined ? NaN : r.citationHit ? 1 : 0))),
    citation_precision: mean(rows.map((r) => (Number.isFinite(r.citationPrecision) ? r.citationPrecision : NaN))),
    uncited: mean(rows.map((r) => (r.citationHit === null || r.citationHit === undefined ? NaN : r.citationPrecision === null ? 1 : 0))),
    latency_ms_p50: percentile(rows.map((r) => r.latencyMs), 50),
    latency_ms_p95: percentile(rows.map((r) => r.latencyMs), 95),
    errors: rows.filter((r) => r.error).length
  };
}

module.exports = { dedupeDocs, recallAtK, ndcgAtK, mrrAtK, mean, percentile, bootstrapCi, summarizeRetrieval, summarizeAnswers };
