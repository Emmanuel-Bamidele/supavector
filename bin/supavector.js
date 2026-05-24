#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const { SupaVectorClient } = require("../sdk/node/src/client");
const {
  PACKAGE_ROOT,
  CONFIG_FILE,
  CONFIG_DIR,
  backupFileIfExists,
  boolFromFlag,
  DEFAULT_ANSWER_PROVIDER,
  DEFAULT_EMBED_PROVIDER,
  DEFAULT_REFLECT_PROVIDER,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  buildInstallBinDir,
  buildInstallRepoDir,
  buildShellPathLine,
  buildBaseUrlCandidates,
  buildComposeProjectName,
  buildComposeContext,
  classifyBundledPostgresBootstrapIssue,
  createOnboardConfig,
  defaultProviderSelection,
  defaultGenerationModelSelectionForProvider,
  defaultEmbeddingModelSelectionForProvider,
  defaultCollectionFromFolder,
  detectCodeLanguage,
  detectIngestibleFileType,
  isCodeLikePath,
  listEmbeddingModelPresets,
  listGenerationModelPresets,
  looksLikeCodebaseRoot,
  extractDocumentText,
  EMBEDDING_PROVIDER_PRESETS,
  GENERATION_PROVIDER_PRESETS,
  maskSecret,
  mergeEnvText,
  normalizeConfiguredModel,
  normalizeEmbeddingModelSelectionForProvider,
  normalizeGenerationModelSelectionForProvider,
  normalizeProviderSelection,
  parseCliArgs,
  parseGitHubRepoSpec,
  normalizeTcpPort,
  preferredBaseUrl,
  randomPassword,
  randomSecret,
  readConfig,
  readEnvAssignments,
  removePathEntry,
  resolveInstallHome,
  resolveBaseUrl,
  resolveProjectRoot,
  safeDocIdFromPath,
  shouldSkipCodebaseRelPath,
  stripManagedShellPath,
  writeConfig
} = require("../cli/lib");

function printHelp() {
  console.log(`SupaVector CLI

Usage:
  supavector onboard [--external-postgres] [--project-root PATH] [--force]
  supavector changemodel [--project-root PATH] [--answer-provider PROVIDER_OR_CHOICE] [--answer-model MODEL_OR_CHOICE] [--boolean-ask-provider PROVIDER|inherit] [--boolean-ask-model MODEL|inherit] [--embed-provider PROVIDER_OR_CHOICE] [--embed-model MODEL] [--reflect-provider PROVIDER_OR_CHOICE] [--reflect-model MODEL] [--compact-provider PROVIDER|inherit] [--compact-model MODEL|inherit] [--restart]
  supavector update [--project-root PATH]
  supavector uninstall [--yes]
  supavector start [--build]
  supavector stop [--down]
  supavector status [--json]
  supavector logs [--service gateway] [--tail 200]
  supavector doctor [--json]
  supavector bootstrap [--username USER] [--password PASS] [--tenant TENANT]
  supavector tenant get|update [setup flags...]
  supavector users list|create|update [user flags...]
  supavector tokens list|create|revoke [token flags...]
  supavector tenants list|get|create|update [enterprise flags...]
  supavector tenants users list|create|update --tenant TENANT [user flags...]
  supavector tenants tokens list|create|revoke --tenant TENANT [token flags...]
  supavector audit list [--tenant TENANT] [--limit 100]
  supavector vector runtime [--json]
  supavector vector reindex [--mode auto|always|off] [--json]
  supavector memories list|get|create|update|delete|status [memory flags...]
  supavector collections list [--json]
  supavector collections delete --collection NAME [--yes] [--json]
  supavector docs list [--collection NAME] [--json]
  supavector docs delete --doc-id ID [--collection NAME] [--yes] [--json]
  supavector docs replace --doc-id ID [--text TEXT | --file PATH | --url URL] [--collection NAME] [--yes] [--json]
  supavector write (--doc-id ID [--text TEXT | --file PATH | --url URL] | --folder PATH | --github-repo OWNER/REPO_OR_URL) [--collection NAME] [--replace] [--sync] [--branch BRANCH] [--yes] [--json]
  supavector search --q QUERY [--k 5] [--collection NAME] [--json]
  supavector ask --question TEXT [--k 5] [--collection NAME] [--policy amvl|ttl|lru] [--answer-length auto|short|medium|long] [--provider PROVIDER_OR_CHOICE] [--model MODEL_OR_CHOICE] [--json]
  supavector code --question TEXT [--k 5] [--collection NAME] [--task TASK] [--language LANG] [--deployment NAME] [--paths a,b] [--constraints a,b] [--error-message TEXT] [--stack-trace TEXT] [--repository NAME] [--provider PROVIDER_OR_CHOICE] [--model MODEL_OR_CHOICE] [--json]
  supavector boolean_ask --question TEXT [--k 5] [--collection NAME] [--policy amvl|ttl|lru] [--provider PROVIDER_OR_CHOICE] [--model MODEL_OR_CHOICE] [--json]
  supavector config show [--show-secrets]
  supavector help

Common flags:
  --project-root PATH          Use a specific SupaVector checkout
  --base-url URL               Override saved base URL
  --api-key KEY                Override saved service token
  --token JWT                  Override saved human/admin JWT
  --openai-key KEY             Send request-scoped X-OpenAI-API-Key
  --gemini-key KEY             Send request-scoped X-Gemini-API-Key
  --anthropic-key KEY          Send request-scoped X-Anthropic-API-Key
  --tenant TENANT              Override tenant scope
  --collection NAME            Override collection scope; folder writes use folder name if omitted
  --replace                    Replace matching docs before re-indexing
  --sync                       Reconcile a folder collection to exactly match local files
  --doc-ids a,b                Restrict retrieval to specific document ids
  --namespace-ids a,b          Restrict retrieval to fully-qualified namespace ids
  --tags a,b                   Require tag overlap during retrieval
  --agent-id ID                Restrict retrieval to one agent-scoped source
  --source-type TYPE[,TYPE]    Restrict retrieval by sourceType
  --document-type TYPE[,TYPE]  Restrict retrieval by metadata documentType
  --since ISO_TIMESTAMP        Apply a lower time bound during retrieval
  --until ISO_TIMESTAMP        Apply an upper time bound during retrieval
  --time-field createdAt|freshness
                               Choose created_at or metadata freshness timestamps for since/until
  --favor-recency true|false   Prefer fresher matching evidence when ranking
  --github-repo OWNER/REPO     Clone a GitHub repo to a temp dir and ingest it
  --branch NAME                Branch to clone for --github-repo
  --github-token TOKEN         Personal access token for private GitHub repo ingest
  --github-token-env NAME      Env var name that stores the GitHub token
  --restart                    Restart the local SupaVector stack after changing local settings
  --yes                        Skip destructive action confirmation prompts
  --json                       Print JSON output where supported

Onboarding / model flags:
  --admin-user USER
  --admin-password PASS
  --tenant TENANT
  --gateway-port PORT
  --provider PROVIDER_OR_CHOICE
  --answer-provider PROVIDER_OR_CHOICE
  --answer-model MODEL_OR_CHOICE
  --model MODEL_OR_CHOICE       Alias for --answer-model during onboarding
  --boolean-ask-provider PROVIDER
  --embed-model MODEL
  --embed-provider PROVIDER_OR_CHOICE
  --reflect-provider PROVIDER_OR_CHOICE
  --boolean-ask-model MODEL
  --reflect-model MODEL
  --compact-provider PROVIDER
  --compact-model MODEL
  --external-postgres
  --pg-host HOST
  --pg-port PORT
  --pg-database NAME
  --pg-user USER
  --pg-password PASS
  --gemini-key KEY
  --anthropic-key KEY
  --non-interactive            Fail instead of prompting for missing values
  --force                      Overwrite env file after creating a backup

Code command flags:
  --task TASK                  understand | debug | review | write | structure | general
  --language LANG              Prefer a language such as typescript, python, or go
  --deployment NAME            Runtime or deployment hint such as vercel, docker, aws lambda
  --repository NAME            Repository name hint such as acme/web
  --paths a,b                  File or folder paths to focus on
  --constraints a,b            Constraints for fixes or code generation
  --error-message TEXT         Error message or failing symptom
  --stack-trace TEXT           Stack trace or log excerpt
  --context-json JSON          Extra structured context for code analysis
  --context-file PATH          Read extra structured context from a JSON file

Tenant / enterprise setup flags:
  --name NAME
  --external-id ID
  --auth-mode sso_only|sso_plus_password|password_only
  --sso-providers google,azure,okta
  --sso-config-json JSON       Inline tenant SSO config object
  --sso-config-file PATH       Read tenant SSO config object from file
  --metadata-json JSON         Inline tenant metadata object
  --metadata-file PATH         Read tenant metadata object from file
  --body-json JSON             Inline full request body for advanced admin commands
  --body-file PATH             Read full request body from file
  --answer-provider VALUE
  --answer-model VALUE
  --boolean-ask-provider VALUE
  --boolean-ask-model VALUE
  --reflect-provider VALUE
  --reflect-model VALUE
  --compact-provider VALUE
  --compact-model VALUE
  --limit N
  --search TEXT
  --action NAME
  --target-type TYPE
  --target-id ID
  --mode auto|always|off        Reindex mode for vector admin commands

Memory flags:
  --id ID
  --description TEXT
  --role TEXT
  --personality TEXT
  --provider VALUE
  --model VALUE
  --instructions TEXT
  --metadata-json JSON         Inline memory metadata object
  --metadata-file PATH         Read memory metadata object from file
  --source-config-json JSON    Inline Memory sourceConfig object
  --source-config-file PATH    Read Memory sourceConfig object from file
  --conversation-memory true|false
  --conversation-memory-auto-write true|false
  --conversation-memory-include-in-ask true|false
  --conversation-memory-strategy turn_log|hybrid_wiki
  --conversation-wiki true|false

User / token setup flags:
  --id ID                      Target user or token id for update/revoke
  --username USER
  --password PASS
  --email EMAIL
  --full-name NAME
  --roles reader,indexer,admin[,instance_admin]
  --sso-only true|false
  --disabled true|false
  --name NAME                  Token display name
  --principal-id ID            Token principal id
  --expires-at ISO_TIMESTAMP
  --bootstrap-admin USER
  --bootstrap-admin-password PASS
  --bootstrap-admin-roles reader,indexer,admin[,instance_admin]
  --bootstrap-admin-email EMAIL
  --bootstrap-admin-full-name NAME
  --bootstrap-admin-sso-only true|false
  --bootstrap-token-name NAME
  --bootstrap-token-principal-id ID
  --bootstrap-token-roles reader,indexer,admin[,instance_admin]
  --bootstrap-token-expires-at ISO_TIMESTAMP
`);
}

const EXECUTABLE_CANDIDATES = {
  docker: [
    process.env.SUPAVECTOR_DOCKER_BIN,
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "docker"
  ].filter(Boolean),
  git: [
    process.env.SUPAVECTOR_GIT_BIN,
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "git"
  ].filter(Boolean),
  npm: [
    process.env.SUPAVECTOR_NPM_BIN,
    path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm"),
    "/usr/local/bin/npm",
    "/opt/homebrew/bin/npm",
    "npm"
  ].filter(Boolean)
};

function buildEnvWithNodePath(baseEnv = process.env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const nodeDir = path.dirname(process.execPath);
  const env = { ...baseEnv };
  const currentPath = String(env.PATH || "");
  const parts = currentPath ? currentPath.split(sep).filter(Boolean) : [];
  if (!parts.includes(nodeDir)) parts.unshift(nodeDir);
  env.PATH = parts.join(sep);
  return env;
}

function resolveExecutable(name, args = ["--version"], options = {}) {
  const candidates = EXECUTABLE_CANDIDATES[name] || [name];
  const env = options.env || process.env;
  for (const candidate of candidates) {
    const result = spawnSync(candidate, args, { encoding: "utf8", env });
    if (result.status === 0) return candidate;
    if (result.error && result.error.code === "ENOENT") continue;
  }
  return null;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("No output returned.");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Bootstrap output was not valid JSON.");
  }
}

function getFlag(parsed, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(parsed.flags, name)) return parsed.flags[name];
  }
  return undefined;
}

function normalizeSubcommand(parsed, allowed = []) {
  const raw = String(parsed.subcommand || "").trim().toLowerCase();
  if (allowed.includes(raw)) return raw;
  return "";
}

function ensureNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node 18+ is required. Current version: ${process.version}`);
  }
}

function ensureDockerAvailable() {
  if (!resolveExecutable("docker", ["--version"])) {
    throw new Error("Docker is required but was not found on PATH.");
  }
  if (!resolveExecutable("docker", ["compose", "version"])) {
    throw new Error("Docker Compose plugin is required. `docker compose version` failed.");
  }
}

function ensureGitAvailable() {
  const gitBin = resolveExecutable("git", ["--version"]);
  if (!gitBin) {
    throw new Error("git is required but was not found on PATH.");
  }
  return gitBin;
}

function ensureNpmAvailable() {
  const npmBin = resolveExecutable("npm", ["--version"], {
    env: buildEnvWithNodePath()
  });
  if (!npmBin) {
    throw new Error("npm is required but was not found alongside the current Node.js installation.");
  }
  return npmBin;
}

function runCommand(command, args, options = {}) {
  const capture = options.capture !== false;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    let stderr = "";

    if (capture && child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
    }
    if (capture && child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const message = capture
        ? String(stderr || stdout || `${command} exited with code ${code}`).trim()
        : `${command} exited with code ${code}`;
      const err = new Error(message);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function runCommandEcho(command, args, options = {}) {
  const result = await runCommand(command, args, { ...options, capture: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function buildComposeArgs(ctx) {
  const args = ["compose"];
  if (ctx.projectName) {
    args.push("-p", ctx.projectName);
  }
  args.push("-f", ctx.composeFile, "--env-file", ctx.envFile);
  return args;
}

async function runCompose(ctx, extraArgs, options = {}) {
  const dockerBin = resolveExecutable("docker", ["--version"]);
  if (!dockerBin) {
    throw new Error("Docker is required but was not found on PATH.");
  }
  return runCommand(dockerBin, [...buildComposeArgs(ctx), ...extraArgs], {
    cwd: ctx.projectRoot,
    capture: options.capture,
    env: options.env
  });
}

async function readComposeLogs(ctx, services, tail = 120) {
  try {
    const result = await runCompose(ctx, ["logs", "--tail", String(tail), ...services]);
    return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  } catch (err) {
    return `${err.stdout || ""}\n${err.stderr || ""}`.trim();
  }
}

async function diagnoseBundledPostgresBootstrapFailure(composeCtx, cliCommand = "supavector") {
  const env = readEnvAssignments(composeCtx.envFile);
  const [gatewayLogs, postgresLogs] = await Promise.all([
    readComposeLogs(composeCtx, ["gateway"]),
    readComposeLogs(composeCtx, ["postgres"])
  ]);
  const issue = classifyBundledPostgresBootstrapIssue({
    gatewayLogs,
    postgresLogs,
    expectedUser: env.POSTGRES_USER,
    expectedDatabase: env.POSTGRES_DB
  });
  if (!issue) return null;

  const expectedParts = [];
  if (issue.expectedUser) expectedParts.push(`user ${issue.expectedUser}`);
  if (issue.expectedDatabase) expectedParts.push(`database ${issue.expectedDatabase}`);
  const expectedText = expectedParts.length ? ` (${expectedParts.join(", ")})` : "";
  const existingDataText = issue.skipInitDetected
    ? " Postgres skipped initialization because the data directory already existed."
    : "";

  return {
    code: issue.code,
    message:
      `Bundled Postgres volume appears to have been initialized with different local credentials${expectedText}.`
      + existingDataText
      + ` This usually happens when another local SupaVector checkout already created the Docker volume for this compose project.`
      + ` If you do not need to keep that local data, run \`docker compose down -v\` in ${composeCtx.projectRoot} and rerun \`${cliCommand} onboard\`.`
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(payload?.error?.message || payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

function isHealthyPayload(payload) {
  if (payload?.ok === true) return true;
  if (payload?.data?.status === "ok") return true;
  return false;
}

function describeHealth(payload) {
  return payload?.tcp || payload?.data?.tcp || payload?.data?.status || "ok";
}

async function probeHostHealth(baseUrl) {
  let lastError = "Gateway did not become healthy.";
  for (const candidateBaseUrl of buildBaseUrlCandidates(baseUrl)) {
    for (const routePath of ["/health", "/v1/health"]) {
      try {
        const payload = await fetchJson(new URL(routePath, candidateBaseUrl).toString());
        if (isHealthyPayload(payload)) {
          return { baseUrl: candidateBaseUrl, routePath, payload };
        }
        lastError = `${candidateBaseUrl}${routePath}: gateway responded without a healthy payload.`;
      } catch (err) {
        lastError = `${candidateBaseUrl}${routePath}: ${String(err.message || err)}`;
      }
    }
  }
  throw new Error(lastError);
}

async function probeGatewayHealthInContainer(composeCtx) {
  const script = [
    `const routes = ${JSON.stringify(["/health", "/v1/health"])};`,
    "(async () => {",
    "  for (const routePath of routes) {",
    "    try {",
    "      const res = await fetch(`http://127.0.0.1:3000${routePath}`);",
    "      const text = await res.text();",
    "      let payload = null;",
    "      try { payload = text ? JSON.parse(text) : null; } catch {}",
    "      const healthy = payload && (payload.ok === true || (payload.data && payload.data.status === 'ok'));",
    "      if (res.ok && healthy) {",
    "        process.stdout.write(JSON.stringify({ routePath, payload }));",
    "        process.exit(0);",
    "        return;",
    "      }",
    "    } catch {}",
    "  }",
    "  throw new Error('Gateway did not return a healthy payload from inside the container.');",
    "})().catch((err) => {",
    "  console.error(String((err && err.message) || err));",
    "  process.exit(1);",
    "});"
  ].join("\n");

  const result = await runCompose(composeCtx, ["exec", "-T", "gateway", "node", "-e", script]);
  const payload = parseJsonFromStdout(result.stdout);
  if (!isHealthyPayload(payload?.payload)) {
    throw new Error("Gateway did not return a healthy payload from inside the container.");
  }
  return payload;
}

async function waitForHealth(baseUrl, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Gateway did not become healthy.";
  while (Date.now() < deadline) {
    try {
      return (await probeHostHealth(baseUrl)).payload;
    } catch (err) {
      lastError = String(err.message || err);
    }
    await sleep(2500);
  }
  throw new Error(`Timed out waiting for ${baseUrl} health routes: ${lastError}`);
}

async function waitForGatewayReady(composeCtx, baseUrl, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Gateway did not become healthy.";

  while (Date.now() < deadline) {
    try {
      const hostHealth = await probeHostHealth(baseUrl);
      return { source: "host", ...hostHealth };
    } catch (err) {
      lastError = `host probe failed: ${String(err.message || err)}`;
    }

    try {
      const containerHealth = await probeGatewayHealthInContainer(composeCtx);
      return { source: "container", ...containerHealth };
    } catch (err) {
      lastError = `${lastError}; container probe failed: ${String(err.message || err)}`;
    }

    await sleep(2500);
  }

  throw new Error(`Timed out waiting for ${baseUrl} health routes: ${lastError}`);
}

async function runBootstrapWithRetries(composeCtx, options = {}) {
  const attempts = Number.isFinite(options.attempts) && options.attempts > 0 ? options.attempts : 5;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs > 0 ? options.retryDelayMs : 2500;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const bootstrap = await runCompose(composeCtx, [
        "exec",
        "-T",
        "gateway",
        "node",
        "scripts/bootstrap_instance.js",
        "--username",
        options.adminUsername,
        "--password",
        options.adminPassword,
        "--tenant",
        options.tenantId,
        "--service-token-name",
        `${options.tenantId}-bootstrap`,
        "--json"
      ]);

      const payload = parseJsonFromStdout(bootstrap.stdout);
      const serviceToken = String(payload?.serviceToken?.token || "").trim();
      if (!serviceToken) {
        throw new Error("Bootstrap finished without returning a service token.");
      }
      return { payload, serviceToken };
    } catch (err) {
      lastError = err;
      if (typeof options.diagnoseFailure === "function") {
        const diagnosis = await options.diagnoseFailure(err, attempt);
        if (diagnosis?.message) {
          const diagnosed = new Error(diagnosis.message);
          diagnosed.code = diagnosis.code || err.code;
          diagnosed.cause = err;
          throw diagnosed;
        }
      }
      if (attempt >= attempts) break;
      console.log(`Bootstrap attempt ${attempt}/${attempts} failed; retrying in ${Math.round(retryDelayMs / 1000)}s...`);
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error("Bootstrap failed.");
}

function askVisible(prompt, defaultValue = "") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close();
      const value = String(answer || "").trim();
      resolve(value || defaultValue || "");
    });
  });
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(`Cannot prompt for ${prompt} without a TTY. Pass the flag explicitly.`));
      return;
    }

    const stdin = process.stdin;
    const stderr = process.stderr;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore.
      }
      stdin.pause();
    };

    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        stderr.write("\n");
        reject(new Error("Cancelled."));
        return;
      }
      if (text === "\r" || text === "\n") {
        cleanup();
        stderr.write("\n");
        resolve(value.trim());
        return;
      }
      if (text === "\u007f" || text === "\b" || text === "\x08") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stderr.write("\b \b");
        }
        return;
      }
      value += text;
      stderr.write("*");
    };

    stderr.write(`${prompt}: `);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

