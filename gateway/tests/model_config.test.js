const assert = require("assert/strict");

const {
  buildPublicModelCatalog,
  buildResponsesCreateParams,
  GENERATION_MODEL_PRESETS,
  GENERATION_PROVIDER_PRESETS,
  resolveEnvModelDefaults,
  resolveTenantModelSettings,
  parseTenantModelSettingsInput
} = require("../model_config");
const { __testHooks: answerHooks } = require("../answer");
const { __testHooks: aiHooks } = require("../ai");
const { __testHooks: reflectHooks } = require("../memory_reflect");

function withEnv(updates, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(updates || {})) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function testTenantModelInheritance() {
  const resolved = resolveTenantModelSettings({
    answer_provider: "gemini",
    answer_model: "gemini-2.5-pro",
    boolean_ask_provider: null,
    boolean_ask_model: null,
    reflect_provider: "anthropic",
    reflect_model: "claude-sonnet-4-20250514",
    compact_provider: null,
    compact_model: null
  }, {
    ANSWER_PROVIDER: "openai",
    ANSWER_MODEL: "gpt-5.2",
    BOOLEAN_ASK_PROVIDER: "",
    BOOLEAN_ASK_MODEL: "",
    EMBED_PROVIDER: "openai",
    EMBED_MODEL: "text-embedding-3-large",
    REFLECT_PROVIDER: "openai",
    REFLECT_MODEL: "gpt-5-mini",
    COMPACT_PROVIDER: "",
    COMPACT_MODEL: ""
  });

  assert.equal(resolved.effective.answerProvider, "gemini");
  assert.equal(resolved.effective.answerModel, "gemini-2.5-pro");
  assert.equal(resolved.effective.booleanAskProvider, "gemini");
  assert.equal(resolved.effective.booleanAskModel, "gemini-2.5-pro");
  assert.equal(resolved.effective.reflectProvider, "anthropic");
  assert.equal(resolved.effective.reflectModel, "claude-sonnet-4-20250514");
  assert.equal(resolved.effective.compactProvider, "anthropic");
  assert.equal(resolved.effective.compactModel, "claude-sonnet-4-20250514");
  assert.equal(resolved.effective.embedProvider, "openai");
  assert.equal(resolved.effective.embedModel, "text-embedding-3-large");
}

function testMissingTenantRecordUsesInstanceDefaults() {
  const resolved = resolveTenantModelSettings(null, {
    ANSWER_PROVIDER: "gemini",
    ANSWER_MODEL: "gemini-2.5-flash",
    EMBED_PROVIDER: "openai",
    EMBED_MODEL: "text-embedding-3-small",
    REFLECT_PROVIDER: "anthropic",
    REFLECT_MODEL: "claude-sonnet-4-20250514"
  });

  assert.equal(resolved.effective.answerProvider, "gemini");
  assert.equal(resolved.effective.answerModel, "gemini-2.5-flash");
  assert.equal(resolved.effective.embedProvider, "openai");
  assert.equal(resolved.effective.reflectProvider, "anthropic");
}

function testEmbedFallbackStaysCompatible() {
  const resolved = resolveEnvModelDefaults({
    ANSWER_PROVIDER: "",
    ANSWER_MODEL: "",
    BOOLEAN_ASK_PROVIDER: "",
    BOOLEAN_ASK_MODEL: "",
    EMBED_PROVIDER: "",
    EMBED_MODEL: "",
    REFLECT_PROVIDER: "",
    REFLECT_MODEL: "",
    COMPACT_PROVIDER: "",
    COMPACT_MODEL: ""
  });

  assert.equal(resolved.answerProvider, "openai");
  assert.equal(resolved.embedProvider, "openai");
  assert.equal(resolved.embedModel, "text-embedding-3-small");
}

function testTenantModelInputParsing() {
  const parsed = parseTenantModelSettingsInput({
    models: {
      answerProvider: " gemini ",
      answerModel: " gemini-2.5-pro ",
      booleanAskProvider: "",
      booleanAskModel: "",
      reflectProvider: "anthropic",
      reflectModel: "claude-sonnet-4-20250514",
      compactProvider: null,
      compactModel: null
    }
  });

  assert.equal(parsed.answerProvider, "gemini");
  assert.equal(parsed.answerModel, "gemini-2.5-pro");
  assert.equal(parsed.booleanAskProvider, null);
  assert.equal(parsed.booleanAskModel, null);
  assert.equal(parsed.reflectProvider, "anthropic");
  assert.equal(parsed.reflectModel, "claude-sonnet-4-20250514");
  assert.equal(parsed.compactProvider, null);
  assert.equal(parsed.compactModel, null);
  assert.throws(
    () => parseTenantModelSettingsInput({ models: { embedModel: "text-embedding-3-large" } }),
    /instance-wide/
  );
  assert.throws(
    () => parseTenantModelSettingsInput({ models: { embedProvider: "gemini" } }),
    /instance-wide/
  );
}

