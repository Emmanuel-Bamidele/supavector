// Contracts other repos rely on. A change here breaks a consumer, so it must
// be deliberate: update the consumer in the same change.
//   - Document and chunk ids: the portal parses tenant::collection::docId and
//     docId#N (supavector-portal/tests/gateway_contract.test.js pins the same).
//   - Ask citations: every field the gateway emits is documented in
//     openapi.json, which the SDKs and supavector-one are built from.

const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");
const { splitChunkId } = require("../answer_context");
const openapi = require("../openapi.json");

function testDocumentAndChunkIds() {
  const docId = __testHooks.namespaceDocId("tenant1", "brain_c", "src_a");
  assert.equal(docId, "tenant1::brain_c::src_a");
  assert.deepEqual(__testHooks.parseNamespacedDocId(docId), { tenantId: "tenant1", collection: "brain_c", docId: "src_a", legacy: false });
  assert.deepEqual(splitChunkId(`${docId}#3`), { base: docId, idx: 3 });
}

function testAskCitationsMatchTheSpec() {
  const documented = new Set(Object.keys(openapi.components.schemas.AskResponseData.properties.citations.items.properties));
  const chunkId = "tenant1::brain_c::src_a#3";
  const [citation] = __testHooks.mapAnswerCitations([chunkId], [{
    chunk_id: chunkId, title: "Refund policy", source_url: "https://example.com/refunds", text: "Refunds within 14 days.", hit_text: "Refunds within 14 days."
  }], "refunds");
  for (const key of Object.keys(citation)) assert.ok(documented.has(key), `citation field "${key}" is not in openapi.json`);
  assert.equal(citation.n, 1);
  assert.equal(citation.chunkId, "src_a#3");
  assert.equal(citation.docId, "src_a");
  assert.equal(citation.url, "https://example.com/refunds");
  assert.ok(citation.snippet.includes("14 days"));
}

testDocumentAndChunkIds();
testAskCitationsMatchTheSpec();
console.log("contract tests passed");
