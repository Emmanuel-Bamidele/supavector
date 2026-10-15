//
//  ai.js
//  SupaVector
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// ai.js
// This file creates embeddings (vectors) for text chunks and queries.

const crypto = require("crypto");
const { DEFAULT_EMBED_MODEL, normalizeModelId, normalizeProviderId } = require("./model_config");
const { embedProviderTexts } = require("./provider_clients");

const DEFAULT_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || "64", 10);
const FALLBACK_DIM = parseInt(process.env.EMBED_FALLBACK_DIM || "1536", 10);
// Hash-based fallback vectors are for local runs and CI without a provider key
// ONLY. Written into a live index they make documents unfindable by meaning,
// silently, so they are off unless explicitly enabled with "1".
const EMBED_FALLBACK_ON_ERROR = process.env.EMBED_FALLBACK_ON_ERROR === "1";
const QUERY_EMBED_CACHE_TTL_MS = parseInt(process.env.QUERY_EMBED_CACHE_TTL_MS || "30000", 10);
const QUERY_EMBED_CACHE_MAX_ITEMS = parseInt(process.env.QUERY_EMBED_CACHE_MAX_ITEMS || "256", 10);
let fallbackWarned = false;
const queryEmbeddingCache = new Map();
const MODEL_FALLBACK_DIMS = Object.freeze({
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
  "gemini-embedding-001": 3072
});

function resolveEmbedProvider(options = {}) {
  return normalizeProviderId(options?.embedProvider)
    || normalizeProviderId(process.env.EMBED_PROVIDER)
    || "openai";
}

function resolveEmbedModel(options = {}) {
  return normalizeModelId(options?.embedModel)
    || normalizeModelId(process.env.EMBED_MODEL)
    || DEFAULT_EMBED_MODEL;
}

function resolveEmbedDimension(options = {}) {
  const explicit = Number(options?.fallbackDim);
  if (Number.isFinite(explicit) && explicit > 8) {
    return Math.floor(explicit);
  }
  if (Number.isFinite(FALLBACK_DIM) && FALLBACK_DIM > 8 && process.env.EMBED_FALLBACK_DIM) {
    return Math.floor(FALLBACK_DIM);
  }
  const model = resolveEmbedModel(options);
  return MODEL_FALLBACK_DIMS[model] || 1536;
}

function warnFallback(reason) {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(`[embed] provider embeddings unavailable, using deterministic local fallback (${reason})`);
}

function normalizeVector(values) {
  let normSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    normSq += values[i] * values[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return values;
  for (let i = 0; i < values.length; i += 1) {
    values[i] /= norm;
  }
  return values;
}

function estimateTokensFromText(text) {
  const chars = String(text || "").length;
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function fallbackEmbedding(text, dim) {
  const vector = new Array(dim).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9._:@-]+/g)
    .filter(Boolean);

  if (!tokens.length) return vector;

  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest();
    for (let i = 0; i + 3 < digest.length; i += 4) {
      const idx = ((digest[i] << 8) | digest[i + 1]) % dim;
      const sign = (digest[i + 2] & 1) === 1 ? 1 : -1;
      const magnitude = 0.25 + (digest[i + 3] / 255) * 0.75;
      vector[idx] += sign * magnitude;
    }
  }

  return normalizeVector(vector);
}

function fallbackEmbeddings(texts, reason, usage, dim) {
  warnFallback(reason);
  let estimatedPromptTokens = 0;
  for (const text of texts) {
    estimatedPromptTokens += estimateTokensFromText(text);
  }
  usage.prompt_tokens += estimatedPromptTokens;
  usage.total_tokens += estimatedPromptTokens;
  usage.estimated = true;
  const vectors = texts.map((text) => fallbackEmbedding(text, dim));
  usage.fallback = true;
  return vectors;
}

function normalizeEmbedOptions(batchSizeOrOptions) {
  if (typeof batchSizeOrOptions === "number") {
    return { batchSize: batchSizeOrOptions };
  }
  if (batchSizeOrOptions && typeof batchSizeOrOptions === "object") {
    return batchSizeOrOptions;
  }
  return {};
}

function normalizeQueryCacheText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashApiKeyScope(apiKey) {
  const clean = String(apiKey || "").trim();
  if (!clean) return "env";
  return crypto.createHash("sha256").update(clean).digest("hex").slice(0, 16);
}

function shouldUseQueryEmbeddingCache(texts, options = {}) {
  const ttlMs = Number.isFinite(QUERY_EMBED_CACHE_TTL_MS) ? QUERY_EMBED_CACHE_TTL_MS : 0;
  const maxItems = Number.isFinite(QUERY_EMBED_CACHE_MAX_ITEMS) ? QUERY_EMBED_CACHE_MAX_ITEMS : 0;
  if (ttlMs <= 0 || maxItems <= 0) return false;
  if (String(options?.taskType || "").trim() !== "RETRIEVAL_QUERY") return false;
  if (!Array.isArray(texts) || texts.length !== 1) return false;
  return Boolean(normalizeQueryCacheText(texts[0]));
}

