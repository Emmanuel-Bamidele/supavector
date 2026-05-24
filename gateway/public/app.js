function $(id){
  return document.getElementById(id);
}

function setBanner(el, kind, msg){
  el.classList.add("show");
  el.classList.remove("ok","err");
  if (kind === "ok") el.classList.add("ok");
  if (kind === "err") el.classList.add("err");
  el.textContent = msg;
}

function clearBanner(el){
  el.classList.remove("show","ok","err");
  el.textContent = "";
}

function normalizePolicy(value){
  const clean = String(value || "").trim().toLowerCase();
  return ["amvl", "ttl", "lru"].includes(clean) ? clean : "amvl";
}

const AUTH_TOKEN_KEY = "supavectorAuthToken";
const AUTH_TYPE_KEY = "supavectorAuthType";
const LEGACY_JWT_KEY = "supavectorJwt";
const PROVIDER_OVERRIDE_KEYS = Object.freeze({
  openai: "supavectorOpenAiApiKey",
  gemini: "supavectorGeminiApiKey",
  anthropic: "supavectorAnthropicApiKey"
});
const UI_THEME_KEY = "supavectorUiTheme";
const UI_THEME_USER_SET_KEY = "supavectorUiThemeUserSet";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: light)";
let activeThemePreference = "system";
let metricsLoaded = false;
let usageLoaded = false;
let metricsLoading = false;
let usageLoading = false;
let lastUsageStats = null;
let authRejected = false;
let authRejectedMessage = "";
let modelCatalogData = null;
const usageWindowByCard = {};
const USAGE_WINDOWS = ["24h", "7d", "all"];
const USAGE_WINDOW_LABELS = { "24h": "24h", "7d": "7d", "all": "All" };
const MAX_UPLOAD_FILE_BYTES = 64 * 1024 * 1024;
const PDFJS_LIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const MAMMOTH_LIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js";
const externalScriptCache = new Map();
const DOC_CONNECT_BASE_URL_PLACEHOLDER = "https://YOUR_SUPAVECTOR_BASE_URL";
const DOC_CONNECT_SERVER_NAME = "supavector-docs";
const TENANT_SSO_PROVIDER_META = Object.freeze({
  google: { label: "Google", prefix: "tenantSsoGoogle", loginButtonId: "ssoLoginGoogleBtn" },
  azure: { label: "Azure", prefix: "tenantSsoAzure", loginButtonId: "ssoLoginAzureBtn" },
  okta: { label: "Okta", prefix: "tenantSsoOkta", loginButtonId: "ssoLoginOktaBtn" }
});
const DEFAULT_RUNTIME_UI_CONFIG = Object.freeze({
  deploymentMode: "self_hosted",
  capabilities: {
    dashboardControlPlane: false,
    localGatewayAdmin: true,
    hostedBilling: false,
    portalEnabled: false
  },
  links: {
    dashboardUrl: null
  }
});
let modelCatalogLoaded = false;
let runtimeUiConfig = DEFAULT_RUNTIME_UI_CONFIG;
let docsSubmenuVisible = false;
let registerOptionsState = null;

function setModelDatalistOptions(listId, models){
  const list = $(listId);
  if (!list) return;
  const next = Array.isArray(models) ? models : [];
  list.innerHTML = "";
  next.forEach((entry) => {
    const model = String(entry?.model || "").trim();
    if (!model || entry?.custom) return;
    const option = document.createElement("option");
    option.value = model;
    list.appendChild(option);
  });
}

function getGenerationModelsForProvider(provider){
  const cleanProvider = String(provider || "").trim().toLowerCase() || "openai";
  return modelCatalogData?.presets?.generationByProvider?.[cleanProvider]
    || modelCatalogData?.presets?.generation
    || [];
}

function getAllGenerationModels(){
  const grouped = modelCatalogData?.presets?.generationByProvider || {};
  const seen = new Set();
  const out = [];
  Object.values(grouped).flat().forEach((entry) => {
    const model = String(entry?.model || "").trim();
    if (!model || seen.has(model)) return;
    seen.add(model);
    out.push(entry);
  });
  return out.length ? out : (modelCatalogData?.presets?.generation || []);
}

function syncGenerationModelList(listId, provider){
  if (listId === "tenantGenerationModels") {
    setModelDatalistOptions(listId, getAllGenerationModels());
    return;
  }
  setModelDatalistOptions(listId, getGenerationModelsForProvider(provider));
}

async function loadModelCatalog(){
  if (modelCatalogLoaded) return;
  try{
    const res = await fetch("/v1/models");
    const payload = await res.json();
    if (!res.ok || !payload?.ok) return;
    modelCatalogData = payload?.data || null;
    syncGenerationModelList("askGenerationModels", $("askProvider")?.value || "");
    syncGenerationModelList("tenantGenerationModels", $("tenantAnswerProvider")?.value || "");
    modelCatalogLoaded = true;
  }catch(_err){
    // Keep the static datalist fallback if the catalog endpoint is unavailable.
  }
}

function loadStoredAuth(){
  let token = localStorage.getItem(AUTH_TOKEN_KEY);
  let type = localStorage.getItem(AUTH_TYPE_KEY);

  if (!token){
    const legacy = localStorage.getItem(LEGACY_JWT_KEY);
    if (legacy){
      token = legacy;
      type = "bearer";
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      localStorage.setItem(AUTH_TYPE_KEY, type);
    }
  }

  return {
    token: (token || "").trim(),
    type: (type || "bearer").trim()
  };
}

function saveStoredAuth(type, token){
  localStorage.setItem(AUTH_TYPE_KEY, type);
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  if (type === "bearer"){
    localStorage.setItem(LEGACY_JWT_KEY, token);
  }
  authRejected = false;
  authRejectedMessage = "";
}

function clearStoredAuth(){
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TYPE_KEY);
  localStorage.removeItem(LEGACY_JWT_KEY);
  authRejected = false;
  authRejectedMessage = "";
}

function loadStoredProviderOverride(provider){
  const key = PROVIDER_OVERRIDE_KEYS[String(provider || "").trim().toLowerCase()] || "";
  return key ? String(localStorage.getItem(key) || "").trim() : "";
}

function saveStoredProviderOverride(provider, value){
  const key = PROVIDER_OVERRIDE_KEYS[String(provider || "").trim().toLowerCase()] || "";
  if (!key) return;
  localStorage.setItem(key, String(value || "").trim());
}

function clearStoredProviderOverrides(){
  Object.values(PROVIDER_OVERRIDE_KEYS).forEach((key) => localStorage.removeItem(key));
}

function setThemeButtonState(theme){
  const btn = $("themeToggleBtn");
  const icon = $("themeToggleIcon");
  if (!btn) return;

  const isLight = theme === "light";
  btn.setAttribute("aria-pressed", isLight ? "true" : "false");
  btn.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
  btn.setAttribute("title", isLight ? "Switch to dark theme" : "Switch to light theme");
  if (icon){
    icon.textContent = isLight ? "◑" : "◐";
  }
}

function getSystemTheme(){
  return (window.matchMedia && window.matchMedia(SYSTEM_THEME_QUERY).matches) ? "light" : "dark";
}

function resolveTheme(preference){
  if (preference === "light" || preference === "dark"){
    return preference;
  }
  return getSystemTheme();
}

function renderTheme(preference){
  const active = resolveTheme(preference);
  document.body.classList.toggle("light-theme", active === "light");
  setThemeButtonState(active);
}

function applyThemePreference(preference, options = {}){
  const next = (preference === "light" || preference === "dark") ? preference : "system";
  const persist = options.persist === true;
  const userSet = options.userSet === true;
  activeThemePreference = next;
  renderTheme(next);
  if (persist){
    localStorage.setItem(UI_THEME_KEY, next);
    localStorage.setItem(UI_THEME_USER_SET_KEY, userSet ? "1" : "0");
  }
}

function initTheme(){
  const saved = localStorage.getItem(UI_THEME_KEY);
  const userSet = localStorage.getItem(UI_THEME_USER_SET_KEY) === "1";
  const initial = (userSet && (saved === "light" || saved === "dark")) ? saved : "system";
  applyThemePreference(initial, { persist: false });

  if (!userSet){
    localStorage.removeItem(UI_THEME_KEY);
    localStorage.removeItem(UI_THEME_USER_SET_KEY);
  }

  const btn = $("themeToggleBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const active = resolveTheme(activeThemePreference);
    const next = active === "light" ? "dark" : "light";
    applyThemePreference(next, { persist: true, userSet: true });
  });

  if (window.matchMedia){
    const mq = window.matchMedia(SYSTEM_THEME_QUERY);
    const onSystemThemeChange = () => {
      if (activeThemePreference === "system"){
        renderTheme("system");
      }
    };
    if (typeof mq.addEventListener === "function"){
      mq.addEventListener("change", onSystemThemeChange);
    }else if (typeof mq.addListener === "function"){
      mq.addListener(onSystemThemeChange);
    }
  }
}

function apiHeaders(){
  const auth = loadStoredAuth();
  const headers = { "Content-Type":"application/json" };
  if (auth.token){
    if (auth.type === "api_key"){
      headers["X-API-Key"] = auth.token;
    }else{
      headers["Authorization"] = `Bearer ${auth.token}`;
    }
  }
  const openAiApiKey = loadStoredProviderOverride("openai");
  const geminiApiKey = loadStoredProviderOverride("gemini");
  const anthropicApiKey = loadStoredProviderOverride("anthropic");
  if (openAiApiKey) headers["X-OpenAI-API-Key"] = openAiApiKey;
  if (geminiApiKey) headers["X-Gemini-API-Key"] = geminiApiKey;
  if (anthropicApiKey) headers["X-Anthropic-API-Key"] = anthropicApiKey;
  return headers;
}

function requireKeyOrWarn(bannerEl){
  if (!loadStoredAuth().token){
    setBanner(bannerEl, "err", "No saved token or JWT. Go to Settings and paste a service token or sign in first.");
    return false;
  }
  if (authRejected){
    setBanner(
      bannerEl,
      "err",
      authRejectedMessage || "Saved token is no longer authorized. Re-login or paste a valid token in Settings."
    );
    return false;
  }
  return true;
}

async function parseResponsePayload(res){
  const text = await res.text();
  if (!text) return null;
  try{
    return JSON.parse(text);
  }catch{
    return { raw: text };
  }
}

function resolveErrorMessage(data, fallback){
  if (!data) return fallback;
  if (typeof data === "string" && data.trim()) return data;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  if (typeof data.error?.message === "string" && data.error.message.trim()) return data.error.message;
  return fallback;
}

function noteUnauthorized(data){
  authRejected = true;
  authRejectedMessage = resolveErrorMessage(
    data,
    "Saved token is unauthorized (401). Re-login or paste a valid token in Settings."
  );
}

async function copyTextToClipboard(text){
  const value = String(text || "");
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (_err) {
      // Fall through to the legacy path for mobile browsers and restricted contexts.
    }
  }

  const tmp = document.createElement("textarea");
  tmp.value = value;
  tmp.setAttribute("readonly", "true");
  tmp.style.position = "fixed";
  tmp.style.top = "0";
  tmp.style.left = "0";
  tmp.style.width = "1px";
  tmp.style.height = "1px";
  tmp.style.padding = "0";
  tmp.style.border = "0";
  tmp.style.outline = "0";
  tmp.style.boxShadow = "none";
  tmp.style.background = "transparent";
  tmp.style.opacity = "0";
  tmp.style.fontSize = "16px";
  tmp.style.pointerEvents = "none";
  document.body.appendChild(tmp);
  tmp.focus();
  tmp.select();
  tmp.setSelectionRange(0, tmp.value.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(tmp);
  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function formatNumber(value){
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString();
}

function formatRate(value){
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatMs(value){
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)} ms`;
}

function formatDuration(totalSeconds){
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "-";
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatBytes(value){
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, value);
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1){
    size /= 1024;
    idx += 1;
  }
  const precision = size >= 10 || idx === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[idx]}`;
}

