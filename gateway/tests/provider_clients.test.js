const assert = require("assert/strict");

const {
  generateProviderText,
  embedProviderTexts,
  resolveProviderApiKey,
  __testHooks
} = require("../provider_clients");

function withEnv(updates, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(updates || {})) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetchStub(handler, fn) {
  const previous = global.fetch;
  global.fetch = handler;
  try {
    await fn();
  } finally {
    global.fetch = previous;
  }
}

function makeJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

function makeErrorResponse(status, payload) {
  return {
    ok: false,
    status,
    statusText: payload?.message || `HTTP ${status}`,
    text: async () => JSON.stringify(payload)
  };
}

function makeEventStreamResponse(events) {
  const encoder = new TextEncoder();
  const chunks = (Array.isArray(events) ? events : []).map((entry) => {
    const eventName = String(entry?.event || "message").trim();
    const payload = entry?.data == null ? "" : JSON.stringify(entry.data);
    return encoder.encode(`event: ${eventName}\ndata: ${payload}\n\n`);
  });
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type"
          ? "text/event-stream; charset=utf-8"
          : null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { value: undefined, done: true };
            return { value: chunks[index++], done: false };
          }
        };
      }
    }
  };
}

function testResolveProviderApiKeyAliases() {
  withEnv({ GEMINI_API: "test-gemini-key", GEMINI_API_KEY: undefined }, () => {
    assert.equal(resolveProviderApiKey("gemini"), "test-gemini-key");
  });
}

async function testGeminiGeneration() {
  await withFetchStub(async (url, options) => {
    assert.match(String(url), /generateContent/);
    assert.equal(options.headers["x-goog-api-key"], "gemini-key");
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.maxOutputTokens, 2048);
    return makeJsonResponse({
      candidates: [{
        content: {
          parts: [{ text: "Gemini answer\nCitations: SOURCE-1" }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14
      }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "gemini",
      model: "gemini-2.5-flash",
      input: "hello",
      apiKey: "gemini-key",
      maxTokens: 2048
    });
    assert.equal(result.text, "Gemini answer\nCitations: SOURCE-1");
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 4);
  });
}

async function testAnthropicGeneration() {
  await withFetchStub(async (url, options) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    assert.equal(options.headers["x-api-key"], "anthropic-key");
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 8192);
    return makeJsonResponse({
      content: [{ type: "text", text: "Anthropic answer\nCitations: SOURCE-2" }],
      usage: { input_tokens: 9, output_tokens: 5 }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      input: "hello",
      apiKey: "anthropic-key",
      maxTokens: 8192
    });
    assert.equal(result.text, "Anthropic answer\nCitations: SOURCE-2");
    assert.equal(result.usage.total_tokens, 14);
  });
}

async function testGeminiGenerationRetriesTransientFailure() {
  let attempts = 0;
  await withFetchStub(async () => {
    attempts += 1;
    if (attempts === 1) {
      return makeErrorResponse(429, {
        error: {
          message: "Rate limit exceeded"
        }
      });
    }
    return makeJsonResponse({
      candidates: [{
        content: {
          parts: [{ text: "Recovered answer\nCitations: SOURCE-3" }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 5,
        totalTokenCount: 16
      }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "gemini",
      model: "gemini-2.5-flash",
      input: "hello",
      apiKey: "gemini-key",
      maxRetries: 1,
      retryDelayMs: 0,
      sleepFn: async () => {}
    });
    assert.equal(attempts, 2);
    assert.equal(result.text, "Recovered answer\nCitations: SOURCE-3");
    assert.equal(result.usage.total_tokens, 16);
  });
}

async function testGeminiGenerationRetriesBlankText() {
  let attempts = 0;
  await withFetchStub(async () => {
    attempts += 1;
    if (attempts === 1) {
      return makeJsonResponse({
        candidates: [{
          content: {
            parts: [{ text: "" }]
          }
        }],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 0,
          totalTokenCount: 8
        }
      });
    }
    return makeJsonResponse({
      candidates: [{
        content: {
          parts: [{ text: "Second try answer\nCitations: SOURCE-4" }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 4,
        totalTokenCount: 12
      }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "gemini",
      model: "gemini-2.5-flash",
      input: "hello",
      apiKey: "gemini-key",
      maxRetries: 1,
      retryDelayMs: 0,
      sleepFn: async () => {}
    });
    assert.equal(attempts, 2);
    assert.equal(result.text, "Second try answer\nCitations: SOURCE-4");
  });
}

async function testGeminiGenerationDoesNotRetryNonRetryableFailure() {
  let attempts = 0;
  await withFetchStub(async () => {
    attempts += 1;
    return makeErrorResponse(400, {
      error: {
        message: "Invalid request body"
      }
    });
  }, async () => {
    await assert.rejects(() => generateProviderText({
      provider: "gemini",
      model: "gemini-2.5-flash",
      input: "hello",
      apiKey: "gemini-key",
      maxRetries: 2,
      retryDelayMs: 0,
      sleepFn: async () => {}
    }), /Invalid request body/);
    assert.equal(attempts, 1);
  });
}

async function testAnthropicGenerationJsonMode() {
  await withFetchStub(async (url, options) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(options.body);
    assert.match(String(body.system || ""), /Return only a valid JSON object/);
    assert.equal(body.messages[1].role, "assistant");
    assert.equal(body.messages[1].content, "{");
    return makeJsonResponse({
      content: [{ type: "text", text: "\"ok\":true}" }],
      usage: { input_tokens: 7, output_tokens: 3 }
    });
  }, async () => {
    const result = await generateProviderText({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      input: { system: "Return JSON only.", user: "Give me a tiny JSON object." },
      apiKey: "anthropic-key",
      jsonMode: true,
      maxTokens: 512
    });
    assert.equal(result.text, "{\"ok\":true}");
    assert.equal(result.usage.total_tokens, 10);
  });
}

async function testGeminiStreamingGeneration() {
  await withFetchStub(async (url, options) => {
    assert.match(String(url), /streamGenerateContent\?alt=sse/);
    assert.equal(options.headers["x-goog-api-key"], "gemini-key");
    return makeEventStreamResponse([
      {
        data: {
          candidates: [{
            content: {
              parts: [{ text: "Gemini " }]
            }
          }]
        }
      },
      {
        data: {
          candidates: [{
            content: {
              parts: [{ text: "stream" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 2,
            totalTokenCount: 7
          }
        }
      }
    ]);
  }, async () => {
    const deltas = [];
    const result = await generateProviderText({
      provider: "gemini",
      model: "gemini-2.5-flash",
      input: "hello",
      apiKey: "gemini-key",
      onToken: async (delta) => {
        deltas.push(delta);
      }
    });
    assert.deepEqual(deltas, ["Gemini ", "stream"]);
    assert.equal(result.text, "Gemini stream");
    assert.equal(result.usage.total_tokens, 7);
  });
}

async function testAnthropicStreamingGeneration() {
  await withFetchStub(async (url, options) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    return makeEventStreamResponse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 6,
              output_tokens: 0
            }
          }
        }
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Anthropic "
          }
        }
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "stream"
          }
        }
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          usage: {
            input_tokens: 6,
            output_tokens: 2
          }
        }
      }
    ]);
  }, async () => {
    const deltas = [];
    const result = await generateProviderText({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      input: "hello",
      apiKey: "anthropic-key",
      onToken: async (delta) => {
        deltas.push(delta);
      }
    });
    assert.deepEqual(deltas, ["Anthropic ", "stream"]);
    assert.equal(result.text, "Anthropic stream");
    assert.equal(result.usage.total_tokens, 8);
  });
}

