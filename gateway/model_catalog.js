const CUSTOM_MODEL_SENTINEL = "__custom__";

const DEFAULT_ANSWER_PROVIDER = "openai";
const DEFAULT_EMBED_PROVIDER = "openai";
const DEFAULT_REFLECT_PROVIDER = "openai";

const DEFAULT_ANSWER_MODEL = "gpt-5.2";
const DEFAULT_EMBED_MODEL = "text-embedding-3-large";
const DEFAULT_REFLECT_MODEL = "gpt-5-mini";

const DEFAULT_GENERATION_MODEL_BY_PROVIDER = Object.freeze({
  openai: DEFAULT_ANSWER_MODEL,
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-20250514"
});

const DEFAULT_EMBEDDING_MODEL_BY_PROVIDER = Object.freeze({
  openai: DEFAULT_EMBED_MODEL,
  gemini: "gemini-embedding-001"
});

const DEFAULT_REFLECTION_MODEL_BY_PROVIDER = Object.freeze({
  openai: DEFAULT_REFLECT_MODEL,
  gemini: "gemini-2.5-flash-lite",
  anthropic: "claude-3-5-haiku-latest"
});

const GENERATION_PROVIDER_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    provider: "openai",
    label: "OpenAI",
    recommended: true
  }),
  Object.freeze({
    key: "2",
    provider: "gemini",
    label: "Google Gemini"
  }),
  Object.freeze({
    key: "3",
    provider: "anthropic",
    label: "Anthropic"
  })
]);

const EMBEDDING_PROVIDER_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    provider: "openai",
    label: "OpenAI",
    recommended: true
  }),
  Object.freeze({
    key: "2",
    provider: "gemini",
    label: "Google Gemini"
  })
]);

const OPENAI_GENERATION_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "gpt-5.2",
    label: "Latest flagship",
    family: "gpt-5",
    supportsTemperature: false,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: "gpt-5-mini",
    label: "Fast lower-cost default",
    family: "gpt-5",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "3",
    model: "gpt-5-nano",
    label: "Smallest lowest-cost GPT-5",
    family: "gpt-5",
    supportsTemperature: false
  }),
  Object.freeze({
    key: "4",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id",
    family: "custom",
    supportsTemperature: false
  })
]);

const GEMINI_GENERATION_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "gemini-2.5-flash",
    label: "Balanced default",
    family: "gemini-2.5",
    supportsTemperature: true,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: "gemini-2.5-pro",
    label: "Strongest quality",
    family: "gemini-2.5",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "3",
    model: "gemini-2.5-flash-lite",
    label: "Lowest cost",
    family: "gemini-2.5",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "4",
    model: "gemini-2.0-flash",
    label: "Broad compatibility",
    family: "gemini-2.0",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "5",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id",
    family: "custom",
    supportsTemperature: true
  })
]);

const ANTHROPIC_GENERATION_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "claude-sonnet-4-20250514",
    label: "Balanced default",
    family: "claude-4",
    supportsTemperature: true,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: "claude-opus-4-20250514",
    label: "Strongest quality",
    family: "claude-4",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "3",
    model: "claude-3-7-sonnet-latest",
    label: "Broad compatibility",
    family: "claude-3.7",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "4",
    model: "claude-3-5-haiku-latest",
    label: "Fastest / lowest cost",
    family: "claude-3.5",
    supportsTemperature: true
  }),
  Object.freeze({
    key: "5",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id",
    family: "custom",
    supportsTemperature: true
  })
]);

const GENERATION_MODEL_PRESETS_BY_PROVIDER = Object.freeze({
  openai: OPENAI_GENERATION_MODEL_PRESETS,
  gemini: GEMINI_GENERATION_MODEL_PRESETS,
  anthropic: ANTHROPIC_GENERATION_MODEL_PRESETS
});

const OPENAI_EMBEDDING_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "text-embedding-3-large",
    label: "Best quality (default)",
    dimensions: 3072,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: "text-embedding-3-small",
    label: "Lower cost",
    dimensions: 1536
  }),
  Object.freeze({
    key: "3",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id"
  })
]);

const GEMINI_EMBEDDING_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    key: "1",
    model: "gemini-embedding-001",
    label: "Recommended",
    dimensions: 3072,
    recommended: true
  }),
  Object.freeze({
    key: "2",
    model: CUSTOM_MODEL_SENTINEL,
    label: "Enter a custom model id"
  })
]);