function formatDateTime(value){
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function splitCommaList(value){
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObjectField(value, label){
  const raw = String(value || "").trim();
  if (!raw) return {};
  let parsed;
  try{
    parsed = JSON.parse(raw);
  }catch(_err){
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)){
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function setSsoLoginButtonsEnabled(states = {}){
  Object.entries(TENANT_SSO_PROVIDER_META).forEach(([provider, meta]) => {
    const btn = $(meta.loginButtonId);
    if (!btn) return;
    btn.disabled = !states[provider];
  });
}

function updateTenantSsoSecretState(provider, config = {}){
  const meta = TENANT_SSO_PROVIDER_META[provider];
  if (!meta) return;
  const prefix = meta.prefix;
  const secretInput = $(`${prefix}ClientSecret`);
  const secretState = $(`${prefix}SecretState`);
  const hasClientSecret = Boolean(config?.hasClientSecret);
  if (secretInput) {
    secretInput.value = "";
    secretInput.placeholder = hasClientSecret
      ? "leave blank to keep saved secret"
      : "optional unless required by provider";
  }
  if (secretState) {
    secretState.textContent = hasClientSecret
      ? "Tenant-scoped client secret is already saved."
      : "No tenant-scoped client secret saved.";
  }
  const clearSecret = $(`${prefix}ClearClientSecret`);
  if (clearSecret) clearSecret.checked = false;
}

function getTenantSsoProviderForm(provider){
  const meta = TENANT_SSO_PROVIDER_META[provider];
  if (!meta) return {};
  const prefix = meta.prefix;
  const payload = {
    enabled: Boolean($(`${prefix}Enabled`)?.checked),
    clientId: String($(`${prefix}ClientId`)?.value || "").trim(),
    issuer: String($(`${prefix}Issuer`)?.value || "").trim(),
    scopes: String($(`${prefix}Scopes`)?.value || "").trim(),
    tenantClaim: String($(`${prefix}TenantClaim`)?.value || "").trim(),
    roleClaim: String($(`${prefix}RoleClaim`)?.value || "").trim(),
    allowedDomains: splitCommaList($(`${prefix}AllowedDomains`)?.value || ""),
    defaultRoles: splitCommaList($(`${prefix}DefaultRoles`)?.value || ""),
    roleMappings: parseJsonObjectField($(`${prefix}RoleMappings`)?.value || "", `${meta.label} role mappings`)
  };
  const clientSecret = String($(`${prefix}ClientSecret`)?.value || "").trim();
  if (clientSecret) {
    payload.clientSecret = clientSecret;
  }
  if ($(`${prefix}ClearClientSecret`)?.checked) {
    payload.clearClientSecret = true;
  }
  return payload;
}

function setTenantSsoProviderForm(provider, config = {}){
  const meta = TENANT_SSO_PROVIDER_META[provider];
  if (!meta) return;
  const prefix = meta.prefix;
  if ($(`${prefix}Enabled`)) $(`${prefix}Enabled`).checked = Boolean(config.enabled);
  if ($(`${prefix}ClientId`)) $(`${prefix}ClientId`).value = config.clientId || "";
  if ($(`${prefix}Issuer`)) $(`${prefix}Issuer`).value = config.issuer || "";
  if ($(`${prefix}Scopes`)) $(`${prefix}Scopes`).value = config.scopes || "";
  if ($(`${prefix}TenantClaim`)) $(`${prefix}TenantClaim`).value = config.tenantClaim || "";
  if ($(`${prefix}RoleClaim`)) $(`${prefix}RoleClaim`).value = config.roleClaim || "";
  if ($(`${prefix}AllowedDomains`)) $(`${prefix}AllowedDomains`).value = Array.isArray(config.allowedDomains) ? config.allowedDomains.join(", ") : "";
  if ($(`${prefix}DefaultRoles`)) $(`${prefix}DefaultRoles`).value = Array.isArray(config.defaultRoles) ? config.defaultRoles.join(", ") : "";
  if ($(`${prefix}RoleMappings`)) {
    const mappings = config.roleMappings && typeof config.roleMappings === "object" && !Array.isArray(config.roleMappings)
      ? config.roleMappings
      : {};
    $(`${prefix}RoleMappings`).value = Object.keys(mappings).length ? JSON.stringify(mappings, null, 2) : "";
  }
  updateTenantSsoSecretState(provider, config);
}

function applyTenantSsoConfig(config = {}){
  Object.keys(TENANT_SSO_PROVIDER_META).forEach((provider) => {
    setTenantSsoProviderForm(provider, config?.[provider] || {});
  });
}

function collectTenantSsoConfig(){
  const out = {};
  Object.keys(TENANT_SSO_PROVIDER_META).forEach((provider) => {
    out[provider] = getTenantSsoProviderForm(provider);
  });
  return out;
}

function renderTenantUsers(users){
  const wrap = $("tenantUsersTableWrap");
  if (!wrap) return;
  const list = Array.isArray(users) ? users : [];
  if (!list.length){
    wrap.innerHTML = '<div class="hint">No tenant users found yet. SSO users appear here after their first successful login.</div>';
    return;
  }

  const rows = list.map((user) => {
    const id = Number(user?.id || 0);
    const roles = Array.isArray(user?.roles) ? user.roles.join(",") : "";
    const authLabel = user?.authProvider
      ? `SSO (${escapeHtml(user.authProvider)})`
      : "Local password";
    return `<tr>
      <td>
        <div class="doc-label">${escapeHtml(user?.username || "-")}</div>
        <div class="hint">${authLabel}</div>
        <div class="hint">Created ${escapeHtml(formatDateTime(user?.createdAt))}</div>
        <div class="hint">Last login ${escapeHtml(formatDateTime(user?.lastLogin))}</div>
      </td>
      <td>
        <input id="tenantUserRoles_${id}" value="${escapeHtml(roles)}" placeholder="admin,indexer,reader">
      </td>
      <td>
        <input id="tenantUserFullName_${id}" value="${escapeHtml(user?.fullName || "")}" placeholder="Full name" style="margin-bottom:8px;">
        <input id="tenantUserEmail_${id}" value="${escapeHtml(user?.email || "")}" placeholder="Email">
      </td>
      <td>
        <label class="check"><input type="checkbox" id="tenantUserDisabled_${id}" ${user?.disabled ? "checked" : ""}> Disabled</label>
        <label class="check"><input type="checkbox" id="tenantUserSsoOnly_${id}" ${user?.ssoOnly ? "checked" : ""}> SSO only</label>
      </td>
      <td>
        <input id="tenantUserPassword_${id}" type="password" placeholder="new password (optional)">
      </td>
      <td>
        <button class="btn secondary" data-tenant-user-save="${id}">Save</button>
      </td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table class="table">
    <thead>
      <tr>
        <th>User</th>
        <th>Roles</th>
        <th>Profile</th>
        <th>Flags</th>
        <th>Password reset</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  wrap.querySelectorAll("button[data-tenant-user-save]").forEach((btn) => {
    btn.addEventListener("click", () => saveTenantUser(btn.dataset.tenantUserSave));
  });
}

function describeSsoProviderStatus(provider, info){
  const meta = TENANT_SSO_PROVIDER_META[provider];
  const label = meta?.label || provider;
  if (info?.enabled) {
    const source = info?.source === "tenant" ? "tenant override" : "instance fallback";
    return `${label}: ready (${source})`;
  }
  if (info?.reason === "provider_not_allowed") return `${label}: disabled for this tenant`;
  if (info?.reason === "auth_mode_disabled") return `${label}: blocked by password-only auth mode`;
  if (info?.reason === "not_configured") return `${label}: not configured`;
  return `${label}: unavailable`;
}

function getUsageWindow(cardId){
  return usageWindowByCard[cardId] || "7d";
}

function setUsageWindow(cardId, window){
  usageWindowByCard[cardId] = window;
  if (lastUsageStats){
    renderUsage(lastUsageStats);
  }
}

function bindUsageWindowClicks(){
  const wrap = $("usageCards");
  if (!wrap || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-usage-window]");
    if (!btn) return;
    const cardId = btn.dataset.card;
    const window = btn.dataset.usageWindow;
    if (!cardId || !window) return;
    setUsageWindow(cardId, window);
  });
}

function maskToken(value){
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 8) return "****";
  const head = raw.slice(0, 4);
  const tail = raw.slice(-4);
  return `${head}****${tail}`;
}

function buildRegisterInstructionsPayload(baseUrl){
  const cleanBaseUrl = String(baseUrl || window.location.origin || DOC_CONNECT_BASE_URL_PLACEHOLDER).trim().replace(/\/+$/, "");
  return {
    installCommand: "python3 -m pip install supavector",
    env: [
      `SUPAVECTOR_BASE_URL=${cleanBaseUrl}`,
      "SUPAVECTOR_API_KEY=<paste-the-copied-service-token>"
    ],
    python: [
      "from supavector import Client",
      "",
      `client = Client(base_url=\"${cleanBaseUrl}\", api_key=\"<paste-the-copied-service-token>\")`,
      "result = client.search(query=\"hello\", collection=\"default\")"
    ]
  };
}

function formatRegisterInstructionsText(instructions){
  const payload = instructions && typeof instructions === "object"
    ? instructions
    : buildRegisterInstructionsPayload(registerOptionsState?.baseUrl || window.location.origin);
  const envLines = Array.isArray(payload.env) ? payload.env : [];
  const pythonLines = Array.isArray(payload.python) ? payload.python : [];
  return [
    String(payload.installCommand || "python3 -m pip install supavector").trim(),
    "",
    ...envLines,
    "",
    ...pythonLines
  ].join("\n");
}

function setRegisterProjectInfo(project){
  const name = String(project?.name || "").trim();
  const id = String(project?.id || "").trim();
  if ($("registerProjectName")) $("registerProjectName").value = name;
  if ($("registerProjectId")) $("registerProjectId").value = id;
}

function showSettingsSection(sectionName){
  if (!sectionName) return;
  activateDocPanel("settings", sectionName);
}

function showHostedTokenSection(sectionName){
  if (!sectionName) return;
  activateDocPanel("settingsHostedTokenSections", sectionName);
}

function publishServiceTokenToUi(token, options = {}){
  const raw = String(token || "").trim();
  if (!raw) return;
  const masked = maskToken(raw);
  if ($("registerCreatedToken")) $("registerCreatedToken").textContent = masked;
  if ($("copyRegisterTokenBtn")) {
    $("copyRegisterTokenBtn").dataset.token = raw;
    $("copyRegisterTokenBtn").disabled = false;
  }
  if ($("useRegisterTokenBtn")) {
    $("useRegisterTokenBtn").dataset.token = raw;
    $("useRegisterTokenBtn").disabled = false;
  }
  if ($("createdApiKey")) $("createdApiKey").textContent = masked;
  if ($("copyCreatedApiKeyBtn")) {
    $("copyCreatedApiKeyBtn").dataset.token = raw;
    $("copyCreatedApiKeyBtn").disabled = false;
  }
  if ($("useCreatedApiKeyBtn")) {
    $("useCreatedApiKeyBtn").dataset.token = raw;
    $("useCreatedApiKeyBtn").disabled = false;
  }
  if (options.project) {
    setRegisterProjectInfo(options.project);
  }
  if ($("registerTokenInstructions")) {
    $("registerTokenInstructions").textContent = formatRegisterInstructionsText(options.instructions);
  }
}

function saveServiceTokenIntoSettings(token, { bannerEl = null, message = "" } = {}){
  const raw = String(token || "").trim();
  if (!raw) return;
  if ($("authType")) $("authType").value = "api_key";
  if ($("apiKey")) $("apiKey").value = raw;
  saveStoredAuth("api_key", raw);
  loadDocsList();
  loadCollectionScopeOptions();
  if (bannerEl && message) {
    setBanner(bannerEl, "ok", message);
  }
}

function slugifyDocId(value){
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isValidDocId(value){
  return /^[a-zA-Z0-9._-]+$/.test(String(value || ""));
}

function isValidCollectionName(value){
  return /^[a-zA-Z0-9._-]+$/.test(String(value || ""));
}

function normalizeCollectionName(value){
  const clean = String(value || "").trim();
  return clean || "default";
}

function getPlaygroundCollection(options = {}){
  const input = $("playCollection");
  const collection = normalizeCollectionName(input ? input.value : "default");
  if (input) input.value = collection;

  if (!isValidCollectionName(collection)){
    const message = "Collection must use only letters, numbers, dot, dash, or underscore (no spaces).";
    if (options.bannerEl) setBanner(options.bannerEl, "err", message);
    return null;
  }
  return collection;
}

function getSelectedDocIds(selectEl){
  if (!selectEl) return [];
  return Array.from(selectEl.selectedOptions || [])
    .map(opt => opt.value)
    .filter(Boolean);
}

function clearDocSelection(selectEl){
  if (!selectEl) return;
  Array.from(selectEl.options || []).forEach(opt => { opt.selected = false; });
  selectEl.selectedIndex = -1;
}

function setDocsStatus(message){
  const targets = [$("searchDocsStatus"), $("askDocsStatus")].filter(Boolean);
  targets.forEach(el => { el.textContent = message; });
}

function setDocOptions(docs){
  const selects = [$("searchDocs"), $("askDocs")].filter(Boolean);
  selects.forEach((selectEl) => {
    selectEl.innerHTML = "";
    selectEl.disabled = false;
    if (!docs || docs.length === 0){
      const opt = document.createElement("option");
      opt.textContent = "No docs indexed yet";
      opt.disabled = true;
      selectEl.appendChild(opt);
      selectEl.disabled = true;
      return;
    }
    docs.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.docId;
      opt.textContent = `${doc.docId} (${doc.chunks})`;
      selectEl.appendChild(opt);
    });
    clearDocSelection(selectEl);
  });
}

async function loadDocsList(){
  if (!loadStoredAuth().token){
    setDocsStatus("Save a token to load docs.");
    setDocOptions([]);
    return;
  }

  const collection = getPlaygroundCollection();
  if (!collection){
    setDocsStatus("Collection is invalid.");
    setDocOptions([]);
    return;
  }

  setDocsStatus(`Loading docs in "${collection}"...`);
  try{
    const res = await fetch(`/docs/list?collection=${encodeURIComponent(collection)}`, { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      setDocsStatus(authRejectedMessage || "Unauthorized. Re-login in Settings.");
      setDocOptions([]);
      return;
    }
    if (res.ok && Array.isArray(data.docs)){
      setDocOptions(data.docs);
      setDocsStatus(`${data.docs.length} doc(s) available in "${collection}".`);
    }else{
      setDocsStatus(resolveErrorMessage(data, "Failed to load docs."));
      setDocOptions([]);
    }
  }catch(e){
    setDocsStatus("Error loading docs.");
    setDocOptions([]);
  }
}

function setCollectionScopeOptions(collections){
  const names = Array.from(new Set(
    (Array.isArray(collections) ? collections : [])
      .map((name) => String(name || "").trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const selects = [$("searchCollectionScope"), $("askCollectionScope")].filter(Boolean);
  selects.forEach((selectEl) => {
    const previous = String(selectEl.value || "all");
    selectEl.innerHTML = "";

    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All collections";
    selectEl.appendChild(allOpt);

    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      selectEl.appendChild(opt);
    });

    const hasPrevious = Array.from(selectEl.options).some((opt) => opt.value === previous);
    selectEl.value = hasPrevious ? previous : "all";
  });
}

async function loadCollectionScopeOptions(){
  if (!loadStoredAuth().token){
    setCollectionScopeOptions([]);
    return;
  }
  if (authRejected){
    setCollectionScopeOptions([]);
    return;
  }

  try{
    const res = await fetch("/v1/collections", { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      setCollectionScopeOptions([]);
      return;
    }
    if (res.ok && data.ok && Array.isArray(data.data?.collections)){
      const names = data.data.collections
        .map((row) => row?.collection)
        .filter(Boolean);
      setCollectionScopeOptions(names);
    } else {
      setCollectionScopeOptions([]);
    }
  }catch{
    setCollectionScopeOptions([]);
  }
}

function suggestDocIdFromFilename(name){
  const base = String(name || "").replace(/\.[^/.]+$/, "");
  return slugifyDocId(base);
}

function getFileExtension(name){
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const parts = raw.split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1];
}

function detectUploadFileType(file){
  const ext = getFileExtension(file?.name);
  const mime = String(file?.type || "").toLowerCase();
  if (ext === "pdf" || mime.includes("application/pdf")) return "pdf";
  if (ext === "docx" || mime.includes("wordprocessingml.document")) return "docx";
  if (ext === "doc" || mime.includes("application/msword")) return "doc";
  return "text";
}

function normalizeExtractedText(value){
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function loadExternalScript(url, globalName){
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (externalScriptCache.has(url)) return externalScriptCache.get(url);

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.getElementsByTagName("script"))
      .find((script) => script.src === url);

    const onReady = () => {
      if (!globalName || window[globalName]) {
        resolve(globalName ? window[globalName] : true);
      } else {
        reject(new Error(`Loaded script but missing ${globalName}`));
      }
    };

    if (existing) {
      if (existing.dataset.ready === "1") {
        onReady();
        return;
      }
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${url}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => {
      script.dataset.ready = "1";
      onReady();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load script: ${url}`)), { once: true });
    document.head.appendChild(script);
  });

  const cached = promise.catch((err) => {
    externalScriptCache.delete(url);
    throw err;
  });
  externalScriptCache.set(url, cached);
  return cached;
}

async function extractTextFromPdfFile(file){
  await loadExternalScript(PDFJS_LIB_URL, "pdfjsLib");
  const pdfjs = window.pdfjsLib;
  if (!pdfjs || !pdfjs.getDocument) {
    throw new Error("PDF parser failed to load");
  }
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const lines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const textLine = (textContent.items || [])
      .map((item) => String(item?.str || ""))
      .join(" ")
      .trim();
    if (textLine) lines.push(textLine);
  }

  return normalizeExtractedText(lines.join("\n\n"));
}

async function extractTextFromDocxFile(file){
  await loadExternalScript(MAMMOTH_LIB_URL, "mammoth");
  const mammoth = window.mammoth;
  if (!mammoth || typeof mammoth.extractRawText !== "function") {
    throw new Error("Word parser failed to load");
  }

  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return normalizeExtractedText(result?.value || "");
}

function suggestDocIdFromUrl(value){
  try{
    const url = new URL(String(value || ""));
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return slugifyDocId(`${url.hostname}${path}`);
  }catch{
    return "";
  }
}

function resolveDocConnectBaseUrl(){
  const raw = String(window.location?.origin || "").trim();
  if (!raw || raw === "null") return DOC_CONNECT_BASE_URL_PLACEHOLDER;
  return raw.replace(/\/+$/, "");
}

function buildDocConnectContent(baseUrl){
  const root = String(baseUrl || DOC_CONNECT_BASE_URL_PLACEHOLDER).replace(/\/+$/, "");
  const docsUrl = `${root}/#pageDocsTop`;
  const apiDocsUrl = `${root}/docs`;
  const llmsUrl = `${root}/llms.txt`;
  const mcpUrl = `${root}/mcp`;
  const serverName = DOC_CONNECT_SERVER_NAME;

  const cursorConfig = {
    mcpServers: {
      [serverName]: {
        url: mcpUrl
      }
    }
  };

  const vscodeConfig = {
    servers: {
      [serverName]: {
        url: mcpUrl
      }
    }
  };

  const antigravityConfig = {
    mcpServers: {
      [serverName]: {
        serverUrl: mcpUrl
      }
    }
  };

  return {
    docsUrl,
    apiDocsUrl,
    llmsUrl,
    mcpUrl,
    claudeProjectCmd: `claude mcp add --transport http ${serverName} ${mcpUrl}`,
    claudeUserCmd: `claude mcp add --transport http ${serverName} --scope user ${mcpUrl}`,
    codexCmd: `codex mcp add ${serverName} --url ${mcpUrl}`,
    cursorConfig: JSON.stringify(cursorConfig, null, 2),
    vscodeConfig: JSON.stringify(vscodeConfig, null, 2),
    antigravityConfig: JSON.stringify(antigravityConfig, null, 2),
    quickPrompt: [
      "Use Supavector documentation as your source of truth.",
      `Documentation UI tab: ${docsUrl}`,
      `API docs: ${apiDocsUrl}`,
      `llms.txt: ${llmsUrl}`,
      `MCP server: ${mcpUrl}`,
      "If you are operating on a local computer with this repo, prefer the supavector CLI over raw bootstrap commands.",
      "Run supavector doctor first. If Supavector is not configured, run supavector onboard.",
      "On the local CLI path, supavector onboard creates the first admin and first service token and saves local config for later CLI use.",
      "Use --collection explicitly on supavector write/search/ask/boolean_ask when scope matters. supavector write --folder ./name uses the folder name as the default collection.",
      "For /v1/ask and /v1/code, you can set answerLength: auto, short, medium, or long.",
      "Use favorRecency=true on search, ask, code, boolean_ask, or memory/recall when newer matching evidence should outrank older results.",
      "Use /v1/boolean_ask when you need a grounded response constrained to true, false, or invalid.",
      "When answering, cite the endpoint path and required headers for each Supavector API call."
    ].join("\n")
  };
}

function setTextById(id, value){
  const el = $(id);
  if (!el) return;
  el.textContent = String(value || "");
}

function setLinkById(id, value){
  const el = $(id);
  if (!el) return;
  const text = String(value || "");
  el.textContent = text;
  if (el.tagName === "A") {
    el.setAttribute("href", text);
  }
}

function normalizeRuntimeUiConfig(config){
  const raw = config && typeof config === "object" ? config : {};
  const capabilities = raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {};
  const links = raw.links && typeof raw.links === "object" ? raw.links : {};
  return {
    deploymentMode: String(raw.deploymentMode || "self_hosted").trim().toLowerCase() === "hosted" ? "hosted" : "self_hosted",
    capabilities: {
      dashboardControlPlane: Boolean(capabilities.dashboardControlPlane),
      localGatewayAdmin: capabilities.localGatewayAdmin !== false,
      hostedBilling: Boolean(capabilities.hostedBilling),
      portalEnabled: Boolean(capabilities.portalEnabled)
    },
    links: {
      dashboardUrl: String(links.dashboardUrl || "").trim() || null
    }
  };
}

function setSettingsScopedVisibility(scope, hidden){
  document.querySelectorAll(`[data-settings-scope="${scope}"]`).forEach((el) => {
    el.hidden = hidden;
  });
}

function ensureFirstVisibleDocTab(groupId){
  const group = document.querySelector(`.doc-tabs[data-doc-tabs="${groupId}"]`);
  if (!group) return;
  const visibleButtons = getDocTabButtons(group).filter((node) => !node.hidden);
  if (!visibleButtons.length) return;
  const activeVisible = visibleButtons.find((btn) => btn.classList.contains("active"));
  if (!activeVisible) {
    activateDocPanel(groupId, visibleButtons[0].dataset.docTab);
  }
}

function refreshSettingsNavIndices(){
  const nav = document.querySelector('.settings-nav[data-doc-tabs="settings"]');
  if (!nav) return;
  const visibleButtons = Array.from(nav.children).filter((node) => node.classList?.contains("doc-tab") && !node.hidden);
  visibleButtons.forEach((btn, idx) => {
    const indexEl = btn.querySelector(".settings-nav-index");
    if (indexEl) {
      indexEl.textContent = String(idx + 1).padStart(2, "0");
    }
  });
}

function applyRuntimeUiConfig(config){
  runtimeUiConfig = normalizeRuntimeUiConfig(config);
  const hosted = runtimeUiConfig.deploymentMode === "hosted";
  document.body.dataset.deploymentMode = runtimeUiConfig.deploymentMode;

  const settingsTab = $("tabSettings");
  if (settingsTab) {
    settingsTab.textContent = "Settings";
    settingsTab.hidden = false;
    settingsTab.setAttribute("aria-hidden", "false");
  }
  const settingsPage = $("pageSettings");
  if (settingsPage) {
    settingsPage.hidden = false;
  }

  setTextById("settingsSidebarKicker", hosted ? "Hosted" : "Settings");
  setTextById("settingsSidebarTitle", hosted ? "Start in the right place" : "Pick the admin job");
  setTextById(
    "settingsSidebarBody",
    hosted
      ? "Register once, then use Service Tokens whenever you need browser-local token work again. Keep long-lived service tokens in backend or agent secrets."
      : "Use saved tokens for machine access, human login only when you need admin controls, and create separate service tokens for each runtime."
  );
  setTextById(
    "registerPanelBody",
    hosted
      ? "Start here for a new hosted workspace. Registration creates the first admin, the default project, and the first service token you will use from your backend, worker, or agent."
      : "Create the first self-hosted account when browser registration is available, or authenticate an existing admin and mint a service token."
  );
  setTextById("settingsAuthKicker", hosted ? "Service Tokens" : "Access");
  setTextById("settingsAuthTitle", hosted ? "Sign in and manage browser tokens" : "Authenticate this browser");
  setTextById(
    "settingsAuthBody",
    hosted
      ? "Start with Overview, use Sign in to mint a fresh service token for this browser, then use Latest token to copy or re-save the newest token created here."
      : "Choose how this browser authenticates to SupaVector. Save a service token, or sign in for a human admin JWT when you need admin actions."
  );
  setTextById("settingsNavAuthTitle", hosted ? "Service Tokens" : "Browser Access");
  setTextById("settingsNavAuthBody", hosted ? "Overview, sign in, latest token" : "Saved token, login, SSO");
  setTextById("settingsNavProvidersTitle", "Provider Keys");
  setTextById("settingsNavProvidersBody", hosted ? "Browser-only AI billing overrides" : "Browser-only AI billing overrides");
  setTextById("settingsProvidersKicker", "Provider keys");
  setTextById("settingsProvidersTitle", "Optional AI keys for this browser");
  setTextById(
    "settingsProvidersBody",
    hosted
      ? "Only use this if you want requests from this browser to use your own OpenAI, Gemini, or Anthropic key."
      : "Save an OpenAI, Gemini, or Anthropic key here only if you want requests from this browser to use your own provider account."
  );
  setTextById("settingsProviderOverridesLabel", "Saved in this browser");
  setTextById(
    "settingsProviderOverridesHint",
    hosted
      ? "These stay in this browser. They are sent only when a request supports provider keys."
      : "These stay in this browser and are only sent when a request supports provider keys."
  );
  setTextById("settingsProviderWhenLabel", "Use this if");
  setTextById(
    "settingsProviderUseCase1",
    hosted
      ? "You want this browser to use your own AI account."
      : "You want this browser to send your own provider key."
  );
  setTextById("settingsProviderUseCase2", "It does not change how SupaVector authenticates you.");
  setTextById("settingsProviderUseCase3", "It affects only requests made from this browser.");

  const hostedNotice = $("settingsHostedNotice");
  if (hostedNotice) {
    hostedNotice.hidden = !hosted;
  }
  setTextById(
    "settingsHostedNoticeBody",
    hosted
      ? "Use Dashboard for projects, users, billing, SSO, and long-lived service-token management. This page is for signing in and managing the token this browser uses."
      : "Use Dashboard for projects, users, billing, SSO, and long-lived service-token management. This page is for signing in and managing the token this browser uses."
  );
  const dashboardLink = $("settingsDashboardLink");
  if (dashboardLink) {
    const dashboardUrl = runtimeUiConfig.links.dashboardUrl || (hosted && runtimeUiConfig.capabilities.portalEnabled ? "/portal" : "");
    dashboardLink.hidden = !hosted || !dashboardUrl;
    if (dashboardUrl) {
      dashboardLink.setAttribute("href", dashboardUrl);
    }
  }
  const billingDashboardLink = $("settingsBillingDashboardLink");
  if (billingDashboardLink) {
    const dashboardUrl = runtimeUiConfig.links.dashboardUrl || (hosted && runtimeUiConfig.capabilities.portalEnabled ? "/portal" : "");
    billingDashboardLink.hidden = !hosted || !dashboardUrl;
    if (dashboardUrl) {
      billingDashboardLink.setAttribute("href", dashboardUrl);
    }
  }

  setSettingsScopedVisibility("self_hosted", hosted);
  setSettingsScopedVisibility("hosted", !hosted);
  ensureFirstVisibleDocTab("settings");
  ensureFirstVisibleDocTab("settingsAuthSections");
  ensureFirstVisibleDocTab("settingsHostedTokenSections");
  refreshSettingsNavIndices();
}

async function loadRuntimeUiConfig(){
  try{
    const res = await fetch("/v1/runtime");
    const payload = await parseResponsePayload(res);
    if (res.ok && payload?.ok && payload.data){
      applyRuntimeUiConfig(payload.data);
      return runtimeUiConfig;
    }
  }catch(_err){
    // Fall back to self-hosted defaults when runtime config is unavailable.
  }
  applyRuntimeUiConfig(DEFAULT_RUNTIME_UI_CONFIG);
  return runtimeUiConfig;
}

async function loadRegisterOptions(){
  const availabilityEl = $("registerAvailability");
  try{
    const res = await fetch("/v1/register/options");
    const payload = await parseResponsePayload(res);
    if (res.ok && payload?.ok && payload.data){
      registerOptionsState = payload.data;
      if (availabilityEl) {
        availabilityEl.textContent = payload.data.note || "Registration options loaded.";
      }
      if ($("registerCreateBtn")) {
        $("registerCreateBtn").disabled = !payload.data.enabled;
      }
      if ($("registerTokenInstructions")) {
        $("registerTokenInstructions").textContent = formatRegisterInstructionsText(
          buildRegisterInstructionsPayload(payload.data.baseUrl || window.location.origin)
        );
      }
      return payload.data;
    }
    if (availabilityEl) {
      availabilityEl.textContent = resolveErrorMessage(payload, "Failed to load registration options.");
    }
  }catch(_err){
    if (availabilityEl) {
      availabilityEl.textContent = "Failed to load registration options.";
    }
  }
  if ($("registerCreateBtn")) {
    $("registerCreateBtn").disabled = true;
  }
  return null;
}

async function mintServiceTokenWithJwt(jwtToken, body){
  const res = await fetch("/v1/admin/service-tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${jwtToken}`
    },
    body: JSON.stringify(body)
  });
  const payload = await parseResponsePayload(res);
  return { res, payload };
}

async function loadTenantSummaryWithJwt(jwtToken){
  const res = await fetch("/v1/admin/tenant", {
    headers: {
      authorization: `Bearer ${jwtToken}`
    }
  });
  const payload = await parseResponsePayload(res);
  if (res.ok && payload?.ok && payload.data?.tenant){
    return payload.data.tenant;
  }
  return null;
}

function copyButtonMarkup(state = "copy"){
  const safeState = String(state || "copy").trim().toLowerCase();
  if (safeState === "copied") {
    return `
      <span class="copy-inline-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.5 8.4 6.6 11.4 12.5 4.9"></path>
        </svg>
      </span>
    `;
  }
  if (safeState === "failed") {
    return `
      <span class="copy-inline-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 5 11 11"></path>
          <path d="M11 5 5 11"></path>
        </svg>
      </span>
    `;
  }
  return `
    <span class="copy-inline-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="3" width="8" height="10" rx="1.8"></rect>
        <path d="M3 11V5.8C3 4.81 3.81 4 4.8 4H9"></path>
      </svg>
    </span>
  `;
}

function setCopyButtonState(btn, label, state = "copy"){
  if (!btn) return;
  const safeLabel = String(label || "Copy").trim() || "Copy";
  btn.innerHTML = copyButtonMarkup(state);
  btn.setAttribute("aria-label", safeLabel);
  btn.setAttribute("title", safeLabel);
  btn.dataset.copyState = state;
}

function resolveCopyTargetElement(btn){
  if (!btn) return null;
  if (btn.__copyTargetEl && btn.__copyTargetEl.isConnected) {
    return btn.__copyTargetEl;
  }

  const targetId = String(btn.getAttribute("data-copy-target") || "").trim();
  if (!targetId) return null;

  const wrap = btn.closest(".doc-copy-wrap");
  const wrapTarget = wrap
    ? Array.from(wrap.querySelectorAll("[id]")).find((el) => el.id === targetId)
    : null;
  if (wrapTarget) {
    btn.__copyTargetEl = wrapTarget;
    return wrapTarget;
  }

  const scopedRoot = btn.closest(".page, .doc-panel, .docs-shell, .product-page") || document;
  const scopedTarget = Array.from(scopedRoot.querySelectorAll("[id]")).find((el) => el.id === targetId) || null;
  if (scopedTarget) {
    btn.__copyTargetEl = scopedTarget;
    return scopedTarget;
  }

  const globalTarget = Array.from(document.querySelectorAll("[id]")).find((el) => el.id === targetId) || null;
  if (globalTarget) {
    btn.__copyTargetEl = globalTarget;
  }
  return globalTarget;
}

function bindCopyButton(btn){
  if (!btn || btn.dataset.copyBound === "1") return;
  btn.dataset.copyBound = "1";
  const existingLabel = String(
    btn.dataset.copyLabel
    || btn.getAttribute("aria-label")
    || btn.getAttribute("title")
    || btn.textContent
    || ""
  ).trim() || "Copy";
  btn.dataset.copyLabel = existingLabel;
  setCopyButtonState(btn, existingLabel, "copy");

  btn.addEventListener("click", async () => {
    const targetEl = resolveCopyTargetElement(btn);
    const value = String(targetEl?.textContent || "").trim();
    if (!value) {
      setCopyButtonState(btn, "No text", "failed");
      window.setTimeout(() => {
        setCopyButtonState(btn, existingLabel, "copy");
      }, 1200);
      return;
    }
    try {
      await copyTextToClipboard(value);
      setCopyButtonState(btn, "Copied", "copied");
    } catch {
      setCopyButtonState(btn, "Failed", "failed");
    } finally {
      window.setTimeout(() => {
        setCopyButtonState(btn, existingLabel, "copy");
      }, 1200);
    }
  });
}

function ensureDocCopyWrap(targetEl){
  if (!targetEl) return null;
  const existingWrap = targetEl.parentElement;
  if (existingWrap?.classList?.contains("doc-copy-wrap")) {
    return existingWrap;
  }
  const wrap = document.createElement("div");
  wrap.className = "doc-copy-wrap";
  targetEl.insertAdjacentElement("beforebegin", wrap);
  wrap.appendChild(targetEl);
  return wrap;
}

function mountCopyButtonOnTarget(btn, targetEl){
  if (!btn || !targetEl) return;
  const wrap = ensureDocCopyWrap(targetEl);
  if (!wrap) return;
  const sourceActions = btn.parentElement?.classList?.contains("actions") ? btn.parentElement : null;
  btn.__copyTargetEl = targetEl;
  btn.classList.remove("btn", "secondary");
  btn.classList.add("copy-inline-btn");
  wrap.appendChild(btn);
  if (sourceActions && !sourceActions.querySelector("[data-copy-target]")) {
    sourceActions.remove();
  }
}

function initPageCopyButtons(page){
  if (!page) return;

  let generatedCount = 0;
  const codeBlocks = Array.from(page.querySelectorAll("pre.doc-code"));
  codeBlocks.forEach((pre) => {
    if (!pre.id) {
      generatedCount += 1;
      pre.id = `pageCodeAuto${generatedCount}`;
    }
    ensureDocCopyWrap(pre);
  });

  Array.from(page.querySelectorAll("[data-copy-target]")).forEach((btn) => {
    const targetId = btn.getAttribute("data-copy-target");
    const targetEl = targetId
      ? (Array.from(page.querySelectorAll("[id]")).find((el) => el.id === targetId) || $(targetId))
      : null;
    if (targetEl) {
      btn.__copyTargetEl = targetEl;
    }
    if (targetEl?.matches?.("pre.doc-code")) {
      mountCopyButtonOnTarget(btn, targetEl);
    }
    bindCopyButton(btn);
  });

  codeBlocks.forEach((pre) => {
    const wrap = pre.parentElement;
    if (!wrap) return;
    const existingBtn = page.querySelector(`[data-copy-target="${pre.id}"]`);
    if (existingBtn) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-inline-btn";
    btn.setAttribute("data-copy-target", pre.id);
    btn.dataset.copyLabel = "Copy";
    btn.__copyTargetEl = pre;
    wrap.appendChild(btn);
    bindCopyButton(btn);
  });
}

function initDocsCopyButtons(){
  initPageCopyButtons($("pageDocs"));
  initPageCopyButtons($("pageProduct"));
}


function initDocsAgentConnect(){
  const section = $("docAgentConnect");
  if (!section) return;

  const bannerEl = $("docAgentConnectBanner");
  if (bannerEl) clearBanner(bannerEl);

  const content = buildDocConnectContent(resolveDocConnectBaseUrl());
  setLinkById("atlasDocsLink", content.docsUrl);
  setLinkById("atlasApiDocsLink", content.apiDocsUrl);
  setLinkById("atlasLlmsLink", content.llmsUrl);
  setLinkById("atlasMcpLink", content.mcpUrl);
  setLinkById("atlasMcpInlineLink", content.mcpUrl);
  setTextById("mcpDesktopUrl", content.mcpUrl);

  setTextById("mcpClaudeProjectCmd", content.claudeProjectCmd);
  setTextById("mcpClaudeUserCmd", content.claudeUserCmd);
  setTextById("mcpCodexCmd", content.codexCmd);
  setTextById("mcpCursorConfig", content.cursorConfig);
  setTextById("mcpVsCodeConfig", content.vscodeConfig);
  setTextById("mcpAntigravityConfig", content.antigravityConfig);
  setTextById("mcpQuickPrompt", content.quickPrompt);
  initDocsCopyButtons();
}

function showPage(pageId){
  const shell = document.querySelector(".shell");
  const tabs = [
    ["tabProduct","pageProduct"],
    ["tabPlayground","pagePlayground"],
    ["tabMetrics","pageMetrics"],
    ["tabUsage","pageUsage"],
    ["tabJobs","pageJobs"],
    ["tabCollections","pageCollections"],
    ["tabDocs","pageDocs"],
    ["tabSettings","pageSettings"]
  ];

  for (const [t,p] of tabs){
    $(t).classList.remove("active");
    $(t).setAttribute("aria-selected", "false");
    $(p).classList.remove("active");
  }

  const found = tabs.find(x => x[1] === pageId);
  if (found){
    $(found[0]).classList.add("active");
    $(found[0]).setAttribute("aria-selected", "true");
    $(found[1]).classList.add("active");
  }

  if (shell) {
    shell.classList.toggle("shell-docs-mode", pageId === "pageDocs");
  }

  if (pageId === "pageMetrics" && !metricsLoaded){
    loadStats();
  }
  if (pageId === "pageUsage" && !usageLoaded){
    loadUsage();
  }
}

const HASH_PAGE_ROUTES = new Map([
  ["pageproduct", "pageProduct"],
  ["pageplayground", "pagePlayground"],
  ["pagemetrics", "pageMetrics"],
  ["pageusage", "pageUsage"],
  ["pagejobs", "pageJobs"],
  ["pagecollections", "pageCollections"],
  ["pagedocs", "pageDocs"],
  ["pagedocstop", "pageDocs"],
  ["pagesettings", "pageSettings"],
  ["docs", "pageDocs"],
  ["start", "pageDocs"],
  ["install", "pageDocs"],
  ["setup", "pageDocs"],
  ["database", "pageDocs"],
  ["rbac", "pageDocs"],
  ["manage", "pageDocs"],
  ["memory", "pageDocs"],
  ["memory-policies", "pageDocs"],
  ["reference", "pageDocs"],
  ["documentation", "pageDocs"]
]);

function resolvePageIdFromHash(rawHash){
  const clean = decodeURIComponent(String(rawHash || "").replace(/^#/, "").trim()).toLowerCase();
  if (!clean) return null;
  if (HASH_PAGE_ROUTES.has(clean)) return HASH_PAGE_ROUTES.get(clean);
  if (clean.startsWith("doc-") || clean.startsWith("amv-") || clean.startsWith("mode-")) return "pageDocs";
  return null;
}

function openPageFromHash(options = {}){
  const rawHash = String(window.location?.hash || "");
  if (!rawHash) return false;
  const targetId = rawHash.replace(/^#/, "").trim();
  const pageId = resolvePageIdFromHash(rawHash);
  if (!pageId) return false;

  showPage(pageId);
  if (pageId === "pageDocs") {
    syncDocsPanelFromHash(rawHash);
  }

  if (targetId && options.scroll !== false) {
    const behavior = options.smooth ? "smooth" : "auto";
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior, block: "start" });
      }
    });
  }

  return true;
}

function getDocTabButtons(group){
  if (!group) return [];
  return Array.from(group.querySelectorAll(".doc-tab[data-doc-tab]"));
}

function getDocPanels(panelWrap){
  if (!panelWrap) return [];
  return Array.from(panelWrap.children).filter((node) => node.classList?.contains("doc-panel"));
}

function getActiveDocsMenuName(){
  return String(document.querySelector('.doc-tabs[data-doc-tabs="docs"] .doc-tab.active')?.dataset.docTab || "").trim();
}

function getDocsSubmenuSource(menuName = getActiveDocsMenuName()){
  return menuName
    ? document.querySelector(`.docs-menu-submenu[data-doc-submenu="${menuName}"]`)
    : null;
}

function getDocsSubmenuLinks(menuName = getActiveDocsMenuName()){
  const source = getDocsSubmenuSource(menuName);
  return source ? Array.from(source.querySelectorAll('a[href^="#"]')) : [];
}

function isDocsSelectionHash(value){
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return false;
  if (["docs", "pagedocs", "pagedocstop", "documentation"].includes(clean)) return false;
  if (clean.startsWith("doc-") || clean.startsWith("amv-") || clean.startsWith("mode-")) return true;
  return [
    "start",
    "install",
    "setup",
    "database",
    "rbac",
    "manage",
    "platform",
    "platform-management",
    "telemetry",
    "troubleshooting",
    "memory",
    "memory-policies",
    "reference",
    "enterprise",
    "deployment"
  ].includes(clean);
}

function isDocsLandingHash(value){
  const clean = String(value || "").trim().toLowerCase();
  return !clean || ["docs", "pagedocs", "pagedocstop", "documentation"].includes(clean);
}

function scrollToHashTarget(rawHash, options = {}){
  const targetId = decodeURIComponent(String(rawHash || "").replace(/^#/, "").trim());
  if (!targetId) return false;
  const target = document.getElementById(targetId) || document.getElementById(targetId.toLowerCase());
  if (!target) return false;
  const behavior = options.smooth ? "smooth" : "auto";
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior, block: "start" });
  });
  return true;
}

function navigateToHash(rawHash, options = {}){
  const nextHash = String(rawHash || "").trim();
  if (!nextHash) return false;
  const normalized = nextHash.startsWith("#") ? nextHash : `#${nextHash}`;
  if (window.location.hash === normalized) {
    const opened = openPageFromHash({
      smooth: options.smooth === true,
      scroll: options.scroll !== false
    });
    if (!opened && options.scroll !== false) {
      scrollToHashTarget(normalized, { smooth: options.smooth === true });
    }
    return opened;
  }
  window.location.hash = normalized;
  return true;
}

function activateDocPanel(groupId, panelName){
  const group = document.querySelector(`.doc-tabs[data-doc-tabs="${groupId}"]`);
  const panelWrap = document.querySelector(`.doc-panels[data-doc-panels="${groupId}"]`);
  if (!group || !panelWrap) return false;

  const buttons = getDocTabButtons(group);
  const panels = getDocPanels(panelWrap);
  const hasPanel = panels.some((panel) => panel.dataset.docPanel === panelName);
  if (!hasPanel) return false;
  const activeButtonName = buttons.some((btn) => btn.dataset.docTab === panelName)
    ? panelName
    : null;

  buttons.forEach((btn) => {
    const isActive = btn.dataset.docTab === activeButtonName;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  if (groupId === "docs") {
    const submenus = Array.from(group.querySelectorAll(".docs-menu-submenu[data-doc-submenu]"));
    submenus.forEach((submenu) => {
      submenu.hidden = submenu.dataset.docSubmenu !== activeButtonName;
    });
  }
  panels.forEach((panel) => {
    const isActive = panel.dataset.docPanel === panelName;
    panel.classList.toggle("active", isActive);
  });
  if (groupId === "docs") {
    syncDocsTopSubmenu(activeButtonName);
    syncDocsSectionOutline();
    syncDocsMenuLinksFromHash(window.location.hash);
  }
  if (groupId !== "docs" && panelWrap.closest("#pageDocs")) {
    syncDocsSectionOutline();
    syncDocsMenuLinksFromHash(window.location.hash);
  }
  return true;
}

function expandDocsSections(){
  document.querySelectorAll("#pageDocs .details.section").forEach((section) => {
    section.open = true;
  });
}

function syncDocsTopSubmenu(activeButtonName){
  void activeButtonName;
}

function syncDocsSectionOutline(){
  const outline = document.getElementById("docsSectionNav");
  const shell = document.querySelector("#pageDocs .docs-outline-shell");
  const main = document.querySelector("#pageDocs .docs-main");
  if (!outline) return;

  const links = docsSubmenuVisible ? getDocsSubmenuLinks() : [];
  outline.innerHTML = links.map((link) => {
    const href = String(link.getAttribute("href") || "").trim();
    const label = String(link.textContent || href).trim();
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  }).join("");

  const hidden = links.length === 0;
  outline.hidden = hidden;
  if (shell) shell.hidden = hidden;
  if (main) main.classList.toggle("docs-main-outline-hidden", hidden);
}

function syncDocsMenuLinksFromHash(rawHash){
  const targetId = decodeURIComponent(String(rawHash || "").replace(/^#/, "").trim()).toLowerCase();
  const containers = [
    document.querySelector('.doc-tabs[data-doc-tabs="docs"]'),
    document.getElementById("docsSectionNav")
  ].filter(Boolean);

  containers.forEach((container) => {
    const links = Array.from(container.querySelectorAll('a[href^="#"]'));
    links.forEach((link) => {
      const href = decodeURIComponent(String(link.getAttribute("href") || "").replace(/^#/, "").trim()).toLowerCase();
      const isActive = !!targetId && href === targetId;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  });
}

function resetDocsHashToLanding(options = {}){
  const landingHash = "#pageDocsTop";
  const nextUrl = `${window.location.pathname}${window.location.search}${landingHash}`;
  if (window.location.hash !== landingHash) {
    window.history.replaceState(null, "", nextUrl);
  }
  syncDocsMenuLinksFromHash(landingHash);
  if (options.scroll !== false) {
    scrollToHashTarget(landingHash, { smooth: options.smooth === true });
  }
}

function syncDocPanelsToTarget(target){
  if (!target) return false;

  const activations = [];
  let current = target;

  while (current){
    const panel = current.closest(".doc-panel[data-doc-panel]");
    if (!panel) break;

    const panelWrap = panel.parentElement;
    if (panelWrap && panelWrap.matches(".doc-panels[data-doc-panels]")) {
      activations.push([panelWrap.dataset.docPanels, panel.dataset.docPanel]);
    }

    current = panelWrap ? panelWrap.closest(".doc-panel[data-doc-panel]") : null;
  }

  if (!activations.length) return false;

  activations.reverse().forEach(([groupId, panelName]) => {
    activateDocPanel(groupId, panelName);
  });
  return true;
}

function syncDocsPanelFromHash(rawHash){
  const targetId = decodeURIComponent(String(rawHash || "").replace(/^#/, "").trim());
  const clean = targetId.toLowerCase();
  if (!clean) {
    docsSubmenuVisible = true;
    activateDocPanel("docs", "core");
    syncDocsMenuLinksFromHash(rawHash);
    return;
  }

  docsSubmenuVisible = isDocsSelectionHash(clean) || isDocsLandingHash(clean);
  expandDocsSections();
  syncDocsMenuLinksFromHash(rawHash);

  const target = document.getElementById(targetId) || document.getElementById(clean);
  if (target && syncDocPanelsToTarget(target)) {
    return;
  }

  if (clean.startsWith("amv-")) {
    activateDocPanel("docs", "amv");
    return;
  }
  if (clean === "start") {
    activateDocPanel("docs", "core");
    return;
  }
  if (clean.startsWith("doc-reference") || clean === "reference") {
    activateDocPanel("docs", "reference");
    return;
  }
  if (clean.startsWith("doc-rbac") || clean === "rbac") {
    activateDocPanel("docs", "rbac");
    return;
  }
  if (clean.startsWith("doc-enterprise") || clean === "enterprise") {
    activateDocPanel("docs", clean === "doc-enterprise-apis" ? "reference" : "setup");
    return;
  }
  if (clean.startsWith("doc-database") || clean === "database") {
    activateDocPanel("docs", "database");
    return;
  }
  if (clean.startsWith("doc-platform") || clean.startsWith("doc-manage") || clean === "manage" || clean === "platform" || clean === "platform-management" || clean === "telemetry" || clean === "troubleshooting") {
    activateDocPanel("docs", "platform");
    return;
  }
  if (clean.startsWith("doc-deployment") || clean === "deployment") {
    activateDocPanel("docs", "setup");
    return;
  }
  if (clean.startsWith("doc-cli") || clean === "install") {
    activateDocPanel("docs", "cli");
    return;
  }
  if (clean === "doc-setup-modes" || clean === "doc-setup-guides" || clean === "setup") {
    activateDocPanel("docs", "setup");
    return;
  }
  const usageModes = {
    "mode-bundled": "bundled",
    "mode-byo-postgres": "byoPostgres",
    "mode-shared": "shared",
    "mode-shared-openai": "sharedOpenAi",
    "mode-backend-proxy": "backendProxy",
    "mode-human-admin": "humanAdmin"
  };
  if (usageModes[clean]) {
    activateDocPanel("docs", "setup");
    activateDocPanel("usageModes", usageModes[clean]);
    return;
  }
  if (clean === "memory" || clean === "memory-policies") {
    activateDocPanel("docs", "amv");
    return;
  }
  if (clean.startsWith("doc-") || isDocsLandingHash(clean)) {
    activateDocPanel("docs", "core");
  }
}

function showPlayPane(paneId){
  const tabs = [
    ["playTabIngest","playPaneIngest"],
    ["playTabSearch","playPaneSearch"],
    ["playTabAsk","playPaneAsk"]
  ];

  for (const [t,p] of tabs){
    $(t).classList.remove("active");
    $(t).setAttribute("aria-selected", "false");
    $(p).classList.remove("active");
  }

  const found = tabs.find(x => x[1] === paneId);
  if (found){
    $(found[0]).classList.add("active");
    $(found[0]).setAttribute("aria-selected", "true");
    $(found[1]).classList.add("active");
  }
}

function initDocTabs(){
  const groups = document.querySelectorAll(".doc-tabs[data-doc-tabs]");
  groups.forEach((group) => {
    const groupId = group.dataset.docTabs;
    const panelWrap = document.querySelector(`.doc-panels[data-doc-panels="${groupId}"]`);
    if (!panelWrap) return;
    const buttons = getDocTabButtons(group);
    const panels = getDocPanels(panelWrap);
    if (!buttons.length || !panels.length) return;

    const activate = (name) => {
      activateDocPanel(groupId, name);
    };

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (groupId === "docs") {
          docsSubmenuVisible = true;
          activateDocPanel(groupId, btn.dataset.docTab);
          resetDocsHashToLanding({ smooth: true });
          return;
        }
        activate(btn.dataset.docTab);
      });
    });

    const current = buttons.find((btn) => btn.classList.contains("active")) || buttons[0];
    if (current) activate(current.dataset.docTab);
  });
}

function initDocsHashNavigation(){
  const docsPage = document.getElementById("pageDocs");
  if (!docsPage) return;
  docsPage.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || !docsPage.contains(link)) return;
    const href = String(link.getAttribute("href") || "").trim();
    if (!href) return;
    const targetHash = href.startsWith("#") ? href : `#${href}`;
    const targetId = decodeURIComponent(targetHash.replace(/^#/, "").trim());
    if (!targetId) return;
    const target = document.getElementById(targetId) || document.getElementById(targetId.toLowerCase());
    const routePage = resolvePageIdFromHash(targetHash);
    if (!target && !routePage) return;
    event.preventDefault();
    navigateToHash(targetHash, { smooth: true });
  });
}

function renderSearch(results){
  const wrap = $("searchCards");
  wrap.innerHTML = "";
  if (!results || results.length === 0){
    wrap.innerHTML = "<div class=\"card reveal\"><div class=\"preview\">No matches found.</div></div>";
    return;
  }

  results.forEach((r, idx) => {
    const score = (typeof r.score === "number") ? r.score.toFixed(4) : String(r.score);
    const html = `
      <div class="card reveal" style="animation-delay:${idx * 40}ms;">
        <div class="cardhead">
          <span class="chip">Chunk <span class="mono">${escapeHtml(r.id)}</span></span>
          <span class="chip">Score <span class="mono">${escapeHtml(score)}</span></span>
          <span class="chip">Doc <span class="mono">${escapeHtml(r.docId || "?")}</span></span>
        </div>
        <div class="preview">${escapeHtml(r.preview || "")}</div>
      </div>
    `;
    wrap.insertAdjacentHTML("beforeend", html);
  });
}

function renderAnswer(data){
  const wrap = $("askAnswerCard");
  wrap.innerHTML = "";

  const answerText = data?.answer || "(no answer)";

  let sources = [];
  if (Array.isArray(data?.sources)) {
    sources = data.sources;
  } else if (Array.isArray(data?.citations)) {
    if (data.citations.length > 0 && typeof data.citations[0] === "string") {
      sources = data.citations.map((chunkId) => ({ chunkId }));
    } else {
      sources = data.citations;
    }
  }

  const html = `
    <div class="card reveal" style="animation-delay:20ms;">
      <div class="cardhead">
        <span class="chip">Answer</span>
        ${data?.provider ? `<span class="chip">Provider <span class="mono">${escapeHtml(data.provider)}</span></span>` : ""}
        ${data?.model ? `<span class="chip">Model <span class="mono">${escapeHtml(data.model)}</span></span>` : ""}
      </div>
      <div class="preview">${escapeHtml(answerText)}</div>
    </div>
  `;
  wrap.insertAdjacentHTML("beforeend", html);

  const sourcesHtml = sources.length
    ? sources.map((src, idx) => {
      const docId = src?.docId || src?.doc_id || null;
      const collection = src?.collection || src?.collection_id || null;
      const chunkId = src?.chunkId || src?.chunk_id || src?.id || null;
      const chips = [];
      chips.push(`<span class="chip">Source ${idx + 1}</span>`);
      if (docId) chips.push(`<span class="chip">Doc <span class="mono">${escapeHtml(docId)}</span></span>`);
      if (collection) chips.push(`<span class="chip">Collection <span class="mono">${escapeHtml(collection)}</span></span>`);
      if (chunkId) chips.push(`<span class="chip">Chunk <span class="mono">${escapeHtml(chunkId)}</span></span>`);
      return `
        <div class="source-item">
          <div class="chips">
            ${chips.join("")}
          </div>
        </div>
      `;
    }).join("")
    : `<div class="preview">No sources returned.</div>`;

  const sourcesCard = `
    <div class="card reveal" style="animation-delay:60ms;">
      <div class="cardhead">
        <span class="chip">Sources</span>
        <span class="chip">${sources.length} total</span>
      </div>
      ${sourcesHtml}
    </div>
  `;
  wrap.insertAdjacentHTML("beforeend", sourcesCard);

  const supportingChunks = Array.isArray(data?.supportingChunks) ? data.supportingChunks : [];
  if (supportingChunks.length) {
    const chunksHtml = supportingChunks.map((chunk, idx) => {
      const chips = [
        `<span class="chip">Chunk ${idx + 1}</span>`
      ];
      if (chunk?.docId) chips.push(`<span class="chip">Doc <span class="mono">${escapeHtml(chunk.docId)}</span></span>`);
      if (chunk?.collection) chips.push(`<span class="chip">Collection <span class="mono">${escapeHtml(chunk.collection)}</span></span>`);
      if (chunk?.chunkId) chips.push(`<span class="chip">Id <span class="mono">${escapeHtml(chunk.chunkId)}</span></span>`);
      if (typeof chunk?.score === "number") chips.push(`<span class="chip">Score <span class="mono">${escapeHtml(chunk.score.toFixed(4))}</span></span>`);
      return `
        <div class="source-item">
          <div class="chips">${chips.join("")}</div>
          <div class="preview">${escapeHtml(chunk?.text || "")}</div>
        </div>
      `;
    }).join("");

    const chunksCard = `
      <div class="card reveal" style="animation-delay:100ms;">
        <div class="cardhead">
          <span class="chip">Supporting Chunks</span>
          <span class="chip">${supportingChunks.length} total</span>
        </div>
        ${chunksHtml}
      </div>
    `;
    wrap.insertAdjacentHTML("beforeend", chunksCard);
  }
}

function renderStats(data){
  const wrap = $("statsCards");
  wrap.innerHTML = "";

  const stats = data || {};
  const uptime = Number(stats.uptime_seconds || 0);
  const commands = Number(stats.commands_processed || 0);
  const ops = uptime > 0 ? commands / uptime : 0;

  const vectors = Number(stats.vectors || 0);
  const vset = Number(stats.vset_count || 0);
  const vsearch = Number(stats.vsearch_count || 0);
  const vsearchAnn = Number(stats.vsearch_ann_count || 0);
  const vdel = Number(stats.vdel_count || 0);
  const vops = uptime > 0 ? (vset + vsearch + vsearchAnn + vdel) / uptime : 0;
  const vectorSearch = stats.gateway?.vectorSearch || {};
  const annConfig = vectorSearch.config || {};
  const shadowOverlapAvg = Number(vectorSearch.shadow?.top_k_overlap?.avg);
  const circuitOpenedUntil = vectorSearch.ann_circuit?.opened_until;

  const cards = [
    {
      label: "Uptime",
      value: formatDuration(uptime),
      meta: `${formatNumber(uptime)} seconds`
    },
    {
      label: "Commands",
      value: formatNumber(commands),
      meta: `${formatRate(ops)} ops/sec`
    },
    {
      label: "Connections",
      value: formatNumber(stats.active_connections),
      meta: `${formatNumber(stats.total_connections)} total`
    },
    {
      label: "Keyspace",
      value: formatNumber(stats.keys),
      meta: `${formatNumber(stats.expired_removed)} expired removed`
    },
    {
      label: "Vector index",
      value: formatNumber(vectors),
      meta: `dims ${formatNumber(stats.vector_dims)}`
    },
    {
      label: "Vector ops",
      value: formatNumber(vset + vsearch + vsearchAnn + vdel),
      meta: `${formatRate(vops)} ops/sec`
    },
    {
      label: "VSET",
      value: formatNumber(vset),
      meta: "vector inserts"
    },
    {
      label: "VSEARCH",
      value: formatNumber(vsearch + vsearchAnn),
      meta: `${formatNumber(vsearchAnn)} ANN`
    },
    {
      label: "ANN index",
      value: stats.ann_index_ready ? "Ready" : "Not ready",
      meta: `${formatNumber(Number(stats.ann_index_vectors || 0))}/${formatNumber(vectors)} vectors`
    },
    {
      label: "ANN mode",
      value: annConfig.mode || "exact",
      meta: annConfig.enabled ? `${formatNumber(Number(annConfig.rollout_percent || 0))}% rollout` : "disabled"
    },
    {
      label: "ANN circuit",
      value: vectorSearch.ann_circuit?.open ? "Open" : "Closed",
      meta: circuitOpenedUntil || "normal"
    },
    {
      label: "Dense p95",
      value: formatMs(Number(vectorSearch.dense_search_ms?.p95)),
      meta: `${formatNumber(Number(vectorSearch.scanned_count?.p95))} scanned p95`
    },
    {
      label: "Shadow overlap",
      value: Number.isFinite(shadowOverlapAvg) ? shadowOverlapAvg.toFixed(2) : "-",
      meta: `${formatNumber(Number(vectorSearch.shadow?.count || 0))} samples`
    },
    {
      label: "Latency p50",
      value: formatMs(stats.gateway?.latency?.overall?.p50_ms),
      meta: "overall"
    },
    {
      label: "Latency p95",
      value: formatMs(stats.gateway?.latency?.overall?.p95_ms),
      meta: "overall"
    },
    {
      label: "Latency p99",
      value: formatMs(stats.gateway?.latency?.overall?.p99_ms),
      meta: "overall"
    }
  ];

  const html = cards.map((card) => {
    return `
      <div class="stat">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value">${escapeHtml(card.value)}</div>
        <div class="stat-meta">${escapeHtml(card.meta)}</div>
      </div>
    `;
  }).join("");

  wrap.insertAdjacentHTML("beforeend", html);
}

function renderUsage(stats){
  const wrap = $("usageCards");
  if (!wrap) return;
  wrap.innerHTML = "";

  const gateway = stats?.gateway?.latency || {};
  const overall = gateway.overall || {};
  const count = Number(overall.count || 0);
  const errRate = Number(overall.error_rate || 0);
  const usage = stats?.usage || {};
  const windows = usage.windows || {};
  const winAll = windows.all || {};
  const win24 = windows["24h"] || {};
  const win7 = windows["7d"] || {};
  const storage = usage.storage || {};
  const billing = usage.billing || {};
  const billingCosts = billing.costs || {};
  const billingWindows = billing.windows || {};
  const billingAll = billingWindows.all || billingCosts;
  const billing24 = billingWindows["24h"] || billingCosts;
  const billing7 = billingWindows["7d"] || billingCosts;
  const storageMonthly = billing.storageMonthly || {};
  const storageMonthlyCurrent = storageMonthly.current || null;
  const projectedStorageCharge = Number(storageMonthlyCurrent?.projectedCharge ?? billingAll.storageCharge ?? 0);
  const projectedStorageChargeText = `$${projectedStorageCharge.toFixed(4)}`;
  const storageChargeLabel = storageMonthlyCurrent ? "Projected storage charge" : "Storage charge";
  const storageChargeMeta = storageMonthlyCurrent
    ? `$${billing.rates?.storagePerGB}/GB-month avg retained`
    : `$${billing.rates?.storagePerGB}/GB`;
  const storageChargeWindowMeta = storageMonthlyCurrent ? "current month projection" : "current";

  const embedTotals = {
    all: Number(winAll.tokens?.embedding?.total || 0),
    "24h": Number(win24.tokens?.embedding?.total || 0),
    "7d": Number(win7.tokens?.embedding?.total || 0)
  };
  const embedReqs = {
    all: Number(winAll.tokens?.embedding?.requests || 0),
    "24h": Number(win24.tokens?.embedding?.requests || 0),
    "7d": Number(win7.tokens?.embedding?.requests || 0)
  };
  const genTotals = {
    all: Number(winAll.tokens?.generation?.total || 0),
    "24h": Number(win24.tokens?.generation?.total || 0),
    "7d": Number(win7.tokens?.generation?.total || 0)
  };
  const genReqs = {
    all: Number(winAll.tokens?.generation?.requests || 0),
    "24h": Number(win24.tokens?.generation?.requests || 0),
    "7d": Number(win7.tokens?.generation?.requests || 0)
  };

  const storageBytes = Number(storage.bytes || 0);
  const storageChunks = Number(storage.chunks || 0);
  const storageDocs = Number(storage.documents || 0);
  const storageItems = Number(storage.memoryItems || 0);
  const storageCollections = Number(storage.collections || 0);

  const cards = [
    {
      id: "requests",
      label: "Requests",
      values: { all: count, "24h": count, "7d": count },
      meta: { all: "since restart", "24h": "since restart", "7d": "since restart" }
    },
    {
      id: "error_rate",
      label: "Error rate",
      values: { all: errRate, "24h": errRate, "7d": errRate },
      format: (value) => `${(Number(value || 0) * 100).toFixed(2)}%`,
      meta: { all: "gateway 5xx", "24h": "gateway 5xx", "7d": "gateway 5xx" }
    },
    {
      id: "embedding_tokens",
      label: "Embedding tokens",
      values: embedTotals,
      meta: {
        all: `${formatNumber(embedReqs.all)} calls`,
        "24h": `${formatNumber(embedReqs["24h"])} calls`,
        "7d": `${formatNumber(embedReqs["7d"])} calls`
      }
    },
    {
      id: "generation_tokens",
      label: "Generation tokens",
      values: genTotals,
      meta: {
        all: `${formatNumber(genReqs.all)} calls`,
        "24h": `${formatNumber(genReqs["24h"])} calls`,
        "7d": `${formatNumber(genReqs["7d"])} calls`
      }
    },
    {
      id: "storage_used",
      label: "Storage used",
      values: { all: storageBytes, "24h": storageBytes, "7d": storageBytes },
      format: formatBytes,
      meta: { all: `${formatNumber(storageChunks)} chunks`, "24h": "current", "7d": "current" }
    },
    {
      id: "documents",
      label: "Documents",
      values: { all: storageDocs, "24h": storageDocs, "7d": storageDocs },
      meta: { all: `${formatNumber(storageCollections)} collections`, "24h": "current", "7d": "current" }
    },
    {
      id: "memory_items",
      label: "Memory items",
      values: { all: storageItems, "24h": storageItems, "7d": storageItems },
      meta: { all: "total", "24h": "current", "7d": "current" }
    },
    {
      id: "latency_p50",
      label: "Latency p50",
      values: { all: overall.p50_ms, "24h": overall.p50_ms, "7d": overall.p50_ms },
      format: formatMs,
      meta: { all: "overall", "24h": "rolling", "7d": "rolling" }
    },
    {
      id: "latency_p95",
      label: "Latency p95",
      values: { all: overall.p95_ms, "24h": overall.p95_ms, "7d": overall.p95_ms },
      format: formatMs,
      meta: { all: "overall", "24h": "rolling", "7d": "rolling" }
    },
    {
      id: "latency_p99",
      label: "Latency p99",
      values: { all: overall.p99_ms, "24h": overall.p99_ms, "7d": overall.p99_ms },
      format: formatMs,
      meta: { all: "overall", "24h": "rolling", "7d": "rolling" }
    },
    {
      id: "vector_ops",
      label: "Vector ops",
      values: { all: (stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0), "24h": (stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0), "7d": (stats?.vset_count || 0) + (stats?.vsearch_count || 0) + (stats?.vdel_count || 0) },
      meta: { all: "total", "24h": "since restart", "7d": "since restart" }
    },
    ...(billing.rates?.storagePerGB ? [{
      id: "storage_charge",
      label: storageChargeLabel,
      value: projectedStorageChargeText,
      values: { all: projectedStorageChargeText, "24h": projectedStorageChargeText, "7d": projectedStorageChargeText },
      format: (v) => v,
      meta: { all: storageChargeMeta, "24h": storageChargeWindowMeta, "7d": storageChargeWindowMeta }
    }] : []),
    ...(billing.rates?.aiTokensPer1K ? [{
      id: "ai_tokens_charge",
      label: "AI generation charge",
      value: `$${Number(billingAll.aiTokensCharge || 0).toFixed(4)}`,
      values: { all: `$${Number(billingAll.aiTokensCharge || 0).toFixed(4)}`, "24h": `$${Number(billing24.aiTokensCharge || 0).toFixed(4)}`, "7d": `$${Number(billing7.aiTokensCharge || 0).toFixed(4)}` },
      format: (v) => v,
      meta: { all: `$${billing.rates?.aiTokensPer1K}/1K billable tokens`, "24h": "billable", "7d": "billable" }
    }] : [])
  ];

  const html = cards.map((card) => {
    const selected = getUsageWindow(card.id);
    const rawValue = card.values?.[selected] ?? card.value ?? "-";
    const value = card.format ? card.format(rawValue) : formatNumber(rawValue);
    const meta = typeof card.meta === "object"
      ? (card.meta?.[selected] ?? card.meta?.all ?? "")
      : (card.meta || "");
    const tabs = USAGE_WINDOWS.map((window) => {
      const label = USAGE_WINDOW_LABELS[window] || window;
      const active = selected === window ? "active" : "";
      return `<button class="stat-tab ${active}" type="button" data-usage-window="${window}" data-card="${card.id}">${label}</button>`;
    }).join("");
    return `
      <div class="stat">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-meta">${escapeHtml(meta)}</div>
        <div class="stat-tabs">${tabs}</div>
      </div>
    `;
  }).join("");

  wrap.insertAdjacentHTML("beforeend", html);
  bindUsageWindowClicks();
}

function renderUsageRoutes(routes){
  const wrap = $("usageRoutesTable");
  if (!wrap) return;
  const entries = Object.entries(routes || {});
  if (!entries.length){
    wrap.textContent = "(no data)";
    return;
  }

  entries.sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
  const rows = entries.map(([route, stats]) => {
    const count = Number(stats?.count || 0);
    const errRate = Number(stats?.error_rate || 0);
    return `
      <tr>
        <td class="mono">${escapeHtml(route)}</td>
        <td>${escapeHtml(formatNumber(count))}</td>
        <td>${escapeHtml((errRate * 100).toFixed(2))}%</td>
        <td>${escapeHtml(formatMs(stats?.p50_ms))}</td>
        <td>${escapeHtml(formatMs(stats?.p95_ms))}</td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Route</th>
          <th>Requests</th>
          <th>Error rate</th>
          <th>p50</th>
          <th>p95</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadStats(){
  if (metricsLoading) return;
  clearBanner($("statsBanner"));
  if (!requireKeyOrWarn($("statsBanner"))) return;

  metricsLoading = true;
  $("statsBtn").disabled = true;
  $("statsBtn").textContent = "Loading...";

  try{
    const res = await fetch("/stats", { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    $("statsRaw").textContent = JSON.stringify(data, null, 2);
    if (res.status === 401){
      noteUnauthorized(data);
      setBanner($("statsBanner"), "err", authRejectedMessage);
      renderStats({});
      metricsLoaded = false;
      return;
    }

    if (res.ok){
      setBanner($("statsBanner"), "ok", "Stats loaded.");
      renderStats(data);
      $("statsUpdated").textContent = new Date().toLocaleString();
      metricsLoaded = true;
    }else{
      setBanner($("statsBanner"), "err", data.error || "Stats failed.");
    }
  }catch(e){
    setBanner($("statsBanner"), "err", "Error: " + e);
  }finally{
    metricsLoading = false;
    $("statsBtn").disabled = false;
    $("statsBtn").textContent = "Refresh stats";
  }
}

async function loadUsage(){
  if (usageLoading) return;
  clearBanner($("usageBanner"));
  if (!requireKeyOrWarn($("usageBanner"))) return;

  usageLoading = true;
  $("usageRefreshBtn").disabled = true;
  $("usageRefreshBtn").textContent = "Loading...";
  const usageCardsEl = $("usageCards");
  if (usageCardsEl) usageCardsEl.innerHTML = '<p class="hint" style="padding:16px;text-align:center;">Loading usage data…</p>';

  try{
    const res = await fetch("/v1/admin/usage", { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    $("usageRaw").textContent = JSON.stringify(data, null, 2);
    if (res.status === 401){
      noteUnauthorized(data);
      setBanner($("usageBanner"), "err", authRejectedMessage);
      lastUsageStats = null;
      renderUsage(null);
      renderUsageRoutes({});
      usageLoaded = false;
      return;
    }

    if (res.ok && data.ok){
      lastUsageStats = data.data;
      renderUsage(lastUsageStats);
      renderUsageRoutes(lastUsageStats?.gateway?.latency?.routes || {});
      $("usageUpdated").textContent = new Date().toLocaleString();
      setBanner($("usageBanner"), "ok", "Usage loaded.");
      usageLoaded = true;
    }else{
      renderUsage(null);
      setBanner($("usageBanner"), "err", data?.error?.message || "Usage failed.");
    }
  }catch(e){
    renderUsage(null);
    setBanner($("usageBanner"), "err", "Error loading usage.");
  }finally{
    usageLoading = false;
    $("usageRefreshBtn").disabled = false;
    $("usageRefreshBtn").textContent = "Refresh usage";
  }
}

function renderJobDetails(job){
  const target = $("jobDetails");
  if (!target) return;
  target.textContent = job ? JSON.stringify(job, null, 2) : "(no job loaded)";
}

function renderJobsTable(jobs){
  const wrap = $("jobListTable");
  if (!wrap) return;
  if (!jobs || jobs.length === 0){
    wrap.textContent = "(no data)";
    return;
  }

  const rows = jobs.map((job) => {
    return `
      <tr>
        <td class="mono">${escapeHtml(job.id)}</td>
        <td>${escapeHtml(job.status || "-")}</td>
        <td>${escapeHtml(job.jobType || job.job_type || "-")}</td>
        <td>${escapeHtml(job.createdAt || job.created_at || "-")}</td>
        <td>${escapeHtml(job.updatedAt || job.updated_at || "-")}</td>
        <td><button class="btn secondary job-view-btn" data-id="${escapeHtml(job.id)}">View</button></td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Status</th>
          <th>Type</th>
          <th>Created</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll(".job-view-btn").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (!id) return;
      $("jobIdInput").value = id;
      fetchJobById(id);
    };
  });
}

function renderCollections(collections){
  const wrap = $("collectionsTable");
  if (!wrap) return;
  if (!collections || collections.length === 0){
    wrap.textContent = "(no data)";
    return;
  }

  const rows = collections.map((col) => {
    const titles = Array.isArray(col.titles) ? col.titles : [];
    const docList = titles.length
      ? titles.map((title) => {
          return `
            <div class="doc-pill">
              <span class="mono">${escapeHtml(title)}</span>
              <button class="btn tiny danger doc-delete-btn" data-collection="${escapeHtml(col.collection)}" data-doc="${escapeHtml(title)}">Delete</button>
            </div>
          `;
        }).join("")
      : `<span class="muted">No docs</span>`;
    return `
      <tr>
        <td class="mono">${escapeHtml(col.collection)}</td>
        <td>${escapeHtml(String(col.totalDocs || 0))}</td>
        <td><div class="doc-list">${docList}</div></td>
        <td><button class="btn danger collection-delete-btn" data-collection="${escapeHtml(col.collection)}">Delete</button></td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Collection</th>
          <th>Docs</th>
          <th>Titles</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll(".collection-delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.collection;
      if (!name) return;
      if (!confirm(`Delete collection "${name}"? This removes stored chunk text and memory items.`)) {
        return;
      }
      clearBanner($("collectionsBanner"));
      if (!requireKeyOrWarn($("collectionsBanner"))) return;
      try{
        const res = await fetch(`/v1/collections/${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: apiHeaders()
        });
        const data = await res.json();
        if (res.ok && data.ok){
          setBanner($("collectionsBanner"), "ok", `Deleted collection "${name}".`);
          await fetchCollections();
        }else{
          const msg = data?.error?.message || data?.error || "Delete failed.";
          setBanner($("collectionsBanner"), "err", msg);
        }
      }catch(e){
        setBanner($("collectionsBanner"), "err", "Error deleting collection.");
      }
    };
  });

  wrap.querySelectorAll(".doc-delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      const docId = btn.dataset.doc;
      const collection = btn.dataset.collection || "default";
      if (!docId) return;
      if (!confirm(`Delete document "${docId}" from "${collection}"?`)) {
        return;
      }
      clearBanner($("collectionsBanner"));
      if (!requireKeyOrWarn($("collectionsBanner"))) return;
      try{
        const res = await fetch(`/v1/docs/${encodeURIComponent(docId)}?collection=${encodeURIComponent(collection)}`, {
          method: "DELETE",
          headers: apiHeaders()
        });
        const data = await res.json();
        if (res.ok && data.ok){
          setBanner($("collectionsBanner"), "ok", `Deleted document "${docId}".`);
          await fetchCollections();
          loadDocsList();
        }else{
          const msg = data?.error?.message || data?.error || "Delete failed.";
          setBanner($("collectionsBanner"), "err", msg);
        }
      }catch(e){
        setBanner($("collectionsBanner"), "err", "Error deleting document.");
      }
    };
  });
}

