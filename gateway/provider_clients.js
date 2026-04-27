const OpenAI = require("openai");
const {
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  buildResponsesCreateParams,
  normalizeModelId,
  normalizeProviderId
} = require("./model_catalog");

const OPENAI_CLIENTS = new Map();
const PROVIDER_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
const PROVIDER_MAX_RETRIES = parseInt(process.env.PROVIDER_MAX_RETRIES || "2", 10);
const PROVIDER_RETRY_BASE_DELAY_MS = parseInt(process.env.PROVIDER_RETRY_BASE_DELAY_MS || "250", 10);
const ANTHROPIC_VERSION = "2023-06-01";
const RETRYABLE_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN"
]);

function providerEnvKey(provider) {
  const clean = normalizeProviderId(provider);
  if (clean === "gemini") return "GEMINI_API_KEY";
  if (clean === "anthropic") return "ANTHROPIC_API_KEY";
  return "OPENAI_API_KEY";
}

function providerEnvAliases(provider) {
  const clean = normalizeProviderId(provider);
  if (clean === "gemini") return ["GEMINI_API_KEY", "GEMINI_API"];
  if (clean === "anthropic") return ["ANTHROPIC_API_KEY"];
  return ["OPENAI_API_KEY"];
}

function resolveProviderApiKey(provider, overrideKey = "") {
  const direct = String(overrideKey || "").trim();
  if (direct) return direct;
  for (const key of providerEnvAliases(provider)) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  throw new Error(`${providerEnvKey(provider)} not set on server`);
}

