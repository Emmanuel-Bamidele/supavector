#!/usr/bin/env node
// Export runs for publication: summaries plus per-query scores, no text.
//
//   node eval/publish.js --out eval/published/2026-10-15 \
//     openai-file-search.multihop=results/competitors/multihop-rag--openai-file-search--both.json ...
//
// Each output keeps only what the published numbers are computed from:
// retrieval rows (query id, ranked doc ids, relevant ids, latency) and answer
// rows (query id, type, judged correct, abstained, context recall, latency).
// Question, reference and answer text stay out; the datasets are public, so
// the ids join back to them. The files keep run.js's row fields, so
// `node eval/compare.js` runs on them directly.

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const outDir = outAt >= 0 ? argv[outAt + 1] : null;
const pairs = argv.filter((a, i) => i !== outAt && i !== outAt + 1 && a.includes("="));
if (!outDir || !pairs.length) {
  console.error("usage: node eval/publish.js --out <dir> <name>=<run.json> [...]");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

for (const pair of pairs) {
  const [name, file] = pair.split("=");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = {
    name,
    label: run.label,
    dataset: run.dataset,
    system: run.system,
    mode: run.mode,
    docs: run.docs,
    judgeModel: run.judgeModel || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    mergedFrom: run.mergedFrom || undefined,
    retrieval: run.retrieval || undefined,
    answers: run.answers || undefined,
    retrievalRows: run.retrievalRows
      ? run.retrievalRows.map(({ id, top, relevant, latencyMs, error }) => ({ id, top, relevant, latencyMs, error: error || undefined }))
      : undefined,
    answerRows: run.answerRows
      ? run.answerRows.map(({ id, type, correct, abstained, contextRecall, latencyMs, error }) => ({ id, type, correct, abstained, contextRecall, latencyMs, error: error || undefined }))
      : undefined
  };
  const target = path.join(outDir, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify(out));
  console.log(`${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
}
