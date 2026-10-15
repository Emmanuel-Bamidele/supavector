#!/usr/bin/env node
// SupaVector eval runner.
//
//   node eval/run.js --dataset beir:scifact --system supavector --mode retrieval --label baseline
//   node eval/run.js --dataset multihop-rag --system openai-file-search --mode answer --limit 200
//
// Every system sees the same deterministic query sample, the same judge and
// the same metrics; results land in eval/results/<label>/ as JSON.

const fs = require("fs");
const path = require("path");
const { loadDataset } = require("./lib/datasets");
const { mapLimit } = require("./lib/http");
const { dedupeDocs, summarizeRetrieval, summarizeAnswers } = require("./lib/metrics");
const { createJudge } = require("./lib/judge");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key.slice(2)] = true;
    else { out[key.slice(2)] = next; i += 1; }
  }
  return out;
}

function seededSample(items, limit, seed = 42) {
  if (!limit || limit >= items.length) return items;
  const copy = items.slice();
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

function buildSystem(name, args, dataset) {
  const collection = String(args.collection || `eval-${dataset.name}`).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (name === "supavector") {
    const { createSupavectorSystem } = require("./systems/supavector");
    return createSupavectorSystem({
      baseUrl: args["base-url"] || process.env.SUPAVECTOR_BASE_URL || "http://localhost:3000",
      token: args.token || process.env.SUPAVECTOR_API_KEY,
      collection,
      answerK: args["answer-k"] ? Number(args["answer-k"]) : undefined,
      provider: args.provider,
      model: args.model,
      citationMode: args["citation-mode"] || "metadata",
      rerank: String(args.rerank ?? "1") !== "0"
    });
  }
  if (name === "openai-file-search") {
    const { createOpenAiFileSearchSystem } = require("./systems/openai_file_search");
    return createOpenAiFileSearchSystem({ name: collection, model: args.model, stateDir: path.join(__dirname, "results", ".state") });
  }
  if (name === "gemini-file-search") {
    const { createGeminiFileSearchSystem } = require("./systems/gemini_file_search");
    return createGeminiFileSearchSystem({ name: collection, model: args.model, stateDir: path.join(__dirname, "results", ".state") });
  }
  throw new Error(`unknown system ${name}`);
}

async function runRetrieval(system, queries, { concurrency, k }) {
  return mapLimit(queries, concurrency, async (q) => {
    const started = Date.now();
    try {
      const hits = await system.retrieve(q, { limit: Math.max(k, 20) });
      return { id: q.id, ranked: dedupeDocs(hits.map((h) => h.docId)), relevance: q.relevance, latencyMs: Date.now() - started };
    } catch (err) {
      return { id: q.id, ranked: [], relevance: q.relevance, latencyMs: Date.now() - started, error: String(err.message || err) };
    }
  });
}

// Answer runs cost money per question, so each graded row is appended to a
// checkpoint as it lands and an interrupted run resumes from it.
function loadCheckpoint(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return new Map(rows.filter((r) => !r.error).map((r) => [r.id, r]));
}

async function runAnswers(system, queries, { concurrency, judge, checkpoint, log, docTexts = new Map() }) {
  const done = loadCheckpoint(checkpoint);
  if (done.size) log(`resuming: ${done.size} answers already graded in ${path.basename(checkpoint)}`);
  return mapLimit(queries, concurrency, async (q) => {
    if (done.has(q.id)) return done.get(q.id);
    const row = await answerOne(system, q, judge, docTexts);
    if (checkpoint) fs.appendFileSync(checkpoint, `${JSON.stringify(row)}\n`);
    return row;
  });
}

// Citation accuracy at the document level, the one level every system's
// citations share: does the answer cite a document holding the answer (the
// gold passage, or a labelled evidence document), and what share of the
// documents it cites do?
function scoreCitations(q, citations, docTexts) {
  if (q.answer === undefined || /insufficient information/i.test(String(q.answer))) return { citationHit: null, citationPrecision: null };
  const cited = [...new Set((citations || []).map((c) => c?.docId).filter(Boolean))];
  if (!cited.length) return { citationHit: false, citationPrecision: null };
  const holds = (docId) => (q.quote ? evidenceHit(q.quote, [{ text: docTexts.get(docId) || "" }]) : q.relevance.has(docId));
  const good = cited.filter(holds).length;
  return { citationHit: good > 0, citationPrecision: good / cited.length };
}

async function answerOne(system, q, judge, docTexts = new Map()) {
  const started = Date.now();
  let answer = { text: "", citations: [], contexts: [] };
  let error = null;
  try { answer = await system.answer(q); } catch (err) { error = String(err.message || err); }
  const latencyMs = Date.now() - started;
  const grade = q.answer !== undefined && judge
    ? await judge.grade({ question: q.text, reference: String(q.answer), candidate: answer.text }).catch((err) => ({ correct: false, reason: `judge error: ${err.message}` }))
    : null;
  const relevant = [...q.relevance.keys()];
  const contextDocs = new Set((answer.contexts || []).map((c) => c.docId).filter(Boolean));
  return {
    id: q.id,
    type: q.type || null,
    question: q.text,
    reference: q.answer ?? null,
    answer: answer.text,
    retrievalQuery: answer.retrievalQuery || null,
    correct: grade ? grade.correct : null,
    abstained: grade ? grade.abstained : null,
    judgeReason: grade ? grade.reason : null,
    contextRecall: relevant.length ? relevant.filter((id) => contextDocs.has(id)).length / relevant.length : null,
    evidenceHit: q.quote ? evidenceHit(q.quote, answer.contexts) : null,
    citations: answer.citations,
    ...scoreCitations(q, answer.citations, docTexts),
    latencyMs,
    error
  };
}

const normWords = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Did the passages given to the answer model contain the gold evidence? */
function evidenceHit(quote, contexts) {
  const target = normWords(quote);
  if (!target) return null;
  const words = [...new Set(target.split(" ").filter((w) => w.length >= 4))];
  return (contexts || []).some((c) => {
    const text = normWords(c.text);
    if (text.includes(target)) return true;
    if (!words.length) return false;
    return words.filter((w) => text.includes(w)).length / words.length >= 0.8;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset) throw new Error("--dataset is required");
  const mode = args.mode || "retrieval";
  const k = Number(args.k || 10);
  const concurrency = Number(args.concurrency || 6);
  const label = String(args.label || "run");
  const log = (msg) => console.error(`[eval] ${msg}`);

  const dataset = await loadDataset(String(args.dataset), { dir: args["data-dir"] });
  // --types narrows the SAME seeded sample to some question types (cheap iteration).
  const types = args.types ? new Set(String(args.types).split(",")) : null;
  const queries = seededSample(dataset.queries.filter((q) => q.relevance.size || q.answer !== undefined), Number(args.limit || 0))
    .filter((q) => !types || types.has(q.type));
  log(`${dataset.name}: ${dataset.docs.length} docs, ${queries.length} queries (mode=${mode})`);

  const system = buildSystem(String(args.system || "supavector"), args, dataset);
  const t0 = Date.now();
  await system.prepare(dataset.docs, { reindex: Boolean(args.reindex), log });
  log(`prepared ${system.name} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const outDir = path.join(args.out || path.join(__dirname, "results"), label);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${dataset.name}--${system.name}--${mode}.json`);
  // A reindex or --fresh changes what earlier answers were measured against.
  const checkpoint = `${outFile}.partial.jsonl`;
  if ((args.reindex || args.fresh) && fs.existsSync(checkpoint)) fs.unlinkSync(checkpoint);

  const result = { label, dataset: dataset.name, system: system.name, mode, k, docs: dataset.docs.length, startedAt: new Date().toISOString() };
  if (mode === "retrieval" || mode === "both") {
    const rows = await runRetrieval(system, queries, { concurrency, k });
    result.retrieval = summarizeRetrieval(rows);
    result.retrievalRows = rows.map((r) => ({ id: r.id, top: r.ranked.slice(0, 20), relevant: [...r.relevance.keys()], latencyMs: r.latencyMs, error: r.error }));
  }
  if (mode === "answer" || mode === "both") {
    // "none" skips grading: context recall alone, e.g. with a cheap --model.
    const judge = args["judge-model"] === "none" ? null : createJudge({ model: args["judge-model"] });
    result.judgeModel = judge ? judge.model : "none";
    const docTexts = new Map(dataset.docs.map((d) => [d.docId, d.text]));
    const rows = await runAnswers(system, queries, { concurrency: Math.min(concurrency, 4), judge, checkpoint, log, docTexts });
    result.answers = summarizeAnswers(rows);
    result.answerRows = rows;
  }
  result.finishedAt = new Date().toISOString();

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  if (fs.existsSync(checkpoint)) fs.unlinkSync(checkpoint);
  console.log(JSON.stringify({ file: outFile, retrieval: result.retrieval, answers: result.answers }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