function createAbortSignal(timeoutMs = PROVIDER_TIMEOUT_MS, externalSignal = undefined) {
  const useTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!useTimeout && !externalSignal) return { signal: undefined, dispose: () => {} };
  const controller = new AbortController();
  let timer = null;
  const abortWithReason = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason instanceof Error ? reason : (reason || new Error("Request aborted")));
  };
  const handleExternalAbort = () => {
    abortWithReason(externalSignal?.reason || new Error("Request aborted"));
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortWithReason(externalSignal.reason || new Error("Request aborted"));
    } else if (typeof externalSignal.addEventListener === "function") {
      externalSignal.addEventListener("abort", handleExternalAbort, { once: true });
    }
  }
  if (useTimeout) {
    timer = setTimeout(() => abortWithReason(new Error("Request timed out")), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (externalSignal && typeof externalSignal.removeEventListener === "function") {
        externalSignal.removeEventListener("abort", handleExternalAbort);
      }
    }
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createOpenAIClient(apiKey) {
  const cleanKey = resolveProviderApiKey("openai", apiKey);
  const options = { apiKey: cleanKey };
  if (Number.isFinite(PROVIDER_TIMEOUT_MS) && PROVIDER_TIMEOUT_MS > 0) {
    options.timeout = PROVIDER_TIMEOUT_MS;
  }
  return new OpenAI(options);
}

function getOpenAIClient(apiKey = "") {
  const cleanKey = String(apiKey || "").trim();
  if (cleanKey) return createOpenAIClient(cleanKey);
  const serverKey = resolveProviderApiKey("openai");
  if (OPENAI_CLIENTS.has(serverKey)) return OPENAI_CLIENTS.get(serverKey);
  const client = createOpenAIClient(serverKey);
  OPENAI_CLIENTS.set(serverKey, client);
  return client;
}

function normalizeGeminiModelPath(model) {
  return String(normalizeModelId(model) || "").replace(/^models\//i, "");
}

function extractAnthropicText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return blocks
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function extractOpenAiText(payload) {
  const direct = String(payload?.output_text || "").trim();
  if (direct) return direct;
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  return outputs
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((item) => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const parts = candidates[0]?.content?.parts;
  const list = Array.isArray(parts) ? parts : [];
  return list
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiUsage(payload) {
  const usage = payload?.usageMetadata || {};
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || (inputTokens + outputTokens));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

function extractAnthropicUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

function extractOpenAiUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || (inputTokens + outputTokens));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

function ensureGeneratedText(text, { provider, model, jsonMode = false } = {}) {
  const clean = String(text || "").trim();
  if (clean) return clean;
  const error = new Error(
    `${String(provider || "provider").trim() || "provider"}:${String(model || "").trim() || "unknown-model"} returned no text`
    + (jsonMode ? " for structured generation" : "")
  );
  error.code = "EMPTY_GENERATION";
  error.provider = provider || null;
  error.model = model || null;
  error.jsonMode = Boolean(jsonMode);
  throw error;
}

function buildOpenAiTextRequestBody({ model, input, temperature, jsonMode = false, maxTokens }) {
  const resolvedInput = (input && typeof input === "object" && !Array.isArray(input) && input.system !== undefined)
    ? [{ role: "developer", content: input.system }, { role: "user", content: input.user }]
    : input;
  return buildResponsesCreateParams({
    provider: "openai",
    model,
    input: resolvedInput,
    temperature,
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { max_output_tokens: Math.floor(maxTokens) } : {}),
    ...(jsonMode ? { text: { format: { type: "json_object" } } } : {})
  });
}

function resolveRetryCount(value, fallback = PROVIDER_MAX_RETRIES) {
  const count = Number.isFinite(value) ? Number(value) : Number(fallback);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.floor(count);
}

function resolveRetryDelayMs(value, fallback = PROVIDER_RETRY_BASE_DELAY_MS) {
  const delay = Number.isFinite(value) ? Number(value) : Number(fallback);
  if (!Number.isFinite(delay) || delay < 0) return 0;
  return Math.floor(delay);
}

function isRetryableGenerationError(err) {
  const status = Number(err?.status);
  if (status === 408 || status === 409 || status === 425 || status === 429) {
    return true;
  }
  if (Number.isFinite(status) && status >= 500) {
    return true;
  }

  const code = String(err?.code || err?.cause?.code || "").trim().toUpperCase();
  if (RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const name = String(err?.name || err?.cause?.name || "").trim();
  if (name === "AbortError") {
    return true;
  }

  const message = String(err?.message || err?.cause?.message || "").toLowerCase();
  return /timeout|timed out|rate limit|too many requests|temporar|overloaded|overload|busy|try again|connect|connection|socket|network|dns|enotfound|econn|reset by peer|service unavailable|bad gateway|gateway timeout|upstream/.test(message);
}

function buildRetryDelayMs(attempt, baseDelayMs) {
  const exponent = Math.max(0, attempt);
  return baseDelayMs * Math.pow(2, exponent);
}

async function fetchJson(url, options = {}) {
  const { signal: upstreamSignal, ...requestOptions } = options || {};
  const { signal, dispose } = createAbortSignal(PROVIDER_TIMEOUT_MS, upstreamSignal);
  try {
    const res = await fetch(url, { ...requestOptions, signal });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const message = payload?.error?.message
        || payload?.error
        || payload?.message
        || res.statusText
        || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    dispose();
  }
}

async function generateTextWithOpenAI({ model, input, apiKey, temperature, jsonMode = false, maxTokens, onToken, signal }) {
  const client = getOpenAIClient(apiKey);
  if (typeof onToken === "function") {
    const stream = client.responses.stream(buildOpenAiTextRequestBody({
      model,
      input,
      temperature,
      jsonMode,
      maxTokens
    }), { signal });
    for await (const event of stream) {
      if (event?.type !== "response.output_text.delta") continue;
      const delta = String(event?.delta || "");
      if (!delta) continue;
      await onToken(delta, {
        snapshot: Object.prototype.hasOwnProperty.call(event || {}, "snapshot")
          ? event.snapshot
          : undefined
      });
    }
    const finalResponse = await stream.finalResponse();
    const finalText = ensureGeneratedText(extractOpenAiText(finalResponse), { provider: "openai", model, jsonMode });
    return {
      text: finalText,
      usage: extractOpenAiUsage(finalResponse?.usage)
    };
  }
  const resp = await client.responses.create(buildOpenAiTextRequestBody({
    model,
    input,
    temperature,
    jsonMode,
    maxTokens
  }), { signal });
  return {
    text: ensureGeneratedText(extractOpenAiText(resp), { provider: "openai", model, jsonMode }),
    usage: extractOpenAiUsage(resp?.usage)
  };
}

async function generateTextWithGemini({ model, input, apiKey, temperature, jsonMode = false, maxTokens, signal }) {
  const key = resolveProviderApiKey("gemini", apiKey);
  const generationConfig = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.floor(maxTokens);
  if (jsonMode) generationConfig.responseMimeType = "application/json";
  // Support input as { system, user } object or plain string
  const isStructured = input && typeof input === "object" && !Array.isArray(input) && input.system !== undefined;
  const body = {
    contents: [{
      role: "user",
      parts: [{ text: isStructured ? String(input.user || "") : String(input || "") }]
    }],
    ...(isStructured ? { systemInstruction: { parts: [{ text: String(input.system || "") }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {})
  };
  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizeGeminiModelPath(model))}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(body),
      signal
    }
  );
  return {
    text: ensureGeneratedText(extractGeminiText(payload), { provider: "gemini", model, jsonMode }),
    usage: extractGeminiUsage(payload)
  };
}

function buildAnthropicTextRequestBody({ model, input, temperature, jsonMode = false, maxTokens = 4096 }) {
  const isStructured = input && typeof input === "object" && !Array.isArray(input) && input.system !== undefined;
  const systemParts = [];
  if (isStructured && String(input.system || "").trim()) {
    systemParts.push(String(input.system || "").trim());
  }
  if (jsonMode) {
    systemParts.push("Return only a valid JSON object. Do not wrap the response in Markdown fences. Start with { and end with }.");
  }
  const userContent = isStructured ? String(input.user || "") : String(input || "");
  const messages = [{ role: "user", content: userContent }];
  if (jsonMode) {
    messages.push({ role: "assistant", content: "{" });
  }
  return {
    model,
    max_tokens: maxTokens,
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages,
    ...(temperature !== undefined ? { temperature } : {})
  };
}

async function generateTextWithAnthropic({ model, input, apiKey, temperature, jsonMode = false, maxTokens = 4096, signal }) {
  const key = resolveProviderApiKey("anthropic", apiKey);
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify(buildAnthropicTextRequestBody({
      model,
      input,
      temperature,
      jsonMode,
      maxTokens
    })),
    signal
  });
  const extracted = extractAnthropicText(payload);
  const text = jsonMode && extracted && !extracted.trim().startsWith("{")
    ? `{${extracted}`
    : extracted;
  return {
    text: ensureGeneratedText(text, { provider: "anthropic", model, jsonMode }),
    usage: extractAnthropicUsage(payload)
  };
}

