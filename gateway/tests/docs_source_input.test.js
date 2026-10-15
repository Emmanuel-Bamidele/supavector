const assert = require("assert");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

{
  const parsed = __testHooks.parseDocumentSourceInput({}, { defaultType: "text" });
  assert.deepStrictEqual(parsed, {
    title: null,
    metadata: null,
    sourceType: "text",
    sourceUrl: null
  });
}

{
  const parsed = __testHooks.parseDocumentSourceInput({
    title: "src/index.ts",
    sourceType: "code",
    sourceUrl: "https://github.com/acme/repo/blob/main/src/index.ts",
    metadata: {
      provider: "github",
      language: "typescript"
    }
  }, { defaultType: "text" });
  assert.deepStrictEqual(parsed, {
    title: "src/index.ts",
    metadata: {
      provider: "github",
      language: "typescript"
    },
    sourceType: "code",
    sourceUrl: "https://github.com/acme/repo/blob/main/src/index.ts"
  });
}

{
  const textOptions = __testHooks.resolveChunkingOptionsForSource({ type: "text" });
  const codeOptions = __testHooks.resolveChunkingOptionsForSource({ type: "code" });
  // Prose follows headings and sections by default (chunk_structured.js).
  assert.equal(textOptions.strategy, "structured");
  assert.equal(codeOptions.strategy, "code");
  assert.ok(codeOptions.maxTokens > textOptions.maxTokens);
}

console.log("docs_source_input tests passed");