async function testGeminiEmbeddings() {
  await withFetchStub(async (url, options) => {
    assert.match(String(url), /embedContent/);
    const body = JSON.parse(options.body);
    assert.equal(body.taskType, "RETRIEVAL_QUERY");
    return makeJsonResponse({
      embedding: {
        values: [0.1, 0.2, 0.3]
      },
      usageMetadata: {
        promptTokenCount: 3,
        totalTokenCount: 3
      }
    });
  }, async () => {
    const result = await embedProviderTexts({
      provider: "gemini",
      texts: ["hello"],
      model: "gemini-embedding-001",
      apiKey: "gemini-key",
      taskType: "RETRIEVAL_QUERY"
    });
    assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]]);
    assert.equal(result.usage.prompt_tokens, 3);
  });
}

function testProviderClientHooks() {
  assert.equal(__testHooks.normalizeGeminiModelPath("models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(__testHooks.extractGeminiText({
    candidates: [{ content: { parts: [{ text: "hello" }, { text: "world" }] } }]
  }), "hello\nworld");
  assert.equal(__testHooks.extractAnthropicText({
    content: [{ type: "text", text: "hi" }, { type: "tool_result", text: "ignored" }]
  }), "hi");
  assert.equal(__testHooks.extractOpenAiText({
    output: [{
      content: [
        { type: "output_text", text: "{\"ok\":true}" }
      ]
    }]
  }), "{\"ok\":true}");
  assert.throws(
    () => __testHooks.ensureGeneratedText("", { provider: "openai", model: "gpt-5.2", jsonMode: true }),
    /returned no text/
  );
  const anthropicBody = __testHooks.buildAnthropicTextRequestBody({
    model: "claude-sonnet-4-20250514",
    input: { system: "Stay grounded.", user: "Return JSON only." },
    jsonMode: true,
    maxTokens: 256
  });
  assert.match(String(anthropicBody.system || ""), /Return only a valid JSON object/);
  assert.equal(anthropicBody.messages[1].role, "assistant");
  assert.equal(anthropicBody.messages[1].content, "{");
}

function testOpenAiRequestBuilderOmitsUnsupportedTemperature() {
  for (const model of ["gpt-5.2", "gpt-5-mini", "gpt-5-nano", "gpt-5.2-codex"]) {
    const body = __testHooks.buildOpenAiTextRequestBody({
      model,
      input: { system: "Follow the repo sources.", user: "Explain the auth flow." },
      temperature: 0.2,
      maxTokens: 2048
    });
    assert.equal(body.model, model);
    assert.equal(body.max_output_tokens, 2048);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "temperature"), false);
    assert.deepEqual(body.input, [
      { role: "developer", content: "Follow the repo sources." },
      { role: "user", content: "Explain the auth flow." }
    ]);
  }

  const legacyBody = __testHooks.buildOpenAiTextRequestBody({
    model: "gpt-4.1",
    input: "hello",
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 1024
  });
  assert.equal(legacyBody.temperature, 0.2);
  assert.equal(legacyBody.max_output_tokens, 1024);
  assert.deepEqual(legacyBody.text, { format: { type: "json_object" } });
}

async function main() {
  testResolveProviderApiKeyAliases();
  testProviderClientHooks();
  testOpenAiRequestBuilderOmitsUnsupportedTemperature();
  await testGeminiGeneration();
  await testAnthropicGeneration();
  await testGeminiGenerationRetriesTransientFailure();
  await testGeminiGenerationRetriesBlankText();
  await testGeminiGenerationDoesNotRetryNonRetryableFailure();
  await testAnthropicGenerationJsonMode();
  await testGeminiStreamingGeneration();
  await testAnthropicStreamingGeneration();
  await testGeminiEmbeddings();
  console.log("provider client tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
