const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildBaseUrlCandidates,
  buildComposeContext,
  buildComposeProjectName,
  buildInstallBinDir,
  buildInstallRepoDir,
  buildShellPathLine,
  classifyBundledPostgresBootstrapIssue,
  createOnboardConfig,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_REFLECT_MODEL,
  GENERATION_MODEL_PRESETS,
  detectCodeLanguage,
  detectIngestibleFileType,
  defaultOnboardAnswerModelSelection,
  defaultCollectionFromFolder,
  detectProjectRoot,
  extractDocumentText,
  isCodeLikePath,
  isIngestibleTextPath,
  isProbablyTextBuffer,
  looksLikeCodebaseRoot,
  mergeEnvText,
  normalizeConfiguredModel,
  normalizeOnboardAnswerModelSelection,
  removePathEntry,
  normalizeTcpPort,
  parseCliArgs,
  parseEnvAssignments,
  parseGitHubRepoSpec,
  preferredBaseUrl,
  readEnvAssignments,
  resolveInstallHome,
  resolveBaseUrl,
  safeDocIdFromPath,
  shouldSkipCodebaseRelPath,
  stripManagedShellPath
} = require("../lib");

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supavector-cli-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testParseCliArgs() {
  const parsed = parseCliArgs([
    "write",
    "--doc-id",
    "welcome",
    "--text=hello world",
    "--json",
    "--replace",
    "--sync",
    "--yes",
    "ignored-positional"
  ]);

  assert.equal(parsed.command, "write");
  assert.equal(parsed.flags["doc-id"], "welcome");
  assert.equal(parsed.flags.text, "hello world");
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.replace, true);
  assert.equal(parsed.flags.sync, true);
  assert.equal(parsed.flags.yes, true);
  assert.deepEqual(parsed.positionals, ["write", "ignored-positional"]);

  const updateParsed = parseCliArgs([
    "update",
    "--project-root",
    "/tmp/supavector"
  ]);
  assert.equal(updateParsed.command, "update");
  assert.equal(updateParsed.flags["project-root"], "/tmp/supavector");

  const uninstallParsed = parseCliArgs([
    "uninstall",
    "--yes",
    "--json"
  ]);
  assert.equal(uninstallParsed.command, "uninstall");
  assert.equal(uninstallParsed.flags.yes, true);
  assert.equal(uninstallParsed.flags.json, true);

  const booleanAskParsed = parseCliArgs([
    "boolean_ask",
    "--question",
    "Does SupaVector store memory?",
    "--json"
  ]);
  assert.equal(booleanAskParsed.command, "boolean_ask");
  assert.equal(booleanAskParsed.flags.question, "Does SupaVector store memory?");
  assert.equal(booleanAskParsed.flags.json, true);

  const changeModelParsed = parseCliArgs([
    "changemodel",
    "--answer-provider",
    "2",
    "--answer-model",
    "2",
    "--boolean-ask-model",
    "inherit",
    "--restart"
  ]);
  assert.equal(changeModelParsed.command, "changemodel");
  assert.equal(changeModelParsed.flags["answer-provider"], "2");
  assert.equal(changeModelParsed.flags["answer-model"], "2");
  assert.equal(changeModelParsed.flags["boolean-ask-model"], "inherit");
  assert.equal(changeModelParsed.flags.restart, true);
}

function testMergeEnvText() {
  const template = "OPENAI_API_KEY=\nJWT_SECRET=change_me\n# comment\n";
  const merged = mergeEnvText(template, {
    OPENAI_API_KEY: "sk-test",
    COOKIE_SECRET: "cookie value"
  });

  assert.match(merged, /^OPENAI_API_KEY=sk-test/m);
  assert.match(merged, /^JWT_SECRET=change_me/m);
  assert.match(merged, /^COOKIE_SECRET="cookie value"$/m);
}