async function confirm(question, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = await askVisible(`${question}${suffix}`);
  if (!answer) return defaultYes;
  const text = answer.trim().toLowerCase();
  if (["y", "yes"].includes(text)) return true;
  if (["n", "no"].includes(text)) return false;
  return defaultYes;
}

async function resolvePromptValue({
  parsed,
  flags,
  names,
  prompt,
  defaultValue = "",
  secret = false,
  required = false,
  allowEmpty = false,
  transform = null
}) {
  const finalizeValue = (rawValue) => {
    const text = String(rawValue ?? "");
    if (!text && required && !allowEmpty) {
      throw new Error(`${prompt} is required.`);
    }
    return transform ? transform(text, prompt) : text;
  };

  for (const name of names) {
    const value = getFlag(parsed, name);
    if (value !== undefined && value !== true) {
      const text = String(value);
      if (text || allowEmpty) return finalizeValue(text);
    }
  }

  if (flags.nonInteractive) {
    if (required && !defaultValue && !allowEmpty) {
      throw new Error(`Missing required flag: --${names[0]}`);
    }
    return finalizeValue(defaultValue);
  }

  while (true) {
    const answer = secret
      ? await askHidden(prompt)
      : await askVisible(prompt, defaultValue);
    try {
      return finalizeValue(answer);
    } catch (err) {
      console.error(String(err.message || err));
    }
  }
}

function formatProviderPrompt(title, presets) {
  const lines = [title];
  for (const option of presets) {
    const defaultLabel = option.recommended ? " (Recommended)" : "";
    lines.push(`  ${option.key}. ${option.provider} - ${option.label}${defaultLabel}`);
  }
  return lines.join("\n");
}

function formatModelPrompt(title, provider, presets) {
  const lines = [`${title} (${provider})`];
  for (const option of presets) {
    const defaultLabel = option.recommended ? " (Recommended)" : "";
    lines.push(`  ${option.key}. ${option.model === "__custom__" ? option.label : `${option.model} - ${option.label}`}${defaultLabel}`);
  }
  return lines.join("\n");
}

async function resolveProviderChoice({
  parsed,
  nonInteractive,
  flagNames,
  prompt,
  existingValue,
  kind = "generation"
}) {
  const presets = kind === "embedding" ? EMBEDDING_PROVIDER_PRESETS : GENERATION_PROVIDER_PRESETS;
  for (const name of flagNames) {
    const value = getFlag(parsed, name);
    if (value !== undefined && value !== true) {
      return normalizeProviderSelection(value, kind, existingValue);
    }
  }
  const fallback = normalizeConfiguredModel(existingValue, kind === "embedding" ? DEFAULT_EMBED_PROVIDER : DEFAULT_ANSWER_PROVIDER);
  if (nonInteractive) return fallback;
  while (true) {
    const answer = await askVisible(
      formatProviderPrompt(prompt, presets),
      defaultProviderSelection(fallback, kind, fallback)
    );
    try {
      return normalizeProviderSelection(answer, kind, fallback);
    } catch (err) {
      console.error(String(err.message || err));
    }
  }
}

function normalizeCliModelFlag(value, provider, fallback = "", kind = "generation") {
  if (value === undefined || value === null || value === true) {
    return normalizeConfiguredModel(fallback, "");
  }
  const clean = String(value || "").trim();
  if (!clean) return normalizeConfiguredModel(fallback, "");
  if (kind === "embedding") {
    return normalizeEmbeddingModelSelectionForProvider(provider, clean, fallback);
  }
  return normalizeGenerationModelSelectionForProvider(provider, clean, fallback);
}

async function resolveProviderAwareModel({
  parsed,
  nonInteractive,
  flagNames,
  prompt,
  provider,
  existingValue,
  kind = "generation"
}) {
  const presets = kind === "embedding" ? listEmbeddingModelPresets(provider) : listGenerationModelPresets(provider);
  const fallback = normalizeConfiguredModel(
    existingValue,
    kind === "embedding"
      ? (provider === "openai" ? DEFAULT_EMBED_MODEL : "")
      : (provider === "openai" ? DEFAULT_ANSWER_MODEL : "")
  );
  for (const name of flagNames) {
    const value = getFlag(parsed, name);
    if (value !== undefined && value !== true) {
      return normalizeCliModelFlag(value, provider, fallback, kind);
    }
  }
  if (nonInteractive) return fallback;
  const customChoice = presets.find((item) => item.model === "__custom__");
  while (true) {
    const defaultSelection = kind === "embedding"
      ? defaultEmbeddingModelSelectionForProvider(provider, fallback, fallback)
      : defaultGenerationModelSelectionForProvider(provider, fallback, fallback);
    const answer = await askVisible(
      formatModelPrompt(prompt, provider, presets),
      defaultSelection
    );
    const clean = String(answer || "").trim();
    if (customChoice && clean === customChoice.key) {
      const existingCustom = presets.some((item) => item.model === fallback) ? "" : fallback;
      const custom = await askVisible(`Custom ${kind === "embedding" ? "embedding" : "generation"} model id`, existingCustom);
      const customClean = String(custom || "").trim();
      if (customClean) return customClean;
      console.error("Custom model id is required.");
      continue;
    }
    try {
      return normalizeCliModelFlag(clean, provider, fallback, kind);
    } catch (err) {
      console.error(String(err.message || err));
    }
  }
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function readTemplate(projectRoot, externalPostgres) {
  const fileName = externalPostgres ? ".env.external-postgres.example" : ".env.example";
  const filePath = path.join(projectRoot, fileName);
  ensureFileExists(filePath, "Env template");
  return fs.readFileSync(filePath, "utf8");
}

async function writeEnvFile({ projectRoot, externalPostgres, updates, force }) {
  const template = readTemplate(projectRoot, externalPostgres);
  const outputName = externalPostgres ? ".env.external-postgres" : ".env";
  const outputPath = path.join(projectRoot, outputName);

  let backupPath = null;
  if (fs.existsSync(outputPath)) {
    if (!force) {
      const okay = await confirm(`${outputName} already exists. Overwrite it after creating a backup?`, false);
      if (!okay) {
        throw new Error("Aborted without changing the env file.");
      }
    }
    backupPath = backupFileIfExists(outputPath);
  }

  const content = mergeEnvText(template, updates);
  fs.writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(outputPath, 0o600);
  } catch {
    // Best effort only.
  }
  return { outputPath, backupPath };
}

function normalizeCliOptionalModelFlag(value, provider, fallback = "", options = {}) {
  if (value === undefined || value === null || value === true) {
    return normalizeConfiguredModel(fallback, "");
  }
  const clean = String(value || "").trim();
  if (!clean) return "";
  const lowered = clean.toLowerCase();
  if (options.allowInherit && ["inherit", "default", "none", "clear"].includes(lowered)) {
    return "";
  }
  if (!options.allowInherit && ["inherit", "default", "none", "clear"].includes(lowered)) {
    throw new Error("Use a concrete model id for this command.");
  }
  return normalizeCliModelFlag(clean, provider, fallback, options.kind || "generation");
}

function resolveLocalEnvTarget(parsed) {
  const saved = readConfig();
  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  const savedProjectName = saved.projectRoot && path.resolve(saved.projectRoot) === path.resolve(projectRoot)
    ? String(saved.projectName || "").trim()
    : "";
  const seen = new Set();
  const candidates = [];

  const pushCandidate = (envFile, composeFile) => {
    const envName = String(envFile || "").trim();
    const composeName = String(composeFile || "").trim();
    if (!envName || !composeName) return;
    const key = `${envName}::${composeName}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ envFile: envName, composeFile: composeName });
  };

  if (saved.projectRoot && path.resolve(saved.projectRoot) === path.resolve(projectRoot)) {
    pushCandidate(saved.envFile || ".env", saved.composeFile || "docker-compose.yml");
  }
  pushCandidate(".env", "docker-compose.yml");
  pushCandidate(".env.external-postgres", "docker-compose.external-postgres.yml");

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(projectRoot, candidate.envFile))) {
      return {
        projectRoot,
        envFile: candidate.envFile,
        composeFile: candidate.composeFile,
        externalPostgres: candidate.envFile === ".env.external-postgres",
        projectName: savedProjectName
      };
    }
  }

  return {
    projectRoot,
    envFile: ".env",
    composeFile: "docker-compose.yml",
    externalPostgres: false,
    projectName: savedProjectName
  };
}

async function promptOptionalModel({
  parsed,
  nonInteractive,
  flagNames,
  prompt,
  provider,
  existingValue = "",
  allowInherit = true,
  kind = "generation"
}) {
  for (const name of flagNames) {
    const value = getFlag(parsed, name);
    if (value !== undefined) {
      return normalizeCliOptionalModelFlag(value, provider, existingValue, { allowInherit, kind });
    }
  }
  if (nonInteractive) {
    return normalizeConfiguredModel(existingValue, "");
  }
  const current = normalizeConfiguredModel(existingValue, "");
  const defaultValue = current || (allowInherit ? "inherit" : "");
  const answer = await askVisible(`${prompt}${allowInherit ? " (type inherit to clear)" : ""}`, defaultValue);
  return normalizeCliOptionalModelFlag(answer, provider, existingValue, { allowInherit, kind });
}

function firstNonEmptyValue(values = []) {
  for (const value of values) {
    const clean = String(value || "").trim();
    if (clean) return clean;
  }
  return "";
}

function readProviderKeyFromAssignments(assignments, provider) {
  if (provider === "gemini") {
    return firstNonEmptyValue([assignments.GEMINI_API_KEY, assignments.GEMINI_API]);
  }
  if (provider === "anthropic") {
    return firstNonEmptyValue([assignments.ANTHROPIC_API_KEY]);
  }
  return firstNonEmptyValue([assignments.OPENAI_API_KEY]);
}

async function resolveProviderApiKeyPrompt({
  parsed,
  nonInteractive,
  provider,
  existingEnv,
  saved
}) {
  if (provider === "gemini") {
    return resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["gemini-key"],
      prompt: "Gemini API key",
      defaultValue: firstNonEmptyValue([
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API,
        readProviderKeyFromAssignments(existingEnv, "gemini"),
        saved.geminiApiKey || ""
      ]),
      secret: true,
      required: true
    });
  }
  if (provider === "anthropic") {
    return resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["anthropic-key"],
      prompt: "Anthropic API key",
      defaultValue: firstNonEmptyValue([
        process.env.ANTHROPIC_API_KEY,
        readProviderKeyFromAssignments(existingEnv, "anthropic"),
        saved.anthropicApiKey || ""
      ]),
      secret: true,
      required: true
    });
  }
  return resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["openai-key"],
    prompt: "OpenAI API key",
    defaultValue: firstNonEmptyValue([
      process.env.OPENAI_API_KEY,
      readProviderKeyFromAssignments(existingEnv, "openai"),
      saved.openAiApiKey || ""
    ]),
    secret: true,
    required: true
  });
}

function printSummary(title, rows) {
  console.log(title);
  for (const row of rows) {
    console.log(`- ${row}`);
  }
}

function resolveClientConfig(parsed) {
  const saved = readConfig();
  const baseUrl = String(
    getFlag(parsed, "base-url")
    || process.env.SUPAVECTOR_BASE_URL
    || process.env.SUPAVECTOR_URL
    || saved.baseUrl
    || "http://localhost:3000"
  ).trim();
  const apiKey = String(
    getFlag(parsed, "api-key")
    || process.env.SUPAVECTOR_API_KEY
    || saved.apiKey
    || ""
  ).trim();
  const token = String(
    getFlag(parsed, "token")
    || process.env.SUPAVECTOR_TOKEN
    || saved.token
    || ""
  ).trim();
  const openAiApiKey = String(
    getFlag(parsed, "openai-key")
    || process.env.SUPAVECTOR_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY
    || saved.openAiApiKey
    || ""
  ).trim();
  const geminiApiKey = String(
    getFlag(parsed, "gemini-key")
    || process.env.SUPAVECTOR_GEMINI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GEMINI_API
    || saved.geminiApiKey
    || ""
  ).trim();
  const anthropicApiKey = String(
    getFlag(parsed, "anthropic-key")
    || process.env.SUPAVECTOR_ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || saved.anthropicApiKey
    || ""
  ).trim();
  const tenantId = String(
    getFlag(parsed, "tenant")
    || process.env.SUPAVECTOR_TENANT_ID
    || saved.tenantId
    || ""
  ).trim();
  const collection = String(
    getFlag(parsed, "collection")
    || process.env.SUPAVECTOR_COLLECTION
    || saved.collection
    || ""
  ).trim();
  return {
    baseUrl,
    clientBaseUrl: preferredBaseUrl(baseUrl),
    apiKey,
    token,
    openAiApiKey,
    geminiApiKey,
    anthropicApiKey,
    tenantId,
    collection
  };
}

function buildClient(parsed, options = {}) {
  const cfg = resolveClientConfig(parsed);
  if (!cfg.apiKey && !cfg.token) {
    throw new Error(`No SupaVector credential is configured. Run \`supavector onboard\` first or set ${"`SUPAVECTOR_API_KEY`"} / ${"`SUPAVECTOR_TOKEN`"}.`);
  }
  return new SupaVectorClient({
    baseUrl: cfg.clientBaseUrl,
    apiKey: cfg.apiKey || null,
    token: cfg.apiKey ? null : cfg.token,
    openAiApiKey: cfg.openAiApiKey || null,
    geminiApiKey: cfg.geminiApiKey || null,
    anthropicApiKey: cfg.anthropicApiKey || null,
    tenantId: cfg.tenantId || null,
    collection: options.ignoreCollection ? null : (cfg.collection || null)
  });
}

async function ensureConfirmedAction(parsed, question, defaultYes = false) {
  if (boolFromFlag(getFlag(parsed, "yes"), false)) return;
  if (!process.stdin.isTTY) {
    throw new Error(`${question} Re-run with --yes to continue non-interactively.`);
  }
  const approved = await confirm(question, defaultYes);
  if (!approved) {
    throw new Error("Cancelled.");
  }
}

function resolveRequestedCollection(parsed, fallback = "default") {
  const value = String(getFlag(parsed, "collection") || "").trim();
  return value || fallback;
}

function buildWriteParams(parsed, overrides = {}) {
  const params = {
    collection: getFlag(parsed, "collection"),
    tenantId: getFlag(parsed, "tenant"),
    policy: getFlag(parsed, "policy"),
    expiresAt: getFlag(parsed, "expires-at"),
    visibility: getFlag(parsed, "visibility"),
    acl: parseListFlag(getFlag(parsed, "acl")),
    agentId: getFlag(parsed, "agent-id"),
    tags: parseListFlag(getFlag(parsed, "tags")),
    idempotencyKey: `supavector-cli-${Date.now()}-${randomSecret(6)}`
  };
  return { ...params, ...overrides };
}

async function deleteDocumentForUpdate(client, docId, params = {}) {
  try {
    await client.deleteDoc(docId, params);
  } catch (err) {
    if (err?.status === 404) return;
    throw err;
  }
}

async function indexDocumentInput(client, docId, text, url, params = {}) {
  return url
    ? client.indexUrl(docId, url, params)
    : client.indexText(docId, text, params);
}