async function fetchJobById(id){
  clearBanner($("jobsBanner"));
  if (!requireKeyOrWarn($("jobsBanner"))) return;
  if (!id){
    setBanner($("jobsBanner"), "err", "Provide a job ID.");
    return;
  }
  try{
    const res = await fetch(`/v1/jobs/${encodeURIComponent(id)}`, { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && data.data?.job){
      renderJobDetails(data.data.job);
      setBanner($("jobsBanner"), "ok", "Job loaded.");
    }else{
      renderJobDetails(null);
      const msg = data?.error?.message || data?.error || "Job not found.";
      setBanner($("jobsBanner"), "err", msg);
    }
  }catch(e){
    setBanner($("jobsBanner"), "err", "Error loading job.");
  }
}

async function fetchInProgressJobs(){
  clearBanner($("jobsBanner"));
  if (!requireKeyOrWarn($("jobsBanner"))) return;
  try{
    const res = await fetch("/v1/jobs?status=in_progress&limit=50", { headers: apiHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.data?.jobs)){
      renderJobsTable(data.data.jobs);
      setBanner($("jobsBanner"), "ok", "In-progress jobs loaded.");
    }else{
      renderJobsTable([]);
      const msg = data?.error?.message || data?.error || "Failed to load jobs.";
      setBanner($("jobsBanner"), "err", msg);
    }
  }catch(e){
    setBanner($("jobsBanner"), "err", "Error loading jobs.");
  }
}

async function fetchCollections(){
  clearBanner($("collectionsBanner"));
  if (!requireKeyOrWarn($("collectionsBanner"))) return;
  try{
    const res = await fetch("/v1/collections", { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      renderCollections([]);
      setBanner($("collectionsBanner"), "err", authRejectedMessage);
      return;
    }
    if (res.ok && data.ok && Array.isArray(data.data?.collections)){
      renderCollections(data.data.collections);
      $("collectionsUpdated").textContent = new Date().toLocaleString();
      setBanner($("collectionsBanner"), "ok", "Collections loaded.");
      loadCollectionScopeOptions();
    }else{
      renderCollections([]);
      const msg = resolveErrorMessage(data, "Failed to load collections.");
      setBanner($("collectionsBanner"), "err", msg);
    }
  }catch(e){
    setBanner($("collectionsBanner"), "err", "Error loading collections.");
  }
}

async function refreshHealth(){
  const dot = $("healthDot");
  const text = $("healthText");
  dot.className = "dot";
  text.textContent = "Checking /health...";

  try{
    const res = await fetch("/health");
    const data = await res.json();
    if (data.ok){
      dot.classList.add("good");
      text.textContent = "Healthy (gateway to TCP OK)";
    }else{
      dot.classList.add("bad");
      text.textContent = "Unhealthy (check logs)";
    }
  }catch(e){
    dot.classList.add("bad");
    text.textContent = "Health check failed";
  }
}

async function loadTenantSettings(){
  const banner = $("tenantAuthBanner");
  const loadBtn = $("tenantAuthLoadBtn");
  if (!banner || !loadBtn) return;
  clearBanner(banner);
  if (!requireKeyOrWarn(banner)) return;

  loadBtn.disabled = true;
  const originalLabel = loadBtn.textContent;
  loadBtn.textContent = "Loading...";

  try{
    const res = await fetch("/v1/admin/tenant", { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      setBanner(banner, "err", authRejectedMessage);
      return;
    }
    if (res.ok && data?.ok && data.data?.tenant){
      const tenant = data.data.tenant;
      const models = tenant.models || {};
      const configuredModels = models.configured || {};
      const instanceDefaults = models.instanceDefaults || {};
      const effectiveModels = models.effective || {};
      if ($("tenantAuthTenantId")) $("tenantAuthTenantId").value = tenant.id || "";
      if ($("tenantAuthTenantName")) $("tenantAuthTenantName").value = tenant.name || "";
      if ($("tenantAuthMode")) $("tenantAuthMode").value = tenant.authMode || "sso_plus_password";
      if ($("tenantAnswerProvider")) $("tenantAnswerProvider").value = configuredModels.answerProvider || "";
      if ($("tenantAnswerModel")) $("tenantAnswerModel").value = configuredModels.answerModel || "";
      if ($("tenantBooleanAskProvider")) $("tenantBooleanAskProvider").value = configuredModels.booleanAskProvider || "";
      if ($("tenantBooleanAskModel")) $("tenantBooleanAskModel").value = configuredModels.booleanAskModel || "";
      if ($("tenantReflectProvider")) $("tenantReflectProvider").value = configuredModels.reflectProvider || "";
      if ($("tenantReflectModel")) $("tenantReflectModel").value = configuredModels.reflectModel || "";
      if ($("tenantCompactProvider")) $("tenantCompactProvider").value = configuredModels.compactProvider || "";
      if ($("tenantCompactModel")) $("tenantCompactModel").value = configuredModels.compactModel || "";
      if ($("tenantEmbedProvider")) $("tenantEmbedProvider").value = effectiveModels.embedProvider || "";
      if ($("tenantEmbedModel")) $("tenantEmbedModel").value = effectiveModels.embedModel || "";
      syncGenerationModelList("tenantGenerationModels", configuredModels.answerProvider || effectiveModels.answerProvider || "");
      if ($("tenantAnswerModel")) $("tenantAnswerModel").placeholder = instanceDefaults.answerModel || "blank = instance default";
      if ($("tenantBooleanAskModel")) $("tenantBooleanAskModel").placeholder = effectiveModels.answerModel || "blank = follow ask model";
      if ($("tenantReflectModel")) $("tenantReflectModel").placeholder = instanceDefaults.reflectModel || "blank = instance default";
      if ($("tenantCompactModel")) $("tenantCompactModel").placeholder = effectiveModels.reflectModel || "blank = follow reflect model";
      const providersRaw = tenant.ssoProviders;
      const providers = Array.isArray(providersRaw) ? providersRaw : ["google", "azure", "okta"];
      const allowed = new Set(providers);
      if ($("tenantSsoGoogle")) $("tenantSsoGoogle").checked = allowed.has("google");
      if ($("tenantSsoAzure")) $("tenantSsoAzure").checked = allowed.has("azure");
      if ($("tenantSsoOkta")) $("tenantSsoOkta").checked = allowed.has("okta");
      applyTenantSsoConfig(tenant.ssoConfig || {});
      if ($("ssoLoginTenant")) $("ssoLoginTenant").value = tenant.id || "";
      await loadTenantUsers({ quietSuccess: true });
      await loadSsoProviders();
      setBanner(banner, "ok", "Tenant settings loaded.");
    }else{
      const msg = resolveErrorMessage(data, "Failed to load tenant settings.");
      setBanner(banner, "err", msg);
    }
  }catch(e){
    setBanner(banner, "err", "Error loading tenant settings.");
  }finally{
    loadBtn.disabled = false;
    loadBtn.textContent = originalLabel;
  }
}

async function saveTenantSettings(){
  const banner = $("tenantAuthBanner");
  const saveBtn = $("tenantAuthSaveBtn");
  if (!banner || !saveBtn) return;
  clearBanner(banner);
  if (!requireKeyOrWarn(banner)) return;

  const authMode = $("tenantAuthMode") ? $("tenantAuthMode").value : "";
  if (!authMode){
    setBanner(banner, "err", "Select an auth mode.");
    return;
  }
  const ssoProviders = [];
  if ($("tenantSsoGoogle")?.checked) ssoProviders.push("google");
  if ($("tenantSsoAzure")?.checked) ssoProviders.push("azure");
  if ($("tenantSsoOkta")?.checked) ssoProviders.push("okta");
  const answerProvider = String($("tenantAnswerProvider")?.value || "").trim();
  const answerModel = String($("tenantAnswerModel")?.value || "").trim();
  const booleanAskProvider = String($("tenantBooleanAskProvider")?.value || "").trim();
  const booleanAskModel = String($("tenantBooleanAskModel")?.value || "").trim();
  const reflectProvider = String($("tenantReflectProvider")?.value || "").trim();
  const reflectModel = String($("tenantReflectModel")?.value || "").trim();
  const compactProvider = String($("tenantCompactProvider")?.value || "").trim();
  const compactModel = String($("tenantCompactModel")?.value || "").trim();
  let ssoConfig;
  try{
    ssoConfig = collectTenantSsoConfig();
  }catch(err){
    setBanner(banner, "err", String(err.message || err));
    return;
  }

  saveBtn.disabled = true;
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = "Saving...";

  try{
    const res = await fetch("/v1/admin/tenant", {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify({
        authMode,
        ssoProviders,
        ssoConfig,
        models: {
          answerProvider: answerProvider || null,
          answerModel: answerModel || null,
          booleanAskProvider: booleanAskProvider || null,
          booleanAskModel: booleanAskModel || null,
          reflectProvider: reflectProvider || null,
          reflectModel: reflectModel || null,
          compactProvider: compactProvider || null,
          compactModel: compactModel || null
        }
      })
    });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      setBanner(banner, "err", authRejectedMessage);
      return;
    }
    if (res.ok && data?.ok && data.data?.tenant){
      const tenant = data.data.tenant;
      const models = tenant.models || {};
      const configuredModels = models.configured || {};
      const instanceDefaults = models.instanceDefaults || {};
      const effectiveModels = models.effective || {};
      if ($("tenantAuthTenantId")) $("tenantAuthTenantId").value = tenant.id || "";
      if ($("tenantAuthTenantName")) $("tenantAuthTenantName").value = tenant.name || "";
      if ($("tenantAuthMode")) $("tenantAuthMode").value = tenant.authMode || authMode;
      if ($("tenantAnswerProvider")) $("tenantAnswerProvider").value = configuredModels.answerProvider || "";
      if ($("tenantAnswerModel")) $("tenantAnswerModel").value = configuredModels.answerModel || "";
      if ($("tenantBooleanAskProvider")) $("tenantBooleanAskProvider").value = configuredModels.booleanAskProvider || "";
      if ($("tenantBooleanAskModel")) $("tenantBooleanAskModel").value = configuredModels.booleanAskModel || "";
      if ($("tenantReflectProvider")) $("tenantReflectProvider").value = configuredModels.reflectProvider || "";
      if ($("tenantReflectModel")) $("tenantReflectModel").value = configuredModels.reflectModel || "";
      if ($("tenantCompactProvider")) $("tenantCompactProvider").value = configuredModels.compactProvider || "";
      if ($("tenantCompactModel")) $("tenantCompactModel").value = configuredModels.compactModel || "";
      if ($("tenantEmbedProvider")) $("tenantEmbedProvider").value = effectiveModels.embedProvider || "";
      if ($("tenantEmbedModel")) $("tenantEmbedModel").value = effectiveModels.embedModel || "";
      syncGenerationModelList("tenantGenerationModels", configuredModels.answerProvider || effectiveModels.answerProvider || "");
      if ($("tenantAnswerModel")) $("tenantAnswerModel").placeholder = instanceDefaults.answerModel || "blank = instance default";
      if ($("tenantBooleanAskModel")) $("tenantBooleanAskModel").placeholder = effectiveModels.answerModel || "blank = follow ask model";
      if ($("tenantReflectModel")) $("tenantReflectModel").placeholder = instanceDefaults.reflectModel || "blank = instance default";
      if ($("tenantCompactModel")) $("tenantCompactModel").placeholder = effectiveModels.reflectModel || "blank = follow reflect model";
      applyTenantSsoConfig(tenant.ssoConfig || {});
      if ($("ssoLoginTenant")) $("ssoLoginTenant").value = tenant.id || "";
      await loadSsoProviders();
      setBanner(banner, "ok", "Tenant settings updated.");
    }else{
      const msg = resolveErrorMessage(data, "Failed to update tenant settings.");
      setBanner(banner, "err", msg);
    }
  }catch(e){
    setBanner(banner, "err", "Error updating tenant settings.");
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

async function loadTenantUsers(options = {}){
  const banner = $("tenantAuthBanner");
  const loadBtn = $("tenantUsersLoadBtn");
  if (!banner) return [];
  if (!requireKeyOrWarn(banner)) return [];

  const quietSuccess = options.quietSuccess === true;
  if (loadBtn) {
    loadBtn.disabled = true;
    loadBtn.dataset.originalLabel = loadBtn.textContent;
    loadBtn.textContent = "Loading...";
  }

  try{
    const res = await fetch("/v1/admin/users", { headers: apiHeaders() });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      renderTenantUsers([]);
      setBanner(banner, "err", authRejectedMessage);
      return [];
    }
    if (res.ok && data?.ok && Array.isArray(data.data?.users)){
      renderTenantUsers(data.data.users);
      if (!quietSuccess) setBanner(banner, "ok", "Tenant users loaded.");
      return data.data.users;
    }
    renderTenantUsers([]);
    if (!quietSuccess) setBanner(banner, "err", resolveErrorMessage(data, "Failed to load tenant users."));
    return [];
  }catch(_err){
    renderTenantUsers([]);
    if (!quietSuccess) setBanner(banner, "err", "Error loading tenant users.");
    return [];
  }finally{
    if (loadBtn) {
      loadBtn.disabled = false;
      loadBtn.textContent = loadBtn.dataset.originalLabel || "Load tenant users";
      delete loadBtn.dataset.originalLabel;
    }
  }
}

async function createTenantUserFromForm(){
  const banner = $("tenantAuthBanner");
  const createBtn = $("tenantUserCreateBtn");
  if (!banner || !createBtn) return;
  clearBanner(banner);
  if (!requireKeyOrWarn(banner)) return;

  const username = String($("tenantUserCreateUsername")?.value || "").trim();
  const password = String($("tenantUserCreatePassword")?.value || "");
  const email = String($("tenantUserCreateEmail")?.value || "").trim();
  const fullName = String($("tenantUserCreateFullName")?.value || "").trim();
  const roles = splitCommaList($("tenantUserCreateRoles")?.value || "");
  const ssoOnly = Boolean($("tenantUserCreateSsoOnly")?.checked);

  if (!username){
    setBanner(banner, "err", "Username is required.");
    return;
  }
  if (!password || password.length < 8){
    setBanner(banner, "err", "Password must be at least 8 characters.");
    return;
  }

  createBtn.disabled = true;
  const originalLabel = createBtn.textContent;
  createBtn.textContent = "Creating...";

  try{
    const res = await fetch("/v1/admin/users", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ username, password, email, fullName, roles, ssoOnly })
    });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      setBanner(banner, "err", authRejectedMessage);
      return;
    }
    if (res.ok && data?.ok && data.data?.user){
      if ($("tenantUserCreateUsername")) $("tenantUserCreateUsername").value = "";
      if ($("tenantUserCreatePassword")) $("tenantUserCreatePassword").value = "";
      if ($("tenantUserCreateEmail")) $("tenantUserCreateEmail").value = "";
      if ($("tenantUserCreateFullName")) $("tenantUserCreateFullName").value = "";
      if ($("tenantUserCreateRoles")) $("tenantUserCreateRoles").value = "";
      if ($("tenantUserCreateSsoOnly")) $("tenantUserCreateSsoOnly").checked = false;
      await loadTenantUsers({ quietSuccess: true });
      setBanner(banner, "ok", "Tenant user created.");
      return;
    }
    setBanner(banner, "err", resolveErrorMessage(data, "Failed to create tenant user."));
  }catch(_err){
    setBanner(banner, "err", "Error creating tenant user.");
  }finally{
    createBtn.disabled = false;
    createBtn.textContent = originalLabel;
  }
}

