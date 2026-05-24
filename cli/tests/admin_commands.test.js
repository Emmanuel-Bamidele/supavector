const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runCli(args, env = {}) {
  return withTempDir(async (dir) => {
    const homeDir = path.join(dir, "home");
    fs.mkdirSync(homeDir, { recursive: true });

    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join("bin", "supavector.js"), ...args],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            ...env
          }
        },
        (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve({
            stdout: String(stdout || ""),
            stderr: String(stderr || "")
          });
        }
      );
    });
  });
}

async function withMockServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        const parsedBody = body ? JSON.parse(body) : null;
        requests.push({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: req.headers,
          body: parsedBody
        });
        const response = await handler({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: req.headers,
          body: parsedBody
        });
        res.statusCode = response.status || 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response.body || { ok: true, data: {}, meta: {} }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: { message: String(err.message || err) }
        }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ baseUrl, requests });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supavector-cli-admin-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testTenantTokenCreateCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/admin/service-tokens");
    assert.equal(req.headers["x-api-key"], "supav_test_token");
    assert.deepEqual(req.body, {
      name: "worker-prod",
      principalId: "worker-prod",
      expiresAt: "2030-01-01T00:00:00.000Z",
      roles: ["reader", "indexer"]
    });
    return {
      body: {
        ok: true,
        data: {
          token: "supav_created_token",
          tokenInfo: {
            id: 7,
            tenantId: "default",
            name: "worker-prod",
            principalId: "worker-prod",
            roles: ["reader", "indexer"],
            expiresAt: "2030-01-01T00:00:00.000Z"
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "tokens",
      "create",
      "--name",
      "worker-prod",
      "--principal-id",
      "worker-prod",
      "--roles",
      "reader,indexer",
      "--expires-at",
      "2030-01-01T00:00:00.000Z",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.token, "supav_created_token");
    assert.equal(payload.data.tokenInfo.id, 7);
  });
}