function formatCollectionCount(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

async function handleOnboard(parsed) {
  ensureNodeVersion();
  ensureDockerAvailable();

  const saved = readConfig();
  const nonInteractive = boolFromFlag(getFlag(parsed, "non-interactive"), false);
  const externalPostgres = boolFromFlag(getFlag(parsed, "external-postgres"), false);
  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  const projectName = String(saved.projectName || "").trim() || buildComposeProjectName(projectRoot);
  const outputName = externalPostgres ? ".env.external-postgres" : ".env";
  const existingEnvPath = path.join(projectRoot, outputName);
  const existingEnv = readEnvAssignments(existingEnvPath);
  const gatewayPort = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["gateway-port"],
    prompt: "Gateway port",
    defaultValue: "3000",
    required: true,
    transform: normalizeTcpPort
  });
  const adminUsername = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["admin-user", "username"],
    prompt: "Admin username",
    defaultValue: saved.adminUsername || "admin",
    required: true
  });
  const adminPassword = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["admin-password", "password"],
    prompt: "Admin password",
    defaultValue: "",
    secret: true,
    required: true
  });
  const tenantId = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["tenant"],
    prompt: "Tenant id",
    defaultValue: saved.tenantId || "default",
    required: true
  });
  const answerProvider = await resolveProviderChoice({
    parsed,
    nonInteractive,
    flagNames: ["answer-provider", "provider"],
    prompt: "Default generation provider",
    existingValue: existingEnv.ANSWER_PROVIDER || DEFAULT_ANSWER_PROVIDER,
    kind: "generation"
  });
  const answerModel = await resolveProviderAwareModel({
    parsed,
    nonInteractive,
    flagNames: ["answer-model", "model"],
    prompt: "Default generation model",
    provider: answerProvider,
    existingValue: existingEnv.ANSWER_MODEL,
    kind: "generation"
  });
  const booleanAskProvider = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["boolean-ask-provider"],
    prompt: "Boolean ask provider (type inherit to clear)",
    defaultValue: normalizeConfiguredModel(existingEnv.BOOLEAN_ASK_PROVIDER, "") || "inherit",
    required: false
  }).then((value) => {
    const clean = String(value || "").trim();
    if (!clean || ["inherit", "default", "none", "clear"].includes(clean.toLowerCase())) return "";
    return normalizeProviderSelection(clean, "generation", answerProvider);
  });
  const effectiveBooleanProvider = booleanAskProvider || answerProvider;
  const booleanAskModel = await promptOptionalModel({
    parsed,
    nonInteractive,
    flagNames: ["boolean-ask-model"],
    prompt: "Boolean ask model",
    provider: effectiveBooleanProvider,
    existingValue: normalizeConfiguredModel(existingEnv.BOOLEAN_ASK_MODEL, ""),
    allowInherit: true,
    kind: "generation"
  });
  const embedProvider = await resolveProviderChoice({
    parsed,
    nonInteractive,
    flagNames: ["embed-provider"],
    prompt: "Embedding provider",
    existingValue: existingEnv.EMBED_PROVIDER || DEFAULT_EMBED_PROVIDER,
    kind: "embedding"
  });
  const embedModel = await resolveProviderAwareModel({
    parsed,
    nonInteractive,
    flagNames: ["embed-model"],
    prompt: "Embedding model",
    provider: embedProvider,
    existingValue: existingEnv.EMBED_MODEL || (embedProvider === "openai" ? DEFAULT_EMBED_MODEL : ""),
    kind: "embedding"
  });
  const reflectProvider = await resolveProviderChoice({
    parsed,
    nonInteractive,
    flagNames: ["reflect-provider"],
    prompt: "Reflect provider",
    existingValue: existingEnv.REFLECT_PROVIDER || DEFAULT_REFLECT_PROVIDER,
    kind: "generation"
  });
  const reflectModel = await resolveProviderAwareModel({
    parsed,
    nonInteractive,
    flagNames: ["reflect-model"],
    prompt: "Reflect model",
    provider: reflectProvider,
    existingValue: existingEnv.REFLECT_MODEL,
    kind: "generation"
  });
  const compactProvider = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["compact-provider"],
    prompt: "Compact provider (type inherit to clear)",
    defaultValue: normalizeConfiguredModel(existingEnv.COMPACT_PROVIDER, "") || "inherit",
    required: false
  }).then((value) => {
    const clean = String(value || "").trim();
    if (!clean || ["inherit", "default", "none", "clear"].includes(clean.toLowerCase())) return "";
    return normalizeProviderSelection(clean, "generation", reflectProvider);
  });
  const effectiveCompactProvider = compactProvider || reflectProvider;
  const compactModel = await promptOptionalModel({
    parsed,
    nonInteractive,
    flagNames: ["compact-model"],
    prompt: "Compact model",
    provider: effectiveCompactProvider,
    existingValue: normalizeConfiguredModel(existingEnv.COMPACT_MODEL, ""),
    allowInherit: true,
    kind: "generation"
  });

  const providerSet = new Set([
    answerProvider,
    effectiveBooleanProvider,
    embedProvider,
    reflectProvider,
    effectiveCompactProvider
  ]);
  const openAiApiKey = providerSet.has("openai")
    ? await resolveProviderApiKeyPrompt({ parsed, nonInteractive, provider: "openai", existingEnv, saved })
    : readProviderKeyFromAssignments(existingEnv, "openai");
  const geminiApiKey = providerSet.has("gemini")
    ? await resolveProviderApiKeyPrompt({ parsed, nonInteractive, provider: "gemini", existingEnv, saved })
    : readProviderKeyFromAssignments(existingEnv, "gemini");
  const anthropicApiKey = providerSet.has("anthropic")
    ? await resolveProviderApiKeyPrompt({ parsed, nonInteractive, provider: "anthropic", existingEnv, saved })
    : readProviderKeyFromAssignments(existingEnv, "anthropic");

  const jwtSecret = existingEnv.JWT_SECRET || randomSecret(32);
  const cookieSecret = existingEnv.COOKIE_SECRET || randomSecret(32);
  const baseUrl = resolveBaseUrl(gatewayPort);
  let envUpdates = {
    ...existingEnv,
    OPENAI_API_KEY: openAiApiKey,
    GEMINI_API_KEY: geminiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey,
    JWT_SECRET: jwtSecret,
    COOKIE_SECRET: cookieSecret,
    PUBLIC_BASE_URL: baseUrl,
    OPENAPI_BASE_URL: baseUrl,
    GATEWAY_HOST_PORT: gatewayPort,
    ANSWER_PROVIDER: answerProvider,
    ANSWER_MODEL: answerModel,
    BOOLEAN_ASK_PROVIDER: booleanAskProvider,
    BOOLEAN_ASK_MODEL: booleanAskModel,
    EMBED_PROVIDER: embedProvider,
    EMBED_MODEL: embedModel,
    REFLECT_PROVIDER: reflectProvider,
    REFLECT_MODEL: reflectModel,
    COMPACT_PROVIDER: compactProvider,
    COMPACT_MODEL: compactModel
  };
  let composeFile = "docker-compose.yml";
  let envFile = ".env";

  if (externalPostgres) {
    composeFile = "docker-compose.external-postgres.yml";
    envFile = ".env.external-postgres";
    const pgHost = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-host"],
      prompt: "Postgres host",
      defaultValue: "127.0.0.1",
      required: true
    });
    const pgPort = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-port"],
      prompt: "Postgres port",
      defaultValue: "5432",
      required: true,
      transform: normalizeTcpPort
    });
    const pgDatabase = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-database"],
      prompt: "Postgres database",
      defaultValue: "supavector",
      required: true
    });
    const pgUser = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-user"],
      prompt: "Postgres user",
      defaultValue: "supavector",
      required: true
    });
    const pgPassword = await resolvePromptValue({
      parsed,
      flags: { nonInteractive },
      names: ["pg-password"],
      prompt: "Postgres password",
      defaultValue: "",
      secret: true,
      required: true
    });

    envUpdates = {
      ...envUpdates,
      PGHOST: pgHost,
      PGPORT: pgPort,
      PGDATABASE: pgDatabase,
      PGUSER: pgUser,
      PGPASSWORD: pgPassword
    };
  } else {
    envUpdates = {
      ...envUpdates,
      POSTGRES_PASSWORD: existingEnv.POSTGRES_PASSWORD || randomPassword(24)
    };
  }

  const { outputPath, backupPath } = await writeEnvFile({
    projectRoot,
    externalPostgres,
    updates: envUpdates,
    force: boolFromFlag(getFlag(parsed, "force"), false)
  });

  const composeCtx = buildComposeContext(projectRoot, { composeFile, envFile, projectName });
  console.log(`Using project root: ${projectRoot}`);
  console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
  if (backupPath) {
    console.log(`Backup created: ${path.relative(projectRoot, backupPath)}`);
  }

  // Save the local project/base URL context before any startup step that can
  // fail so users can resume with `supavector bootstrap` if onboarding stops.
  writeConfig(createOnboardConfig({
    projectRoot,
    projectName,
    mode: externalPostgres ? "external-postgres" : "bundled-postgres",
    envFile,
    composeFile,
    baseUrl,
    tenantId,
    adminUsername,
    apiKey: saved.apiKey || "",
    openAiApiKey,
    geminiApiKey,
    anthropicApiKey,
    onboardingPending: true
  }));

  console.log("Starting SupaVector services...");
  await runCompose(composeCtx, ["up", "-d", "--build"], { capture: false });

  console.log("Bootstrapping the first admin and service token...");
  const { payload, serviceToken } = await runBootstrapWithRetries(composeCtx, {
    adminUsername,
    adminPassword,
    tenantId,
    attempts: 60,
    retryDelayMs: 2500,
    diagnoseFailure: externalPostgres
      ? null
      : () => diagnoseBundledPostgresBootstrapFailure(composeCtx, "supavector")
  });

  writeConfig(createOnboardConfig({
    projectRoot,
    projectName,
    mode: externalPostgres ? "external-postgres" : "bundled-postgres",
    envFile,
    composeFile,
    baseUrl,
    tenantId,
    adminUsername,
    apiKey: serviceToken,
    openAiApiKey,
    geminiApiKey,
    anthropicApiKey,
    onboardingPending: false
  }));

  let hostHealthSettled = false;
  let readinessSource = "";
  console.log(`Checking SupaVector gateway readiness (${baseUrl}/health) ...`);
  try {
    const readiness = await waitForGatewayReady(composeCtx, baseUrl, 30000);
    readinessSource = readiness.source;
    hostHealthSettled = readiness.source === "host";
    if (readiness.source === "container") {
      console.log("Gateway responded inside Docker. Host routing may still be settling.");
    }
  } catch {
    hostHealthSettled = false;
  }
  if (!hostHealthSettled && readinessSource === "container") {
    try {
      await waitForHealth(baseUrl, 15000);
      hostHealthSettled = true;
    } catch {
      hostHealthSettled = false;
    }
  }

  console.log("");
  const summaryRows = [
    `App URL: ${baseUrl}`,
    `Docs URL: ${baseUrl}/docs`,
    `Admin username: ${adminUsername}`,
    `Tenant: ${tenantId}`,
    `Service token: ${maskSecret(serviceToken)}`,
    `CLI config: ${CONFIG_FILE}`,
    "Next: supavector status",
    "Try: supavector write --doc-id welcome --text \"SupaVector stores memory for agents.\"",
    "Then: supavector ask --question \"What does SupaVector store?\"",
    "Or: supavector boolean_ask --question \"Is SupaVector designed for agents?\""
  ];
  if (!hostHealthSettled) {
    summaryRows.push(`Host health is still settling at ${baseUrl}; retry \`supavector status\` in a few seconds if needed.`);
  }
  printSummary("SupaVector is ready.", summaryRows);
}

async function handleChangeModel(parsed) {
  const nonInteractive = boolFromFlag(getFlag(parsed, "non-interactive"), false);
  const target = resolveLocalEnvTarget(parsed);
  const envPath = path.join(target.projectRoot, target.envFile);
  const existingEnv = readEnvAssignments(envPath);

  const currentAnswerProvider = normalizeConfiguredModel(existingEnv.ANSWER_PROVIDER, DEFAULT_ANSWER_PROVIDER);
  const currentAnswerModel = normalizeConfiguredModel(existingEnv.ANSWER_MODEL, DEFAULT_ANSWER_MODEL);
  const currentBooleanAskProvider = normalizeConfiguredModel(existingEnv.BOOLEAN_ASK_PROVIDER, "");
  const currentBooleanAskModel = normalizeConfiguredModel(existingEnv.BOOLEAN_ASK_MODEL, "");
  const currentEmbedProvider = normalizeConfiguredModel(existingEnv.EMBED_PROVIDER, DEFAULT_EMBED_PROVIDER);
  const currentEmbedModel = normalizeConfiguredModel(existingEnv.EMBED_MODEL, DEFAULT_EMBED_MODEL);
  const currentReflectProvider = normalizeConfiguredModel(existingEnv.REFLECT_PROVIDER, DEFAULT_REFLECT_PROVIDER);
  const currentReflectModel = normalizeConfiguredModel(existingEnv.REFLECT_MODEL, DEFAULT_REFLECT_MODEL);
  const currentCompactProvider = normalizeConfiguredModel(existingEnv.COMPACT_PROVIDER, "");
  const currentCompactModel = normalizeConfiguredModel(existingEnv.COMPACT_MODEL, "");

  const answerProvider = await resolveProviderChoice({
    parsed,
    nonInteractive,
    flagNames: ["answer-provider", "provider"],
    prompt: "Default generation provider",
    existingValue: currentAnswerProvider,
    kind: "generation"
  });
  const answerModel = await resolveProviderAwareModel({
    parsed,
    nonInteractive,
    flagNames: ["answer-model", "model"],
    prompt: "Default generation model",
    provider: answerProvider,
    existingValue: currentAnswerModel,
    kind: "generation"
  });
  const booleanAskProvider = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["boolean-ask-provider"],
    prompt: "Boolean ask provider (type inherit to clear)",
    defaultValue: currentBooleanAskProvider || "inherit",
    required: false
  }).then((value) => {
    const clean = String(value || "").trim();
    if (!clean || ["inherit", "default", "none", "clear"].includes(clean.toLowerCase())) return "";
    return normalizeProviderSelection(clean, "generation", answerProvider);
  });
  const effectiveBooleanProvider = booleanAskProvider || answerProvider;
  const booleanAskModel = await promptOptionalModel({
    parsed,
    nonInteractive,
    flagNames: ["boolean-ask-model"],
    prompt: "Boolean ask model",
    provider: effectiveBooleanProvider,
    existingValue: currentBooleanAskModel,
    allowInherit: true,
    kind: "generation"
  });
  const embedProvider = await resolveProviderChoice({
    parsed,
    nonInteractive,
    flagNames: ["embed-provider"],
    prompt: "Embedding provider",
    existingValue: currentEmbedProvider,
    kind: "embedding"
  });
  const embedModel = await resolveProviderAwareModel({
    parsed,
    nonInteractive,
    flagNames: ["embed-model"],
    prompt: "Embedding model",
    provider: embedProvider,
    existingValue: currentEmbedModel,
    kind: "embedding"
  });
  const reflectProvider = await resolveProviderChoice({
    parsed,
    nonInteractive,
    flagNames: ["reflect-provider"],
    prompt: "Reflect provider",
    existingValue: currentReflectProvider,
    kind: "generation"
  });
  const reflectModel = await resolveProviderAwareModel({
    parsed,
    nonInteractive,
    flagNames: ["reflect-model"],
    prompt: "Reflect model",
    provider: reflectProvider,
    existingValue: currentReflectModel,
    kind: "generation"
  });
  const compactProvider = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["compact-provider"],
    prompt: "Compact provider (type inherit to clear)",
    defaultValue: currentCompactProvider || "inherit",
    required: false
  }).then((value) => {
    const clean = String(value || "").trim();
    if (!clean || ["inherit", "default", "none", "clear"].includes(clean.toLowerCase())) return "";
    return normalizeProviderSelection(clean, "generation", reflectProvider);
  });
  const effectiveCompactProvider = compactProvider || reflectProvider;
  const compactModel = await promptOptionalModel({
    parsed,
    nonInteractive,
    flagNames: ["compact-model"],
    prompt: "Compact model",
    provider: effectiveCompactProvider,
    existingValue: currentCompactModel,
    allowInherit: true,
    kind: "generation"
  });

  const embedChanged = embedModel !== currentEmbedModel || embedProvider !== currentEmbedProvider;
  const providerSet = new Set([
    answerProvider,
    effectiveBooleanProvider,
    embedProvider,
    reflectProvider,
    effectiveCompactProvider
  ]);
  const openAiApiKey = providerSet.has("openai")
    ? await resolveProviderApiKeyPrompt({ parsed, nonInteractive, provider: "openai", existingEnv, saved: readConfig() })
    : readProviderKeyFromAssignments(existingEnv, "openai");
  const geminiApiKey = providerSet.has("gemini")
    ? await resolveProviderApiKeyPrompt({ parsed, nonInteractive, provider: "gemini", existingEnv, saved: readConfig() })
    : readProviderKeyFromAssignments(existingEnv, "gemini");
  const anthropicApiKey = providerSet.has("anthropic")
    ? await resolveProviderApiKeyPrompt({ parsed, nonInteractive, provider: "anthropic", existingEnv, saved: readConfig() })
    : readProviderKeyFromAssignments(existingEnv, "anthropic");

  const updates = {
    ...existingEnv,
    OPENAI_API_KEY: openAiApiKey,
    GEMINI_API_KEY: geminiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey,
    ANSWER_PROVIDER: answerProvider,
    ANSWER_MODEL: answerModel,
    BOOLEAN_ASK_PROVIDER: booleanAskProvider,
    BOOLEAN_ASK_MODEL: booleanAskModel,
    EMBED_PROVIDER: embedProvider,
    EMBED_MODEL: embedModel,
    REFLECT_PROVIDER: reflectProvider,
    REFLECT_MODEL: reflectModel,
    COMPACT_PROVIDER: compactProvider,
    COMPACT_MODEL: compactModel
  };
  if (embedChanged) {
    updates.REINDEX_ON_START = "force";
  }

  const { outputPath, backupPath } = await writeEnvFile({
    projectRoot: target.projectRoot,
    externalPostgres: target.externalPostgres,
    updates,
    force: boolFromFlag(getFlag(parsed, "yes"), false) || boolFromFlag(getFlag(parsed, "force"), false)
  });

  const rows = [
    `project root: ${target.projectRoot}`,
    `env file: ${path.relative(target.projectRoot, outputPath)}`,
    `answer provider/model: ${answerProvider} / ${answerModel}`,
    `boolean ask provider/model: ${booleanAskProvider || "inherit -> answer provider"} / ${booleanAskModel || "inherit -> answer model"}`,
    `embed provider/model: ${embedProvider} / ${embedModel}`,
    `reflect provider/model: ${reflectProvider} / ${reflectModel}`,
    `compact provider/model: ${compactProvider || "inherit -> reflect provider"} / ${compactModel || "inherit -> reflect model"}`
  ];
  if (backupPath) {
    rows.push(`backup created: ${path.relative(target.projectRoot, backupPath)}`);
  }
  if (embedChanged) {
    rows.push("Embedding model changed: REINDEX_ON_START was set to force so the next gateway restart rebuilds vectors from stored chunks.");
  }

  if (boolFromFlag(getFlag(parsed, "restart"), false)) {
    ensureNodeVersion();
    ensureDockerAvailable();
    const composeCtx = buildComposeContext(target.projectRoot, {
      composeFile: target.composeFile,
      envFile: target.envFile,
      projectName: target.projectName
    });
    await runCompose(composeCtx, ["up", "-d"], { capture: false });
    rows.push("Restarted the local SupaVector stack.");
  } else {
    rows.push(`next: supavector start --project-root "${target.projectRoot}"`);
  }

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify({
      ok: true,
      projectRoot: target.projectRoot,
      envFile: target.envFile,
      models: {
        answerProvider,
        answerModel,
        booleanAskProvider: booleanAskProvider || null,
        booleanAskModel: booleanAskModel || null,
        embedProvider,
        embedModel,
        reflectProvider,
        reflectModel,
        compactProvider: compactProvider || null,
        compactModel: compactModel || null
      },
      embedModelChanged: embedChanged,
      restartRequested: boolFromFlag(getFlag(parsed, "restart"), false)
    }, null, 2));
    return;
  }

  printSummary("Model settings updated.", rows);
}

function resolveComposeFromSaved(parsed) {
  const saved = readConfig();
  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  const composeFile = saved.composeFile || "docker-compose.yml";
  const envFile = saved.envFile || ".env";
  const ctx = buildComposeContext(projectRoot, {
    composeFile,
    envFile,
    projectName: saved.projectName || ""
  });
  ensureFileExists(ctx.composeFile, "Compose file");
  ensureFileExists(ctx.envFile, "Env file");
  return { saved, ctx };
}

