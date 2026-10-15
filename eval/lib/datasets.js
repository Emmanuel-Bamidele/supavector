// Dataset loaders. Every loader returns the same shape:
//   { name, docs: [{docId, title, text, sourceId}], queries: [{id, text, relevance: Map,
//     answer?, type?, history?}] }
// Downloads land in the data dir (default ~/.cache/supavector-eval); they are
// third-party data and are only ever parsed as JSON/TSV, never executed.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BEIR_BASE = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets";
const MULTIHOP_BASE = "https://huggingface.co/datasets/yixuantt/MultiHopRAG/resolve/main";
const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
// LoCoMo question categories as the paper defines them. Category 5 is
// adversarial and, as in most published memory comparisons, excluded by default.
const LOCOMO_CATEGORIES = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
const DOC_ID_RE = /^[a-zA-Z0-9._-]+$/;

function dataDir(explicit) {
  return explicit || process.env.SUPAVECTOR_EVAL_DATA || path.join(os.homedir(), ".cache", "supavector-eval");
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
  return dest;
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Gateway docIds allow [a-zA-Z0-9._-]; map anything else and fail on collisions. */
function makeDocIdMapper(prefix) {
  const used = new Map();
  return (sourceId) => {
    const raw = String(sourceId);
    const clean = `${prefix}${raw}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
    if (!DOC_ID_RE.test(clean)) throw new Error(`cannot map doc id ${raw}`);
    const prior = used.get(clean);
    if (prior !== undefined && prior !== raw) throw new Error(`doc id collision: ${raw} vs ${prior}`);
    used.set(clean, raw);
    return clean;
  };
}

async function loadBeir(name, { dir, split = "test" } = {}) {
  const root = path.join(dataDir(dir), "beir");
  const zip = await download(`${BEIR_BASE}/${name}.zip`, path.join(root, `${name}.zip`));
  const folder = path.join(root, name);
  if (!fs.existsSync(path.join(folder, "corpus.jsonl"))) {
    execFileSync("unzip", ["-q", "-o", zip, "-d", root]);
  }
  const toDocId = makeDocIdMapper("");
  const docs = readJsonl(path.join(folder, "corpus.jsonl")).map((d) => ({
    docId: toDocId(d._id),
    sourceId: String(d._id),
    title: String(d.title || "").trim(),
    text: [d.title, d.text].filter(Boolean).join("\n\n")
  })).filter((d) => d.text.trim());
  const byId = new Map(docs.map((d) => [d.sourceId, d.docId]));
  const qrels = new Map();
  const lines = fs.readFileSync(path.join(folder, "qrels", `${split}.tsv`), "utf8").split("\n").slice(1);
  for (const line of lines) {
    const [qid, cid, score] = line.split("\t");
    if (!qid || !cid || !byId.has(cid)) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(byId.get(cid), Number(score) || 0);
  }
  const queries = readJsonl(path.join(folder, "queries.jsonl"))
    .filter((q) => qrels.has(String(q._id)))
    .map((q) => ({ id: String(q._id), text: String(q.text), relevance: qrels.get(String(q._id)) }));
  return { name: `beir-${name}`, docs, queries };
}

async function loadMultiHopRag({ dir } = {}) {
  const root = path.join(dataDir(dir), "multihop-rag");
  const corpus = JSON.parse(fs.readFileSync(await download(`${MULTIHOP_BASE}/corpus.json`, path.join(root, "corpus.json")), "utf8"));
  const raw = JSON.parse(fs.readFileSync(await download(`${MULTIHOP_BASE}/MultiHopRAG.json`, path.join(root, "MultiHopRAG.json")), "utf8"));
  const docs = corpus.map((d, i) => ({
    docId: `mh-${i}`,
    sourceId: d.url || d.title,
    title: String(d.title || "").trim(),
    text: [d.title, d.published_at ? `Published: ${d.published_at}` : "", d.source ? `Source: ${d.source}` : "", d.body].filter(Boolean).join("\n\n")
  }));
  const byUrl = new Map(corpus.map((d, i) => [d.url, `mh-${i}`]));
  const byTitle = new Map(corpus.map((d, i) => [String(d.title || "").trim(), `mh-${i}`]));
  const queries = raw.map((q, i) => {
    const relevance = new Map();
    for (const ev of q.evidence_list || []) {
      const id = byUrl.get(ev.url) || byTitle.get(String(ev.title || "").trim());
      if (id) relevance.set(id, 1);
    }
    return { id: `mh-q${i}`, text: q.query, answer: q.answer, type: q.question_type, relevance };
  });
  return { name: "multihop-rag", docs, queries };
}

/**
 * LoCoMo: 10 long two-person conversations. Each session becomes a document
 * that carries its date (temporal questions depend on it); each question is
 * scoped to its own conversation through `docIds`.
 */
async function loadLocomo({ dir, includeAdversarial = false } = {}) {
  const root = path.join(dataDir(dir), "locomo");
  const samples = JSON.parse(fs.readFileSync(await download(LOCOMO_URL, path.join(root, "locomo10.json")), "utf8"));
  const docs = [];
  const queries = [];
  for (const sample of samples) {
    const c = sample.conversation;
    const sampleId = String(sample.sample_id).replace(/[^a-zA-Z0-9._-]/g, "_");
    const sessionDocIds = [];
    for (let n = 1; c[`session_${n}`]; n += 1) {
      const turns = c[`session_${n}`].map((t) => `${t.speaker}: ${t.text}${t.blip_caption ? ` [shares an image: ${t.blip_caption}]` : ""}`);
      const docId = `locomo-${sampleId}-s${n}`;
      sessionDocIds.push(docId);
      docs.push({
        docId,
        sourceId: `${sample.sample_id}:${n}`,
        title: `${c.speaker_a} and ${c.speaker_b}, session ${n} (${c[`session_${n}_date_time`]})`,
        text: `Conversation between ${c.speaker_a} and ${c.speaker_b}. Session ${n}, ${c[`session_${n}_date_time`]}.\n\n${turns.join("\n")}`
      });
    }
    sample.qa.forEach((qa, i) => {
      if (qa.category === 5 && !includeAdversarial) return;
      const relevance = new Map();
      for (const ev of qa.evidence || []) {
        const m = String(ev).match(/^D(\d+):/);
        if (m) relevance.set(`locomo-${sampleId}-s${m[1]}`, 1);
      }
      queries.push({
        id: `${sampleId}-q${i}`,
        text: qa.question,
        answer: qa.category === 5 ? "Insufficient information: the conversation does not say." : String(qa.answer),
        type: LOCOMO_CATEGORIES[qa.category] || `cat${qa.category}`,
        relevance,
        docIds: sessionDocIds
      });
    });
  }
  return { name: "locomo", docs, queries };
}

/**
 * A JSON file of {docs, queries} written by the product-set generator. An
 * optional set-level `persona` is the voice the product answers in for that
 * AI; it rides on every question so the eval asks what the product asks.
 */
function loadJsonSet(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    name: raw.name || path.basename(file, ".json"),
    docs: raw.docs,
    queries: raw.queries.map((q) => ({
      ...q,
      persona: q.persona ?? raw.persona,
      relevance: new Map(Object.entries(q.relevance || {}))
    }))
  };
}

async function loadDataset(spec, opts = {}) {
  if (spec.startsWith("beir:")) return loadBeir(spec.slice(5), opts);
  if (spec === "multihop-rag") return loadMultiHopRag(opts);
  if (spec === "locomo") return loadLocomo(opts);
  if (spec.endsWith(".json")) return loadJsonSet(spec);
  throw new Error(`unknown dataset ${spec} (use beir:<name>, multihop-rag, or a .json set)`);
}

module.exports = { loadDataset, dataDir, download };
