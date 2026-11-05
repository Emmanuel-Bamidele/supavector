// The small helper calls (query rewrite, listwise rerank, chunk context) moved
// off gpt-4.1-mini, which had no hidden reasoning, onto gpt-6-luna, which
// reasons at "medium" unless told otherwise. Their output caps are sized for
// the visible answer alone, so every one of them must ask for the lowest
// effort; this pins that, and the resulting request body, with a stubbed
// provider (no network).

const assert = require("assert/strict");
const path = require("path");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.RERANK_PROVIDER = "openai";
delete process.env.QUERY_REWRITE_MODEL;
delete process.env.RERANK_MODEL;
delete process.env.CHUNK_CONTEXT_MODEL;

const calls = [];
const providerPath = path.join(__dirname, "..", "provider_clients.js");
const real = require(providerPath);
require.cache[providerPath].exports = {
  ...real,
  generateProviderText: async (args) => {
    calls.push(args);
    if (args.jsonMode && /rank passages/.test(String(args.input?.system || ""))) {
      return { text: JSON.stringify({ ranking: [1, 0] }), usage: null };
    }
    if (args.jsonMode && /retrieval context/.test(String(args.input?.system || ""))) {
      return { text: JSON.stringify({ contexts: ["About the visa fee."] }), usage: null };
    }
    if (args.jsonMode) return { text: JSON.stringify({ query: "visa fee", subqueries: [] }), usage: null };
    return { text: "tourist visa fee", usage: null };
  }
};

const { rewriteQueryForRetrieval, planRetrieval } = require("../query_rewrite");
const { rerankCandidates } = require("../rerank");
const { buildChunkContexts } = require("../chunk_context");
const { __testHooks } = require("../provider_clients");

async function main() {
  const history = [{ role: "user", text: "Tell me about the tourist visa" }, { role: "assistant", text: "It is the B-2." }];
  await rewriteQueryForRetrieval({ question: "how much is it?", history });
  await planRetrieval({ question: "how much is it?", history });
  await rerankCandidates("visa fee", [{ row: { text: "a" } }, { row: { text: "b" } }]);
  await buildChunkContexts({ title: "Visa guide", text: "The fee is $185.", chunks: [{ text: "The fee is $185." }] });

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.model, "gpt-6-luna");
    assert.equal(call.reasoningEffort, "lowest");
    const body = __testHooks.buildOpenAiTextRequestBody(call);
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(Object.prototype.hasOwnProperty.call(body, "temperature"), false);
  }
  console.log("helper model tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
