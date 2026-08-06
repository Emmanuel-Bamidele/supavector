const {
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL: CATALOG_DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  GENERATION_PROVIDER_PRESETS,
  EMBEDDING_PROVIDER_PRESETS,
  GENERATION_MODEL_PRESETS,
  EMBEDDING_MODEL_PRESETS,
  buildPublicModelCatalog,
  buildResponsesCreateParams,
  defaultEmbeddingModelForProvider,
  defaultGenerationModelForProvider,
  defaultReflectModelForProvider,
  normalizeModelId,
  normalizeProviderId,
  supportsTemperature
} = require("./model_catalog");

// Keep the runtime fallback conservative for older installs that never pinned EMBED_MODEL.
// Fresh installs and CLI-managed env files explicitly write the recommended embed model.
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

function resolveEmbedRuntimeDefault(provider) {
  const cleanProvider = normalizeProviderId(provider) || DEFAULT_EMBED_PROVIDER;
  if (cleanProvider === "openai") return DEFAULT_EMBED_MODEL;
  return defaultEmbeddingModelForProvider(cleanProvider);
}

function resolveEnvModelDefaults(env = process.env) {
  const answerProvider = normalizeProviderId(env.ANSWER_PROVIDER) || DEFAULT_ANSWER_PROVIDER;
  const answerModel = normalizeModelId(env.ANSWER_MODEL) || defaultGenerationModelForProvider(answerProvider);

  const booleanAskProvider = normalizeProviderId(env.BOOLEAN_ASK_PROVIDER) || answerProvider;
  const booleanAskModel = normalizeModelId(env.BOOLEAN_ASK_MODEL)
    || (booleanAskProvider === answerProvider ? answerModel : defaultGenerationModelForProvider(booleanAskProvider));

  const reflectProvider = normalizeProviderId(env.REFLECT_PROVIDER) || DEFAULT_REFLECT_PROVIDER;
  const reflectModel = normalizeModelId(env.REFLECT_MODEL) || defaultReflectModelForProvider(reflectProvider);

  const compactProvider = normalizeProviderId(env.COMPACT_PROVIDER) || reflectProvider;
  const compactModel = normalizeModelId(env.COMPACT_MODEL)
    || (compactProvider === reflectProvider ? reflectModel : defaultReflectModelForProvider(compactProvider));

  const embedProvider = normalizeProviderId(env.EMBED_PROVIDER) || DEFAULT_EMBED_PROVIDER;
  const embedModel = normalizeModelId(env.EMBED_MODEL) || resolveEmbedRuntimeDefault(embedProvider);

  return {
    answerProvider,
    answerModel,
    booleanAskProvider,
    booleanAskModel,
    embedProvider,
    embedModel,
    reflectProvider,
    reflectModel,
    compactProvider,
    compactModel
  };
}

function extractTenantModelOverrides(record = {}) {
  // A tenant lookup that found no row passes an explicit null, which a
  // default parameter does not replace — treat it as "no overrides".
  record = record || {};
  return {
    answerProvider: normalizeProviderId(record.answer_provider ?? record.answerProvider),
    answerModel: normalizeModelId(record.answer_model ?? record.answerModel),
    booleanAskProvider: normalizeProviderId(record.boolean_ask_provider ?? record.booleanAskProvider),
    booleanAskModel: normalizeModelId(record.boolean_ask_model ?? record.booleanAskModel),
    reflectProvider: normalizeProviderId(record.reflect_provider ?? record.reflectProvider),
    reflectModel: normalizeModelId(record.reflect_model ?? record.reflectModel),
    compactProvider: normalizeProviderId(record.compact_provider ?? record.compactProvider),
    compactModel: normalizeModelId(record.compact_model ?? record.compactModel)
  };
}

function resolveTenantModelSettings(record = {}, env = process.env) {
  const configured = extractTenantModelOverrides(record);
  const instanceDefaults = resolveEnvModelDefaults(env);

  const answerProvider = configured.answerProvider || instanceDefaults.answerProvider;
  const answerModel = configured.answerModel
    || (configured.answerProvider ? defaultGenerationModelForProvider(answerProvider) : instanceDefaults.answerModel);

  const booleanAskProvider = configured.booleanAskProvider || answerProvider;
  const booleanAskModel = configured.booleanAskModel
    || (configured.booleanAskProvider
      ? defaultGenerationModelForProvider(booleanAskProvider)
      : (configured.answerModel || configured.answerProvider ? answerModel : instanceDefaults.booleanAskModel));

  const reflectProvider = configured.reflectProvider || instanceDefaults.reflectProvider;
  const reflectModel = configured.reflectModel
    || (configured.reflectProvider ? defaultReflectModelForProvider(reflectProvider) : instanceDefaults.reflectModel);

  const compactProvider = configured.compactProvider || reflectProvider;
  const compactModel = configured.compactModel
    || (configured.compactProvider
      ? defaultReflectModelForProvider(compactProvider)
      : (configured.reflectModel || configured.reflectProvider ? reflectModel : instanceDefaults.compactModel));

  return {
    configured,
    instanceDefaults,
    effective: {
      answerProvider,
      answerModel,
      booleanAskProvider,
      booleanAskModel,
      embedProvider: instanceDefaults.embedProvider,
      embedModel: instanceDefaults.embedModel,
      reflectProvider,
      reflectModel,
      compactProvider,
      compactModel
    }
  };
}