async function saveTenantUser(userId){
  const banner = $("tenantAuthBanner");
  if (!banner) return;
  clearBanner(banner);
  if (!requireKeyOrWarn(banner)) return;

  const cleanId = parseInt(String(userId || ""), 10);
  if (!Number.isInteger(cleanId) || cleanId <= 0){
    setBanner(banner, "err", "Invalid tenant user id.");
    return;
  }

  const saveBtn = document.querySelector(`button[data-tenant-user-save="${cleanId}"]`);
  const body = {
    roles: splitCommaList($(`tenantUserRoles_${cleanId}`)?.value || ""),
    fullName: String($(`tenantUserFullName_${cleanId}`)?.value || "").trim(),
    email: String($(`tenantUserEmail_${cleanId}`)?.value || "").trim(),
    disabled: Boolean($(`tenantUserDisabled_${cleanId}`)?.checked),
    ssoOnly: Boolean($(`tenantUserSsoOnly_${cleanId}`)?.checked)
  };
  const password = String($(`tenantUserPassword_${cleanId}`)?.value || "");
  if (password) body.password = password;

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.dataset.originalLabel = saveBtn.textContent;
    saveBtn.textContent = "Saving...";
  }

  try{
    const res = await fetch(`/v1/admin/users/${encodeURIComponent(cleanId)}`, {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify(body)
    });
    const data = await parseResponsePayload(res);
    if (res.status === 401){
      noteUnauthorized(data);
      setBanner(banner, "err", authRejectedMessage);
      return;
    }
    if (res.ok && data?.ok && data.data?.user){
      if ($(`tenantUserPassword_${cleanId}`)) $(`tenantUserPassword_${cleanId}`).value = "";
      await loadTenantUsers({ quietSuccess: true });
      setBanner(banner, "ok", "Tenant user updated.");
      return;
    }
    setBanner(banner, "err", resolveErrorMessage(data, "Failed to update tenant user."));
  }catch(_err){
    setBanner(banner, "err", "Error updating tenant user.");
  }finally{
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtn.dataset.originalLabel || "Save";
      delete saveBtn.dataset.originalLabel;
    }
  }
}

