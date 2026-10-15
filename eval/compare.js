#!/usr/bin/env node
// Paired comparison of two runs on the same queries.
//
//   node eval/compare.js [--answers|--context] results/v2/beir-scifact--supavector--retrieval.json \
//                        results/competitors/beir-scifact--openai-file-search--retrieval.json
//
// Per query, A minus B: nDCG@10 for retrieval runs, correctness for answer
// runs, or with --context the share of relevant documents that reached the
// answer model. Reports the mean difference with a 95% paired bootstrap interval and
// how many queries each side won. An interval that excludes zero is a
// difference the query sample supports, not noise.

const fs = require("fs");
const { ndcgAtK } = require("./lib/metrics");

const args = process.argv.slice(2);
const metricFlag = args.includes("--answers") ? "answers" : args.includes("--context") ? "context" : null;
const [fileA, fileB] = args.filter((a) => !a.startsWith("--"));
if (!fileA || !fileB) {
  console.error("usage: node eval/compare.js <runA.json> <runB.json>");
  process.exit(1);
}
const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const a = load(fileA);
const b = load(fileB);

function perQuery(run) {
  if (metricFlag === "context") {
    return { metric: "context recall", values: new Map((run.answerRows || []).filter((r) => r.contextRecall !== null).map((r) => [r.id, r.contextRecall])) };
  }
  if (run.retrievalRows && metricFlag !== "answers") {
    return { metric: "nDCG@10", values: new Map(run.retrievalRows.map((r) => [r.id, ndcgAtK(r.top, new Map(r.relevant.map((d) => [d, 1])), 10)])) };
  }
  return { metric: "accuracy", values: new Map((run.answerRows || []).filter((r) => r.correct !== null).map((r) => [r.id, r.correct ? 1 : 0])) };
}

const pa = perQuery(a);
const pb = perQuery(b);
const ids = [...pa.values.keys()].filter((id) => pb.values.has(id) && pa.values.get(id) !== null && pb.values.get(id) !== null);
const diffs = ids.map((id) => pa.values.get(id) - pb.values.get(id));
const mean = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const means = [];
for (let i = 0; i < 2000; i += 1) {
  let sum = 0;
  for (let j = 0; j < diffs.length; j += 1) sum += diffs[Math.floor(rand() * diffs.length)];
  means.push(sum / diffs.length);
}
means.sort((x, y) => x - y);
const sign = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
const better = diffs.filter((d) => d > 1e-9).length;
const worse = diffs.filter((d) => d < -1e-9).length;

console.log(`${a.system} (${a.label}) − ${b.system} (${b.label}) on ${a.dataset}, ${pa.metric}:`);
console.log(`  mean difference ${sign(mean)} (95% paired bootstrap ${sign(means[50])} to ${sign(means[1949])}), n=${diffs.length}`);
console.log(`  A better on ${better}, worse on ${worse}, tied on ${diffs.length - better - worse}`);