const EMBEDDING_MODEL_PRESETS_BY_PROVIDER = Object.freeze({
  openai: OPENAI_EMBEDDING_MODEL_PRESETS,
  gemini: GEMINI_EMBEDDING_MODEL_PRESETS
});

const GENERATION_MODEL_PRESETS = OPENAI_GENERATION_MODEL_PRESETS;
const EMBEDDING_MODEL_PRESETS = OPENAI_EMBEDDING_MODEL_PRESETS;

function normalizeModelId(value) {
  const clean = String(value || "").trim();
  return clean || null;
}

function normalizeProviderId(value) {
  const clean = String(value || "").trim().toLowerCase();
  return clean || null;
}

function listGenerationProviders() {
  return GENERATION_PROVIDER_PRESETS.slice();
}

function listEmbeddingProviders() {
  return EMBEDDING_PROVIDER_PRESETS.slice();
}

function listGenerationModelPresets(provider = DEFAULT_ANSWER_PROVIDER) {
  return GENERATION_MODEL_PRESETS_BY_PROVIDER[normalizeProviderId(provider)] || GENERATION_MODEL_PRESETS_BY_PROVIDER[DEFAULT_ANSWER_PROVIDER];
}

function listEmbeddingModelPresets(provider = DEFAULT_EMBED_PROVIDER) {
  return EMBEDDING_MODEL_PRESETS_BY_PROVIDER[normalizeProviderId(provider)] || EMBEDDING_MODEL_PRESETS_BY_PROVIDER[DEFAULT_EMBED_PROVIDER];
}

function findGenerationProviderPreset(value) {
  const clean = normalizeProviderId(value) || String(value || "").trim();
  if (!clean) return null;
  return GENERATION_PROVIDER_PRESETS.find((item) => item.key === clean || item.provider === normalizeProviderId(clean)) || null;
}

function findEmbeddingProviderPreset(value) {
  const clean = normalizeProviderId(value) || String(value || "").trim();
  if (!clean) return null;
  return EMBEDDING_PROVIDER_PRESETS.find((item) => item.key === clean || item.provider === normalizeProviderId(clean)) || null;
}

function findGenerationModelPreset(provider, value) {
  const clean = normalizeModelId(value);
  if (!clean) return null;
  return listGenerationModelPresets(provider).find((item) => item.key === clean || item.model === clean) || null;
}

function findEmbeddingModelPreset(provider, value) {
  const clean = normalizeModelId(value);
  if (!clean) return null;
  return listEmbeddingModelPresets(provider).find((item) => item.key === clean || item.model === clean) || null;
}

function defaultGenerationModelForProvider(provider = DEFAULT_ANSWER_PROVIDER) {
  const clean = normalizeProviderId(provider) || DEFAULT_ANSWER_PROVIDER;
  return DEFAULT_GENERATION_MODEL_BY_PROVIDER[clean] || DEFAULT_GENERATION_MODEL_BY_PROVIDER[DEFAULT_ANSWER_PROVIDER];
}

function defaultEmbeddingModelForProvider(provider = DEFAULT_EMBED_PROVIDER) {
  const clean = normalizeProviderId(provider) || DEFAULT_EMBED_PROVIDER;
  return DEFAULT_EMBEDDING_MODEL_BY_PROVIDER[clean] || DEFAULT_EMBEDDING_MODEL_BY_PROVIDER[DEFAULT_EMBED_PROVIDER];
}

function defaultReflectModelForProvider(provider = DEFAULT_REFLECT_PROVIDER) {
  const clean = normalizeProviderId(provider) || DEFAULT_REFLECT_PROVIDER;
  return DEFAULT_REFLECTION_MODEL_BY_PROVIDER[clean] || DEFAULT_REFLECTION_MODEL_BY_PROVIDER[DEFAULT_REFLECT_PROVIDER];
}

function defaultProviderSelection(value, kind = "generation", fallback = "") {
  const clean = normalizeProviderId(value) || normalizeProviderId(fallback) || (kind === "embedding" ? DEFAULT_EMBED_PROVIDER : DEFAULT_ANSWER_PROVIDER);
  const preset = kind === "embedding"
    ? findEmbeddingProviderPreset(clean)
    : findGenerationProviderPreset(clean);
  return preset ? preset.key : clean;
}