async function generateProviderText({
  provider = DEFAULT_ANSWER_PROVIDER,
  model,
  input,
  apiKey,
  temperature,
  jsonMode = false,
  maxTokens,
  maxRetries,
  retryDelayMs,
  retryOnEmptyText = true,
  sleepFn,
  onToken,
  signal
}) {
  const cleanProvider = normalizeProviderId(provider) || DEFAULT_ANSWER_PROVIDER;
  const retries = resolveRetryCount(maxRetries);
  const baseDelayMs = resolveRetryDelayMs(retryDelayMs);
  const wait = typeof sleepFn === "function" ? sleepFn : sleep;
  let generator = generateTextWithOpenAI;
  if (cleanProvider === "gemini") {
    generator = generateTextWithGemini;
  } else if (cleanProvider === "anthropic") {
    generator = generateTextWithAnthropic;
  }

  let lastError = null;
  let streamedTextEmitted = false;
  const forwardToken = typeof onToken === "function" && cleanProvider === "openai"
    ? async (delta, meta = {}) => {
        const textDelta = String(delta || "");
        if (!textDelta) return;
        streamedTextEmitted = true;
        await onToken(textDelta, {
          provider: cleanProvider,
          model: model || null,
          ...(meta && typeof meta === "object" ? meta : {})
        });
      }
    : null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await generator({
        model,
        input,
        apiKey,
        temperature,
        jsonMode,
        maxTokens,
        onToken: forwardToken,
        signal
      });
      const text = String(result?.text || "").trim();
      if (!text && retryOnEmptyText && attempt < retries) {
        await wait(buildRetryDelayMs(attempt, baseDelayMs));
        continue;
      }
      return {
        ...result,
        text
      };
    } catch (err) {
      lastError = err;
      if (streamedTextEmitted) {
        throw err;
      }
      if (err?.code === "EMPTY_GENERATION") {
        if (!retryOnEmptyText || attempt >= retries) {
          throw err;
        }
        await wait(buildRetryDelayMs(attempt, baseDelayMs));
        continue;
      }
      if (!isRetryableGenerationError(err) || attempt >= retries) {
        throw err;
      }
      await wait(buildRetryDelayMs(attempt, baseDelayMs));
    }
  }

  throw lastError || new Error(`Provider generation failed for ${cleanProvider}.`);
}

