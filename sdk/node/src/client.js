class SupaVectorClient {
  constructor(options = {}) {
    const baseUrl = options.baseUrl || "http://localhost:3000";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = options.token || null;
    this.apiKey = options.apiKey || null;
    this.openAiApiKey = options.openAiApiKey || null;
    this.geminiApiKey = options.geminiApiKey || null;
    this.anthropicApiKey = options.anthropicApiKey || null;
    this.tenantId = options.tenantId || null;
    this.collection = options.collection || null;
    this.principalId = options.principalId || null;
  }

  setToken(token) {
    this.token = token;
  }

  setApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  setOpenAiApiKey(openAiApiKey) {
    this.openAiApiKey = openAiApiKey;
  }

  setGeminiApiKey(geminiApiKey) {
    this.geminiApiKey = geminiApiKey;
  }

  setAnthropicApiKey(anthropicApiKey) {
    this.anthropicApiKey = anthropicApiKey;
  }

  setProviderApiKey(provider, value) {
    const cleanProvider = String(provider || "").trim().toLowerCase();
    if (cleanProvider === "gemini") {
      this.geminiApiKey = value || null;
      return;
    }
    if (cleanProvider === "anthropic") {
      this.anthropicApiKey = value || null;
      return;
    }
    this.openAiApiKey = value || null;
  }

  setTenant(tenantId) {
    this.tenantId = tenantId;
  }

  setCollection(collection) {
    this.collection = collection;
  }

  setPrincipal(principalId) {
    this.principalId = principalId;
  }

  buildQuery(params = {}) {
    const query = { ...params };
    if (this.tenantId && query.tenantId === undefined) query.tenantId = this.tenantId;
    if (this.collection && query.collection === undefined) query.collection = this.collection;

    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        urlParams.set(key, value.join(","));
      } else {
        urlParams.set(key, String(value));
      }
    }
    const qs = urlParams.toString();
    return qs ? `?${qs}` : "";
  }

  buildBody(body = {}) {
    const payload = { ...body };
    if (this.tenantId && payload.tenantId === undefined) payload.tenantId = this.tenantId;
    if (this.collection && payload.collection === undefined) payload.collection = this.collection;
    if (this.principalId && payload.principalId === undefined) payload.principalId = this.principalId;
    return payload;
  }

  async request(path, options = {}) {
    const method = options.method || "GET";
    const auth = options.auth !== false;
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      if (this.apiKey) {
        headers["X-API-Key"] = this.apiKey;
      } else if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }
    }
    if (this.openAiApiKey) {
      headers["X-OpenAI-API-Key"] = this.openAiApiKey;
    }
    if (this.geminiApiKey) {
      headers["X-Gemini-API-Key"] = this.geminiApiKey;
    }
    if (this.anthropicApiKey) {
      headers["X-Anthropic-API-Key"] = this.anthropicApiKey;
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    const query = options.query ? this.buildQuery(options.query) : "";
    const url = `${this.baseUrl}${path}${query}`;

    const body = options.body ? JSON.stringify(this.buildBody(options.body)) : undefined;

    const res = await fetch(url, {
      method,
      headers,
      body
    });

    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const message = payload?.error?.message || payload?.error || res.statusText;
      const err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  async health() {
    return this.request("/v1/health", { auth: false });
  }

  async login(username, password) {
    const payload = await this.request("/v1/login", {
      method: "POST",
      auth: false,
      body: { username, password }
    });
    if (payload?.data?.token) this.token = payload.data.token;
    if (payload?.data?.user?.tenant) this.tenantId = payload.data.user.tenant;
    return payload;
  }

  async stats() {
    return this.request("/v1/stats");
  }

  async vectorRuntime() {
    return this.request("/v1/admin/vector/search-runtime");
  }

  async vectorReindex(params = {}) {
    return this.request("/v1/admin/vector/reindex", {
      method: "POST",
      body: params
    });
  }

  async getModels() {
    return this.request("/v1/models", { auth: false });
  }

  async models() {
    return this.getModels();
  }

  async listDocs(params = {}) {
    return this.request("/v1/docs", { query: params });
  }

  async listCollections(params = {}) {
    return this.request("/v1/collections", { query: params });
  }

  async indexText(docId, text, params = {}) {
    const { idempotencyKey, ...body } = params || {};
    return this.request("/v1/docs", {
      method: "POST",
      body: { docId, text, ...body },
      idempotencyKey
    });
  }

  async indexUrl(docId, url, params = {}) {
    const { idempotencyKey, ...body } = params || {};
    return this.request("/v1/docs/url", {
      method: "POST",
      body: { docId, url, ...body },
      idempotencyKey
    });
  }

  async deleteDoc(docId, params = {}) {
    return this.request(`/v1/docs/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      query: params
    });
  }

  async deleteCollection(collection, params = {}) {
    return this.request(`/v1/collections/${encodeURIComponent(collection)}`, {
      method: "DELETE",
      query: params
    });
  }

  async search(query, params = {}) {
    return this.request("/v1/search", {
      query: { q: query, ...params }
    });
  }

  async ask(question, params = {}) {
    return this.request("/v1/ask", {
      method: "POST",
      body: { question, ...params }
    });
  }

  async code(question, params = {}) {
    return this.request("/v1/code", {
      method: "POST",
      body: { question, ...params }
    });
  }

  async booleanAsk(question, params = {}) {
    return this.request("/v1/boolean_ask", {
      method: "POST",
      body: { question, ...params }
    });
  }

  async boolean_ask(question, params = {}) {
    return this.booleanAsk(question, params);
  }

  async memoryWrite(data) {
    const payload = data || {};
    const { idempotencyKey, ...body } = payload;
    return this.request("/v1/memory/write", {
      method: "POST",
      body,
      idempotencyKey
    });
  }

  async memoryRecall(data) {
    return this.request("/v1/memory/recall", {
      method: "POST",
      body: data
    });
  }

  async memoryReflect(data) {
    const payload = data || {};
    const { idempotencyKey, ...body } = payload;
    return this.request("/v1/memory/reflect", {
      method: "POST",
      body,
      idempotencyKey
    });
  }

  async memoryCleanup(data) {
    return this.request("/v1/memory/cleanup", {
      method: "POST",
      body: data
    });
  }

  async memoryCompact(data) {
    return this.request("/v1/memory/compact", {
      method: "POST",
      body: data
    });
  }

  async feedback(data) {
    return this.request("/v1/feedback", {
      method: "POST",
      body: data
    });
  }

  async getTenantSettings() {
    return this.request("/v1/admin/tenant");
  }

  async updateTenantSettings(data) {
    return this.request("/v1/admin/tenant", {
      method: "PATCH",
      body: data
    });
  }

  async getJob(id) {
    return this.request(`/v1/jobs/${id}`);
  }
}

module.exports = { SupaVectorClient };
