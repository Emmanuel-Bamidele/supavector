// Second-stage reranking: hybrid retrieval casts a wide net, a reranker that
// reads the query and each passage together picks the best few.
//
// Providers (RERANK_PROVIDER):
//   cohere | voyage | jina  hosted cross-encoder rerank APIs (key in env)
//   openai                  listwise LLM reranker over a small model
//   none                    keep fusion order (default when nothing is set)
// Any failure or timeout keeps the fusion order: reranking can improve
// results but never break a search.

const { generateProviderText } = require("./provider_clients");

const PROVIDER = String(process.env.RERANK_PROVIDER || "none").trim().toLowerCase();
const CANDIDATES = Math.max(5, parseInt(process.env.RERANK_CANDIDATES || "40", 10) || 40);
const TIMEOUT_MS = parseInt(process.env.RERANK_TIMEOUT_MS || "6000", 10);
const PASSAGE_CHARS = parseInt(process.env.RERANK_PASSAGE_CHARS || "1200", 10);
const MODELS = {
  cohere: process.env.RERANK_MODEL || "rerank-v3.5",
  voyage: process.env.RERANK_MODEL || "rerank-2.5",
  jina: process.env.RERANK_MODEL || "jina-reranker-v2-base-multilingual",
  openai: process.env.RERANK_MODEL || "gpt-4.1-mini"
};
const ENDPOINTS = {
  cohere: { url: "https://api.cohere.com/v2/rerank", key: () => process.env.COHERE_API_KEY },
  voyage: { url: "https://api.voyageai.com/v1/rerank", key: () => process.env.VOYAGE_API_KEY },
  jina: { url: "https://api.jina.ai/v1/rerank", key: () => process.env.JINA_API_KEY }
};

function rerankEnabled() {
  if (PROVIDER === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(ENDPOINTS[PROVIDER]?.key());
}

async function hostedScores(provider, query, texts, signal) {
  const { url, key } = ENDPOINTS[provider];
  const body = provider === "voyage"
    ? { model: MODELS.voyage, query, documents: texts, top_k: texts.length }
    : { model: MODELS[provider], query, documents: texts, top_n: texts.length };
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw new Error(`${provider} rerank ${res.status}`);
  const json = await res.json();
  const rows = json.results || json.data || [];
  const scores = new Array(texts.length).fill(-Infinity);
  for (const row of rows) {
    const index = Number(row.index);
    if (Number.isInteger(index) && index >= 0 && index < texts.length) scores[index] = Number(row.relevance_score ?? row.score ?? 0);
  }
  return { scores, usage: null };
}

const LISTWISE_INSTRUCTIONS = `You rank passages by how well they answer a search query.
Read every passage. Return JSON {"ranking": [ids]} listing the passage ids from most to least useful for answering the query. Include every id exactly once. A passage that directly answers the query beats one that only mentions its words.`;

async function listwiseScores(query, texts, signal) {
  const passages = texts.map((t, i) => `[${i}] ${String(t).replace(/\s+/g, " ").slice(0, PASSAGE_CHARS)}`).join("\n\n");
  const result = await generateProviderText({
    provider: "openai",
    model: MODELS.openai,
    input: { system: LISTWISE_INSTRUCTIONS, user: `Query: ${query}\n\nPassages:\n${passages}` },
    temperature: 0,
    jsonMode: true,
    maxTokens: 20 + texts.length * 6,
    maxRetries: 0,
    signal
  });
  const ranking = JSON.parse(result.text || "{}").ranking;
  if (!Array.isArray(ranking)) throw new Error("listwise rerank returned no ranking");
  const scores = new Array(texts.length).fill(-Infinity);
  ranking.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < texts.length).forEach((index, position) => {
    if (scores[index] === -Infinity) scores[index] = ranking.length - position;
  });
  return { scores, usage: result.usage || null };
}

/**
 * Rerank the head of `candidates` (already fusion-ordered). Returns
 * {candidates, reranked, usage, error?}; each reranked candidate gains
 * `rerankScore`. The tail beyond RERANK_CANDIDATES keeps its order.
 */
async function rerankCandidates(query, candidates, { textOf = (c) => c?.row?.text } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!rerankEnabled() || list.length < 2 || !String(query || "").trim()) {
    return { candidates: list, reranked: false, usage: null };
  }
  const head = list.slice(0, CANDIDATES);
  const tail = list.slice(CANDIDATES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const texts = head.map((c) => String(textOf(c) || ""));
    const { scores, usage } = PROVIDER === "openai"
      ? await listwiseScores(query, texts, controller.signal)
      : await hostedScores(PROVIDER, query, texts, controller.signal);
    // Unscored passages sink below scored ones but keep their fusion order.
    const order = head
      .map((candidate, index) => ({ candidate, index, score: scores[index] }))
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return {
      candidates: [...order.map(({ candidate, score }) => ({ ...candidate, rerankScore: Number.isFinite(score) ? score : null })), ...tail],
      reranked: true,
      usage
    };
  } catch (err) {
    return { candidates: list, reranked: false, usage: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { rerankCandidates, rerankEnabled, RERANK_CANDIDATES: CANDIDATES, RERANK_PROVIDER: PROVIDER };