function testAnswerModelResolvers() {
  withEnv({
    ANSWER_PROVIDER: "openai",
    ANSWER_MODEL: "gpt-5.2",
    BOOLEAN_ASK_PROVIDER: "",
    BOOLEAN_ASK_MODEL: "",
    EMBED_PROVIDER: "openai",
    EMBED_MODEL: "text-embedding-3-large",
    REFLECT_PROVIDER: "openai",
    REFLECT_MODEL: "gpt-5-mini",
    COMPACT_PROVIDER: "",
    COMPACT_MODEL: ""
  }, () => {
    assert.equal(answerHooks.resolveAnswerProvider({ provider: "gemini" }), "gemini");
    assert.equal(answerHooks.resolveAnswerModel({ provider: "gemini", model: "gemini-2.5-pro" }), "gemini-2.5-pro");
    assert.equal(answerHooks.resolveAnswerModel({}), "gpt-5.2");
    assert.equal(answerHooks.resolveBooleanAskProvider({ provider: "anthropic" }), "anthropic");
    assert.equal(answerHooks.resolveBooleanAskModel({ provider: "anthropic", model: "claude-opus-4-20250514" }), "claude-opus-4-20250514");
  });
}

function testResponsesCompatibility() {
  for (const model of ["gpt-5.2", "gpt-5-mini", "gpt-5-nano", "gpt-5.1"]) {
    const params = buildResponsesCreateParams({
      provider: "openai",
      model,
      input: "hello",
      temperature: 0.2,
      max_output_tokens: 4096
    });
    assert.equal(Object.prototype.hasOwnProperty.call(params, "temperature"), false);
    assert.equal(params.max_output_tokens, 4096);
  }

  const o1 = buildResponsesCreateParams({
    provider: "openai",
    model: "o1",
    input: "hello",
    temperature: 0.2
  });
  assert.equal(Object.prototype.hasOwnProperty.call(o1, "temperature"), false);

  const gemini = buildResponsesCreateParams({
    provider: "gemini",
    model: "gemini-2.5-flash",
    input: "hello",
    temperature: 0.2
  });
  assert.equal(gemini.temperature, 0.2);
}

function testPublicModelCatalog() {
  const catalog = buildPublicModelCatalog();
  const generationModels = catalog.generation.map((item) => item.model);
  assert.deepEqual(
    generationModels,
    GENERATION_MODEL_PRESETS.map((item) => item.model)
  );
  assert.deepEqual(
    catalog.generationProviders.map((item) => item.provider),
    GENERATION_PROVIDER_PRESETS.map((item) => item.provider)
  );
  assert.equal(Array.isArray(catalog.generationByProvider.gemini), true);
  assert.equal(Array.isArray(catalog.generationByProvider.anthropic), true);
  assert.equal(catalog.generationByProvider.gemini.some((item) => item.model === "gemini-2.5-pro"), true);
  assert.equal(catalog.generationByProvider.anthropic.some((item) => item.model === "claude-sonnet-4-20250514"), true);
}

function testEmbedAndReflectResolvers() {
  withEnv({
    EMBED_PROVIDER: "gemini",
    EMBED_MODEL: "gemini-embedding-001",
    REFLECT_PROVIDER: "anthropic",
    REFLECT_MODEL: "claude-sonnet-4-20250514",
    COMPACT_PROVIDER: "",
    COMPACT_MODEL: ""
  }, () => {
    assert.equal(aiHooks.resolveEmbedProvider({}), "gemini");
    assert.equal(aiHooks.resolveEmbedModel({}), "gemini-embedding-001");
    assert.equal(aiHooks.resolveEmbedDimension({}), 3072);
    assert.equal(reflectHooks.resolveReflectProvider({}), "anthropic");
    assert.equal(reflectHooks.resolveReflectModel({}), "claude-sonnet-4-20250514");
    assert.equal(reflectHooks.resolveCompactProvider({}), "anthropic");
    assert.equal(reflectHooks.resolveCompactModel({ reflectProvider: "gemini", reflectModel: "gemini-2.5-flash" }), "gemini-2.5-flash");
  });
}

function main() {
  testEmbedFallbackStaysCompatible();
  testTenantModelInheritance();
  testMissingTenantRecordUsesInstanceDefaults();
  testTenantModelInputParsing();
  testAnswerModelResolvers();
  testResponsesCompatibility();
  testPublicModelCatalog();
  testEmbedAndReflectResolvers();
  console.log("model config tests passed");
}

main();