function looksLikeAtlasragCheckout(projectRoot) {
  return fs.existsSync(path.join(projectRoot, "bin", "supavector.js"))
    && fs.existsSync(path.join(projectRoot, "docker-compose.yml"))
    && fs.existsSync(path.join(projectRoot, "gateway"));
}

function isSameOrChildPath(parentPath, childPath) {
  const parent = path.resolve(String(parentPath || ""));
  const child = path.resolve(String(childPath || ""));
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function writeTextFile(filePath, text) {
  fs.writeFileSync(filePath, text ? `${String(text).replace(/\s+$/u, "")}\n` : "", "utf8");
}

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  fs.rmSync(targetPath, { recursive: true, force: true });
  return true;
}

function removeDirectoryIfEmpty(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return false;
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return false;
    if (fs.readdirSync(dirPath).length > 0) return false;
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWindowsShellBin() {
  const candidates = [
    "powershell",
    "pwsh",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8"
    });
    if (result.status === 0) return candidate;
    if (result.error && result.error.code === "ENOENT") continue;
  }
  return null;
}

function resolveUninstallPlan() {
  const saved = readConfig();
  const installHome = resolveInstallHome(process.env);
  const binDir = path.resolve(String(process.env.SUPAVECTOR_BIN_DIR || buildInstallBinDir(installHome)));
  const defaultRepoDir = buildInstallRepoDir(installHome);
  const packageRoot = path.resolve(PACKAGE_ROOT);
  const repoDir = looksLikeAtlasragCheckout(packageRoot) && isSameOrChildPath(installHome, packageRoot)
    ? packageRoot
    : (looksLikeAtlasragCheckout(defaultRepoDir) ? defaultRepoDir : "");
  const useSavedPaths = repoDir
    && saved.projectRoot
    && path.resolve(String(saved.projectRoot)) === path.resolve(repoDir);
  const composeCtx = repoDir
    ? buildComposeContext(repoDir, {
        composeFile: useSavedPaths ? (saved.composeFile || "docker-compose.yml") : "docker-compose.yml",
        envFile: useSavedPaths ? (saved.envFile || ".env") : ".env",
        projectName: useSavedPaths ? (saved.projectName || "") : ""
      })
    : null;
  return {
    saved,
    installHome,
    binDir,
    repoDir,
    composeCtx,
    wrappers: [
      path.join(binDir, "supavector"),
      path.join(binDir, "supavector.ps1"),
      path.join(binDir, "supavector.cmd")
    ],
    configFile: CONFIG_FILE,
    configDir: CONFIG_DIR,
    shellRcFiles: [
      path.join(os.homedir(), ".zshrc"),
      path.join(os.homedir(), ".bashrc"),
      path.join(os.homedir(), ".profile")
    ]
  };
}

function removePosixPathEntries(plan) {
  const touched = [];
  for (const rcFile of plan.shellRcFiles) {
    if (!fs.existsSync(rcFile)) continue;
    const before = fs.readFileSync(rcFile, "utf8");
    const after = stripManagedShellPath(before, plan.binDir);
    if (after === before) continue;
    writeTextFile(rcFile, after);
    touched.push(rcFile);
  }
  return touched;
}

async function removeWindowsPathEntry(binDir) {
  const shellBin = resolveWindowsShellBin();
  if (!shellBin) {
    return {
      ok: false,
      detail: "PowerShell not found; remove the SupaVector bin directory from the user PATH manually."
    };
  }

  const script = `
$target = ${JSON.stringify(path.resolve(binDir))};
$userPath = [Environment]::GetEnvironmentVariable("Path", "User");
if ($null -eq $userPath) { exit 0 }
$parts = $userPath -split ";" | Where-Object { $_ };
$normalizedTarget = $target.Trim().TrimEnd("\\").ToLowerInvariant();
$kept = @();
foreach ($part in $parts) {
  $normalizedPart = $part.Trim().TrimEnd("\\").ToLowerInvariant();
  if ($normalizedPart -ne $normalizedTarget) {
    $kept += $part.Trim();
  }
}
[Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User");
`;

  await runCommand(shellBin, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    capture: true
  });
  return {
    ok: true,
    detail: `Removed ${binDir} from the user PATH. Open a new terminal for the change to take effect.`
  };
}

async function removeManagedDockerState(plan) {
  if (!plan.composeCtx) {
    return {
      ok: true,
      removed: false,
      detail: "No managed local compose stack was detected."
    };
  }
  if (!fs.existsSync(plan.composeCtx.composeFile) || !fs.existsSync(plan.composeCtx.envFile)) {
    return {
      ok: true,
      removed: false,
      detail: "No managed compose/env files were found for Docker cleanup."
    };
  }
  const dockerBin = resolveExecutable("docker", ["--version"]);
  if (!dockerBin) {
    return {
      ok: false,
      removed: false,
      detail: "Docker is not available; local SupaVector containers and volumes may still exist."
    };
  }
  try {
    await runCompose(plan.composeCtx, ["down", "-v"], { capture: false });
    return {
      ok: true,
      removed: true,
      detail: `Removed local SupaVector containers and volumes for ${plan.composeCtx.projectRoot}.`
    };
  } catch (error) {
    return {
      ok: false,
      removed: false,
      detail: `Could not remove local SupaVector Docker state automatically: ${String(error.message || error)}`
    };
  }
}

function schedulePosixCleanup(plan) {
  if (!plan.repoDir) return false;
  const srcDir = path.dirname(plan.repoDir);
  const shellBin = fs.existsSync("/bin/sh") ? "/bin/sh" : "sh";
  const script = [
    "sleep 1",
    "rm -rf -- \"$1\"",
    "rmdir \"$2\" 2>/dev/null || true",
    "rmdir \"$3\" 2>/dev/null || true",
    "rmdir \"$4\" 2>/dev/null || true"
  ].join("\n");
  const child = spawn(shellBin, ["-c", script, "supavector-uninstall", plan.repoDir, srcDir, plan.binDir, plan.installHome], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return true;
}

function scheduleWindowsCleanup(plan) {
  if (!plan.repoDir) return false;
  const shellBin = resolveWindowsShellBin();
  if (!shellBin) return false;
  const script = `
$repoDir = ${JSON.stringify(path.resolve(plan.repoDir))};
$srcDir = ${JSON.stringify(path.dirname(plan.repoDir))};
$binDir = ${JSON.stringify(path.resolve(plan.binDir))};
$installHome = ${JSON.stringify(path.resolve(plan.installHome))};
Start-Sleep -Seconds 2
if (Test-Path $repoDir) {
  Remove-Item -LiteralPath $repoDir -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path $srcDir -PathType Container) {
  $srcEntries = @(Get-ChildItem -LiteralPath $srcDir -Force -ErrorAction SilentlyContinue)
  if ($srcEntries.Count -eq 0) {
    Remove-Item -LiteralPath $srcDir -Force -ErrorAction SilentlyContinue
  }
}
if (Test-Path $binDir -PathType Container) {
  $binEntries = @(Get-ChildItem -LiteralPath $binDir -Force -ErrorAction SilentlyContinue)
  if ($binEntries.Count -eq 0) {
    Remove-Item -LiteralPath $binDir -Force -ErrorAction SilentlyContinue
  }
}
if (Test-Path $installHome -PathType Container) {
  $homeEntries = @(Get-ChildItem -LiteralPath $installHome -Force -ErrorAction SilentlyContinue)
  if ($homeEntries.Count -eq 0) {
    Remove-Item -LiteralPath $installHome -Force -ErrorAction SilentlyContinue
  }
}
`;
  const child = spawn(shellBin, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return true;
}

function resolveUpdateTargetRoot(parsed) {
  const explicitRoot = getFlag(parsed, "project-root");
  const projectRoot = explicitRoot
    ? path.resolve(String(explicitRoot))
    : PACKAGE_ROOT;
  if (!looksLikeAtlasragCheckout(projectRoot)) {
    throw new Error(`Not an SupaVector checkout: ${projectRoot}`);
  }
  if (!fs.existsSync(path.join(projectRoot, ".git"))) {
    throw new Error(
      `Git metadata not found at ${projectRoot}. SupaVector update requires a git checkout. `
      + `If you installed via npm, update by reinstalling with npm install -g instead, or use scripts/install.sh for a managed checkout.`
    );
  }
  return projectRoot;
}

function isManagedInstallCheckout(projectRoot) {
  const installHome = resolveInstallHome(process.env);
  const managedRepoDir = buildInstallRepoDir(installHome);
  return path.resolve(projectRoot) === path.resolve(managedRepoDir);
}

async function ensureCleanGitWorktree(gitBin, projectRoot) {
  const result = await runCommand(gitBin, ["status", "--short"], { cwd: projectRoot });
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (!lines.length) return;
  const preview = lines.slice(0, 10).join("\n");
  const suffix = lines.length > 10 ? `\n... and ${lines.length - 10} more` : "";
  throw new Error(
    `Update requires a clean git worktree at ${projectRoot}. Commit, stash, or discard local changes first.\n${preview}${suffix}`
  );
}

async function readGitRevision(gitBin, projectRoot, ref = "HEAD") {
  const result = await runCommand(gitBin, ["rev-parse", "--short", ref], { cwd: projectRoot });
  return String(result.stdout || "").trim();
}

async function fetchOriginMain(gitBin, projectRoot) {
  try {
    await runCommandEcho(gitBin, ["fetch", "--depth=1", "origin", "main"], { cwd: projectRoot });
  } catch {
    await runCommandEcho(gitBin, ["fetch", "origin"], { cwd: projectRoot });
  }
}

function isFastForwardOnlyPullFailure(err) {
  const text = [
    err?.message,
    err?.stderr,
    err?.stdout
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return text.includes("not possible to fast-forward")
    || text.includes("diverging branches can't be fast-forwarded");
}

async function handleUpdate(parsed) {
  ensureNodeVersion();
  const gitBin = ensureGitAvailable();
  const npmBin = ensureNpmAvailable();
  const projectRoot = resolveUpdateTargetRoot(parsed);
  const packageJsonPath = path.join(projectRoot, "package.json");
  const managedCheckout = isManagedInstallCheckout(projectRoot);

  await ensureCleanGitWorktree(gitBin, projectRoot);
  const before = await readGitRevision(gitBin, projectRoot);

  console.log(`Updating SupaVector in ${projectRoot}...`);
  await fetchOriginMain(gitBin, projectRoot);
  await runCommandEcho(gitBin, ["checkout", "main"], { cwd: projectRoot });
  let resetApplied = false;
  try {
    await runCommandEcho(gitBin, ["pull", "--ff-only", "origin", "main"], { cwd: projectRoot });
  } catch (err) {
    if (!managedCheckout || !isFastForwardOnlyPullFailure(err)) {
      throw err;
    }
    console.log("origin/main was force-updated; resetting the clean managed checkout to match the remote branch...");
    await runCommandEcho(gitBin, ["reset", "--hard", "origin/main"], { cwd: projectRoot });
    resetApplied = true;
  }

  if (fs.existsSync(packageJsonPath)) {
    await runCommandEcho(npmBin, ["install"], {
      cwd: projectRoot,
      env: buildEnvWithNodePath()
    });
  }

  const after = await readGitRevision(gitBin, projectRoot);
  const summaryRows = [
    `project root: ${projectRoot}`,
    `before: ${before}`,
    `after: ${after}`
  ];
  if (before === after) {
    summaryRows.push("git: already up to date");
  }
  if (resetApplied) {
    summaryRows.push("git: reset the clean managed checkout to origin/main after a force-pushed remote update");
  }
  if (fs.existsSync(path.join(projectRoot, "docker-compose.yml"))) {
    summaryRows.push("If you self-host locally, run: supavector start --build");
  }
  printSummary("SupaVector update complete.", summaryRows);
}

async function handleUninstall(parsed) {
  ensureNodeVersion();
  const plan = resolveUninstallPlan();
  const json = boolFromFlag(getFlag(parsed, "json"), false);
  const targets = [
    `wrappers in ${plan.binDir}`,
    `saved config at ${plan.configFile}`,
    "PATH updates created by the installer"
  ];
  if (plan.repoDir) {
    targets.splice(1, 0, `managed checkout at ${plan.repoDir}`);
  }
  if (plan.composeCtx) {
    targets.splice(plan.repoDir ? 2 : 1, 0, `local Docker containers and volumes for ${plan.composeCtx.projectRoot}`);
  }

  await ensureConfirmedAction(
    parsed,
    `Remove the SupaVector CLI install (${targets.join(", ")})?`,
    false
  );

  const touchedShellFiles = process.platform === "win32"
    ? []
    : removePosixPathEntries(plan);
  const pathUpdate = process.platform === "win32"
    ? await removeWindowsPathEntry(plan.binDir)
    : {
        ok: true,
        detail: touchedShellFiles.length
          ? `Updated shell startup files: ${touchedShellFiles.join(", ")}`
          : "No shell startup files needed changes."
      };
  const dockerCleanup = await removeManagedDockerState(plan);

  const removedWrappers = plan.wrappers.filter((filePath) => removeIfExists(filePath));
  const removedConfig = removeIfExists(plan.configFile);
  if (removedConfig && plan.configDir !== plan.installHome) {
    removeDirectoryIfEmpty(plan.configDir);
  }

  let deferredCleanup = false;
  if (plan.repoDir) {
    deferredCleanup = process.platform === "win32"
      ? scheduleWindowsCleanup(plan)
      : schedulePosixCleanup(plan);
    if (!deferredCleanup) {
      removeIfExists(plan.repoDir);
      removeDirectoryIfEmpty(path.dirname(plan.repoDir));
    }
  }

  if (!plan.repoDir || !deferredCleanup) {
    removeDirectoryIfEmpty(plan.binDir);
    removeDirectoryIfEmpty(plan.installHome);
  }

  const payload = {
    installHome: plan.installHome,
    removedWrappers,
    removedConfig,
    removedRepoDir: plan.repoDir || null,
    deferredRepoCleanup: deferredCleanup,
    dockerCleanup,
    path: pathUpdate
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const summaryRows = [
    `install home: ${plan.installHome}`,
    removedWrappers.length
      ? `wrappers removed: ${removedWrappers.join(", ")}`
      : "wrappers removed: none found",
    removedConfig
      ? `config removed: ${plan.configFile}`
      : `config removed: none found at ${plan.configFile}`,
    dockerCleanup.detail,
    pathUpdate.detail
  ];
  if (plan.repoDir) {
    summaryRows.push(
      deferredCleanup
        ? `repo checkout scheduled for removal after this command exits: ${plan.repoDir}`
        : `repo checkout removed: ${plan.repoDir}`
    );
  } else {
    summaryRows.push("repo checkout removed: no managed checkout found under the install home");
  }
  summaryRows.push("Open a new terminal before re-checking `supavector` on PATH.");
  printSummary("SupaVector uninstall complete.", summaryRows);
}

async function handleStart(parsed) {
  ensureDockerAvailable();
  const { ctx } = resolveComposeFromSaved(parsed);
  const args = ["up", "-d"];
  if (boolFromFlag(getFlag(parsed, "build"), false)) args.push("--build");
  await runCompose(ctx, args, { capture: false });
  const saved = readConfig();
  const baseUrl = saved.baseUrl || resolveBaseUrl("3000");
  try {
    await waitForGatewayReady(ctx, baseUrl, 120000);
  } catch {
    // Leave status to the user if startup is still settling.
  }
  console.log("SupaVector services started.");
}

async function handleStop(parsed) {
  ensureDockerAvailable();
  const { ctx } = resolveComposeFromSaved(parsed);
  if (boolFromFlag(getFlag(parsed, "down"), false)) {
    await runCompose(ctx, ["down"], { capture: false });
    console.log("SupaVector stack stopped and containers removed.");
    return;
  }
  await runCompose(ctx, ["stop"], { capture: false });
  console.log("SupaVector services stopped.");
}

async function handleStatus(parsed) {
  ensureDockerAvailable();
  const { saved, ctx } = resolveComposeFromSaved(parsed);
  const ps = await runCompose(ctx, ["ps"]);
  let health = null;
  let healthError = "";
  if (saved.baseUrl) {
    try {
      health = (await probeHostHealth(saved.baseUrl)).payload;
    } catch (err) {
      healthError = String(err.message || err);
    }
  }

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify({
      projectRoot: ctx.projectRoot,
      composeFile: ctx.composeFile,
      envFile: ctx.envFile,
      baseUrl: saved.baseUrl || null,
      health,
      healthError: healthError || null,
      composePs: ps.stdout
    }, null, 2));
    return;
  }

  console.log(`Project root: ${ctx.projectRoot}`);
  console.log(`Base URL: ${saved.baseUrl || "(not saved)"}`);
  if (isHealthyPayload(health)) {
    console.log(`Health: healthy (${describeHealth(health)})`);
  } else if (healthError) {
    console.log(`Health: unavailable (${healthError})`);
  } else {
    console.log("Health: unknown");
  }
  console.log("");
  process.stdout.write(ps.stdout);
}

async function handleLogs(parsed) {
  ensureDockerAvailable();
  const { ctx } = resolveComposeFromSaved(parsed);
  const service = String(getFlag(parsed, "service") || "gateway").trim();
  const tail = String(getFlag(parsed, "tail") || "200").trim();
  await runCompose(ctx, ["logs", "-f", "--tail", tail, service], { capture: false });
}

async function handleBootstrap(parsed) {
  ensureDockerAvailable();
  const { saved, ctx } = resolveComposeFromSaved(parsed);
  const nonInteractive = boolFromFlag(getFlag(parsed, "non-interactive"), false);
  const username = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["username", "admin-user"],
    prompt: "Admin username",
    defaultValue: saved.adminUsername || "admin",
    required: true
  });
  const password = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["password", "admin-password"],
    prompt: "Admin password",
    defaultValue: "",
    secret: true,
    required: true
  });
  const tenant = await resolvePromptValue({
    parsed,
    flags: { nonInteractive },
    names: ["tenant"],
    prompt: "Tenant id",
    defaultValue: saved.tenantId || "default",
    required: true
  });

  const result = await runCompose(ctx, [
    "exec",
    "-T",
    "gateway",
    "node",
    "scripts/bootstrap_instance.js",
    "--username",
    username,
    "--password",
    password,
    "--tenant",
    tenant,
    "--service-token-name",
    `${tenant}-bootstrap`,
    "--json"
  ]);

  const payload = parseJsonFromStdout(result.stdout);
  const nextConfig = {
    ...saved,
    adminUsername: username,
    tenantId: payload?.tenant || tenant,
    baseUrl: payload?.baseUrl || saved.baseUrl || resolveBaseUrl("3000"),
    apiKey: payload?.serviceToken?.token || saved.apiKey || "",
    onboardingPending: false,
    updatedAt: new Date().toISOString()
  };
  writeConfig(nextConfig);

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printSummary("Bootstrap complete.", [
    `Base URL: ${nextConfig.baseUrl}`,
    `Tenant: ${nextConfig.tenantId}`,
    `Admin username: ${username}`,
    `Service token: ${maskSecret(nextConfig.apiKey)}`
  ]);
}