function testEnvAssignmentHelpers() {
  const parsed = parseEnvAssignments([
    "# comment",
    "POSTGRES_PASSWORD=secret-value",
    "JWT_SECRET=\"quoted value\"",
    "PUBLIC_BASE_URL=http://localhost:3000 # inline comment"
  ].join("\n"));
  assert.equal(parsed.POSTGRES_PASSWORD, "secret-value");
  assert.equal(parsed.JWT_SECRET, "quoted value");
  assert.equal(parsed.PUBLIC_BASE_URL, "http://localhost:3000");

  return withTempDir(async (dir) => {
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "COOKIE_SECRET=cookie\n", "utf8");
    const fileParsed = readEnvAssignments(envPath);
    assert.equal(fileParsed.COOKIE_SECRET, "cookie");
  });
}

function testDetectProjectRoot() {
  return withTempDir(async (dir) => {
    const root = path.join(dir, "supavector");
    const nested = path.join(root, "gateway", "public");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services:\n", "utf8");
    fs.writeFileSync(path.join(root, ".env.example"), "OPENAI_API_KEY=\n", "utf8");

    const detected = detectProjectRoot(nested);
    assert.equal(detected, root);
  });
}

function testCreateOnboardConfig() {
  const config = createOnboardConfig({
    projectRoot: "/tmp/supavector",
    projectName: "supavector-deadbeef1234",
    mode: "bundled-postgres",
    envFile: ".env",
    composeFile: "docker-compose.yml",
    baseUrl: resolveBaseUrl("4100"),
    tenantId: "default",
    adminUsername: "admin",
    apiKey: "supav_secret",
    openAiApiKey: "sk-test",
    geminiApiKey: "gemini-test",
    anthropicApiKey: "anthropic-test"
  });

  assert.equal(config.projectRoot, "/tmp/supavector");
  assert.equal(config.projectName, "supavector-deadbeef1234");
  assert.equal(config.baseUrl, "http://localhost:4100");
  assert.equal(config.tenantId, "default");
  assert.equal(config.adminUsername, "admin");
  assert.equal(config.apiKey, "supav_secret");
  assert.equal(config.openAiApiKey, "sk-test");
  assert.equal(config.geminiApiKey, "gemini-test");
  assert.equal(config.anthropicApiKey, "anthropic-test");
  assert.equal(config.onboardingPending, false);
  assert.ok(config.updatedAt);

  const pending = createOnboardConfig({
    projectRoot: "/tmp/supavector",
    projectName: "supavector-deadbeef1234",
    mode: "bundled-postgres",
    envFile: ".env",
    composeFile: "docker-compose.yml",
    baseUrl: resolveBaseUrl("4100"),
    tenantId: "default",
    adminUsername: "admin",
    apiKey: "",
    openAiApiKey: "sk-test",
    onboardingPending: true
  });
  assert.equal(pending.onboardingPending, true);
}

function testComposeProjectHelpers() {
  const first = buildComposeProjectName("/tmp/supavector-a");
  const second = buildComposeProjectName("/tmp/supavector-a");
  const third = buildComposeProjectName("/tmp/supavector-b");

  assert.match(first, /^supavector-[a-f0-9]{12}$/);
  assert.equal(first, second);
  assert.notEqual(first, third);

  const ctx = buildComposeContext("/tmp/supavector-a", {
    composeFile: "docker-compose.yml",
    envFile: ".env",
    projectName: first
  });
  assert.equal(ctx.projectName, first);
}

function testBootstrapFailureClassification() {
  const issue = classifyBundledPostgresBootstrapIssue({
    gatewayLogs: 'Failed to start gateway: error: password authentication failed for user "supavector"',
    postgresLogs: [
      "PostgreSQL Database directory appears to contain a database; Skipping initialization",
      'DETAIL:  Role "supavector" does not exist.'
    ].join("\n"),
    expectedUser: "supavector",
    expectedDatabase: "supavector"
  });
  assert.equal(issue.code, "bundled_postgres_volume_mismatch");
  assert.equal(issue.skipInitDetected, true);
  assert.equal(issue.roleMissing, true);
  assert.equal(issue.expectedUser, "supavector");

  assert.equal(classifyBundledPostgresBootstrapIssue({
    gatewayLogs: "Gateway healthy",
    postgresLogs: "database system is ready to accept connections",
    expectedUser: "supavector",
    expectedDatabase: "supavector"
  }), null);
}