function normalizeProviderSelection(value, kind = "generation", fallback = "") {
  const clean = normalizeProviderId(value) || normalizeProviderId(fallback) || (kind === "embedding" ? DEFAULT_EMBED_PROVIDER : DEFAULT_ANSWER_PROVIDER);
  const preset = kind === "embedding"
    ? findEmbeddingProviderPreset(clean)
    : findGenerationProviderPreset(clean);
  return preset ? preset.provider : clean;
}

function defaultGenerationModelSelectionForProvider(provider, value, fallback = "") {
  const resolvedProvider = normalizeProviderSelection(provider, "generation", DEFAULT_ANSWER_PROVIDER);
  const clean = normalizeModelId(value) || normalizeModelId(fallback) || defaultGenerationModelForProvider(resolvedProvider);
  const match = findGenerationModelPreset(resolvedProvider, clean);
  return match ? match.key : clean;
}

function normalizeGenerationModelSelectionForProvider(provider, value, fallback = "") {
  const resolvedProvider = normalizeProviderSelection(provider, "generation", DEFAULT_ANSWER_PROVIDER);
  const clean = normalizeModelId(value) || normalizeModelId(fallback) || defaultGenerationModelForProvider(resolvedProvider);
  const match = findGenerationModelPreset(resolvedProvider, clean);
  if (!match) return clean;
  if (match.model === CUSTOM_MODEL_SENTINEL) {
    throw new Error("Custom model id is required.");
  }
  return match.model;
}

function defaultEmbeddingModelSelectionForProvider(provider, value, fallback = "") {
  const resolvedProvider = normalizeProviderSelection(provider, "embedding", DEFAULT_EMBED_PROVIDER);
  const clean = normalizeModelId(value) || normalizeModelId(fallback) || defaultEmbeddingModelForProvider(resolvedProvider);
  const match = findEmbeddingModelPreset(resolvedProvider, clean);
  return match ? match.key : clean;
}

function normalizeEmbeddingModelSelectionForProvider(provider, value, fallback = "") {
  const resolvedProvider = normalizeProviderSelection(provider, "embedding", DEFAULT_EMBED_PROVIDER);
  const clean = normalizeModelId(value) || normalizeModelId(fallback) || defaultEmbeddingModelForProvider(resolvedProvider);
  const match = findEmbeddingModelPreset(resolvedProvider, clean);
  if (!match) return clean;
  if (match.model === CUSTOM_MODEL_SENTINEL) {
    throw new Error("Custom model id is required.");
  }
  return match.model;
}

function defaultGenerationModelSelection(value, fallback = DEFAULT_ANSWER_MODEL) {
  return defaultGenerationModelSelectionForProvider(DEFAULT_ANSWER_PROVIDER, value, fallback);
}

function normalizeGenerationModelSelection(value, fallback = DEFAULT_ANSWER_MODEL) {
  return normalizeGenerationModelSelectionForProvider(DEFAULT_ANSWER_PROVIDER, value, fallback);
}

function isReasoningStyleModel(modelId) {
  const clean = String(normalizeModelId(modelId) || "").toLowerCase();
  return /^o\d/.test(clean) || /^gpt-5/i.test(clean);
}

function supportsTemperature(modelId, provider = DEFAULT_ANSWER_PROVIDER) {
  const cleanProvider = normalizeProviderId(provider) || DEFAULT_ANSWER_PROVIDER;
  if (cleanProvider !== "openai") return true;
  const preset = findGenerationModelPreset(cleanProvider, modelId);
  if (preset) return preset.supportsTemperature !== false;
  return !isReasoningStyleModel(modelId);
}

function buildResponsesCreateParams({ provider = DEFAULT_ANSWER_PROVIDER, model, temperature, ...rest }) {
  const params = { model, ...rest };
  if (temperature !== undefined && supportsTemperature(model, provider)) {
    params.temperature = temperature;
  }
  return params;
}

function mapGenerationCatalogEntry(provider, item) {
  return {
    key: item.key,
    provider,
    model: item.model,
    label: item.label,
    family: item.family,
    supportsTemperature: item.supportsTemperature !== false,
    recommended: Boolean(item.recommended),
    custom: item.model === CUSTOM_MODEL_SENTINEL
  };
}

function mapEmbeddingCatalogEntry(provider, item) {
  return {
    key: item.key,
    provider,
    model: item.model,
    label: item.label,
    dimensions: item.dimensions || null,
    recommended: Boolean(item.recommended),
    custom: item.model === CUSTOM_MODEL_SENTINEL
  };
}