function extractOpenAiEmbeddingUsage(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0)
  };
}

async function embedTextsWithOpenAI({ texts, model, apiKey }) {
  const client = getOpenAIClient(apiKey);
  const resp = await client.embeddings.create({
    model,
    input: texts
  });
  return {
    vectors: resp.data.map((item) => item.embedding),
    usage: extractOpenAiEmbeddingUsage(resp.usage)
  };
}

async function embedSingleTextWithGemini({ model, text, apiKey, taskType }) {
  const key = resolveProviderApiKey("gemini", apiKey);
  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizeGeminiModelPath(model))}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        content: {
          parts: [{ text: String(text || "") }]
        },
        ...(taskType ? { taskType } : {})
      })
    }
  );
  const values = payload?.embedding?.values || payload?.embeddings?.[0]?.values;
  if (!Array.isArray(values)) {
    throw new Error("Gemini embedding response did not include vector values.");
  }
  return {
    vector: values,
    usage: {
      prompt_tokens: Number(payload?.usageMetadata?.promptTokenCount || 0),
      total_tokens: Number(payload?.usageMetadata?.totalTokenCount || payload?.usageMetadata?.promptTokenCount || 0)
    }
  };
}

async function embedTextsWithGemini({ texts, model, apiKey, taskType }) {
  const vectors = [];
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  for (const text of texts) {
    const item = await embedSingleTextWithGemini({ model, text, apiKey, taskType });
    vectors.push(item.vector);
    usage.prompt_tokens += Number(item?.usage?.prompt_tokens || 0);
    usage.total_tokens += Number(item?.usage?.total_tokens || 0);
  }
  return { vectors, usage };
}

async function embedProviderTexts({
  provider = DEFAULT_EMBED_PROVIDER,
  texts,
  model,
  apiKey,
  taskType
}) {
  const cleanProvider = normalizeProviderId(provider) || DEFAULT_EMBED_PROVIDER;
  if (cleanProvider === "gemini") {
    return embedTextsWithGemini({ texts, model, apiKey, taskType });
  }
  if (cleanProvider !== "openai") {
    throw new Error(`Embedding provider "${cleanProvider}" is not supported. Use openai or gemini.`);
  }
  return embedTextsWithOpenAI({ texts, model, apiKey });
}

module.exports = {
  providerEnvKey,
  providerEnvAliases,
  resolveProviderApiKey,
  generateProviderText,
  embedProviderTexts,
  __testHooks: {
    createAbortSignal,
    buildOpenAiTextRequestBody,
    buildAnthropicTextRequestBody,
    normalizeGeminiModelPath,
    extractGeminiText,
    extractAnthropicText,
    extractOpenAiText,
    extractGeminiUsage,
    extractAnthropicUsage,
    extractOpenAiUsage,
    ensureGeneratedText,
    resolveRetryCount,
    resolveRetryDelayMs,
    isRetryableGenerationError,
    buildRetryDelayMs
  }
};