async function testVectorRuntimeCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/v1/admin/vector/search-runtime");
    assert.equal(req.headers["x-api-key"], "supav_test_token");
    return {
      body: {
        ok: true,
        data: {
          vector: {
            vectors: 100,
            vectorDims: 1536,
            ann: {
              enabled: true,
              mode: "shadow",
              indexReady: true,
              indexVectors: 100,
              circuitOpen: false
            }
          },
          runtime: {
            total: 12,
            modes: { exact: 10, ann: 2 },
            fallbacks: {},
            dense_search_ms: { p95: 8 },
            scanned_count: { p95: 5000 },
            shadow: { top_k_overlap: { avg: 0.9 } }
          },
          reindex: {
            running: false,
            last: { status: "completed" }
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli(["vector", "runtime", "--json"], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.vector.ann.indexReady, true);
    assert.equal(payload.data.runtime.total, 12);
  });
}

async function testVectorReindexCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/admin/vector/reindex");
    assert.equal(req.headers["x-api-key"], "supav_test_token");
    assert.deepEqual(req.body, { mode: "auto" });
    return {
      body: {
        ok: true,
        data: {
          accepted: true,
          mode: "auto",
          reindex: {
            running: true,
            last: { status: "running" }
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli(["vector", "reindex", "--mode", "auto", "--json"], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.accepted, true);
    assert.equal(payload.data.mode, "auto");
  });
}

async function testTenantUpdateCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "PATCH");
    assert.equal(req.path, "/v1/admin/tenant");
    assert.deepEqual(req.body, {
      authMode: "sso_only",
      ssoProviders: ["google", "okta"],
      ssoConfig: {
        google: {
          clientId: "google-client",
          tenantClaim: "tid"
        }
      },
      answerProvider: "openai",
      answerModel: "gpt-5.2"
    });
    return {
      body: {
        ok: true,
        data: {
          tenant: {
            id: "default",
            authMode: "sso_only",
            ssoProviders: ["google", "okta"],
            ssoConfig: {
              google: {
                clientId: "google-client",
                tenantClaim: "tid"
              }
            },
            models: {
              effective: {
                answerProvider: "openai",
                answerModel: "gpt-5.2"
              }
            }
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "tenant",
      "update",
      "--auth-mode",
      "sso_only",
      "--sso-providers",
      "google,okta",
      "--sso-config-json",
      "{\"google\":{\"clientId\":\"google-client\",\"tenantClaim\":\"tid\"}}",
      "--answer-provider",
      "openai",
      "--answer-model",
      "gpt-5.2",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.tenant.authMode, "sso_only");
    assert.equal(payload.data.tenant.models.effective.answerModel, "gpt-5.2");
  });
}

async function testEnterpriseTenantCreateCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/admin/tenants");
    assert.deepEqual(req.body, {
      tenantId: "acme-prod",
      name: "Acme Prod",
      externalId: "acct_123",
      metadata: {
        plan: "enterprise",
        region: "us"
      },
      bootstrapAdmin: {
        username: "acme-admin",
        password: "SupaVectorPass123!",
        roles: ["admin", "indexer", "reader"],
        email: "admin@acme.example",
        fullName: "Acme Admin"
      },
      bootstrapServiceToken: {
        name: "acme-runtime",
        roles: ["reader", "indexer"]
      }
    });
    return {
      body: {
        ok: true,
        data: {
          tenant: {
            id: "acme-prod",
            name: "Acme Prod",
            externalId: "acct_123",
            metadata: {
              plan: "enterprise",
              region: "us"
            }
          },
          bootstrapAdmin: {
            user: {
              id: 21,
              username: "acme-admin"
            }
          },
          bootstrapServiceToken: {
            token: "supav_bootstrap_token",
            tokenInfo: {
              id: 31,
              name: "acme-runtime"
            }
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "tenants",
      "create",
      "--tenant",
      "acme-prod",
      "--name",
      "Acme Prod",
      "--external-id",
      "acct_123",
      "--metadata-json",
      "{\"plan\":\"enterprise\",\"region\":\"us\"}",
      "--bootstrap-admin",
      "acme-admin",
      "--bootstrap-admin-password",
      "SupaVectorPass123!",
      "--bootstrap-admin-roles",
      "admin,indexer,reader",
      "--bootstrap-admin-email",
      "admin@acme.example",
      "--bootstrap-admin-full-name",
      "Acme Admin",
      "--bootstrap-token-name",
      "acme-runtime",
      "--bootstrap-token-roles",
      "reader,indexer",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_TOKEN: "jwt_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.tenant.id, "acme-prod");
    assert.equal(payload.data.bootstrapServiceToken.token, "supav_bootstrap_token");
  });
}

async function testAuditListCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/v1/admin/tenants/acme-prod/audit");
    assert.deepEqual(req.query, {
      limit: "25",
      action: "tenant.settings.update"
    });
    return {
      body: {
        ok: true,
        data: {
          logs: [
            {
              id: 1,
              tenantId: "acme-prod",
              action: "tenant.settings.update"
            }
          ]
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "audit",
      "list",
      "--tenant",
      "acme-prod",
      "--limit",
      "25",
      "--action",
      "tenant.settings.update",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.logs.length, 1);
    assert.equal(payload.data.logs[0].tenantId, "acme-prod");
  });
}

async function testMemoriesCreateCommandWithConversationWiki() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/memories");
    assert.equal(req.headers["x-api-key"], "supav_test_token");
    assert.deepEqual(req.body, {
      name: "Support Memory",
      provider: "openai",
      model: "gpt-5.2",
      sourceConfig: {
        conversationMemory: {
          wikiKeepRecentTurns: 6,
          enabled: true,
          autoWriteDefault: true,
          includeInAskDefault: true,
          strategy: "hybrid_wiki",
          wikiEnabled: true
        }
      }
    });
    return {
      body: {
        ok: true,
        data: {
          memory: {
            id: "mem_support",
            name: "Support Memory",
            provider: "openai",
            model: "gpt-5.2",
            collection: "__brain_mem_support",
            sourceConfig: req.body.sourceConfig
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "memories",
      "create",
      "--name",
      "Support Memory",
      "--provider",
      "openai",
      "--model",
      "gpt-5.2",
      "--conversation-memory",
      "true",
      "--conversation-memory-auto-write",
      "true",
      "--conversation-memory-include-in-ask",
      "true",
      "--conversation-memory-strategy",
      "hybrid_wiki",
      "--source-config-json",
      "{\"conversationMemory\":{\"wikiKeepRecentTurns\":6}}",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.memory.id, "mem_support");
    assert.equal(payload.data.memory.sourceConfig.conversationMemory.strategy, "hybrid_wiki");
    assert.equal(payload.data.memory.sourceConfig.conversationMemory.wikiKeepRecentTurns, 6);
  });
}

async function testCodeCommand() {
  await withMockServer(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/code");
    assert.equal(req.headers["x-api-key"], "supav_test_token");
    assert.deepEqual(req.body, {
      question: "Why is auth middleware looping?",
      k: 7,
      docIds: ["middleware.ts"],
      answerLength: "short",
      task: "debug",
      language: "typescript",
      deployment: "vercel",
      repository: "acme/web",
      paths: ["src/middleware.ts", "src/auth.ts"],
      constraints: ["do not add dependencies"],
      errorMessage: "Too many redirects",
      stackTrace: "Error: redirect loop",
      context: { framework: "nextjs" },
      provider: "openai",
      model: "gpt-5.2"
    });
    return {
      body: {
        ok: true,
        data: {
          answer: "The refresh redirect loop starts in middleware.",
          provider: "openai",
          model: "gpt-5.2",
          files: [
            { path: "src/middleware.ts", repo: "acme/web", language: "typescript" }
          ],
          citations: [
            { path: "src/middleware.ts", docId: "middleware.ts" }
          ],
          sourceSummary: {
            repositories: ["acme/web"],
            languages: ["typescript"]
          }
        },
        meta: {}
      }
    };
  }, async ({ baseUrl }) => {
    const result = await runCli([
      "code",
      "--question",
      "Why is auth middleware looping?",
      "--k",
      "7",
      "--doc-ids",
      "middleware.ts",
      "--answer-length",
      "short",
      "--task",
      "debug",
      "--language",
      "typescript",
      "--deployment",
      "vercel",
      "--repository",
      "acme/web",
      "--paths",
      "src/middleware.ts,src/auth.ts",
      "--constraints",
      "do not add dependencies",
      "--error-message",
      "Too many redirects",
      "--stack-trace",
      "Error: redirect loop",
      "--context-json",
      "{\"framework\":\"nextjs\"}",
      "--provider",
      "openai",
      "--model",
      "gpt-5.2",
      "--json"
    ], {
      SUPAVECTOR_BASE_URL: baseUrl,
      SUPAVECTOR_API_KEY: "supav_test_token"
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.answer, "The refresh redirect loop starts in middleware.");
    assert.equal(payload.data.files[0].path, "src/middleware.ts");
  });
}

async function testWriteFolderCodebaseMetadata() {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{\n  \"name\": \"demo\"\n}\n", "utf8");
    fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n", "utf8");
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");

    await withMockServer(async (req) => {
      assert.equal(req.method, "POST");
      assert.equal(req.path, "/v1/docs");
      return {
        body: {
          ok: true,
          data: {
            docId: req.body.docId,
            chunksIndexed: 1
          },
          meta: {}
        }
      };
    }, async ({ baseUrl, requests }) => {
      const result = await runCli([
        "write",
        "--folder",
        dir,
        "--collection",
        "demo-codebase",
        "--json"
      ], {
        SUPAVECTOR_BASE_URL: baseUrl,
        SUPAVECTOR_API_KEY: "supav_test_token"
      });
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.collection, "demo-codebase");
      assert.equal(payload.indexed.length, 3);
      assert.equal(payload.skipped.length, 1);
      assert.match(payload.skipped[0].path, /node_modules/);

      const docs = requests.filter((item) => item.path === "/v1/docs");
      assert.equal(docs.length, 3);
      const tsDoc = docs.find((item) => item.body.docId === "src__index.ts");
      assert.equal(tsDoc.body.sourceType, "code");
      assert.equal(tsDoc.body.title, "src/index.ts");
      assert.deepEqual(tsDoc.body.metadata, {
        path: "src/index.ts",
        language: "typescript"
      });

      const readmeDoc = docs.find((item) => item.body.docId === "README.md");
      assert.equal(readmeDoc.body.sourceType, "text");
      assert.deepEqual(readmeDoc.body.metadata, {
        path: "README.md"
      });
    });
  });
}