function buildPublicModelCatalog() {
  const generationByProvider = {};
  for (const preset of GENERATION_PROVIDER_PRESETS) {
    generationByProvider[preset.provider] = listGenerationModelPresets(preset.provider).map((item) => mapGenerationCatalogEntry(preset.provider, item));
  }

  const embeddingsByProvider = {};
  for (const preset of EMBEDDING_PROVIDER_PRESETS) {
    embeddingsByProvider[preset.provider] = listEmbeddingModelPresets(preset.provider).map((item) => mapEmbeddingCatalogEntry(preset.provider, item));
  }

  return {
    generationProviders: GENERATION_PROVIDER_PRESETS.map((item) => ({
      key: item.key,
      provider: item.provider,
      label: item.label,
      recommended: Boolean(item.recommended)
    })),
    embeddingProviders: EMBEDDING_PROVIDER_PRESETS.map((item) => ({
      key: item.key,
      provider: item.provider,
      label: item.label,
      recommended: Boolean(item.recommended)
    })),
    generationByProvider,
    embeddingsByProvider,
    generation: generationByProvider.openai || [],
    embeddings: embeddingsByProvider.openai || [],
    notes: {
      customModelAllowed: true,
      compatibility: "SupaVector omits unsupported temperature parameters automatically for reasoning-style OpenAI models. Gemini and Anthropic use provider-native request formats.",
      availability: "Model availability depends on your provider account, enabled APIs, and region.",
      requestScopedKeys: "Use X-OpenAI-API-Key, X-Gemini-API-Key, or X-Anthropic-API-Key to override provider credentials per request."
    }
  };
}

/*
 * Reasoning effort for OpenAI reasoning models (gpt-5 family, o-series).
 * Unset means the API default, which differs by model: none for gpt-5.1 and
 * later, medium for gpt-5 / gpt-5-mini / gpt-5-nano. "lowest" asks for the
 * cheapest, fastest setting each family accepts, so a caller can say "no
 * hidden reasoning" without knowing which spelling the model takes.
 */
const REASONING_EFFORTS = new Set(["lowest", "none", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeReasoningEffort(value) {
  const clean = String(value || "").trim().toLowerCase();
  return REASONING_EFFORTS.has(clean) ? clean : null;
}

/** The Responses API `reasoning` param for this model, or null to send none. */
function openAiReasoningParam(model, effort) {
  const requested = normalizeReasoningEffort(effort);
  if (!requested) return null;
  const id = String(model || "").trim().toLowerCase();
  if (id.includes("-chat")) return null; // chat snapshots take no reasoning param
  const gpt5 = /^gpt-5(?:\.(\d+))?(?:-|$)/.exec(id);
  const oSeries = /^o\d/.test(id);
  if (!gpt5 && !oSeries) return null; // not a reasoning model
  if (requested !== "lowest") return { effort: requested };
  if (oSeries) return { effort: "low" };
  return { effort: gpt5[1] && Number(gpt5[1]) >= 1 ? "none" : "minimal" };
}

module.exports = {
  CUSTOM_MODEL_SENTINEL,
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_EMBEDDING_MODEL_BY_PROVIDER,
  DEFAULT_REFLECTION_MODEL_BY_PROVIDER,
  GENERATION_PROVIDER_PRESETS,
  EMBEDDING_PROVIDER_PRESETS,
  GENERATION_MODEL_PRESETS,
  EMBEDDING_MODEL_PRESETS,
  GENERATION_MODEL_PRESETS_BY_PROVIDER,
  EMBEDDING_MODEL_PRESETS_BY_PROVIDER,
  normalizeModelId,
  normalizeProviderId,
  normalizeReasoningEffort,
  openAiReasoningParam,
  listGenerationProviders,
  listEmbeddingProviders,
  listGenerationModelPresets,
  listEmbeddingModelPresets,
  findGenerationProviderPreset,
  findEmbeddingProviderPreset,
  findGenerationModelPreset,
  findEmbeddingModelPreset,
  defaultGenerationModelForProvider,
  defaultEmbeddingModelForProvider,
  defaultReflectModelForProvider,
  defaultProviderSelection,
  normalizeProviderSelection,
  defaultGenerationModelSelection,
  normalizeGenerationModelSelection,
  defaultGenerationModelSelectionForProvider,
  normalizeGenerationModelSelectionForProvider,
  defaultEmbeddingModelSelectionForProvider,
  normalizeEmbeddingModelSelectionForProvider,
  isReasoningStyleModel,
  supportsTemperature,
  buildResponsesCreateParams,
  buildPublicModelCatalog
};