async function loadSsoProviders(){
  const statusEl = $("ssoProvidersStatus");
  const tenantId = String($("ssoLoginTenant")?.value || "").trim();
  setSsoLoginButtonsEnabled({});
  if (statusEl) statusEl.textContent = "Checking SSO provider availability...";

  try{
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
    const res = await fetch(`/v1/auth/providers${query}`);
    const data = await parseResponsePayload(res);
    if (!res.ok || !data?.ok){
      if (statusEl) statusEl.textContent = resolveErrorMessage(data, "Failed to load SSO provider status.");
      return null;
    }

    const authMode = String(data.authMode || "sso_plus_password");
    const providers = data.providers && typeof data.providers === "object" ? data.providers : {};
    const enabledStates = {};
    Object.entries(TENANT_SSO_PROVIDER_META).forEach(([provider, meta]) => {
      const info = providers[provider] || {};
      enabledStates[provider] = Boolean(info.enabled);
      const btn = $(meta.loginButtonId);
      if (!btn) return;
      btn.disabled = !info.enabled;
      btn.title = describeSsoProviderStatus(provider, info);
    });
    setSsoLoginButtonsEnabled(enabledStates);

    if (statusEl) {
      if (authMode === "password_only") {
        statusEl.textContent = "This tenant is password-only. Enable SSO in tenant settings before starting enterprise sign-in.";
      } else {
        const parts = Object.keys(TENANT_SSO_PROVIDER_META).map((provider) => describeSsoProviderStatus(provider, providers[provider] || {}));
        statusEl.textContent = parts.join(" | ");
      }
    }
    return data;
  }catch(_err){
    if (statusEl) statusEl.textContent = "Error loading SSO provider status.";
    return null;
  }
}

