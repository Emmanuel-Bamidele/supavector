#!/usr/bin/env node
// Merge answer runs over disjoint parts of the same query sample into one.
//
//   node eval/merge.js --label v2-direct-all results/v2-direct/multihop-rag--supavector--answer.json \
//                      results/v2-direct-inf/multihop-rag--supavector--answer.json
//
// Lets a change be checked on the question types it targets (run.js --types)
// and then completed with the remaining types, without paying for the
// targeted questions twice. Inputs must share dataset and system; a query
// that appears in more than one input is an error.

const fs = require("fs");
const path = require("path");
const { summarizeAnswers } = require("./lib/metrics");

const argv = process.argv.slice(2);
const labelAt = argv.indexOf("--label");
const label = labelAt >= 0 ? argv[labelAt + 1] : null;
const files = argv.filter((a, i) => !a.startsWith("--") && i !== labelAt + 1);
if (!label || files.length < 2) {
  console.error("usage: node eval/merge.js --label <out-label> <run.json> <run.json> [...]");
  process.exit(1);
}

const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const { dataset, system } = runs[0];
if (runs.some((r) => r.dataset !== dataset || r.system !== system || !Array.isArray(r.answerRows))) {
  throw new Error("inputs must be answer runs of the same dataset and system");
}
const rows = [];
const seen = new Set();
for (const row of runs.flatMap((r) => r.answerRows)) {
  if (seen.has(row.id)) throw new Error(`query ${row.id} appears in more than one input`);
  seen.add(row.id);
  rows.push(row);
}

const result = {
  label,
  dataset,
  system,
  mode: "answer",
  k: runs[0].k,
  docs: runs[0].docs,
  judgeModel: runs[0].judgeModel,
  mergedFrom: runs.map((r) => r.label),
  answers: summarizeAnswers(rows),
  answerRows: rows
};
const outDir = path.join(__dirname, "results", label);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${dataset}--${system}--answer.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ file: outFile, answers: result.answers }, null, 2));