function parseTenantModelSettingsInput(body = {}) {
  const models = body && typeof body.models === "object" && body.models ? body.models : {};
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

  if (has(models, "embedModel") || has(body, "embedModel") || has(body, "embed_model")) {
    const error = new Error("embedModel is instance-wide. Change it in the self-hosted env or with `atlasrag changemodel`.");
    error.code = "INSTANCE_WIDE_MODEL";
    throw error;
  }
  if (has(models, "embedProvider") || has(body, "embedProvider") || has(body, "embed_provider")) {
    const error = new Error("embedProvider is instance-wide. Change it in the self-hosted env or with `atlasrag changemodel`.");
    error.code = "INSTANCE_WIDE_MODEL";
    throw error;
  }

  const parseModel = (value) => {
    if (value === undefined) return undefined;
    return normalizeModelId(value);
  };
  const parseProvider = (value) => {
    if (value === undefined) return undefined;
    return normalizeProviderId(value);
  };

  return {
    answerProvider: parseProvider(has(models, "answerProvider") ? models.answerProvider : (has(body, "answerProvider") ? body.answerProvider : body.answer_provider)),
    answerModel: parseModel(has(models, "answerModel") ? models.answerModel : (has(body, "answerModel") ? body.answerModel : body.answer_model)),
    booleanAskProvider: parseProvider(has(models, "booleanAskProvider") ? models.booleanAskProvider : (has(body, "booleanAskProvider") ? body.booleanAskProvider : body.boolean_ask_provider)),
    booleanAskModel: parseModel(has(models, "booleanAskModel") ? models.booleanAskModel : (has(body, "booleanAskModel") ? body.booleanAskModel : body.boolean_ask_model)),
    reflectProvider: parseProvider(has(models, "reflectProvider") ? models.reflectProvider : (has(body, "reflectProvider") ? body.reflectProvider : body.reflect_provider)),
    reflectModel: parseModel(has(models, "reflectModel") ? models.reflectModel : (has(body, "reflectModel") ? body.reflectModel : body.reflect_model)),
    compactProvider: parseProvider(has(models, "compactProvider") ? models.compactProvider : (has(body, "compactProvider") ? body.compactProvider : body.compact_provider)),
    compactModel: parseModel(has(models, "compactModel") ? models.compactModel : (has(body, "compactModel") ? body.compactModel : body.compact_model))
  };
}

function hasTenantModelSettingsInput(input = {}) {
  return input.answerProvider !== undefined
    || input.answerModel !== undefined
    || input.booleanAskProvider !== undefined
    || input.booleanAskModel !== undefined
    || input.reflectProvider !== undefined
    || input.reflectModel !== undefined
    || input.compactProvider !== undefined
    || input.compactModel !== undefined;
}

function resolveRequestedGenerationConfig({
  provider,
  model,
  fallbackProvider = DEFAULT_ANSWER_PROVIDER,
  fallbackModel = defaultGenerationModelForProvider(fallbackProvider)
}) {
  const requestedProvider = normalizeProviderId(provider);
  const effectiveProvider = requestedProvider || normalizeProviderId(fallbackProvider) || DEFAULT_ANSWER_PROVIDER;
  const effectiveModel = normalizeModelId(model)
    || (requestedProvider && requestedProvider !== normalizeProviderId(fallbackProvider)
      ? defaultGenerationModelForProvider(effectiveProvider)
      : normalizeModelId(fallbackModel)
        || defaultGenerationModelForProvider(effectiveProvider));
  return {
    provider: effectiveProvider,
    model: effectiveModel
  };
}

module.exports = {
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  CLI_DEFAULT_EMBED_MODEL: CATALOG_DEFAULT_EMBED_MODEL,
  GENERATION_PROVIDER_PRESETS,
  EMBEDDING_PROVIDER_PRESETS,
  GENERATION_MODEL_PRESETS,
  EMBEDDING_MODEL_PRESETS,
  normalizeProviderId,
  normalizeModelId,
  supportsTemperature,
  buildResponsesCreateParams,
  buildPublicModelCatalog,
  resolveEnvModelDefaults,
  extractTenantModelOverrides,
  resolveTenantModelSettings,
  parseTenantModelSettingsInput,
  hasTenantModelSettingsInput,
  resolveRequestedGenerationConfig
};