function testFolderHelpers() {
  assert.equal(defaultCollectionFromFolder("/tmp/customer-support"), "customer-support");
  assert.equal(isIngestibleTextPath("/tmp/notes.md"), true);
  assert.equal(isIngestibleTextPath("/tmp/manual.pdf"), false);
  assert.equal(detectIngestibleFileType("/tmp/manual.pdf"), "pdf");
  assert.equal(detectIngestibleFileType("/tmp/report.docx"), "docx");
  assert.equal(detectIngestibleFileType("/tmp/notes.md"), "text");
  assert.equal(safeDocIdFromPath("guides/intro file.md"), "guides__intro-file.md");
  assert.equal(isProbablyTextBuffer(Buffer.from("hello world", "utf8")), true);
  assert.equal(isProbablyTextBuffer(Buffer.from([0, 1, 2, 3])), false);
  assert.equal(isProbablyTextBuffer(Buffer.concat([
    Buffer.from("a".repeat(3000), "utf8"),
    Buffer.from([0])
  ])), false);
  assert.equal(detectCodeLanguage("src/index.ts"), "typescript");
  assert.equal(detectCodeLanguage("Dockerfile"), "docker");
  assert.equal(detectCodeLanguage("README.md"), null);
  assert.equal(isCodeLikePath("package.json"), true);
  assert.equal(isCodeLikePath("README.md"), false);
  assert.equal(shouldSkipCodebaseRelPath("node_modules/react/index.js"), true);
  assert.equal(shouldSkipCodebaseRelPath("src/app/index.ts"), false);
}

async function testCodebaseHelpers() {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "package.json"), "{\n  \"name\": \"demo\"\n}\n", "utf8");
    assert.equal(looksLikeCodebaseRoot(dir), true);
  });

  const repo = parseGitHubRepoSpec("https://github.com/acme/platform/tree/main");
  assert.equal(repo.name, "acme/platform");
  assert.equal(repo.branch, "main");
  assert.equal(repo.cloneUrl, "https://github.com/acme/platform.git");

  const short = parseGitHubRepoSpec("acme/platform");
  assert.equal(short.name, "acme/platform");
  assert.equal(short.branch, null);
}

async function testDocumentExtraction() {
  await withTempDir(async (dir) => {
    const textPath = path.join(dir, "notes.md");
    const pdfPath = path.join(dir, "manual.pdf");
    const docxPath = path.join(dir, "resume.docx");

    fs.writeFileSync(textPath, "Hello from SupaVector.\n", "utf8");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-test", "utf8"));
    fs.writeFileSync(docxPath, Buffer.from("PK-test", "utf8"));

    assert.equal(await extractDocumentText(textPath), "Hello from SupaVector.\n");

    const pdfText = await extractDocumentText(pdfPath, {
      extractPdfText: async () => "PDF content\u0000\n\nwith spacing"
    });
    assert.equal(pdfText, "PDF content\n\nwith spacing");

    const docxText = await extractDocumentText(docxPath, {
      extractDocxText: async () => "DOCX content\u0000\r\n\r\nwith spacing"
    });
    assert.equal(docxText, "DOCX content\n\nwith spacing");
  });
}

function testNormalizeTcpPort() {
  assert.equal(normalizeTcpPort("3000"), "3000");
  assert.equal(normalizeTcpPort(" 5432 ", "Gateway port"), "5432");
  assert.throws(() => normalizeTcpPort("supavector status", "Gateway port"), /Gateway port must be a number between 1 and 65535/);
  assert.throws(() => normalizeTcpPort("70000"), /Port must be a number between 1 and 65535/);
}

