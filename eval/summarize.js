#!/usr/bin/env node
// Print a comparison table of eval results across labels.
//
//   node eval/summarize.js                 # every label under eval/results
//   node eval/summarize.js baseline v2     # just these labels, in this order
//
// One row per dataset × system × label: retrieval metrics where measured,
// answer accuracy (with 95% CI) and latency where measured.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "results");
const wanted = process.argv.slice(2);
const labels = (wanted.length ? wanted : fs.readdirSync(root).filter((d) => !d.startsWith(".") && fs.statSync(path.join(root, d)).isDirectory())).sort((a, b) =>
  wanted.length ? wanted.indexOf(a) - wanted.indexOf(b) : a.localeCompare(b));

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "");
const num = (v) => (Number.isFinite(v) ? v.toFixed(3) : "");
const ci = (pair, f) => (Array.isArray(pair) ? ` (${f(pair[0])}–${f(pair[1])})` : "");
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "");

const rows = [];
for (const label of labels) {
  const dir = path.join(root, label);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const x = r.retrieval || {};
    const a = r.answers || {};
    rows.push({
      dataset: r.dataset,
      system: r.system,
      label,
      "nDCG@10": x["ndcg@10"] !== undefined ? num(x["ndcg@10"]) + ci(x["ndcg@10_ci95"], num) : "",
      "recall@10": num(x["recall@10"]),
      "answer acc": a.accuracy !== undefined ? pct(a.accuracy) + ci(a.accuracy_ci95, pct) : "",
      evidence: pct(a.evidence_hit),
      p50: secs(a.latency_ms_p50 ?? x.latency_ms_p50),
      n: String(a.queries ?? x.queries ?? "")
    });
  }
}
rows.sort((p, q) => p.dataset.localeCompare(q.dataset) || p.system.localeCompare(q.system) || labels.indexOf(p.label) - labels.indexOf(q.label));

const cols = ["dataset", "system", "label", "nDCG@10", "recall@10", "answer acc", "evidence", "p50", "n"];
const out = [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => r[c]).join(" | ")} |`)];
console.log(out.join("\n"));