function buildQueryEmbeddingCacheKey(text, options = {}) {
  const provider = resolveEmbedProvider(options);
  const model = resolveEmbedModel(options);
  const normalizedText = normalizeQueryCacheText(text);
  const apiKeyScope = hashApiKeyScope(options.apiKey);
  return `${provider}::${model}::${apiKeyScope}::${normalizedText}`;
}

function cloneVector(vector) {
  return Array.isArray(vector) ? vector.slice() : [];
}

function getQueryEmbeddingCacheEntry(key, now = Date.now()) {
  const entry = queryEmbeddingCache.get(key);
  if (!entry) return null;
  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
    queryEmbeddingCache.delete(key);
    return null;
  }
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, entry);
  return {
    vector: cloneVector(entry.vector),
    expiresAt: entry.expiresAt
  };
}

function trimQueryEmbeddingCache(now = Date.now()) {
  if (queryEmbeddingCache.size === 0) return;
  for (const [key, entry] of queryEmbeddingCache.entries()) {
    if (Number.isFinite(entry?.expiresAt) && entry.expiresAt > now) continue;
    queryEmbeddingCache.delete(key);
  }
  const maxItems = Number.isFinite(QUERY_EMBED_CACHE_MAX_ITEMS) ? QUERY_EMBED_CACHE_MAX_ITEMS : 0;
  if (maxItems <= 0) {
    queryEmbeddingCache.clear();
    return;
  }
  while (queryEmbeddingCache.size > maxItems) {
    const oldestKey = queryEmbeddingCache.keys().next().value;
    if (!oldestKey) break;
    queryEmbeddingCache.delete(oldestKey);
  }
}

function setQueryEmbeddingCacheEntry(key, vector, now = Date.now()) {
  const ttlMs = Number.isFinite(QUERY_EMBED_CACHE_TTL_MS) ? QUERY_EMBED_CACHE_TTL_MS : 0;
  if (!key || ttlMs <= 0) return;
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, {
    vector: cloneVector(vector),
    expiresAt: now + ttlMs
  });
  trimQueryEmbeddingCache(now);
}

function clearQueryEmbeddingCache() {
  queryEmbeddingCache.clear();
}

async function embedTexts(texts, batchSizeOrOptions = DEFAULT_BATCH_SIZE) {
  const out = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  const options = normalizeEmbedOptions(batchSizeOrOptions);
  const safeBatch = Number.isFinite(options.batchSize) && options.batchSize > 0 ? options.batchSize : 64;
  const list = Array.isArray(texts) ? texts : [];
  const fallbackDim = resolveEmbedDimension(options);
  const embedProvider = resolveEmbedProvider(options);
  const embedModel = resolveEmbedModel(options);

  for (let i = 0; i < list.length; i += safeBatch) {
    const slice = list.slice(i, i + safeBatch);
    const useQueryCache = shouldUseQueryEmbeddingCache(slice, options);
    const cacheKey = useQueryCache ? buildQueryEmbeddingCacheKey(slice[0], options) : null;
    if (cacheKey) {
      const cached = getQueryEmbeddingCacheEntry(cacheKey);
      if (cached) {
        out.push(cached.vector);
        usage.cached = true;
        usage.cached_hits = Number(usage.cached_hits || 0) + 1;
        continue;
      }
    }
    try {
      const resp = await embedProviderTexts({
        provider: embedProvider,
        texts: slice,
        model: embedModel,
        apiKey: options.apiKey,
        taskType: options.taskType
      });
      out.push(...resp.vectors);
      if (cacheKey && Array.isArray(resp.vectors) && resp.vectors[0]) {
        setQueryEmbeddingCacheEntry(cacheKey, resp.vectors[0]);
      }
      if (resp.usage) {
        usage.prompt_tokens += Number(resp.usage.prompt_tokens || 0);
        usage.total_tokens += Number(resp.usage.total_tokens || 0);
      }
    } catch (err) {
      if (!EMBED_FALLBACK_ON_ERROR) throw err;
      out.push(...fallbackEmbeddings(slice, String(err?.message || err || "request failed"), usage, fallbackDim));
    }
  }

  return { vectors: out, usage };
}

module.exports = {
  embedTexts,
  resolveEmbedDimension,
  __testHooks: {
    resolveEmbedProvider,
    resolveEmbedModel,
    resolveEmbedDimension,
    normalizeQueryCacheText,
    shouldUseQueryEmbeddingCache,
    buildQueryEmbeddingCacheKey,
    getQueryEmbeddingCacheEntry,
    setQueryEmbeddingCacheEntry,
    clearQueryEmbeddingCache
  }
};