function testBaseUrlHelpers() {
  assert.deepEqual(buildBaseUrlCandidates("http://localhost:3000"), [
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);
  assert.deepEqual(buildBaseUrlCandidates("https://supavector.com"), [
    "https://supavector.com"
  ]);
  assert.equal(preferredBaseUrl("http://localhost:3000"), "http://127.0.0.1:3000");
  assert.equal(preferredBaseUrl("https://supavector.com"), "https://supavector.com");
}

function testModelHelpers() {
  assert.equal(DEFAULT_ANSWER_MODEL, "gpt-5.2");
  assert.equal(DEFAULT_EMBED_MODEL, "text-embedding-3-large");
  assert.equal(DEFAULT_REFLECT_MODEL, "gpt-5-mini");
  assert.equal(GENERATION_MODEL_PRESETS.length, 4);
  assert.equal(normalizeConfiguredModel("", "gpt-5.2"), "gpt-5.2");
  assert.equal(normalizeConfiguredModel(" gpt-5-mini ", "gpt-5.2"), "gpt-5-mini");
  assert.equal(defaultOnboardAnswerModelSelection("gpt-5.2"), "1");
  assert.equal(defaultOnboardAnswerModelSelection("gpt-5-mini"), "2");
  assert.equal(defaultOnboardAnswerModelSelection("gpt-5-nano"), "3");
  assert.equal(normalizeOnboardAnswerModelSelection("1"), "gpt-5.2");
  assert.equal(normalizeOnboardAnswerModelSelection("2"), "gpt-5-mini");
  assert.equal(normalizeOnboardAnswerModelSelection("3"), "gpt-5-nano");
  assert.equal(normalizeOnboardAnswerModelSelection("gpt-5.2"), "gpt-5.2");
  assert.throws(() => normalizeOnboardAnswerModelSelection("4"), /Custom model id is required/);
}

function testInstallHelpers() {
  const installHome = resolveInstallHome({ SUPAVECTOR_HOME: "/tmp/custom-supavector" }, "/Users/tester");
  assert.equal(installHome, path.resolve("/tmp/custom-supavector"));
  assert.equal(buildInstallBinDir(installHome), path.join(path.resolve("/tmp/custom-supavector"), "bin"));
  assert.equal(buildInstallRepoDir(installHome), path.join(path.resolve("/tmp/custom-supavector"), "src", "supavector"));

  const shellPathLine = buildShellPathLine("/tmp/custom-supavector/bin");
  assert.equal(shellPathLine, `export PATH="${path.resolve("/tmp/custom-supavector/bin")}:$PATH"`);

  const rcText = [
    "export PATH=\"/usr/local/bin:$PATH\"",
    "# >>> supavector >>>",
    shellPathLine,
    "# <<< supavector <<<",
    "alias ll='ls -la'"
  ].join("\n");
  assert.equal(stripManagedShellPath(rcText, "/tmp/custom-supavector/bin"), [
    "export PATH=\"/usr/local/bin:$PATH\"",
    "alias ll='ls -la'"
  ].join("\n"));

  const legacyRcText = [
    shellPathLine,
    "export PATH=\"/usr/local/bin:$PATH\""
  ].join("\n");
  assert.equal(stripManagedShellPath(legacyRcText, "/tmp/custom-supavector/bin"), "export PATH=\"/usr/local/bin:$PATH\"");

  assert.equal(
    removePathEntry("/usr/local/bin:/tmp/custom-supavector/bin:/bin", "/tmp/custom-supavector/bin", "linux"),
    "/usr/local/bin:/bin"
  );
  assert.equal(
    removePathEntry("C:\\Windows;C:\\Users\\Test\\.supavector\\bin;C:\\Tools", "c:\\users\\test\\.supavector\\bin\\", "win32"),
    "C:\\Windows;C:\\Tools"
  );
}

async function main() {
  testParseCliArgs();
  testMergeEnvText();
  await testEnvAssignmentHelpers();
  await testDetectProjectRoot();
  testCreateOnboardConfig();
  testComposeProjectHelpers();
  testBootstrapFailureClassification();
  testFolderHelpers();
  await testDocumentExtraction();
  await testCodebaseHelpers();
  testNormalizeTcpPort();
  testBaseUrlHelpers();
  testModelHelpers();
  testInstallHelpers();
  console.log("cli helper tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