function startSsoLogin(provider){
  const cleanProvider = String(provider || "").trim().toLowerCase();
  if (!TENANT_SSO_PROVIDER_META[cleanProvider]) return;
  const tenantId = String($("ssoLoginTenant")?.value || "").trim();
  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  window.location.href = `/auth/${encodeURIComponent(cleanProvider)}/login${query}`;
}

window.addEventListener("DOMContentLoaded", async () => {
  const footerYearEl = $("footerYear");
  if (footerYearEl) {
    footerYearEl.textContent = String(new Date().getFullYear());
  }

  const footerDateEl = $("footerDate");
  const renderFooterDate = () => {
    if (!footerDateEl) return;
    footerDateEl.textContent = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(new Date());
  };
  const scheduleFooterDateRefresh = () => {
    if (!footerDateEl) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 5, 0);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    window.setTimeout(() => {
      renderFooterDate();
      scheduleFooterDateRefresh();
    }, delay);
  };
  renderFooterDate();
  scheduleFooterDateRefresh();

  initTheme();
  await loadRuntimeUiConfig();
  if (runtimeUiConfig.deploymentMode === "hosted") {
    await loadRegisterOptions();
  }
  initDocTabs();
  expandDocsSections();
  initDocsHashNavigation();
  initDocsAgentConnect();
  initDocsCopyButtons();
  loadModelCatalog();
  if ($("askProvider")) {
    $("askProvider").onchange = () => syncGenerationModelList("askGenerationModels", $("askProvider").value || "");
  }
  if ($("tenantAnswerProvider")) {
    $("tenantAnswerProvider").onchange = () => syncGenerationModelList("tenantGenerationModels", $("tenantAnswerProvider").value || "");
  }
  $("tabPlayground").onclick = () => showPage("pagePlayground");
  $("tabMetrics").onclick = () => showPage("pageMetrics");
  $("tabUsage").onclick = () => showPage("pageUsage");
  $("tabDocs").onclick = () => {
    showPage("pageDocs");
    const cleanHash = decodeURIComponent(String(window.location.hash || "").replace(/^#/, "").trim()).toLowerCase();
    if (isDocsSelectionHash(cleanHash) || isDocsLandingHash(cleanHash)) {
      syncDocsPanelFromHash(window.location.hash);
    } else {
      docsSubmenuVisible = true;
      activateDocPanel("docs", "core");
      syncDocsMenuLinksFromHash(window.location.hash);
    }
  };
  $("tabSettings").onclick = () => showPage("pageSettings");
  $("tabProduct").onclick = () => showPage("pageProduct");
  $("playTabIngest").onclick = () => showPlayPane("playPaneIngest");
  $("playTabSearch").onclick = () => showPlayPane("playPaneSearch");
  $("playTabAsk").onclick = () => showPlayPane("playPaneAsk");

  if (!openPageFromHash({ smooth: false })) {
    showPage("pageProduct");
  }
  window.addEventListener("hashchange", () => {
    openPageFromHash({ smooth: true });
  });

  refreshHealth();
  setInterval(refreshHealth, 12000);

  const auth = loadStoredAuth();
  $("apiKey").value = auth.token;
  if ($("authType")) $("authType").value = auth.type || "bearer";
  if ($("openAiApiKeyOverride")) $("openAiApiKeyOverride").value = loadStoredProviderOverride("openai");
  if ($("geminiApiKeyOverride")) $("geminiApiKeyOverride").value = loadStoredProviderOverride("gemini");
  if ($("anthropicApiKeyOverride")) $("anthropicApiKeyOverride").value = loadStoredProviderOverride("anthropic");

  // Auto-save service token on paste/input (debounced 600 ms) — no button required
  let _apiKeySaveTimer = null;
  $("apiKey").addEventListener("input", () => {
    const badge = $("apiKeySavedBadge");
    if (badge) badge.style.display = "none";
    clearTimeout(_apiKeySaveTimer);
    _apiKeySaveTimer = setTimeout(() => {
      const val = $("apiKey").value.trim();
      if (!val) return;
      // Detect type: service tokens start with "supav_" or are long hex strings; otherwise treat as bearer JWT
      const type = (val.startsWith("supav_") || (!val.includes(".") && val.length > 32)) ? "api_key" : "bearer";
      saveStoredAuth(type, val);
      if ($("authType")) $("authType").value = type;
      if (badge) { badge.style.display = "inline"; setTimeout(() => { if (badge) badge.style.display = "none"; }, 2500); }
      loadDocsList();
      loadCollectionScopeOptions();
    }, 600);
  });

  // Show / hide toggle for the token field
  if ($("apiKeyToggleBtn")) {
    $("apiKeyToggleBtn").addEventListener("click", () => {
      const input = $("apiKey");
      const revealing = input.type === "password";
      input.type = revealing ? "text" : "password";
      $("apiKeyToggleBtn").textContent = revealing ? "Hide" : "Show";
    });
  }

  if ($("saveKeyBtn")) {
    $("saveKeyBtn").onclick = () => {
      const authType = $("authType") ? $("authType").value : "bearer";
      const key = $("apiKey").value.trim();
      if (!key){
        setBanner($("settingsBanner"), "err", "Please paste a token first.");
        return;
      }
      saveStoredAuth(authType, key);
      setBanner($("settingsBanner"), "ok", "Saved. You can now Index, Search, and Ask.");
      loadDocsList();
      loadCollectionScopeOptions();
    };
  }

  if ($("registerRefreshBtn")) {
    $("registerRefreshBtn").onclick = () => loadRegisterOptions();
  }

  if ($("registerCreateBtn")) {
    $("registerCreateBtn").onclick = async () => {
      clearBanner($("registerBanner"));
      clearBanner($("settingsBanner"));
      const username = $("registerUsername")?.value?.trim() || "";
      const projectName = $("registerProjectNameInput")?.value?.trim() || "";
      const fullName = $("registerFullName")?.value?.trim() || "";
      const email = $("registerEmail")?.value?.trim() || "";
      const password = $("registerPassword")?.value || "";
      const confirmPassword = $("registerPasswordConfirm")?.value || "";

      if (!username || !password) {
        setBanner($("registerBanner"), "err", "Username and password are required.");
        return;
      }
      if (password !== confirmPassword) {
        setBanner($("registerBanner"), "err", "Password confirmation does not match.");
        return;
      }

      $("registerCreateBtn").disabled = true;
      $("registerCreateBtn").textContent = "Creating...";

      try{
        const res = await fetch("/v1/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            projectName,
            fullName,
            email,
            password,
            confirmPassword
          })
        });
        const payload = await parseResponsePayload(res);
        if (res.ok && payload?.ok && payload.data?.serviceToken?.token){
          const data = payload.data;
          const token = data.serviceToken.token;
          publishServiceTokenToUi(token, {
            project: data.project || data.tenant || null,
            instructions: data.instructions || buildRegisterInstructionsPayload(registerOptionsState?.baseUrl || window.location.origin)
          });
          saveServiceTokenIntoSettings(token);
          if ($("registerLoginUser")) $("registerLoginUser").value = username;
          if ($("registerProjectNameInput")) $("registerProjectNameInput").value = "";
          if ($("registerPassword")) $("registerPassword").value = "";
          if ($("registerPasswordConfirm")) $("registerPasswordConfirm").value = "";
          if ($("loginUser")) $("loginUser").value = username;
          if ($("apiKeyBanner")) {
            clearBanner($("apiKeyBanner"));
          }
          showSettingsSection("auth");
          showHostedTokenSection("hostedLatestToken");
          setBanner($("settingsBanner"), "ok", "Account created. Your new service token is saved for this browser and ready to use.");
          await loadRegisterOptions();
        }else{
          setBanner($("registerBanner"), "err", resolveErrorMessage(payload, "Registration failed."));
        }
      }catch(e){
        setBanner($("registerBanner"), "err", "Error creating account.");
      }finally{
        $("registerCreateBtn").disabled = Boolean(registerOptionsState && registerOptionsState.enabled === false);
        $("registerCreateBtn").textContent = "Create account, project, and token";
      }
    };
  }

  if ($("registerLoginBtn")) {
    $("registerLoginBtn").onclick = async () => {
      clearBanner($("settingsBanner"));
      const username = $("registerLoginUser")?.value?.trim() || "";
      const password = $("registerLoginPass")?.value || "";
      const tokenName = $("registerExistingTokenName")?.value?.trim() || `browser-${username || "token"}`;

      if (!username || !password) {
        setBanner($("settingsBanner"), "err", "Username and password are required.");
        return;
      }

      $("registerLoginBtn").disabled = true;
      $("registerLoginBtn").textContent = "Signing in...";

      try{
        const loginRes = await fetch("/v1/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const loginPayload = await parseResponsePayload(loginRes);
        const jwtToken = loginPayload?.data?.token || "";
        if (!loginRes.ok || !loginPayload?.ok || !jwtToken) {
          setBanner($("settingsBanner"), "err", resolveErrorMessage(loginPayload, "Authentication failed."));
          return;
        }

        const tenant = await loadTenantSummaryWithJwt(jwtToken);
        const mintBody = {
          name: tokenName,
          principalId: username,
          roles: ["admin", "indexer", "reader"]
        };
        const { res: mintRes, payload: mintPayload } = await mintServiceTokenWithJwt(jwtToken, mintBody);
        if (mintRes.ok && mintPayload?.ok && mintPayload.data?.token){
          const token = mintPayload.data.token;
          publishServiceTokenToUi(token, {
            project: tenant
              ? { id: tenant.id || "", name: tenant.name || "" }
              : { id: loginPayload?.data?.user?.tenant || "", name: "" },
            instructions: buildRegisterInstructionsPayload(registerOptionsState?.baseUrl || window.location.origin)
          });
          saveServiceTokenIntoSettings(token, {
            bannerEl: $("settingsBanner"),
            message: "Authenticated and created a fresh service token. This browser now uses that service token."
          });
          if ($("loginUser")) $("loginUser").value = username;
          if ($("registerLoginPass")) $("registerLoginPass").value = "";
          showSettingsSection("auth");
          showHostedTokenSection("hostedLatestToken");
          return;
        }

        saveStoredAuth("bearer", jwtToken);
        if ($("authType")) $("authType").value = "bearer";
        if ($("apiKey")) $("apiKey").value = jwtToken;
        loadDocsList();
        loadCollectionScopeOptions();
        setBanner($("settingsBanner"), "err", `${resolveErrorMessage(mintPayload, "Authenticated, but failed to create a service token.")} A JWT was saved instead.`);
      }catch(_err){
        setBanner($("settingsBanner"), "err", "Error authenticating account.");
      }finally{
        $("registerLoginBtn").disabled = false;
        $("registerLoginBtn").textContent = "Sign in and create token";
      }
    };
  }

  if ($("useRegisterTokenBtn")) {
    $("useRegisterTokenBtn").onclick = () => {
      const token = $("useRegisterTokenBtn").dataset.token;
      if (!token){
        setBanner($("settingsBanner"), "err", "No service token to use yet.");
        return;
      }
      saveServiceTokenIntoSettings(token, {
        bannerEl: $("settingsBanner"),
        message: "Service token saved for this browser. You can now use it from this page."
      });
    };
  }

  if ($("copyRegisterTokenBtn")) {
    $("copyRegisterTokenBtn").onclick = async () => {
      const token = $("copyRegisterTokenBtn").dataset.token;
      if (!token){
        setBanner($("settingsBanner"), "err", "No service token to copy yet.");
        return;
      }
      try{
        await copyTextToClipboard(token);
        setBanner($("settingsBanner"), "ok", "Service token copied to clipboard.");
      }catch(_err){
        setBanner($("settingsBanner"), "err", "Failed to copy service token.");
      }
    };
  }

  $("loginBtn").onclick = async () => {
    clearBanner($("settingsBanner"));
    const username = $("loginUser").value.trim();
    const password = $("loginPass").value;

    if (!username || !password) {
      setBanner($("settingsBanner"), "err", "Please enter username and password.");
      return;
    }

    $("loginBtn").disabled = true;
    $("loginBtn").textContent = "Logging in...";

    try{
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.token){
        saveStoredAuth("bearer", data.token);
        $("apiKey").value = data.token;
        if ($("authType")) $("authType").value = "bearer";
        $("loginPass").value = "";
        setBanner($("settingsBanner"), "ok", "Token saved. You can now Index, Search, and Ask.");
        loadDocsList();
        loadCollectionScopeOptions();
      }else{
        setBanner($("settingsBanner"), "err", data.error || "Login failed.");
      }
    }catch(e){
      setBanner($("settingsBanner"), "err", "Error: " + e);
    }finally{
      $("loginBtn").disabled = false;
      $("loginBtn").textContent = "Login and Save Token";
    }
  };

  $("clearKeyBtn").onclick = () => {
    clearStoredAuth();
    $("apiKey").value = "";
    if ($("authType")) $("authType").value = "bearer";
    setBanner($("settingsBanner"), "ok", "Removed saved token.");
    setDocsStatus("Save a token to load docs.");
    setDocOptions([]);
    setCollectionScopeOptions([]);
  };

  if ($("saveProviderOverridesBtn")) {
    $("saveProviderOverridesBtn").onclick = () => {
      const bannerEl = $("providerOverridesBanner") || $("settingsBanner");
      const openAiValue = $("openAiApiKeyOverride")?.value?.trim() || "";
      const geminiValue = $("geminiApiKeyOverride")?.value?.trim() || "";
      const anthropicValue = $("anthropicApiKeyOverride")?.value?.trim() || "";
      if (!openAiValue && !geminiValue && !anthropicValue) {
        setBanner(bannerEl, "err", "Paste at least one provider key first.");
        return;
      }
      saveStoredProviderOverride("openai", openAiValue);
      saveStoredProviderOverride("gemini", geminiValue);
      saveStoredProviderOverride("anthropic", anthropicValue);
      setBanner(bannerEl, "ok", "Saved provider key overrides. Supavector requests from this browser will send the matching provider header when needed.");
    };
  }

  if ($("clearProviderOverridesBtn")) {
    $("clearProviderOverridesBtn").onclick = () => {
      const bannerEl = $("providerOverridesBanner") || $("settingsBanner");
      clearStoredProviderOverrides();
      if ($("openAiApiKeyOverride")) $("openAiApiKeyOverride").value = "";
      if ($("geminiApiKeyOverride")) $("geminiApiKeyOverride").value = "";
      if ($("anthropicApiKeyOverride")) $("anthropicApiKeyOverride").value = "";
      setBanner(bannerEl, "ok", "Removed saved provider key overrides.");
    };
  }

  $("createApiKeyBtn").onclick = async () => {
    clearBanner($("apiKeyBanner"));
    $("copyCreatedApiKeyBtn").disabled = true;
    $("useCreatedApiKeyBtn").disabled = true;
    const auth = loadStoredAuth();
    if (!auth.token){
      setBanner($("apiKeyBanner"), "err", "Save a token first (admin required).");
      return;
    }

    const name = $("apiKeyName").value.trim();
    if (!name){
      setBanner($("apiKeyBanner"), "err", "Service token name is required.");
      return;
    }

    const principalId = $("apiKeyPrincipal").value.trim();
    const rolesRaw = $("apiKeyRoles").value.trim();
    const roles = rolesRaw
      ? rolesRaw.split(",").map(r => r.trim()).filter(Boolean)
      : [];
    const expiresRaw = $("apiKeyExpires").value;
    let expiresAt = null;
    if (expiresRaw){
      const dt = new Date(expiresRaw);
      if (Number.isNaN(dt.getTime())){
        setBanner($("apiKeyBanner"), "err", "Invalid expiration date.");
        return;
      }
      expiresAt = dt.toISOString();
    }

    const body = { name };
    if (principalId) body.principalId = principalId;
    if (roles.length) body.roles = roles;
    if (expiresAt) body.expiresAt = expiresAt;

    $("createApiKeyBtn").disabled = true;
    $("createApiKeyBtn").textContent = "Creating...";

    try{
      const res = await fetch("/v1/admin/service-tokens", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok && data.ok && data.data?.token){
        const token = data.data.token;
        publishServiceTokenToUi(token, {
          instructions: buildRegisterInstructionsPayload(registerOptionsState?.baseUrl || window.location.origin)
        });
        setBanner($("apiKeyBanner"), "ok", "Service token created. Save it now.");
      }else{
        const msg = data?.error?.message || data?.error || "Failed to create service token.";
        setBanner($("apiKeyBanner"), "err", msg);
      }
    }catch(e){
      setBanner($("apiKeyBanner"), "err", "Error creating service token.");
    }finally{
      $("createApiKeyBtn").disabled = false;
      $("createApiKeyBtn").textContent = "Create service token";
    }
  };

  $("useCreatedApiKeyBtn").onclick = () => {
    const token = $("useCreatedApiKeyBtn").dataset.token;
    if (!token){
      setBanner($("apiKeyBanner"), "err", "No service token to use yet.");
      return;
    }
    saveServiceTokenIntoSettings(token, {
      bannerEl: $("apiKeyBanner"),
      message: "Service token saved. You can now Index, Search, and Ask."
    });
  };

  $("copyCreatedApiKeyBtn").onclick = async () => {
    const token = $("copyCreatedApiKeyBtn").dataset.token;
    if (!token){
      setBanner($("apiKeyBanner"), "err", "No service token to copy yet.");
      return;
    }
    try{
      await copyTextToClipboard(token);
      setBanner($("apiKeyBanner"), "ok", "Service token copied to clipboard.");
    }catch(e){
      setBanner($("apiKeyBanner"), "err", "Failed to copy service token.");
    }
  };

  if ($("tenantAuthLoadBtn")) {
    $("tenantAuthLoadBtn").onclick = () => loadTenantSettings();
  }
  if ($("tenantAuthSaveBtn")) {
    $("tenantAuthSaveBtn").onclick = () => saveTenantSettings();
  }
  if ($("tenantUsersLoadBtn")) {
    $("tenantUsersLoadBtn").onclick = () => loadTenantUsers();
  }
  if ($("tenantUserCreateBtn")) {
    $("tenantUserCreateBtn").onclick = () => createTenantUserFromForm();
  }
  if ($("ssoProvidersLoadBtn")) {
    $("ssoProvidersLoadBtn").onclick = () => loadSsoProviders();
  }
  if ($("ssoLoginGoogleBtn")) {
    $("ssoLoginGoogleBtn").onclick = () => startSsoLogin("google");
  }
  if ($("ssoLoginAzureBtn")) {
    $("ssoLoginAzureBtn").onclick = () => startSsoLogin("azure");
  }
  if ($("ssoLoginOktaBtn")) {
    $("ssoLoginOktaBtn").onclick = () => startSsoLogin("okta");
  }
  const tenantTabBtn = document.querySelector('.doc-tabs[data-doc-tabs="settings"] .doc-tab[data-doc-tab="tenant"]');
  if (tenantTabBtn){
    tenantTabBtn.addEventListener("click", () => loadTenantSettings());
  }

  $("indexClearBtn").onclick = () => {
    $("docId").value = "";
    $("docText").value = "";
    $("docUrl").value = "";
    $("docFile").value = "";
    $("indexRaw").textContent = "(no output)";
    clearBanner($("indexBanner"));
  };

  if ($("searchCollectionScope")) {
    $("searchCollectionScope").addEventListener("focus", () => {
      loadCollectionScopeOptions();
    });
  }
  if ($("askCollectionScope")) {
    $("askCollectionScope").addEventListener("focus", () => {
      loadCollectionScopeOptions();
    });
  }

  $("docUrl").addEventListener("blur", () => {
    if ($("docId").value.trim()) return;
    const suggested = suggestDocIdFromUrl($("docUrl").value.trim());
    if (suggested) $("docId").value = suggested;
  });

  const collectionInput = $("playCollection");
  if (collectionInput){
    collectionInput.addEventListener("blur", () => {
      collectionInput.value = normalizeCollectionName(collectionInput.value);
    });
    collectionInput.addEventListener("change", () => {
      collectionInput.value = normalizeCollectionName(collectionInput.value);
      loadDocsList();
    });
  }

  $("docFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      setBanner($("indexBanner"), "err", `File too large. Max size is ${formatBytes(MAX_UPLOAD_FILE_BYTES)}.`);
      return;
    }

    const uploadType = detectUploadFileType(file);
    try{
      let text = "";
      if (uploadType === "pdf") {
        setBanner($("indexBanner"), "ok", `Extracting text from PDF "${file.name}"...`);
        text = await extractTextFromPdfFile(file);
      } else if (uploadType === "docx") {
        setBanner($("indexBanner"), "ok", `Extracting text from Word file "${file.name}"...`);
        text = await extractTextFromDocxFile(file);
      } else if (uploadType === "doc") {
        throw new Error("Legacy .doc is not supported. Save as .docx and upload again.");
      } else {
        text = normalizeExtractedText(await file.text());
      }

      if (!text.trim()) {
        throw new Error("No extractable text found in file.");
      }

      $("docText").value = text;

      if (!$("docId").value.trim()) {
        const suggested = suggestDocIdFromFilename(file.name) || "upload";
        $("docId").value = suggested;
      }

      const kindLabel = uploadType === "pdf"
        ? "PDF"
        : (uploadType === "docx" ? "Word (.docx)" : "text");
      setBanner($("indexBanner"), "ok", `Loaded ${kindLabel} file "${file.name}" (${text.length} chars).`);
    }catch(e){
      setBanner($("indexBanner"), "err", "Failed to read file: " + e);
    }
  });

  $("indexBtn").onclick = async () => {
    clearBanner($("indexBanner"));
    if (!requireKeyOrWarn($("indexBanner"))) return;

    const collection = getPlaygroundCollection({ bannerEl: $("indexBanner") });
    if (!collection) return;

    let docId = $("docId").value.trim();
    const text = $("docText").value.trim();
    const url = $("docUrl").value.trim();

    if (!docId && url) {
      docId = suggestDocIdFromUrl(url);
      if (docId) $("docId").value = docId;
    }

    if (!docId){
      setBanner($("indexBanner"), "err", "Please provide a Doc ID.");
      return;
    }
    if (!isValidDocId(docId)){
      setBanner($("indexBanner"), "err", "Doc ID must use only letters, numbers, dot, dash, or underscore (no spaces).");
      return;
    }

    $("indexBtn").disabled = true;
    $("indexBtn").textContent = "Indexing...";

    try{
      let res;
      if (url){
        res = await fetch("/docs/url", {
          method:"POST",
          headers: apiHeaders(),
          body: JSON.stringify({ docId, url, collection })
        });
      }else{
        if (!text.trim()){
          setBanner($("indexBanner"), "err", "Paste text or provide a URL.");
          return;
        }
        res = await fetch("/docs", {
          method:"POST",
          headers: apiHeaders(),
          body: JSON.stringify({ docId, text, collection })
        });
      }

      const data = await res.json();
      $("indexRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.ok){
        const extra = data.truncated || data.docTruncated ? " (truncated)" : "";
        const sourceLabel = url ? " from URL" : "";
        setBanner($("indexBanner"), "ok", `Indexed "${docId}"${sourceLabel} in "${collection}"${extra} (${data.chunksIndexed} chunks).`);
        showPage("pagePlayground");
        showPlayPane("playPaneSearch");
        loadDocsList();
        loadCollectionScopeOptions();
      }else{
        setBanner($("indexBanner"), "err", data.error || "Index failed.");
      }
    }catch(e){
      setBanner($("indexBanner"), "err", "Error: " + e);
    }finally{
      $("indexBtn").disabled = false;
      $("indexBtn").textContent = "Index content";
    }
  };

  $("searchClearBtn").onclick = () => {
    $("searchCards").innerHTML = "";
    $("searchRaw").textContent = "(no output)";
    if ($("searchPolicy")) $("searchPolicy").value = "amvl";
    clearBanner($("searchBanner"));
  };

  $("searchBtn").onclick = async () => {
    clearBanner($("searchBanner"));
    if (!requireKeyOrWarn($("searchBanner"))) return;

    const q = $("searchQ").value.trim();
    const k = parseInt($("searchK").value || "5", 10);
    const scope = String($("searchCollectionScope")?.value || "all").trim();
    const policy = normalizePolicy($("searchPolicy")?.value || "amvl");

    if (!q){
      setBanner($("searchBanner"), "err", "Please enter a search query.");
      return;
    }

    $("searchBtn").disabled = true;
    $("searchBtn").textContent = "Searching...";

    try{
      const effectiveCollection = scope === "all" ? null : scope;
      const collectionParam = effectiveCollection
        ? `&collection=${encodeURIComponent(effectiveCollection)}`
        : "&collectionScope=all";
      const res = await fetch(`/search?q=${encodeURIComponent(q)}&k=${k}${collectionParam}&policy=${encodeURIComponent(policy)}`, {
        headers: apiHeaders()
      });

      const data = await res.json();
      $("searchRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.results){
        const label = effectiveCollection || "all collections";
        setBanner($("searchBanner"), "ok", `Found ${data.results.length} result(s) in "${label}" (${policy.toUpperCase()}).`);
        renderSearch(data.results);
      }else{
        setBanner($("searchBanner"), "err", data.error || "Search failed.");
      }
    }catch(e){
      setBanner($("searchBanner"), "err", "Error: " + e);
    }finally{
      $("searchBtn").disabled = false;
      $("searchBtn").textContent = "Search";
    }
  };

  $("askClearBtn").onclick = () => {
    $("askAnswerCard").innerHTML = "";
    $("askRaw").textContent = "(no output)";
    if ($("askPolicy")) $("askPolicy").value = "amvl";
    if ($("askProvider")) $("askProvider").value = "";
    if ($("askModel")) $("askModel").value = "";
    syncGenerationModelList("askGenerationModels", $("askProvider")?.value || "");
    clearBanner($("askBanner"));
  };

  async function submitAsk(mode = "ask") {
    clearBanner($("askBanner"));
    if (!requireKeyOrWarn($("askBanner"))) return;

    const isBooleanAsk = mode === "boolean_ask";
    const question = $("askQ").value.trim();
    const k = parseInt($("askK").value || "7", 10);
    const scope = String($("askCollectionScope")?.value || "all").trim();
    const answerLength = String($("askAnswerLength")?.value || "auto").trim().toLowerCase();
    const policy = normalizePolicy($("askPolicy")?.value || "amvl");
    const provider = String($("askProvider")?.value || "").trim();
    const model = String($("askModel")?.value || "").trim();

    if (!question){
      setBanner($("askBanner"), "err", "Please enter a question.");
      return;
    }

    $("askBtn").disabled = true;
    if ($("askBooleanAskBtn")) $("askBooleanAskBtn").disabled = true;
    $("askBtn").textContent = isBooleanAsk ? "Generate answer" : "Thinking...";
    if ($("askBooleanAskBtn")) $("askBooleanAskBtn").textContent = isBooleanAsk ? "Checking..." : "True / False only";

    try{
      const body = { question, k };
      if (scope === "all"){
        body.collectionScope = "all";
      } else {
        body.collection = scope;
      }
      if (!isBooleanAsk && answerLength){
        body.answerLength = answerLength;
      }
      body.policy = policy;
      if (provider) body.provider = provider;
      if (model) body.model = model;

      const res = await fetch(isBooleanAsk ? "/boolean_ask" : "/ask", {
        method:"POST",
        headers: apiHeaders(),
        body: JSON.stringify(body)
      });

      const data = await res.json();
      $("askRaw").textContent = JSON.stringify(data, null, 2);

      if (res.ok && data.answer){
        const label = scope === "all" ? "all collections" : scope;
        const providerLabel = data.provider ? `, ${data.provider}` : "";
        const modelLabel = data.model ? ` / ${data.model}` : "";
        if (isBooleanAsk) {
          setBanner($("askBanner"), "ok", `Boolean answer generated from "${label}" (${policy.toUpperCase()}${providerLabel}${modelLabel}).`);
        } else {
          const lengthLabel = String(data.answerLength || answerLength || "auto").toUpperCase();
          setBanner($("askBanner"), "ok", `Answer generated from "${label}" (${lengthLabel}, ${policy.toUpperCase()}${providerLabel}${modelLabel}).`);
        }
        renderAnswer(data);
      }else{
        setBanner($("askBanner"), "err", data.error || (isBooleanAsk ? "Boolean ask request failed." : "Ask failed."));
      }
    }catch(e){
      setBanner($("askBanner"), "err", "Error: " + e);
    }finally{
      $("askBtn").disabled = false;
      if ($("askBooleanAskBtn")) $("askBooleanAskBtn").disabled = false;
      $("askBtn").textContent = "Generate answer";
      if ($("askBooleanAskBtn")) $("askBooleanAskBtn").textContent = "True / False only";
    }
  }

  $("askBtn").onclick = () => submitAsk("ask");
  if ($("askBooleanAskBtn")) {
    $("askBooleanAskBtn").onclick = () => submitAsk("boolean_ask");
  }

  $("statsClearBtn").onclick = () => {
    $("statsRaw").textContent = "(no output)";
    $("statsCards").innerHTML = "";
    $("statsUpdated").textContent = "-";
    clearBanner($("statsBanner"));
    metricsLoaded = false;
  };

  $("statsBtn").onclick = async () => {
    loadStats();
  };

  $("usageRefreshBtn").onclick = async () => {
    loadUsage();
  };

  $("jobFetchBtn").onclick = () => {
    const id = $("jobIdInput").value.trim();
    if (!id) {
      fetchInProgressJobs();
      return;
    }
    fetchJobById(id);
  };

  $("jobListBtn").onclick = () => {
    fetchInProgressJobs();
  };

  $("tabJobs").onclick = () => {
    showPage("pageJobs");
    fetchInProgressJobs();
  };

  $("collectionsRefreshBtn").onclick = () => {
    fetchCollections();
  };

  $("tabCollections").onclick = () => {
    showPage("pageCollections");
    fetchCollections();
  };

  loadDocsList();
  loadCollectionScopeOptions();
});
