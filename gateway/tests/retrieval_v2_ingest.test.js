// Retrieval v2 ingestion and assembly: structure-aware chunks, whole-text
// rebuild, neighbour expansion, chunk-context fallback, re-ingestion and the
// planner's no-call path. No services or model calls.

process.env.CHUNK_CONTEXT_ENABLED = "0";

const assert = require("assert/strict");
const { chunkStructured, detectHeading, wordCount } = require("../chunk_structured");
const { chunkText } = require("../chunk");
const { joinChunkTexts } = require("../doc_text");
const { expandWithNeighbors, withPartCoverage } = require("../answer_context");
const { buildChunkContexts, headerFor } = require("../chunk_context");
const { createReingestJob } = require("../reingest");
const { planRetrieval, planFollowupSearches, looksMultiPart } = require("../query_rewrite");

const POLICY = `# Refund Policy

Refunds are issued within 14 days of purchase.

## Exceptions

Gift cards cannot be refunded.

WARRANTY

Every device carries a two year warranty.`;

function testHeadingsBecomeSectionPaths() {
  const chunks = chunkStructured(POLICY, { maxWords: 300 });
  assert.deepEqual(chunks.map((c) => c.heading), [
    "Refund Policy",
    "Refund Policy › Exceptions",
    "Refund Policy › WARRANTY"
  ]);
  assert.equal(detectHeading("1.2 Claims Process", true, true).level, 3);
  assert.equal(detectHeading("This is a normal sentence that ends with a period.", true, true), null);
}

function testChunksNeverOverlapAndRebuildExactly() {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} explains step ${i} of the setup in plain words.`).join("\n\n");
  const chunks = chunkStructured(`# Guide\n\n${long}`, { maxWords: 60 });
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => wordCount(c.text) <= 60 * 1.25));
  const rebuilt = joinChunkTexts(chunks.map((c) => c.text));
  assert.equal(rebuilt, `# Guide\n\n${long}`);
}

function testTinyTrailingPieceFoldsIntoItsSection() {
  const text = `# A\n\n${"word ".repeat(70).trim()}\n\nTiny tail.`;
  const chunks = chunkStructured(text, { maxWords: 80, minWords: 20 });
  assert.equal(chunks.length, 1);
}

function testChunkTextStructuredCarriesHeadingAndIds() {
  const chunks = chunkText("t::c::policy", POLICY, { strategy: "structured", maxWords: 300 });
  assert.equal(chunks[0].chunkId, "t::c::policy#0");
  assert.equal(chunks[1].heading, "Refund Policy › Exceptions");
}

function testJoinDropsLegacyTokenOverlap() {
  const words = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  const windows = chunkText("d", words, { strategy: "token", maxTokens: 120, overlapTokens: 30 }).map((c) => c.text);
  assert.ok(windows.length > 3);
  assert.equal(joinChunkTexts(windows), words);
}

async function testNeighbourExpansionAbsorbsAdjacentHits() {
  const store = new Map([
    ["t::c::d#0", { chunk_id: "t::c::d#0", text: "A0" }],
    ["t::c::d#4", { chunk_id: "t::c::d#4", text: "A4" }]
  ]);
  const hits = [
    { chunk_id: "t::c::d#1", text: "A1" },
    { chunk_id: "t::c::d#3", text: "A3" },
    { chunk_id: "t::c::d#2", text: "A2" }
  ];
  const out = await expandWithNeighbors(hits, async (ids) => new Map(ids.filter((id) => store.has(id)).map((id) => [id, store.get(id)])));
  assert.deepEqual(out.map((c) => c.chunk_id), ["t::c::d#1", "t::c::d#3"]);
  assert.equal(out[0].text, "A0\n\nA1\n\nA2");
  assert.equal(out[1].text, "A3\n\nA4");
}

async function testContextFallsBackToHeadersWithoutAModel() {
  const { contexts, usage, generated } = await buildChunkContexts({
    title: "Refunds.pdf",
    text: POLICY,
    chunks: [{ text: "x", heading: "Refund Policy › Exceptions" }, { text: "y" }]
  });
  assert.equal(generated, 0);
  assert.equal(usage, null);
  assert.equal(contexts[0], "Document: Refunds.pdf\nSection: Refund Policy › Exceptions");
  assert.equal(contexts[1], headerFor("Refunds.pdf", null));
}