async function handleDoctor(parsed) {
  const saved = readConfig();
  const results = [];

  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
  };

  try {
    ensureNodeVersion();
  record("Node.js", true, process.version);
  } catch (err) {
    record("Node.js", false, String(err.message || err));
  }

  const dockerBin = resolveExecutable("docker", ["--version"]);
  const dockerComposeOk = Boolean(resolveExecutable("docker", ["compose", "version"]));
  record("Docker", Boolean(dockerBin), dockerBin || "missing");
  record("Docker Compose", dockerComposeOk, dockerComposeOk ? "available" : "missing");

  const projectRoot = resolveProjectRoot(saved, getFlag(parsed, "project-root"));
  record("Project root", fs.existsSync(projectRoot), projectRoot);

  const composeFile = path.join(projectRoot, saved.composeFile || "docker-compose.yml");
  const envFile = path.join(projectRoot, saved.envFile || ".env");
  record("Compose file", fs.existsSync(composeFile), composeFile);
  record("Env file", fs.existsSync(envFile), envFile);
  record("CLI config", fs.existsSync(CONFIG_FILE), CONFIG_FILE);
  record("Saved base URL", Boolean(saved.baseUrl), saved.baseUrl || "not configured");
  const apiKeyDetail = saved.apiKey
    ? maskSecret(saved.apiKey)
    : (saved.onboardingPending
        ? "pending bootstrap; rerun `supavector onboard` or `supavector bootstrap --username ... --tenant ...` if setup stopped early"
        : "not configured");
  record("Saved API key", Boolean(saved.apiKey), apiKeyDetail);

  if (saved.baseUrl) {
    try {
      const health = (await probeHostHealth(saved.baseUrl)).payload;
      record("Gateway health", isHealthyPayload(health), describeHealth(health));
    } catch (err) {
      record("Gateway health", false, String(err.message || err));
    }
  }

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify({ ok: results.every((r) => r.ok), checks: results }, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  for (const item of results) {
    console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}`);
  }

  if (!results.every((r) => r.ok)) {
    process.exit(1);
  }
}

async function getTextInput(parsed) {
  const direct = getFlag(parsed, "text");
  if (direct && direct !== true) return String(direct);
  const filePath = getFlag(parsed, "file");
  if (filePath && filePath !== true) {
    return extractDocumentText(path.resolve(String(filePath)));
  }
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8");
  }
  return "";
}

function parseListFlag(value) {
  if (value === undefined || value === null || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildGitHttpAuthEnv(token, baseEnv = process.env) {
  const clean = String(token || "").trim();
  if (!clean) return { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  const basic = Buffer.from(`x-access-token:${clean}`, "utf8").toString("base64");
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

function parseGitHubPathList(parsed, ...names) {
  for (const name of names) {
    const value = getFlag(parsed, name);
    if (value === undefined) continue;
    return parseListFlag(value);
  }
  return [];
}

function buildGitHubBlobUrl(repoInfo, relativePath) {
  if (!repoInfo?.htmlUrl || !repoInfo?.branch || !relativePath) return null;
  const cleanPath = String(relativePath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (!cleanPath) return null;
  return `${repoInfo.htmlUrl}/blob/${encodeURIComponent(repoInfo.branch)}/${cleanPath}`;
}

function defaultCollectionFromRepositoryName(repoName, fallbackPath = "") {
  const raw = String(repoName || "").trim();
  if (raw) {
    return raw
      .replace(/[\\/]+/g, "-")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || defaultCollectionFromFolder(fallbackPath || ".");
  }
  return defaultCollectionFromFolder(fallbackPath || ".");
}

async function readTrimmedCommandOutput(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  return String(result.stdout || "").trim();
}

function parseGitHubRepoFromRemoteUrl(remoteUrl) {
  const clean = String(remoteUrl || "").trim();
  if (!clean) return null;
  try {
    return parseGitHubRepoSpec(clean);
  } catch {
    return null;
  }
}

async function resolveLocalRepoContext(folderPath) {
  const gitBin = resolveExecutable("git", ["--version"]);
  if (!gitBin) return null;

  const cwd = path.resolve(String(folderPath || "").trim() || ".");
  try {
    const repoRoot = await readTrimmedCommandOutput(gitBin, ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const branchRaw = await readTrimmedCommandOutput(gitBin, ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    const remoteUrl = await readTrimmedCommandOutput(gitBin, ["-C", cwd, "remote", "get-url", "origin"]).catch(() => "");
    const github = parseGitHubRepoFromRemoteUrl(remoteUrl);
    const repositoryName = github?.name || path.basename(repoRoot);
    return {
      repoRoot,
      repositoryName,
      branch: branchRaw && branchRaw !== "HEAD" ? branchRaw : (github?.branch || null),
      provider: github ? "github" : null,
      htmlUrl: github?.htmlUrl || null,
      remoteUrl: remoteUrl || null
    };
  } catch {
    return null;
  }
}

async function cloneGitHubRepoToTempDir(parsed, repoSpec, branch) {
  const gitBin = ensureGitAvailable();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supavector-github-"));
  const targetDir = path.join(tempRoot, repoSpec.repo);
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (branch) {
    args.push("--branch", branch);
  }
  args.push(repoSpec.cloneUrl, targetDir);

  const tokenEnvName = maybeStringFlag(parsed, "github-token-env");
  const token = maybeStringFlag(parsed, "github-token")
    || (tokenEnvName ? process.env[tokenEnvName] : "")
    || process.env.SUPAVECTOR_GITHUB_TOKEN
    || process.env.GITHUB_TOKEN
    || "";

  try {
    await runCommand(gitBin, args, {
      cwd: tempRoot,
      env: buildGitHttpAuthEnv(token, process.env)
    });
    return {
      tempRoot,
      targetDir,
      repoContext: {
        repoRoot: targetDir,
        repositoryName: repoSpec.name,
        branch: branch || repoSpec.branch || null,
        provider: "github",
        htmlUrl: repoSpec.htmlUrl,
        remoteUrl: repoSpec.cloneUrl
      }
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    const tokenHint = token
      ? ""
      : " For private repositories, set SUPAVECTOR_GITHUB_TOKEN, GITHUB_TOKEN, or pass --github-token.";
    throw new Error(`Failed to clone ${repoSpec.name}.${tokenHint} ${String(error.message || error)}`.trim());
  }
}

function buildDocumentSourcePayload(item, options = {}) {
  const repoContext = options.repoContext || null;
  const explicitSourceType = String(options.sourceType || "").trim().toLowerCase();
  const metadata = { ...(options.metadata || {}) };
  const relPath = String(item?.repoRelPath || item?.relPath || "").trim();
  const language = item?.language || detectCodeLanguage(relPath || item?.absPath || "");
  const inferredSourceType = explicitSourceType || (language ? "code" : "text");

  if (repoContext?.provider) metadata.provider = repoContext.provider;
  if (repoContext?.repositoryName) metadata.repo = repoContext.repositoryName;
  if (repoContext?.branch) metadata.branch = repoContext.branch;
  if (relPath) metadata.path = relPath;
  if (language) metadata.language = language;

  const hasMetadata = Object.keys(metadata).length > 0;
  return {
    title: relPath || item?.docId || null,
    sourceType: inferredSourceType,
    sourceUrl: buildGitHubBlobUrl(repoContext, relPath),
    metadata: hasMetadata ? metadata : null
  };
}

async function buildSingleInputSourcePayload(parsed, docId) {
  const explicitSourceType = maybeStringFlag(parsed, "source-type");
  const filePath = maybeStringFlag(parsed, "file");
  if (!filePath && !explicitSourceType) return {};
  if (!filePath) {
    return {
      title: docId,
      sourceType: explicitSourceType
    };
  }

  const absPath = path.resolve(filePath);
  const repoContext = await resolveLocalRepoContext(path.dirname(absPath));
  const relPath = repoContext?.repoRoot && absPath.startsWith(repoContext.repoRoot)
    ? path.relative(repoContext.repoRoot, absPath)
    : path.basename(absPath);
  return buildDocumentSourcePayload({
    absPath,
    relPath,
    repoRelPath: relPath,
    docId,
    language: detectCodeLanguage(relPath)
  }, {
    repoContext,
    sourceType: explicitSourceType || undefined
  });
}

function renderCodeFiles(files = []) {
  files.forEach((item, index) => {
    const parts = [];
    if (item?.path) parts.push(item.path);
    if (item?.repo) parts.push(item.repo);
    if (item?.language) parts.push(item.language);
    const label = parts.length ? parts.join("  ") : (item?.docId || item?.chunkId || "source");
    console.log(`${index + 1}. ${label}`);
  });
}

async function ingestCollectedDocuments(client, parsed, collection, documents, options = {}) {
  const tenantId = getFlag(parsed, "tenant");
  const replaceExisting = options.replaceExisting === true;
  const syncFolder = options.syncFolder === true;
  const commonParams = {
    collection,
    tenantId,
    policy: getFlag(parsed, "policy"),
    expiresAt: getFlag(parsed, "expires-at"),
    visibility: getFlag(parsed, "visibility"),
    acl: parseListFlag(getFlag(parsed, "acl")),
    agentId: getFlag(parsed, "agent-id"),
    tags: parseListFlag(getFlag(parsed, "tags"))
  };
  const replaced = [];
  const pruned = [];

  if (syncFolder) {
    const existingPayload = await client.listDocs({ collection, tenantId });
    const existingDocs = extractDocs(existingPayload);
    const desiredDocIds = new Set(documents.accepted.map((item) => item.docId));
    for (const item of existingDocs) {
      if (desiredDocIds.has(item.docId)) continue;
      await deleteDocumentForUpdate(client, item.docId, { collection, tenantId });
      pruned.push(item.docId);
    }
  }

  const indexed = [];
  for (const item of documents.accepted) {
    if (replaceExisting || syncFolder) {
      await deleteDocumentForUpdate(client, item.docId, { collection, tenantId });
      replaced.push(item.docId);
    }
    const payload = await client.indexText(item.docId, item.text, {
      ...commonParams,
      ...buildDocumentSourcePayload(item, options),
      idempotencyKey: `supavector-cli-${Date.now()}-${randomSecret(6)}`
    });
    const data = payload?.data || payload;
    indexed.push({
      path: item.repoRelPath || item.relPath,
      docId: data.docId || item.docId,
      chunksIndexed: data.chunksIndexed ?? null,
      sourceType: item.sourceType || null,
      language: item.language || null
    });
  }

  return {
    collection,
    indexed,
    skipped: documents.skipped,
    replaced: Array.from(new Set(replaced)),
    pruned
  };
}

function getNestedSubcommand(parsed, index = 2) {
  return String(parsed?.positionals?.[index] || "").trim().toLowerCase();
}

function formatDateTime(value) {
  const clean = String(value || "").trim();
  return clean || "never";
}

function parseJsonText(raw, label) {
  const text = String(raw || "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function readJsonObjectFile(filePath, label) {
  const resolved = path.resolve(String(filePath || "").trim());
  if (!resolved) {
    throw new Error(`${label} file path is required.`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} file not found: ${resolved}`);
  }
  return parseJsonText(fs.readFileSync(resolved, "utf8"), label);
}

function readJsonObjectInput(parsed, options = {}) {
  const label = options.label || "JSON input";
  const jsonFlag = options.jsonFlag || "body-json";
  const fileFlag = options.fileFlag || "body-file";
  const rawJson = getFlag(parsed, jsonFlag);
  const rawFile = getFlag(parsed, fileFlag);
  if (rawJson !== undefined && rawFile !== undefined) {
    throw new Error(`Use either --${jsonFlag} or --${fileFlag}, not both.`);
  }
  if (rawJson !== undefined) {
    if (rawJson === true) {
      throw new Error(`--${jsonFlag} requires a JSON object value.`);
    }
    return parseJsonText(rawJson, label);
  }
  if (rawFile !== undefined) {
    if (rawFile === true) {
      throw new Error(`--${fileFlag} requires a file path.`);
    }
    return readJsonObjectFile(rawFile, label);
  }
  return {};
}

function maybeStringFlag(parsed, ...names) {
  for (const name of names) {
    const value = getFlag(parsed, name);
    if (value === undefined) continue;
    if (value === true) {
      throw new Error(`--${name} requires a value.`);
    }
    return String(value).trim();
  }
  return undefined;
}

function maybeBooleanFlag(parsed, ...names) {
  for (const name of names) {
    const value = getFlag(parsed, name);
    if (value === undefined) continue;
    return boolFromFlag(value, value === true);
  }
  return undefined;
}

function buildRetrievalParams(parsed, overrides = {}) {
  const params = {
    policy: getFlag(parsed, "policy"),
    docIds: parseListFlag(getFlag(parsed, "doc-ids") || getFlag(parsed, "docIds")),
    namespaceIds: parseListFlag(getFlag(parsed, "namespace-ids") || getFlag(parsed, "namespaceIds")),
    tags: parseListFlag(getFlag(parsed, "tags")),
    agentId: maybeStringFlag(parsed, "agent-id"),
    sourceTypes: parseListFlag(
      getFlag(parsed, "source-types")
      || getFlag(parsed, "source-type")
      || getFlag(parsed, "sourceType")
      || getFlag(parsed, "source")
    ),
    documentTypes: parseListFlag(
      getFlag(parsed, "document-types")
      || getFlag(parsed, "document-type")
      || getFlag(parsed, "documentTypes")
      || getFlag(parsed, "documentType")
      || getFlag(parsed, "doc-types")
      || getFlag(parsed, "doc-type")
      || getFlag(parsed, "docType")
    ),
    since: maybeStringFlag(parsed, "since"),
    until: maybeStringFlag(parsed, "until"),
    timeField: maybeStringFlag(parsed, "time-field", "timeField"),
    favorRecency: maybeBooleanFlag(parsed, "favor-recency", "favorRecency")
  };
  const merged = { ...params, ...overrides };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
      continue;
    }
    if (Array.isArray(merged[key]) && merged[key].length === 0) {
      delete merged[key];
    }
  }
  return merged;
}

function maybeNullableStringFlag(parsed, ...names) {
  const value = maybeStringFlag(parsed, ...names);
  if (value === undefined) return undefined;
  if (!value) return null;
  if (["inherit", "clear", "none", "default", "null"].includes(value.toLowerCase())) {
    return null;
  }
  return value;
}

function maybeRolesFlag(parsed, name, options = {}) {
  const value = getFlag(parsed, name);
  if (value === undefined) {
    return options.fallback === undefined ? undefined : options.fallback;
  }
  const roles = parseListFlag(value);
  if (!roles.length && options.allowEmpty !== true) {
    throw new Error(`--${name} must include at least one role.`);
  }
  return roles;
}

function maybePositiveIntFlag(parsed, ...names) {
  const value = maybeStringFlag(parsed, ...names);
  if (value === undefined) return undefined;
  const parsedInt = parseInt(value, 10);
  if (!Number.isFinite(parsedInt) || parsedInt <= 0) {
    throw new Error(`--${names[0]} must be a positive integer.`);
  }
  return parsedInt;
}

function setIfDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function buildAuthHeaders(parsed) {
  const cfg = resolveClientConfig(parsed);
  if (!cfg.apiKey && !cfg.token) {
    throw new Error(`No SupaVector credential is configured. Run \`supavector onboard\` first or set ${"`SUPAVECTOR_API_KEY`"} / ${"`SUPAVECTOR_TOKEN`"}.`);
  }
  const headers = {
    accept: "application/json"
  };
  if (cfg.apiKey) {
    headers["x-api-key"] = cfg.apiKey;
  } else {
    headers.authorization = `Bearer ${cfg.token}`;
  }
  return { cfg, headers };
}