async function testWriteGitHubRepoCommand() {
  await withTempDir(async (dir) => {
    const fakeGit = path.join(dir, "fake-git.sh");
    fs.writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "git version 2.42.0"
  exit 0
fi
if [ "$1" = "clone" ]; then
  target=""
  for arg in "$@"; do
    target="$arg"
  done
  mkdir -p "$target/src" "$target/node_modules/pkg"
  cat > "$target/package.json" <<'EOF'
{"name":"platform"}
EOF
  cat > "$target/src/main.ts" <<'EOF'
export function main() { return "ok"; }
EOF
  cat > "$target/README.md" <<'EOF'
# Platform
EOF
  cat > "$target/node_modules/pkg/index.js" <<'EOF'
module.exports = 1;
EOF
  exit 0
fi
echo "unexpected git args: $@" >&2
exit 1
`, { mode: 0o755 });

    await withMockServer(async (req) => {
      assert.equal(req.method, "POST");
      assert.equal(req.path, "/v1/docs");
      return {
        body: {
          ok: true,
          data: {
            docId: req.body.docId,
            chunksIndexed: 1
          },
          meta: {}
        }
      };
    }, async ({ baseUrl, requests }) => {
      const result = await runCli([
        "write",
        "--github-repo",
        "acme/platform",
        "--branch",
        "main",
        "--collection",
        "acme-platform",
        "--json"
      ], {
        SUPAVECTOR_BASE_URL: baseUrl,
        SUPAVECTOR_API_KEY: "supav_test_token",
        SUPAVECTOR_GIT_BIN: fakeGit
      });
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.collection, "acme-platform");
      assert.equal(payload.repository, "acme/platform");
      assert.equal(payload.branch, "main");
      assert.equal(payload.indexed.length, 3);

      const tsDoc = requests.find((item) => item.body.docId === "src__main.ts");
      assert.equal(tsDoc.body.sourceType, "code");
      assert.equal(tsDoc.body.sourceUrl, "https://github.com/acme/platform/blob/main/src/main.ts");
      assert.deepEqual(tsDoc.body.metadata, {
        provider: "github",
        repo: "acme/platform",
        branch: "main",
        path: "src/main.ts",
        language: "typescript"
      });
    });
  });
}

async function main() {
  await testVectorRuntimeCommand();
  await testVectorReindexCommand();
  await testTenantTokenCreateCommand();
  await testTenantUpdateCommand();
  await testEnterpriseTenantCreateCommand();
  await testAuditListCommand();
  await testMemoriesCreateCommandWithConversationWiki();
  await testCodeCommand();
  await testWriteFolderCodebaseMetadata();
  await testWriteGitHubRepoCommand();
  console.log("admin_commands.test.js passed");
}

main().catch((err) => {
  console.error(err.stack || String(err.message || err));
  process.exit(1);
});
