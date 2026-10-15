// Reranker behaviour against a fake hosted provider: reorders the head of the
// fused list, keeps the tail, and falls back to fusion order on any failure.

process.env.RERANK_PROVIDER = "cohere";
process.env.COHERE_API_KEY = "test-key";
process.env.RERANK_CANDIDATES = "5"; // the module never sends fewer than 5

const assert = require("assert/strict");
const { rerankCandidates, rerankEnabled } = require("../rerank");

const candidates = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((text, i) => ({ row: { chunk_id: `c#${i}`, text } }));

async function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function testReordersHeadKeepsTail() {
  assert.equal(rerankEnabled(), true);
  let sent = null;
  const result = await withFetch(async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }, { index: 1, relevance_score: 0.1 }] }) };
  }, () => rerankCandidates("which one", candidates));
  assert.match(sent.url, /cohere/);
  assert.deepEqual(sent.body.documents, ["alpha", "bravo", "charlie", "delta", "echo"]);
  assert.equal(result.reranked, true);
  // Scored head first by score; unscored head entries keep fusion order; the tail stays last.
  assert.deepEqual(result.candidates.map((c) => c.row.text), ["charlie", "alpha", "bravo", "delta", "echo", "foxtrot"]);
  assert.equal(result.candidates[0].rerankScore, 0.9);
}

async function testProviderFailureKeepsFusionOrder() {
  const result = await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }), () => rerankCandidates("q", candidates));
  assert.equal(result.reranked, false);
  assert.match(result.error, /503/);
  assert.deepEqual(result.candidates.map((c) => c.row.text), ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]);
}

async function testSingleCandidateIsNotSent() {
  let called = false;
  const result = await withFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; }, () => rerankCandidates("q", candidates.slice(0, 1)));
  assert.equal(called, false);
  assert.equal(result.reranked, false);
}

(async () => {
  await testReordersHeadKeepsTail();
  await testProviderFailureKeepsFusionOrder();
  await testSingleCandidateIsNotSent();
  console.log("rerank tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
