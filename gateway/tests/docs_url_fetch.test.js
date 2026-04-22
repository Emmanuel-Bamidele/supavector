const assert = require("assert/strict");
const path = require("path");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

for (const pluginModulePath of [
  path.resolve(__dirname, "../plugins/index.js"),
  path.resolve(__dirname, "../../../supavector-portal/plugins/index.js")
]) {
  require.cache[pluginModulePath] = {
    id: pluginModulePath,
    filename: pluginModulePath,
    loaded: true,
    exports: {
      mount: () => null
    }
  };
}

const { __testHooks } = require("../index");

function makeHeaders(values = {}) {
  const map = {};
  for (const [key, value] of Object.entries(values)) {
    map[String(key || "").trim().toLowerCase()] = value;
  }
  return {
    get(name) {
      return map[String(name || "").trim().toLowerCase()] || null;
    }
  };
}

async function testNormalizeUrlFetchValidators() {
  assert.deepEqual(__testHooks.normalizeUrlFetchValidators(null), null);
  assert.deepEqual(__testHooks.normalizeUrlFetchValidators({
    etag: "\"etag-1\"",
    last_modified: "Mon, 21 Apr 2026 10:00:00 GMT"
  }), {
    etag: "\"etag-1\"",
    lastModified: "Mon, 21 Apr 2026 10:00:00 GMT"
  });
}

async function testFetchUrlTextHandlesNotModifiedResponses() {
  let capturedHeaders = null;
  const result = await __testHooks.fetchUrlText("https://example.com/docs", {
    validators: {
      etag: "\"etag-1\"",
      lastModified: "Mon, 21 Apr 2026 10:00:00 GMT"
    },
    deps: {
      assertPublicDnsHost: async () => null,
      fetchWithTimeout: async (_url, options) => {
        capturedHeaders = options.headers;
        return {
          status: 304,
          statusText: "Not Modified",
          ok: false,
          headers: makeHeaders({
            etag: "\"etag-1\"",
            "last-modified": "Mon, 21 Apr 2026 10:00:00 GMT"
          })
        };
      }
    }
  });

  assert.equal(capturedHeaders["If-None-Match"], "\"etag-1\"");
  assert.equal(capturedHeaders["If-Modified-Since"], "Mon, 21 Apr 2026 10:00:00 GMT");
  assert.equal(result.notModified, true);
  assert.equal(result.finalUrl, "https://example.com/docs");
  assert.equal(result.etag, "\"etag-1\"");
  assert.equal(result.lastModified, "Mon, 21 Apr 2026 10:00:00 GMT");
}

async function testFetchUrlTextReturnsValidatorsForIndexedResponses() {
  const result = await __testHooks.fetchUrlText("https://example.com/docs", {
    deps: {
      assertPublicDnsHost: async () => null,
      fetchWithTimeout: async () => ({
        status: 200,
        statusText: "OK",
        ok: true,
        headers: makeHeaders({
          "content-type": "text/html; charset=utf-8",
          etag: "\"etag-2\"",
          "last-modified": "Tue, 21 Apr 2026 11:00:00 GMT"
        })
      }),
      readResponseTextWithCap: async () => ({
        raw: "<html><body><h1>Docs</h1><p>Hosted sync content</p></body></html>",
        truncated: false
      }),
      extractTextFromHtml: () => "Docs Hosted sync content"
    }
  });

  assert.equal(result.notModified, false);
  assert.equal(result.finalUrl, "https://example.com/docs");
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.equal(result.etag, "\"etag-2\"");
  assert.equal(result.lastModified, "Tue, 21 Apr 2026 11:00:00 GMT");
  assert.match(result.text, /Hosted sync content/);
}

async function main() {
  await testNormalizeUrlFetchValidators();
  await testFetchUrlTextHandlesNotModifiedResponses();
  await testFetchUrlTextReturnsValidatorsForIndexedResponses();
  console.log("docs_url_fetch tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