async function requestApiJson(parsed, method, routePath, options = {}) {
  const { cfg, headers } = buildAuthHeaders(parsed);
  const url = new URL(routePath, cfg.clientBaseUrl);
  const query = options.query && typeof options.query === "object" ? options.query : null;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  const init = { method, headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!res.ok) {
    const message = payload?.error?.message || payload?.error || payload?.message || payload?.raw || `HTTP ${res.status}`;
    const err = new Error(String(message));
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function unwrapEnvelope(payload) {
  return payload?.data !== undefined ? payload.data : payload;
}

function printJsonOrSummary(parsed, payload, renderSummary) {
  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  renderSummary();
  return false;
}

function buildTenantModelBodyFromFlags(parsed) {
  const body = {};
  setIfDefined(body, "answerProvider", maybeNullableStringFlag(parsed, "answer-provider"));
  setIfDefined(body, "answerModel", maybeNullableStringFlag(parsed, "answer-model", "model"));
  setIfDefined(body, "booleanAskProvider", maybeNullableStringFlag(parsed, "boolean-ask-provider"));
  setIfDefined(body, "booleanAskModel", maybeNullableStringFlag(parsed, "boolean-ask-model"));
  setIfDefined(body, "reflectProvider", maybeNullableStringFlag(parsed, "reflect-provider"));
  setIfDefined(body, "reflectModel", maybeNullableStringFlag(parsed, "reflect-model"));
  setIfDefined(body, "compactProvider", maybeNullableStringFlag(parsed, "compact-provider"));
  setIfDefined(body, "compactModel", maybeNullableStringFlag(parsed, "compact-model"));
  return body;
}

function buildTenantSettingsBodyFromFlags(parsed, options = {}) {
  const body = readJsonObjectInput(parsed, {
    jsonFlag: options.bodyJsonFlag || "body-json",
    fileFlag: options.bodyFileFlag || "body-file",
    label: options.bodyLabel || "tenant request body"
  });
  if (options.allowName) {
    setIfDefined(body, "name", maybeNullableStringFlag(parsed, "name"));
  }
  if (options.allowExternalId) {
    setIfDefined(body, "externalId", maybeNullableStringFlag(parsed, "external-id"));
  }
  if (options.allowMetadata) {
    const metadata = readJsonObjectInput(parsed, {
      jsonFlag: "metadata-json",
      fileFlag: "metadata-file",
      label: "tenant metadata"
    });
    if (Object.keys(metadata).length) {
      body.metadata = metadata;
    }
  }
  setIfDefined(body, "authMode", maybeStringFlag(parsed, "auth-mode"));
  const ssoProviders = maybeStringFlag(parsed, "sso-providers");
  if (ssoProviders !== undefined) {
    const clean = String(ssoProviders || "").trim().toLowerCase();
    body.ssoProviders = ["clear", "none", "inherit", "null"].includes(clean)
      ? []
      : parseListFlag(ssoProviders);
  }
  const ssoConfig = readJsonObjectInput(parsed, {
    jsonFlag: "sso-config-json",
    fileFlag: "sso-config-file",
    label: "tenant SSO config"
  });
  if (Object.keys(ssoConfig).length) {
    body.ssoConfig = ssoConfig;
  }
  return { ...body, ...buildTenantModelBodyFromFlags(parsed) };
}

function buildTenantUserBodyFromFlags(parsed, options = {}) {
  const body = readJsonObjectInput(parsed, {
    jsonFlag: options.bodyJsonFlag || "body-json",
    fileFlag: options.bodyFileFlag || "body-file",
    label: options.bodyLabel || "user request body"
  });
  setIfDefined(body, "username", maybeStringFlag(parsed, "username"));
  setIfDefined(body, "password", maybeStringFlag(parsed, "password"));
  setIfDefined(body, "email", maybeNullableStringFlag(parsed, "email"));
  setIfDefined(body, "fullName", maybeNullableStringFlag(parsed, "full-name"));
  setIfDefined(body, "ssoOnly", maybeBooleanFlag(parsed, "sso-only"));
  setIfDefined(body, "disabled", maybeBooleanFlag(parsed, "disabled"));
  setIfDefined(body, "roles", maybeRolesFlag(parsed, "roles", options.roles));
  return body;
}

function buildServiceTokenBodyFromFlags(parsed, options = {}) {
  const body = readJsonObjectInput(parsed, {
    jsonFlag: options.bodyJsonFlag || "body-json",
    fileFlag: options.bodyFileFlag || "body-file",
    label: options.bodyLabel || "service token request body"
  });
  setIfDefined(body, "name", maybeStringFlag(parsed, "name"));
  setIfDefined(body, "principalId", maybeStringFlag(parsed, "principal-id"));
  setIfDefined(body, "expiresAt", maybeStringFlag(parsed, "expires-at"));
  setIfDefined(body, "roles", maybeRolesFlag(parsed, "roles", options.roles));
  if (body.roles === undefined && Array.isArray(options.defaultRoles)) {
    body.roles = options.defaultRoles.slice();
  }
  return body;
}

function normalizeConversationMemoryStrategyFlag(value) {
  if (value === undefined) return undefined;
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (["turn_log", "turn-log", "turnlog"].includes(raw)) return "turn_log";
  if (["hybrid_wiki", "hybrid-wiki", "conversation_wiki", "conversation-wiki", "wiki"].includes(raw)) return "hybrid_wiki";
  throw new Error("--conversation-memory-strategy must be turn_log or hybrid_wiki.");
}

function buildConversationMemoryConfigFromFlags(parsed, existingConversation = null) {
  const conversation = existingConversation && typeof existingConversation === "object" && !Array.isArray(existingConversation)
    ? { ...existingConversation }
    : {};
  let touched = false;

  const enabled = maybeBooleanFlag(parsed, "conversation-memory");
  const autoWriteDefault = maybeBooleanFlag(parsed, "conversation-memory-auto-write");
  const includeInAskDefault = maybeBooleanFlag(parsed, "conversation-memory-include-in-ask");
  const strategy = normalizeConversationMemoryStrategyFlag(maybeStringFlag(parsed, "conversation-memory-strategy"));
  const wikiEnabled = maybeBooleanFlag(parsed, "conversation-wiki", "conversation-memory-wiki");

  if (enabled !== undefined) {
    conversation.enabled = enabled;
    touched = true;
  }
  if (autoWriteDefault !== undefined) {
    conversation.autoWriteDefault = autoWriteDefault;
    touched = true;
  }
  if (includeInAskDefault !== undefined) {
    conversation.includeInAskDefault = includeInAskDefault;
    touched = true;
  }
  if (strategy !== undefined) {
    conversation.strategy = strategy;
    conversation.wikiEnabled = strategy === "hybrid_wiki";
    touched = true;
  }
  if (wikiEnabled !== undefined) {
    conversation.wikiEnabled = wikiEnabled;
    if (wikiEnabled === true && strategy === undefined) {
      conversation.strategy = "hybrid_wiki";
    } else if (wikiEnabled === false && strategy === undefined && String(conversation.strategy || "").trim().toLowerCase() === "hybrid_wiki") {
      conversation.strategy = "turn_log";
    }
    touched = true;
  }

  return touched ? conversation : null;
}

function buildMemoryBodyFromFlags(parsed, options = {}) {
  const body = readJsonObjectInput(parsed, {
    jsonFlag: options.bodyJsonFlag || "body-json",
    fileFlag: options.bodyFileFlag || "body-file",
    label: options.bodyLabel || "memory request body"
  });
  setIfDefined(body, "name", maybeStringFlag(parsed, "name"));
  setIfDefined(body, "description", maybeNullableStringFlag(parsed, "description"));
  setIfDefined(body, "role", maybeNullableStringFlag(parsed, "role"));
  setIfDefined(body, "personality", maybeNullableStringFlag(parsed, "personality"));
  setIfDefined(body, "provider", maybeNullableStringFlag(parsed, "provider"));
  setIfDefined(body, "model", maybeNullableStringFlag(parsed, "model"));
  setIfDefined(body, "instructions", maybeNullableStringFlag(parsed, "instructions"));

  const metadata = readJsonObjectInput(parsed, {
    jsonFlag: "metadata-json",
    fileFlag: "metadata-file",
    label: "memory metadata"
  });
  if (Object.keys(metadata).length) {
    body.metadata = metadata;
  }

  const sourceConfig = readJsonObjectInput(parsed, {
    jsonFlag: "source-config-json",
    fileFlag: "source-config-file",
    label: "memory source config"
  });
  if (Object.keys(sourceConfig).length) {
    body.sourceConfig = {
      ...(body.sourceConfig && typeof body.sourceConfig === "object" && !Array.isArray(body.sourceConfig) ? body.sourceConfig : {}),
      ...sourceConfig
    };
  }

  const existingConversation = body.sourceConfig && typeof body.sourceConfig === "object" && body.sourceConfig.conversationMemory && typeof body.sourceConfig.conversationMemory === "object"
    ? body.sourceConfig.conversationMemory
    : null;
  const conversationMemory = buildConversationMemoryConfigFromFlags(parsed, existingConversation);
  if (conversationMemory) {
    body.sourceConfig = {
      ...(body.sourceConfig && typeof body.sourceConfig === "object" && !Array.isArray(body.sourceConfig) ? body.sourceConfig : {}),
      conversationMemory
    };
  }
  return body;
}

function formatRoles(roles) {
  return Array.isArray(roles) && roles.length ? roles.join(",") : "(none)";
}

function renderServiceTokensList(tokens, title = "Service tokens") {
  if (!tokens.length) {
    console.log(`No ${title.toLowerCase()}.`);
    return;
  }
  console.log(`${title}:`);
  console.log("");
  for (const token of tokens) {
    console.log(`#${token.id}  ${token.name || "(unnamed)"}  principal=${token.principalId || "(none)"}  roles=${formatRoles(token.roles)}`);
    console.log(`   created=${formatDateTime(token.createdAt)}  lastUsed=${formatDateTime(token.lastUsedAt)}  expires=${formatDateTime(token.expiresAt)}  revoked=${formatDateTime(token.revokedAt)}`);
  }
}

function renderUsersList(users, title = "Users") {
  if (!users.length) {
    console.log(`No ${title.toLowerCase()}.`);
    return;
  }
  console.log(`${title}:`);
  console.log("");
  for (const user of users) {
    console.log(`#${user.id}  ${user.username}  roles=${formatRoles(user.roles)}  disabled=${user.disabled ? "yes" : "no"}  ssoOnly=${user.ssoOnly ? "yes" : "no"}`);
    console.log(`   email=${user.email || "(none)"}  fullName=${user.fullName || "(none)"}  lastLogin=${formatDateTime(user.lastLogin)}  created=${formatDateTime(user.createdAt)}`);
  }
}

function renderTenantRecord(tenant, options = {}) {
  if (!tenant) {
    console.log("Tenant not found.");
    return;
  }
  const models = tenant.models?.effective || tenant.models || {};
  console.log(`${options.title || "Tenant"}: ${tenant.id}`);
  console.log(`Name: ${tenant.name || "(none)"}`);
  console.log(`External ID: ${tenant.externalId || "(none)"}`);
  console.log(`Auth mode: ${tenant.authMode || "(default)"}`);
  console.log(`SSO providers: ${Array.isArray(tenant.ssoProviders) && tenant.ssoProviders.length ? tenant.ssoProviders.join(",") : "(none)"}`);
  console.log(`Created: ${formatDateTime(tenant.createdAt)}`);
  if (tenant.summary && Object.keys(tenant.summary).length) {
    console.log(`Summary: ${JSON.stringify(tenant.summary)}`);
  }
  if (tenant.metadata && Object.keys(tenant.metadata).length) {
    console.log(`Metadata: ${JSON.stringify(tenant.metadata)}`);
  }
  if (tenant.ssoConfig && Object.keys(tenant.ssoConfig).length) {
    console.log(`SSO config: ${JSON.stringify(tenant.ssoConfig)}`);
  }
  if (Object.keys(models).length) {
    console.log(`Models: ${JSON.stringify(models)}`);
  }
}

function renderAuditLogs(logs) {
  if (!logs.length) {
    console.log("No audit logs.");
    return;
  }
  console.log("Audit logs:");
  console.log("");
  for (const entry of logs) {
    console.log(`#${entry.id}  tenant=${entry.tenantId || "(all)"}  action=${entry.action}  actor=${entry.actorType || "system"}:${entry.actorId || "(none)"}`);
    console.log(`   target=${entry.targetType || "(none)"}:${entry.targetId || "(none)"}  created=${formatDateTime(entry.createdAt)}  requestId=${entry.requestId || "(none)"}`);
  }
}

function renderVectorRuntime(data) {
  const vector = data.vector || {};
  const ann = vector.ann || {};
  const runtime = data.runtime || {};
  const config = runtime.config || {};
  const reindex = data.reindex || {};
  printSummary("Vector search runtime.", [
    `vectors: ${vector.vectors ?? "(unknown)"}`,
    `dimensions: ${vector.vectorDims ?? "(unknown)"}`,
    `ANN enabled: ${ann.enabled ? "yes" : "no"}`,
    `ANN mode: ${ann.mode || config.mode || "(unknown)"}`,
    `ANN index ready: ${ann.indexReady ? "yes" : "no"}`,
    `ANN index vectors: ${ann.indexVectors ?? "(unknown)"}`,
    `ANN circuit open: ${ann.circuitOpen ? "yes" : "no"}`,
    `searches observed: ${runtime.total ?? 0}`,
    `modes: ${JSON.stringify(runtime.modes || {})}`,
    `fallbacks: ${JSON.stringify(runtime.fallbacks || {})}`,
    `dense p95 ms: ${runtime.dense_search_ms?.p95 ?? "(none)"}`,
    `scanned p95: ${runtime.scanned_count?.p95 ?? "(none)"}`,
    `shadow overlap avg: ${runtime.shadow?.top_k_overlap?.avg ?? "(none)"}`,
    `reindex running: ${reindex.running ? "yes" : "no"}`,
    `last reindex: ${reindex.last?.status || "(none)"}`
  ]);
}

function renderVectorReindex(data, fallbackMode) {
  const reindex = data.reindex || {};
  printSummary("Vector reindex requested.", [
    `accepted: ${data.accepted ? "yes" : "no"}`,
    `mode: ${data.mode || fallbackMode || "(unknown)"}`,
    `running: ${reindex.running ? "yes" : "no"}`,
    `status: ${reindex.last?.status || "(pending)"}`,
    `startedAt: ${formatDateTime(reindex.last?.startedAt)}`
  ]);
}

function renderMemoriesList(memories, title = "Memories") {
  if (!memories.length) {
    console.log(`No ${title.toLowerCase()}.`);
    return;
  }
  console.log(`${title}:`);
  console.log("");
  for (const memory of memories) {
    const conversation = memory?.sourceConfig?.conversationMemory && typeof memory.sourceConfig.conversationMemory === "object"
      ? memory.sourceConfig.conversationMemory
      : {};
    console.log(`${memory.id || "(unknown)"}  ${memory.name || "(unnamed)"}  model=${memory.model || "(default)"}  conversation=${conversation.enabled ? "on" : "off"}  strategy=${conversation.strategy || "turn_log"}`);
  }
}

function renderMemoryRecord(memory, options = {}) {
  if (!memory) {
    console.log("Memory not found.");
    return;
  }
  const conversation = memory?.sourceConfig?.conversationMemory && typeof memory.sourceConfig.conversationMemory === "object"
    ? memory.sourceConfig.conversationMemory
    : {};
  console.log(`${options.title || "Memory"}: ${memory.id || "(unknown)"}`);
  console.log(`Name: ${memory.name || "(none)"}`);
  console.log(`Description: ${memory.description || "(none)"}`);
  console.log(`Role: ${memory.role || "(none)"}`);
  console.log(`Personality: ${memory.personality || "(none)"}`);
  console.log(`Provider/model: ${memory.provider || "(default)"} / ${memory.model || "(default)"}`);
  console.log(`Collection: ${memory.collection || "(unknown)"}`);
  console.log(`Conversation memory: ${conversation.enabled ? "enabled" : "disabled"}`);
  console.log(`Conversation strategy: ${conversation.strategy || "turn_log"}`);
  console.log(`Conversation wiki: ${conversation.wikiEnabled || conversation.strategy === "hybrid_wiki" ? "enabled" : "off"}`);
  if (memory.metadata && Object.keys(memory.metadata).length) {
    console.log(`Metadata: ${JSON.stringify(memory.metadata)}`);
  }
  if (memory.sourceConfig && Object.keys(memory.sourceConfig).length) {
    console.log(`Source config: ${JSON.stringify(memory.sourceConfig)}`);
  }
}

function resolveEffectiveCollection(client, payload) {
  return payload?.meta?.collection || client.collection || "default";
}

function walkFiles(rootDir) {
  const out = [];

  function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      if (entry.isFile()) out.push(absPath);
    }
  }

  visit(rootDir);
  return out;
}