async function testReingestUsesStoredTextElseRebuildsAndCountsFailures() {
  const items = [
    { id: 1, namespace_id: "t::c::a", tenant_id: "t", collection: "c", external_id: "a", title: "A" },
    { id: 2, namespace_id: "t::c::b", tenant_id: "t", collection: "c", external_id: "b", title: "B" },
    { id: 3, namespace_id: "t::c::empty", tenant_id: "t", collection: "c", external_id: "empty" }
  ];
  const indexed = [];
  const job = createReingestJob({
    listArtifacts: async ({ afterId }) => (afterId ? [] : items),
    getDocExports: async ([ns]) => new Map([[ns, { text: ns === "t::c::a" ? "Stored original text." : null }]]),
    getChunksByDocId: async (ns) => (ns === "t::c::b" ? [{ text: "Rebuilt one." }, { text: "Rebuilt two." }] : []),
    indexDocument: async (tenant, collection, docId, text, source) => { indexed.push({ docId, text, title: source.title }); },
    log: () => {}
  });
  job.start({ concurrency: 1 });
  for (let i = 0; i < 50 && job.status().running; i += 1) await new Promise((r) => setTimeout(r, 10));
  const status = job.status();
  assert.equal(status.running, false);
  assert.equal(status.done, 2);
  assert.equal(status.failed, 1);
  assert.match(status.lastError, /empty: no text/);
  assert.deepEqual(indexed, [
    { docId: "a", text: "Stored original text.", title: "A" },
    { docId: "b", text: "Rebuilt one.\n\nRebuilt two.", title: "B" }
  ]);
}

async function testPlannerSkipsTheModelForSimpleQuestions() {
  assert.equal(looksMultiPart("How do refunds work?"), false);
  assert.equal(looksMultiPart("Did the Guardian report the merger before TechCrunch covered the funding round?"), true);
  const started = Date.now();
  const plan = await planRetrieval({ question: "How do refunds work?" });
  assert.deepEqual(plan, { query: "How do refunds work?", subqueries: [], rewritten: false, usage: null });
  assert.ok(Date.now() - started < 50, "no model call for a simple, history-free question");
}

function testEveryPartKeepsItsBestPassage() {
  const idOf = (r) => r.id;
  const chosen = [{ id: "nike#1" }, { id: "nike#2" }, { id: "nike#3" }];
  const parts = [[{ id: "nike#2" }, { id: "nike#9" }], [{ id: "homes#0" }, { id: "nike#1" }], []];
  assert.deepEqual(withPartCoverage(chosen, parts, idOf).map(idOf), ["nike#1", "nike#2", "nike#3", "homes#0"]);
  assert.deepEqual(withPartCoverage(chosen, [[{ id: "nike#3" }]], idOf).map(idOf), ["nike#1", "nike#2", "nike#3"]);
}

async function testFollowupRoundIsOffByDefaultAndNeedsSeveralParts() {
  const started = Date.now();
  const off = await planFollowupSearches({ question: "Did A and B agree?", parts: ["A", "B"], found: [] });
  assert.deepEqual(off, { queries: [], usage: null });
  const single = await planFollowupSearches({ question: "What is A?", parts: [], found: [] });
  assert.deepEqual(single, { queries: [], usage: null });
  assert.ok(Date.now() - started < 50, "no model call");
  const idOf = (r) => r.id;
  const kept = withPartCoverage([{ id: "a#0" }], [[{ id: "b#0" }, { id: "b#1" }, { id: "b#2" }]], idOf, 2).map(idOf);
  assert.deepEqual(kept, ["a#0", "b#0", "b#1"]);
}

(async () => {
  testHeadingsBecomeSectionPaths();
  testChunksNeverOverlapAndRebuildExactly();
  testTinyTrailingPieceFoldsIntoItsSection();
  testChunkTextStructuredCarriesHeadingAndIds();
  testJoinDropsLegacyTokenOverlap();
  await testNeighbourExpansionAbsorbsAdjacentHits();
  testEveryPartKeepsItsBestPassage();
  await testContextFallsBackToHeadersWithoutAModel();
  await testReingestUsesStoredTextElseRebuildsAndCountsFailures();
  await testPlannerSkipsTheModelForSimpleQuestions();
  await testFollowupRoundIsOffByDefaultAndNeedsSeveralParts();
  console.log("retrieval v2 ingest tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