async function collectFolderDocuments(folderPath, options = {}) {
  const rootDir = path.resolve(String(folderPath || "").trim());
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Folder not found: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Not a folder: ${rootDir}`);
  }

  const repoContext = options.repoContext || await resolveLocalRepoContext(rootDir);
  const codebaseMode = options.forceCode === true || Boolean(repoContext) || looksLikeCodebaseRoot(rootDir);
  const files = walkFiles(rootDir);
  const usedDocIds = new Map();
  const accepted = [];
  const skipped = [];

  for (const absPath of files) {
    const relPath = path.relative(rootDir, absPath);
    if (codebaseMode && shouldSkipCodebaseRelPath(relPath)) {
      skipped.push({ path: relPath, reason: "ignored generated or dependency directory" });
      continue;
    }
    const fileType = detectIngestibleFileType(absPath);
    if (fileType === "unsupported") {
      skipped.push({ path: relPath, reason: "unsupported extension" });
      continue;
    }

    let text = "";
    try {
      text = await extractDocumentText(absPath);
    } catch (error) {
      const detail = error && error.message ? error.message : "failed to extract text";
      skipped.push({ path: relPath, reason: detail });
      continue;
    }

    const repoRelPath = repoContext?.repoRoot && absPath.startsWith(repoContext.repoRoot)
      ? path.relative(repoContext.repoRoot, absPath)
      : relPath;
    const baseDocId = safeDocIdFromPath(repoRelPath);
    const nextCount = (usedDocIds.get(baseDocId) || 0) + 1;
    usedDocIds.set(baseDocId, nextCount);
    const docId = nextCount === 1 ? baseDocId : `${baseDocId}-${nextCount}`;
    const language = detectCodeLanguage(repoRelPath);
    const sourceType = options.sourceType
      ? String(options.sourceType).trim().toLowerCase()
      : (language ? "code" : "text");

    accepted.push({
      absPath,
      relPath,
      repoRelPath,
      docId,
      language,
      sourceType,
      text
    });
  }

  return { rootDir, accepted, skipped, repoContext, codebaseMode };
}

function extractDocs(payload) {
  const data = payload?.data || payload;
  return Array.isArray(data?.docs) ? data.docs : [];
}

function extractCollections(payload) {
  const data = payload?.data || payload;
  return Array.isArray(data?.collections) ? data.collections : [];
}

async function handleCollections(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list", "delete"]);
  if (subcommand === "list") {
    await handleCollectionsList(parsed);
    return;
  }
  if (subcommand === "delete") {
    await handleCollectionsDelete(parsed);
    return;
  }
  throw new Error("collections requires a subcommand: list or delete.");
}

async function handleCollectionsList(parsed) {
  const client = buildClient(parsed, { ignoreCollection: true });
  const payload = await client.listCollections({ tenantId: getFlag(parsed, "tenant") });
  const collections = extractCollections(payload);

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!collections.length) {
    console.log("No collections.");
    return;
  }

  console.log("Collections:");
  console.log("");
  collections.forEach((item, index) => {
    console.log(`${index + 1}. ${item.collection}  docs=${formatCollectionCount(item.totalDocs)}`);
  });
}

async function handleCollectionsDelete(parsed) {
  const client = buildClient(parsed, { ignoreCollection: true });
  const collection = resolveRequestedCollection(parsed, "");
  if (!collection) {
    throw new Error("collections delete requires --collection NAME.");
  }

  await ensureConfirmedAction(
    parsed,
    `Delete collection "${collection}" and all documents inside it?`,
    false
  );

  const payload = await client.deleteCollection(collection, {
    tenantId: getFlag(parsed, "tenant")
  });

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  printSummary("Collection deleted.", [
    `collection: ${collection}`,
    `deletedDocs: ${data.deletedDocs ?? 0}`,
    `deletedMemoryItems: ${data.deletedMemoryItems ?? 0}`
  ]);
}

async function handleDocs(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list", "delete", "replace"]);
  if (subcommand === "list") {
    await handleDocsList(parsed);
    return;
  }
  if (subcommand === "delete") {
    await handleDocsDelete(parsed);
    return;
  }
  if (subcommand === "replace") {
    await handleDocsReplace(parsed);
    return;
  }
  throw new Error("docs requires a subcommand: list, delete, or replace.");
}

async function handleDocsList(parsed) {
  const client = buildClient(parsed);
  const payload = await client.listDocs({
    collection: getFlag(parsed, "collection"),
    tenantId: getFlag(parsed, "tenant")
  });
  const docs = extractDocs(payload);
  const effectiveCollection = payload?.meta?.collection || client.collection || "default";

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!docs.length) {
    console.log(`No docs in collection ${effectiveCollection}.`);
    return;
  }

  console.log(`Docs in collection ${effectiveCollection}:`);
  console.log("");
  docs.forEach((item, index) => {
    console.log(`${index + 1}. ${item.docId}  chunks=${item.chunks ?? 0}`);
  });
}

async function handleDocsDelete(parsed) {
  const client = buildClient(parsed);
  const docId = String(getFlag(parsed, "doc-id") || getFlag(parsed, "docId") || "").trim();
  if (!docId) {
    throw new Error("docs delete requires --doc-id ID.");
  }
  const collection = resolveRequestedCollection(parsed, client.collection || "default");

  await ensureConfirmedAction(
    parsed,
    `Delete doc "${docId}" from collection "${collection}"?`,
    false
  );

  const payload = await client.deleteDoc(docId, {
    collection,
    tenantId: getFlag(parsed, "tenant")
  });

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printSummary("Document deleted.", [
    `docId: ${docId}`,
    `collection: ${collection}`
  ]);
}

async function handleDocsReplace(parsed) {
  const client = buildClient(parsed);
  const docId = String(getFlag(parsed, "doc-id") || getFlag(parsed, "docId") || "").trim();
  if (!docId) {
    throw new Error("docs replace requires --doc-id ID.");
  }
  const url = String(getFlag(parsed, "url") || "").trim();
  const text = (await getTextInput(parsed)).trim();
  if (url && text) {
    throw new Error("docs replace accepts either --url or text input, not both.");
  }
  if (!url && !text) {
    throw new Error("docs replace requires --text, --file, --url, or piped stdin.");
  }

  const collection = resolveRequestedCollection(parsed, client.collection || "default");
  await ensureConfirmedAction(
    parsed,
    `Replace doc "${docId}" in collection "${collection}"?`,
    false
  );

  await deleteDocumentForUpdate(client, docId, {
    collection,
    tenantId: getFlag(parsed, "tenant")
  });

  const sourcePayload = await buildSingleInputSourcePayload(parsed, docId);
  const payload = await indexDocumentInput(client, docId, text, url, buildWriteParams(parsed, {
    collection,
    ...sourcePayload
  }));

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  printSummary("Document replaced.", [
    `docId: ${data.docId || docId}`,
    `chunksIndexed: ${data.chunksIndexed ?? "unknown"}`,
    `collection: ${resolveEffectiveCollection(client, payload)}`
  ]);
}

async function handleWrite(parsed) {
  const client = buildClient(parsed);
  const replaceExisting = boolFromFlag(getFlag(parsed, "replace"), false);
  const syncFolder = boolFromFlag(getFlag(parsed, "sync"), false);
  const folder = String(getFlag(parsed, "folder") || "").trim();
  const githubRepoRaw = String(getFlag(parsed, "github-repo") || getFlag(parsed, "repo-url") || "").trim();
  if (folder || githubRepoRaw) {
    const docId = String(getFlag(parsed, "doc-id") || getFlag(parsed, "docId") || "").trim();
    const url = String(getFlag(parsed, "url") || "").trim();
    const directText = getFlag(parsed, "text");
    const filePath = getFlag(parsed, "file");
    if (folder && githubRepoRaw) {
      throw new Error("Use either --folder or --github-repo, not both.");
    }
    if (docId || url || (directText && directText !== true) || (filePath && filePath !== true)) {
      throw new Error("write --folder and write --github-repo cannot be combined with --doc-id, --text, --file, or --url.");
    }

    let cloned = null;
    let documents = null;
    try {
      if (githubRepoRaw) {
        const repoSpec = parseGitHubRepoSpec(githubRepoRaw);
        const branch = maybeStringFlag(parsed, "branch") || repoSpec.branch || "main";
        cloned = await cloneGitHubRepoToTempDir(parsed, repoSpec, branch);
        documents = await collectFolderDocuments(cloned.targetDir, {
          repoContext: cloned.repoContext,
          forceCode: true
        });
      } else {
        documents = await collectFolderDocuments(folder);
      }
    } finally {
      if (cloned && !documents) {
        fs.rmSync(cloned.tempRoot, { recursive: true, force: true });
      }
    }

    if (!documents?.accepted?.length) {
      throw new Error("No supported files were found. SupaVector CLI codebase ingest accepts text, PDF, DOCX, and common source/config files.");
    }

    const collection = String(
      getFlag(parsed, "collection")
      || defaultCollectionFromRepositoryName(documents.repoContext?.repositoryName, documents.rootDir)
    ).trim();

    if (syncFolder) {
      const targetLabel = githubRepoRaw ? githubRepoRaw : documents.rootDir;
      await ensureConfirmedAction(
        parsed,
        `Sync collection "${collection}" to match ${targetLabel}? This may delete docs that are not present in the current source.`,
        false
      );
    }

    let result = null;
    try {
      result = await ingestCollectedDocuments(client, parsed, collection, documents, {
        replaceExisting,
        syncFolder,
        repoContext: documents.repoContext
      });
    } finally {
      if (cloned) {
        fs.rmSync(cloned.tempRoot, { recursive: true, force: true });
      }
    }

    if (boolFromFlag(getFlag(parsed, "json"), false)) {
      console.log(JSON.stringify({
        ok: true,
        source: githubRepoRaw || documents.rootDir,
        collection: result.collection,
        indexed: result.indexed,
        skipped: result.skipped,
        replaced: result.replaced,
        pruned: result.pruned,
        repository: documents.repoContext?.repositoryName || null,
        branch: documents.repoContext?.branch || null
      }, null, 2));
      return;
    }

    printSummary(githubRepoRaw ? "GitHub repo ingest complete." : "Folder ingest complete.", [
      `${githubRepoRaw ? "source" : "folder"}: ${githubRepoRaw || documents.rootDir}`,
      `collection: ${result.collection}`,
      `repository: ${documents.repoContext?.repositoryName || "(none)"}`,
      `branch: ${documents.repoContext?.branch || "(unknown)"}`,
      `indexed: ${result.indexed.length}`,
      `replaced: ${result.replaced.length}`,
      `pruned: ${result.pruned.length}`,
      `skipped: ${result.skipped.length}`
    ]);
    if (result.skipped.length) {
      console.log("");
      console.log("Skipped:");
      result.skipped.slice(0, 10).forEach((item) => {
        console.log(`- ${item.path} (${item.reason})`);
      });
      if (result.skipped.length > 10) {
        console.log(`- ... and ${result.skipped.length - 10} more`);
      }
    }
    return;
  }

  const docId = String(getFlag(parsed, "doc-id") || getFlag(parsed, "docId") || "").trim();
  if (!docId) {
    throw new Error("write requires --doc-id, or use --folder PATH.");
  }
  const url = String(getFlag(parsed, "url") || "").trim();
  const text = (await getTextInput(parsed)).trim();
  if (url && text) {
    throw new Error("write accepts either --url or text input, not both.");
  }
  if (!url && !text) {
    throw new Error("write requires --text, --file, --url, or piped stdin.");
  }

  const collection = getFlag(parsed, "collection");
  const tenantId = getFlag(parsed, "tenant");
  if (replaceExisting) {
    await deleteDocumentForUpdate(client, docId, { collection, tenantId });
  }

  const sourcePayload = await buildSingleInputSourcePayload(parsed, docId);
  const payload = await indexDocumentInput(client, docId, text, url, buildWriteParams(parsed, sourcePayload));

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  printSummary("Write complete.", [
    `docId: ${data.docId || docId}`,
    `chunksIndexed: ${data.chunksIndexed ?? "unknown"}`,
    `replaced: ${replaceExisting ? "yes" : "no"}`,
    `collection: ${resolveEffectiveCollection(client, payload)}`
  ]);
}

async function handleSearch(parsed) {
  const client = buildClient(parsed);
  const query = String(getFlag(parsed, "q") || parsed.positionals.slice(1).join(" ") || "").trim();
  if (!query) {
    throw new Error("search requires --q QUERY or a positional query.");
  }
  const k = parseInt(String(getFlag(parsed, "k") || "5"), 10);
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("search requires --k to be a positive integer.");
  }
  const payload = await client.search(query, buildRetrievalParams(parsed, { k }));

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  const results = Array.isArray(data.results) ? data.results : [];
  console.log(`Query: ${query}`);
  console.log(`Collection: ${resolveEffectiveCollection(client, payload)}`);
  if (!results.length) {
    console.log("No results.");
    return;
  }
  console.log("");
  results.forEach((item, index) => {
    const score = Number.isFinite(item.score) ? item.score.toFixed(4) : String(item.score || "");
    console.log(`${index + 1}. ${item.docId || "(no docId)"}  score=${score}`);
    if (item.preview) console.log(`   ${item.preview}`);
  });
}

async function handleAsk(parsed) {
  const client = buildClient(parsed);
  const question = String(getFlag(parsed, "question") || parsed.positionals.slice(1).join(" ") || "").trim();
  if (!question) {
    throw new Error("ask requires --question TEXT or a positional question.");
  }
  const k = parseInt(String(getFlag(parsed, "k") || "5"), 10);
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("ask requires --k to be a positive integer.");
  }
  const answerLength = String(getFlag(parsed, "answer-length") || getFlag(parsed, "answerLength") || "auto");
  const provider = (() => {
    const raw = getFlag(parsed, "provider") ?? getFlag(parsed, "answer-provider");
    if (raw === undefined) return "";
    return normalizeProviderSelection(raw, "generation", DEFAULT_ANSWER_PROVIDER);
  })();
  const model = normalizeCliOptionalModelFlag(
    getFlag(parsed, "model") ?? getFlag(parsed, "answer-model"),
    provider || DEFAULT_ANSWER_PROVIDER,
    "",
    { allowInherit: false, kind: "generation" }
  );
  const payload = await client.ask(question, buildRetrievalParams(parsed, {
    k,
    answerLength,
    provider: provider || undefined,
    model: model || undefined
  }));

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  console.log(`Question: ${question}`);
  console.log(`Collection: ${resolveEffectiveCollection(client, payload)}`);
  if (data.provider) console.log(`Provider: ${data.provider}`);
  if (data.model) console.log(`Model: ${data.model}`);
  console.log("");
  console.log(data.answer || "(no answer)");
  const citations = Array.isArray(data.citations) ? data.citations : [];
  if (citations.length) {
    console.log("");
    console.log("Sources:");
    citations.forEach((item, index) => {
      if (typeof item === "string") {
        console.log(`${index + 1}. ${item}`);
        return;
      }
      console.log(`${index + 1}. ${item.docId || item.chunkId || "source"}`);
    });
  }
}

async function handleCode(parsed) {
  const client = buildClient(parsed);
  const question = String(getFlag(parsed, "question") || parsed.positionals.slice(1).join(" ") || "").trim();
  if (!question) {
    throw new Error("code requires --question TEXT or a positional question.");
  }
  const k = parseInt(String(getFlag(parsed, "k") || "5"), 10);
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("code requires --k to be a positive integer.");
  }

  const provider = (() => {
    const raw = getFlag(parsed, "provider") ?? getFlag(parsed, "answer-provider");
    if (raw === undefined) return "";
    return normalizeProviderSelection(raw, "generation", DEFAULT_ANSWER_PROVIDER);
  })();
  const model = normalizeCliOptionalModelFlag(
    getFlag(parsed, "model") ?? getFlag(parsed, "answer-model"),
    provider || DEFAULT_ANSWER_PROVIDER,
    "",
    { allowInherit: false, kind: "generation" }
  );
  const context = readJsonObjectInput(parsed, {
    jsonFlag: "context-json",
    fileFlag: "context-file",
    label: "code context"
  });
  const payload = await client.code(question, {
    ...buildRetrievalParams(parsed, { k }),
    answerLength: String(getFlag(parsed, "answer-length") || getFlag(parsed, "answerLength") || "auto"),
    task: maybeStringFlag(parsed, "task", "mode"),
    language: maybeStringFlag(parsed, "language", "lang"),
    deployment: maybeStringFlag(parsed, "deployment"),
    repository: maybeStringFlag(parsed, "repository", "repo"),
    paths: parseGitHubPathList(parsed, "paths", "path"),
    constraints: parseGitHubPathList(parsed, "constraints", "constraint"),
    errorMessage: maybeStringFlag(parsed, "error-message", "error"),
    stackTrace: maybeStringFlag(parsed, "stack-trace"),
    context: Object.keys(context).length ? context : undefined,
    provider: provider || undefined,
    model: model || undefined
  });

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  console.log(`Question: ${question}`);
  console.log(`Collection: ${resolveEffectiveCollection(client, payload)}`);
  if (data.provider) console.log(`Provider: ${data.provider}`);
  if (data.model) console.log(`Model: ${data.model}`);
  if (data.sourceSummary?.repositories?.length) {
    console.log(`Repositories: ${data.sourceSummary.repositories.join(", ")}`);
  }
  if (data.sourceSummary?.languages?.length) {
    console.log(`Languages: ${data.sourceSummary.languages.join(", ")}`);
  }
  console.log("");
  console.log(data.answer || "(no answer)");

  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length) {
    console.log("");
    console.log("Relevant files:");
    renderCodeFiles(files);
  }

  const citations = Array.isArray(data.citations) ? data.citations : [];
  if (citations.length) {
    console.log("");
    console.log("Sources:");
    citations.forEach((item, index) => {
      if (typeof item === "string") {
        console.log(`${index + 1}. ${item}`);
        return;
      }
      const label = item.path || item.docId || item.chunkId || "source";
      console.log(`${index + 1}. ${label}`);
    });
  }
}

async function handleBooleanAsk(parsed) {
  const client = buildClient(parsed);
  const question = String(getFlag(parsed, "question") || parsed.positionals.slice(1).join(" ") || "").trim();
  if (!question) {
    throw new Error("boolean_ask requires --question TEXT or a positional question.");
  }
  const k = parseInt(String(getFlag(parsed, "k") || "5"), 10);
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("boolean_ask requires --k to be a positive integer.");
  }
  const provider = (() => {
    const raw = getFlag(parsed, "provider") ?? getFlag(parsed, "boolean-ask-provider");
    if (raw === undefined) return "";
    return normalizeProviderSelection(raw, "generation", DEFAULT_ANSWER_PROVIDER);
  })();
  const model = normalizeCliOptionalModelFlag(
    getFlag(parsed, "model") ?? getFlag(parsed, "boolean-ask-model"),
    provider || DEFAULT_ANSWER_PROVIDER,
    "",
    { allowInherit: false, kind: "generation" }
  );
  const payload = await client.booleanAsk(question, buildRetrievalParams(parsed, {
    k,
    provider: provider || undefined,
    model: model || undefined
  }));

  if (boolFromFlag(getFlag(parsed, "json"), false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const data = payload?.data || payload;
  console.log(`Question: ${question}`);
  console.log(`Collection: ${resolveEffectiveCollection(client, payload)}`);
  if (data.provider) console.log(`Provider: ${data.provider}`);
  if (data.model) console.log(`Model: ${data.model}`);
  console.log("");
  console.log(data.answer || "invalid");
  const citations = Array.isArray(data.citations) ? data.citations : [];
  if (citations.length) {
    console.log("");
    console.log("Sources:");
    citations.forEach((item, index) => {
      if (typeof item === "string") {
        console.log(`${index + 1}. ${item}`);
        return;
      }
      console.log(`${index + 1}. ${item.docId || item.chunkId || "source"}`);
    });
  }
  const supportingChunks = Array.isArray(data.supportingChunks) ? data.supportingChunks : [];
  if (supportingChunks.length) {
    console.log("");
    console.log("Supporting chunks:");
    supportingChunks.forEach((item, index) => {
      const score = Number.isFinite(item?.score) ? ` score=${Number(item.score).toFixed(4)}` : "";
      console.log(`${index + 1}. ${item.docId || item.chunkId || "chunk"}${score}`);
      const text = String(item?.text || "").replace(/\s+/g, " ").trim();
      if (text) {
        const preview = text.length > 220 ? `${text.slice(0, 220)}...` : text;
        console.log(`   ${preview}`);
      }
    });
  }
}

async function handleTokens(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list", "create", "revoke"]);
  if (subcommand === "list") {
    const payload = await requestApiJson(parsed, "GET", "/v1/admin/service-tokens");
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderServiceTokensList(Array.isArray(data.tokens) ? data.tokens : []));
    return;
  }
  if (subcommand === "create") {
    const body = buildServiceTokenBodyFromFlags(parsed, {
      defaultRoles: ["indexer", "reader"]
    });
    if (!body.name) {
      throw new Error("tokens create requires --name.");
    }
    const payload = await requestApiJson(parsed, "POST", "/v1/admin/service-tokens", { body });
    const data = unwrapEnvelope(payload);
    if (!printJsonOrSummary(parsed, payload, () => {
      printSummary("Service token created.", [
        `id: ${data.tokenInfo?.id || "(unknown)"}`,
        `name: ${data.tokenInfo?.name || body.name}`,
        `principalId: ${data.tokenInfo?.principalId || body.principalId || "(default principal)"}`,
        `roles: ${formatRoles(data.tokenInfo?.roles || body.roles)}`,
        `expiresAt: ${formatDateTime(data.tokenInfo?.expiresAt || body.expiresAt)}`,
        `token: ${data.token || ""}`,
        "Store this token now. It will not be shown again."
      ]);
    })) {
      return;
    }
    return;
  }
  if (subcommand === "revoke") {
    const id = maybePositiveIntFlag(parsed, "id");
    if (!id) {
      throw new Error("tokens revoke requires --id.");
    }
    await ensureConfirmedAction(parsed, `Revoke service token #${id}?`, false);
    const payload = await requestApiJson(parsed, "DELETE", `/v1/admin/service-tokens/${id}`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      printSummary("Service token revoked.", [
        `id: ${data.token?.id || id}`,
        `name: ${data.token?.name || "(unknown)"}`,
        `revokedAt: ${formatDateTime(data.token?.revokedAt)}`
      ]);
    });
    return;
  }
  throw new Error("tokens requires a subcommand: list, create, or revoke.");
}

async function handleUsers(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list", "create", "update"]);
  if (subcommand === "list") {
    const payload = await requestApiJson(parsed, "GET", "/v1/admin/users");
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderUsersList(Array.isArray(data.users) ? data.users : []));
    return;
  }
  if (subcommand === "create") {
    const body = buildTenantUserBodyFromFlags(parsed, {
      roles: { fallback: ["reader"] }
    });
    if (!body.username) {
      throw new Error("users create requires --username.");
    }
    if (!body.password) {
      throw new Error("users create requires --password.");
    }
    const payload = await requestApiJson(parsed, "POST", "/v1/admin/users", { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      printSummary("User created.", [
        `id: ${data.user?.id || "(unknown)"}`,
        `username: ${data.user?.username || body.username}`,
        `roles: ${formatRoles(data.user?.roles || body.roles)}`,
        `disabled: ${data.user?.disabled ? "yes" : "no"}`,
        `ssoOnly: ${data.user?.ssoOnly ? "yes" : "no"}`
      ]);
    });
    return;
  }
  if (subcommand === "update") {
    const id = maybePositiveIntFlag(parsed, "id", "user-id");
    if (!id) {
      throw new Error("users update requires --id.");
    }
    const body = buildTenantUserBodyFromFlags(parsed);
    delete body.username;
    if (!Object.keys(body).length) {
      throw new Error("users update requires at least one mutable field such as --roles, --disabled, --password, --email, --full-name, or --sso-only.");
    }
    const payload = await requestApiJson(parsed, "PATCH", `/v1/admin/users/${id}`, { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      printSummary("User updated.", [
        `id: ${data.user?.id || id}`,
        `username: ${data.user?.username || "(unknown)"}`,
        `roles: ${formatRoles(data.user?.roles)}`,
        `disabled: ${data.user?.disabled ? "yes" : "no"}`,
        `ssoOnly: ${data.user?.ssoOnly ? "yes" : "no"}`
      ]);
    });
    return;
  }
  throw new Error("users requires a subcommand: list, create, or update.");
}

async function handleTenant(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["get", "show", "update"]);
  if (subcommand === "get" || subcommand === "show") {
    const payload = await requestApiJson(parsed, "GET", "/v1/admin/tenant");
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderTenantRecord(data.tenant, { title: "Tenant settings" }));
    return;
  }
  if (subcommand === "update") {
    const body = buildTenantSettingsBodyFromFlags(parsed);
    if (!Object.keys(body).length) {
      throw new Error("tenant update requires flags such as --auth-mode, --sso-providers, --sso-config-json/--sso-config-file, model overrides, or --body-json/--body-file.");
    }
    const payload = await requestApiJson(parsed, "PATCH", "/v1/admin/tenant", { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderTenantRecord(data.tenant, { title: "Tenant updated" }));
    return;
  }
  throw new Error("tenant requires a subcommand: get or update.");
}

function buildEnterpriseBootstrapFieldsFromFlags(parsed, body = {}) {
  const next = { ...body };
  const bootstrapAdminUsername = maybeStringFlag(parsed, "bootstrap-admin", "bootstrap-admin-username");
  const bootstrapAdminPassword = maybeStringFlag(parsed, "bootstrap-admin-password");
  const bootstrapAdminEmail = maybeNullableStringFlag(parsed, "bootstrap-admin-email");
  const bootstrapAdminFullName = maybeNullableStringFlag(parsed, "bootstrap-admin-full-name");
  const bootstrapAdminRoles = maybeRolesFlag(parsed, "bootstrap-admin-roles");
  const bootstrapAdminSsoOnly = maybeBooleanFlag(parsed, "bootstrap-admin-sso-only");
  if (
    bootstrapAdminUsername !== undefined
    || bootstrapAdminPassword !== undefined
    || bootstrapAdminEmail !== undefined
    || bootstrapAdminFullName !== undefined
    || bootstrapAdminRoles !== undefined
    || bootstrapAdminSsoOnly !== undefined
  ) {
    next.bootstrapAdmin = {
      ...(typeof next.bootstrapAdmin === "object" && next.bootstrapAdmin && !Array.isArray(next.bootstrapAdmin) ? next.bootstrapAdmin : {}),
      username: bootstrapAdminUsername ?? next.bootstrapAdmin?.username,
      ...(bootstrapAdminPassword !== undefined ? { password: bootstrapAdminPassword } : {}),
      ...(bootstrapAdminEmail !== undefined ? { email: bootstrapAdminEmail } : {}),
      ...(bootstrapAdminFullName !== undefined ? { fullName: bootstrapAdminFullName } : {}),
      ...(bootstrapAdminRoles !== undefined ? { roles: bootstrapAdminRoles } : {}),
      ...(bootstrapAdminSsoOnly !== undefined ? { ssoOnly: bootstrapAdminSsoOnly } : {})
    };
  }

  const bootstrapTokenName = maybeStringFlag(parsed, "bootstrap-token-name");
  const bootstrapTokenPrincipalId = maybeStringFlag(parsed, "bootstrap-token-principal-id", "bootstrap-token-principal");
  const bootstrapTokenRoles = maybeRolesFlag(parsed, "bootstrap-token-roles");
  const bootstrapTokenExpiresAt = maybeStringFlag(parsed, "bootstrap-token-expires-at");
  if (
    bootstrapTokenName !== undefined
    || bootstrapTokenPrincipalId !== undefined
    || bootstrapTokenRoles !== undefined
    || bootstrapTokenExpiresAt !== undefined
  ) {
    next.bootstrapServiceToken = {
      ...(typeof next.bootstrapServiceToken === "object" && next.bootstrapServiceToken && !Array.isArray(next.bootstrapServiceToken) ? next.bootstrapServiceToken : {}),
      ...(bootstrapTokenName !== undefined ? { name: bootstrapTokenName } : {}),
      ...(bootstrapTokenPrincipalId !== undefined ? { principalId: bootstrapTokenPrincipalId } : {}),
      ...(bootstrapTokenRoles !== undefined ? { roles: bootstrapTokenRoles } : {}),
      ...(bootstrapTokenExpiresAt !== undefined ? { expiresAt: bootstrapTokenExpiresAt } : {})
    };
  }
  return next;
}

function resolveEnterpriseTenantFlag(parsed) {
  const tenantId = maybeStringFlag(parsed, "tenant", "tenant-id");
  if (!tenantId) {
    throw new Error("This command requires --tenant TENANT_ID.");
  }
  return tenantId;
}

async function handleEnterpriseTenantUsers(parsed, tenantId) {
  const action = getNestedSubcommand(parsed, 2);
  if (action === "list") {
    const payload = await requestApiJson(parsed, "GET", `/v1/admin/tenants/${encodeURIComponent(tenantId)}/users`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderUsersList(Array.isArray(data.users) ? data.users : [], `Users for ${tenantId}`));
    return;
  }
  if (action === "create") {
    const body = buildTenantUserBodyFromFlags(parsed, {
      roles: { fallback: ["reader"] }
    });
    if (!body.username) {
      throw new Error("tenants users create requires --username.");
    }
    const payload = await requestApiJson(parsed, "POST", `/v1/admin/tenants/${encodeURIComponent(tenantId)}/users`, { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      const rows = [
        `tenant: ${tenantId}`,
        `id: ${data.user?.id || "(unknown)"}`,
        `username: ${data.user?.username || body.username}`,
        `roles: ${formatRoles(data.user?.roles || body.roles)}`
      ];
      if (data.generatedPassword) {
        rows.push(`generatedPassword: ${data.generatedPassword}`);
      }
      printSummary("Tenant user created.", rows);
    });
    return;
  }
  if (action === "update") {
    const id = maybePositiveIntFlag(parsed, "id", "user-id");
    if (!id) {
      throw new Error("tenants users update requires --id.");
    }
    const body = buildTenantUserBodyFromFlags(parsed);
    delete body.username;
    if (!Object.keys(body).length) {
      throw new Error("tenants users update requires at least one mutable field.");
    }
    const payload = await requestApiJson(parsed, "PATCH", `/v1/admin/tenants/${encodeURIComponent(tenantId)}/users/${id}`, { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      printSummary("Tenant user updated.", [
        `tenant: ${tenantId}`,
        `id: ${data.user?.id || id}`,
        `username: ${data.user?.username || "(unknown)"}`,
        `roles: ${formatRoles(data.user?.roles)}`
      ]);
    });
    return;
  }
  throw new Error("tenants users requires a nested subcommand: list, create, or update.");
}

async function handleEnterpriseTenantTokens(parsed, tenantId) {
  const action = getNestedSubcommand(parsed, 2);
  if (action === "list") {
    const payload = await requestApiJson(parsed, "GET", `/v1/admin/tenants/${encodeURIComponent(tenantId)}/service-tokens`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderServiceTokensList(Array.isArray(data.tokens) ? data.tokens : [], `Service tokens for ${tenantId}`));
    return;
  }
  if (action === "create") {
    const body = buildServiceTokenBodyFromFlags(parsed, {
      defaultRoles: ["indexer", "reader"]
    });
    if (!body.name) {
      throw new Error("tenants tokens create requires --name.");
    }
    const payload = await requestApiJson(parsed, "POST", `/v1/admin/tenants/${encodeURIComponent(tenantId)}/service-tokens`, { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      printSummary("Tenant service token created.", [
        `tenant: ${tenantId}`,
        `id: ${data.tokenInfo?.id || "(unknown)"}`,
        `name: ${data.tokenInfo?.name || body.name}`,
        `principalId: ${data.tokenInfo?.principalId || body.principalId || tenantId}`,
        `roles: ${formatRoles(data.tokenInfo?.roles || body.roles)}`,
        `token: ${data.token || ""}`,
        "Store this token now. It will not be shown again."
      ]);
    });
    return;
  }
  if (action === "revoke") {
    const id = maybePositiveIntFlag(parsed, "id");
    if (!id) {
      throw new Error("tenants tokens revoke requires --id.");
    }
    await ensureConfirmedAction(parsed, `Revoke tenant service token #${id} for ${tenantId}?`, false);
    const payload = await requestApiJson(parsed, "DELETE", `/v1/admin/tenants/${encodeURIComponent(tenantId)}/service-tokens/${id}`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      printSummary("Tenant service token revoked.", [
        `tenant: ${tenantId}`,
        `id: ${data.token?.id || id}`,
        `name: ${data.token?.name || "(unknown)"}`,
        `revokedAt: ${formatDateTime(data.token?.revokedAt)}`
      ]);
    });
    return;
  }
  throw new Error("tenants tokens requires a nested subcommand: list, create, or revoke.");
}

async function handleTenants(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list", "get", "show", "create", "update", "users", "tokens", "service-tokens"]);
  if (subcommand === "list") {
    const limit = maybePositiveIntFlag(parsed, "limit");
    const search = maybeStringFlag(parsed, "search");
    const payload = await requestApiJson(parsed, "GET", "/v1/admin/tenants", {
      query: {
        ...(limit ? { limit } : {}),
        ...(search ? { search } : {})
      }
    });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      const tenants = Array.isArray(data.tenants) ? data.tenants : [];
      if (!tenants.length) {
        console.log("No tenants.");
        return;
      }
      console.log("Tenants:");
      console.log("");
      for (const tenant of tenants) {
        console.log(`${tenant.id}  auth=${tenant.authMode || "(default)"}  users=${tenant.summary?.userCount ?? 0}  tokens=${tenant.summary?.serviceTokenCount ?? 0}`);
      }
    });
    return;
  }

  if (subcommand === "users") {
    const tenantId = resolveEnterpriseTenantFlag(parsed);
    await handleEnterpriseTenantUsers(parsed, tenantId);
    return;
  }

  if (subcommand === "tokens" || subcommand === "service-tokens") {
    const tenantId = resolveEnterpriseTenantFlag(parsed);
    await handleEnterpriseTenantTokens(parsed, tenantId);
    return;
  }

  if (subcommand === "get" || subcommand === "show") {
    const tenantId = resolveEnterpriseTenantFlag(parsed);
    const payload = await requestApiJson(parsed, "GET", `/v1/admin/tenants/${encodeURIComponent(tenantId)}`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderTenantRecord(data.tenant, { title: "Enterprise tenant" }));
    return;
  }

  if (subcommand === "create") {
    const tenantId = resolveEnterpriseTenantFlag(parsed);
    let body = buildTenantSettingsBodyFromFlags(parsed, {
      allowName: true,
      allowExternalId: true,
      allowMetadata: true,
      bodyLabel: "tenant create request body"
    });
    body = buildEnterpriseBootstrapFieldsFromFlags(parsed, body);
    body.tenantId = tenantId;
    if (!Object.keys(body).length || !body.tenantId) {
      throw new Error("tenants create requires --tenant plus any optional create flags or --body-json/--body-file.");
    }
    const payload = await requestApiJson(parsed, "POST", "/v1/admin/tenants", { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      const rows = [
        `tenant: ${data.tenant?.id || tenantId}`,
        `authMode: ${data.tenant?.authMode || "(default)"}`,
        `serviceTokens: ${data.tenant?.summary?.serviceTokenCount ?? 0}`,
        `users: ${data.tenant?.summary?.userCount ?? 0}`
      ];
      if (data.bootstrapAdmin?.user?.username) {
        rows.push(`bootstrapAdmin: ${data.bootstrapAdmin.user.username}`);
      }
      if (data.bootstrapAdmin?.generatedPassword) {
        rows.push(`bootstrapAdminPassword: ${data.bootstrapAdmin.generatedPassword}`);
      }
      if (data.bootstrapServiceToken?.token) {
        rows.push(`bootstrapServiceToken: ${data.bootstrapServiceToken.token}`);
      }
      printSummary("Enterprise tenant created.", rows);
    });
    return;
  }

  if (subcommand === "update") {
    const tenantId = resolveEnterpriseTenantFlag(parsed);
    const body = buildTenantSettingsBodyFromFlags(parsed, {
      allowName: true,
      allowExternalId: true,
      allowMetadata: true,
      bodyLabel: "tenant update request body"
    });
    if (!Object.keys(body).length) {
      throw new Error("tenants update requires one or more update flags or --body-json/--body-file.");
    }
    const payload = await requestApiJson(parsed, "PATCH", `/v1/admin/tenants/${encodeURIComponent(tenantId)}`, { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderTenantRecord(data.tenant, { title: "Enterprise tenant updated" }));
    return;
  }

  throw new Error("tenants requires a subcommand: list, get, create, update, users, or tokens.");
}

async function handleAudit(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list"]);
  if (subcommand !== "list") {
    throw new Error("audit requires a subcommand: list.");
  }
  const tenantId = maybeStringFlag(parsed, "tenant", "tenant-id");
  const limit = maybePositiveIntFlag(parsed, "limit");
  const action = maybeStringFlag(parsed, "action");
  const targetType = maybeStringFlag(parsed, "target-type");
  const targetId = maybeStringFlag(parsed, "target-id");
  const routePath = tenantId
    ? `/v1/admin/tenants/${encodeURIComponent(tenantId)}/audit`
    : "/v1/admin/audit";
  const payload = await requestApiJson(parsed, "GET", routePath, {
    query: {
      ...(limit ? { limit } : {}),
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {})
    }
  });
  const data = unwrapEnvelope(payload);
  printJsonOrSummary(parsed, payload, () => renderAuditLogs(Array.isArray(data.logs) ? data.logs : []));
}

async function handleVector(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["runtime", "status", "reindex"]);
  if (subcommand === "runtime" || subcommand === "status") {
    const payload = await requestApiJson(parsed, "GET", "/v1/admin/vector/search-runtime");
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderVectorRuntime(data));
    return;
  }
  if (subcommand === "reindex") {
    const mode = String(getFlag(parsed, "mode") || "always").trim().toLowerCase();
    if (!["auto", "always", "force", "off", "disabled"].includes(mode)) {
      throw new Error("vector reindex --mode must be auto, always, force, off, or disabled.");
    }
    const payload = await requestApiJson(parsed, "POST", "/v1/admin/vector/reindex", {
      body: { mode }
    });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderVectorReindex(data, mode));
    return;
  }
  throw new Error("vector requires a subcommand: runtime or reindex.");
}

async function handleMemories(parsed) {
  const subcommand = normalizeSubcommand(parsed, ["list", "get", "show", "create", "update", "delete", "status"]);
  const memoryId = maybeStringFlag(parsed, "id", "memory-id");

  if (subcommand === "list") {
    const payload = await requestApiJson(parsed, "GET", "/v1/memories");
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderMemoriesList(Array.isArray(data.memories) ? data.memories : []));
    return;
  }

  if (subcommand === "get" || subcommand === "show") {
    if (!memoryId) throw new Error("memories get requires --id.");
    const payload = await requestApiJson(parsed, "GET", `/v1/memories/${encodeURIComponent(memoryId)}`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderMemoryRecord(data.memory || data.brain, { title: "Memory" }));
    return;
  }

  if (subcommand === "status") {
    if (!memoryId) throw new Error("memories status requires --id.");
    const payload = await requestApiJson(parsed, "GET", `/v1/memories/${encodeURIComponent(memoryId)}/status`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => {
      renderMemoryRecord(data.memory || data.brain, { title: "Memory status" });
      if (data.status && Object.keys(data.status).length) {
        console.log(`Status: ${JSON.stringify(data.status)}`);
      }
    });
    return;
  }

  if (subcommand === "create") {
    const body = buildMemoryBodyFromFlags(parsed);
    if (!body.name) {
      throw new Error("memories create requires --name or --body-json/--body-file with a name.");
    }
    const payload = await requestApiJson(parsed, "POST", "/v1/memories", { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderMemoryRecord(data.memory || data.brain, { title: "Memory created" }));
    return;
  }

  if (subcommand === "update") {
    if (!memoryId) throw new Error("memories update requires --id.");
    const body = buildMemoryBodyFromFlags(parsed);
    if (!Object.keys(body).length) {
      throw new Error("memories update requires one or more fields, --source-config-json/--source-config-file, or --body-json/--body-file.");
    }
    const payload = await requestApiJson(parsed, "PATCH", `/v1/memories/${encodeURIComponent(memoryId)}`, { body });
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderMemoryRecord(data.memory || data.brain, { title: "Memory updated" }));
    return;
  }

  if (subcommand === "delete") {
    if (!memoryId) throw new Error("memories delete requires --id.");
    await ensureConfirmedAction(parsed, `Delete Memory ${memoryId}?`, false);
    const payload = await requestApiJson(parsed, "DELETE", `/v1/memories/${encodeURIComponent(memoryId)}`);
    const data = unwrapEnvelope(payload);
    printJsonOrSummary(parsed, payload, () => renderMemoryRecord(data.memory || data.brain, { title: "Memory deleted" }));
    return;
  }

  throw new Error("memories requires a subcommand: list, get, create, update, delete, or status.");
}

function handleConfig(parsed) {
  const sub = parsed.subcommand || "show";
  if (sub !== "show") {
    throw new Error(`Unknown config subcommand: ${sub}`);
  }
  const saved = readConfig();
  const showSecrets = boolFromFlag(getFlag(parsed, "show-secrets"), false);
  const output = {
    ...saved,
    apiKey: showSecrets ? (saved.apiKey || "") : maskSecret(saved.apiKey || ""),
    openAiApiKey: showSecrets ? (saved.openAiApiKey || "") : maskSecret(saved.openAiApiKey || ""),
    geminiApiKey: showSecrets ? (saved.geminiApiKey || "") : maskSecret(saved.geminiApiKey || ""),
    anthropicApiKey: showSecrets ? (saved.anthropicApiKey || "") : maskSecret(saved.anthropicApiKey || "")
  };
  console.log(JSON.stringify(output, null, 2));
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const command = parsed.command;

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "onboard":
      await handleOnboard(parsed);
      return;
    case "changemodel":
    case "change-model":
      await handleChangeModel(parsed);
      return;
    case "update":
      await handleUpdate(parsed);
      return;
    case "uninstall":
      await handleUninstall(parsed);
      return;
    case "start":
      await handleStart(parsed);
      return;
    case "stop":
      await handleStop(parsed);
      return;
    case "status":
      await handleStatus(parsed);
      return;
    case "logs":
      await handleLogs(parsed);
      return;
    case "doctor":
      await handleDoctor(parsed);
      return;
    case "bootstrap":
      await handleBootstrap(parsed);
      return;
    case "tenant":
      await handleTenant(parsed);
      return;
    case "users":
      await handleUsers(parsed);
      return;
    case "tokens":
    case "service-tokens":
      await handleTokens(parsed);
      return;
    case "tenants":
      await handleTenants(parsed);
      return;
    case "audit":
      await handleAudit(parsed);
      return;
    case "vector":
    case "vectors":
      await handleVector(parsed);
      return;
    case "memories":
    case "memory":
      await handleMemories(parsed);
      return;
    case "collections":
      await handleCollections(parsed);
      return;
    case "docs":
      await handleDocs(parsed);
      return;
    case "write":
      await handleWrite(parsed);
      return;
    case "search":
      await handleSearch(parsed);
      return;
    case "ask":
      await handleAsk(parsed);
      return;
    case "code":
      await handleCode(parsed);
      return;
    case "boolean_ask":
    case "boolean-ask":
    case "yesno":
    case "yes-no":
      await handleBooleanAsk(parsed);
      return;
    case "config":
      handleConfig(parsed);
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run \`supavector help\`.`);
  }
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
