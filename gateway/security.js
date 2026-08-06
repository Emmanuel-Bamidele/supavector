//
//  security.js
//  SupaVector
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// security.js
// JWT auth + rate limiting (simple production protections)

const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { getServiceTokenByHash, recordServiceTokenUse } = require("./db");

function buildMeta() {
  return {
    tenantId: null,
    collection: null,
    timestamp: new Date().toISOString()
  };
}

function sendAuthError(res, status, message, req, code) {
  const path = req?.path || "";
  const errorCode = code || "AUTH_INVALID";
  if (path.startsWith("/v1")) {
    return res.status(status).json({
      ok: false,
      error: { message, code: errorCode },
      meta: buildMeta()
    });
  }
  return res.status(status).json({ error: message, code: errorCode, tenantId: null, collection: null });
}

function sendRateLimitError(res, req) {
  const path = req?.path || "";
  const message = "Rate limit exceeded";
  if (path.startsWith("/v1")) {
    return res.status(429).json({
      ok: false,
      error: { message, code: "RATE_LIMITED" },
      meta: buildMeta()
    });
  }
  return res.status(429).json({ error: message, code: "RATE_LIMITED", tenantId: null, collection: null });
}

function buildVerifyOptions() {
  const opts = { algorithms: ["HS256"] };
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return opts;
}

function hashApiKey(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

// Every service token is minted with this prefix (see the token-creation paths
// in index.js and the portal plugin). JWTs never carry it, so seeing it after
// "Bearer" is an unambiguous signal that the caller sent an API key.
const SERVICE_TOKEN_PREFIX = "supav_";

function extractApiKey(req) {
  const headerKey = req.header("x-api-key");
  if (headerKey) return String(headerKey).trim();

  const auth = String(req.header("authorization") || "").trim();
  const match = auth.match(/^(apikey|bearer)\s+(\S+)$/i);
  if (!match) return null;
  const [, scheme, token] = match;

  const normalizedScheme = scheme.toLowerCase();
  if (normalizedScheme === "apikey") {
    return String(token).trim();
  }
  // Accept "Bearer <service token>" too. Bearer is what most developers reach
  // for by default, and previously it fell through to JWT verification, which
  // cannot parse a service token -- producing a bare 401 "Invalid token" that
  // gave no hint the scheme was the problem. Gated on the prefix so genuine
  // Bearer JWTs still take the JWT path untouched.
  if (normalizedScheme === "bearer" && String(token).trim().startsWith(SERVICE_TOKEN_PREFIX)) {
    return String(token).trim();
  }
  return null;
}

async function tryApiKeyAuth(req, res) {
  const apiKey = extractApiKey(req);
  if (!apiKey) return { handled: false, ok: false };

  const keyHash = hashApiKey(apiKey);
  let record = null;
  try {
    record = await getServiceTokenByHash(keyHash);
  } catch (err) {
    sendAuthError(res, 500, "Auth lookup failed", req, "AUTH_LOOKUP_FAILED");
    return { handled: true, ok: false };
  }

  if (!record) {
    sendAuthError(res, 401, "Invalid API key", req, "AUTH_INVALID");
    return { handled: true, ok: false };
  }

  if (record.revoked_at) {
    sendAuthError(res, 401, "API key revoked", req, "AUTH_REVOKED");
    return { handled: true, ok: false };
  }

  if (record.expires_at && new Date(record.expires_at) <= new Date()) {
    sendAuthError(res, 401, "API key expired", req, "AUTH_EXPIRED");
    return { handled: true, ok: false };
  }

  try {
    await recordServiceTokenUse(record.id);
  } catch (err) {
    sendAuthError(res, 500, "Auth lookup failed", req, "AUTH_LOOKUP_FAILED");
    return { handled: true, ok: false };
  }
  req.user = {
    sub: record.principal_id,
    principal_id: record.principal_id,
    tenant: record.tenant_id,
    roles: record.roles || [],
    auth: "api_key",
    token_id: record.id
  };
  return { handled: true, ok: true };
}

// Require Bearer JWT or API key for protected routes
async function requireJwt(req, res, next) {
  const apiKeyResult = await tryApiKeyAuth(req, res);
  if (apiKeyResult.handled) {
    if (apiKeyResult.ok) {
      return tenantLimiter(req, res, next);
    }
    return;
  }

  const secret = process.env.JWT_SECRET;

  // If no JWT_SECRET set, we refuse (safer than accidentally public)
  if (!secret) {
    return sendAuthError(res, 500, "JWT_SECRET not set on server", req, "AUTH_CONFIG");
  }

  const auth = req.header("authorization") || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) {
    return sendAuthError(res, 401, "Missing or invalid auth header (Authorization: Bearer <jwt> or X-API-Key)", req, "AUTH_REQUIRED");
  }

  try {
    const payload = jwt.verify(token, secret, buildVerifyOptions());
    req.user = payload;
    if (req.user && !req.user.auth) {
      req.user.auth = "jwt";
    }
    return tenantLimiter(req, res, next);
  } catch (err) {
    return sendAuthError(res, 401, "Invalid token", req, "AUTH_INVALID");
  }
}

const publicWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const publicMax = parseInt(process.env.RATE_LIMIT_MAX || "60", 10);
// Rate limiter: max requests per window per IP (public/unauth)
const limiter = rateLimit({
  windowMs: Number.isFinite(publicWindowMs) && publicWindowMs > 0 ? publicWindowMs : 60000,
  max: Number.isFinite(publicMax) && publicMax > 0 ? publicMax : 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => sendRateLimitError(res, req)
});

const tenantWindowMs = parseInt(process.env.TENANT_RATE_LIMIT_WINDOW_MS || "60000", 10);
const tenantMax = parseInt(process.env.TENANT_RATE_LIMIT_MAX || "120", 10);
const tenantLimiter = rateLimit({
  windowMs: Number.isFinite(tenantWindowMs) && tenantWindowMs > 0 ? tenantWindowMs : 60000,
  max: Number.isFinite(tenantMax) && tenantMax > 0 ? tenantMax : 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => sendRateLimitError(res, req),
  keyGenerator: (req) => {
    const user = req.user || {};
    if (user.auth === "api_key" && user.token_id) {
      return `key:${user.token_id}`;
    }
    const tenant = user.tenant || user.tid || user.tenantId || user.sub;
    if (tenant) return `tenant:${tenant}`;
    return ipKeyGenerator(req.ip);
  }
});

const loginWindowMs = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || "60000", 10);
const loginMax = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || "10", 10);
const loginLimiter = rateLimit({
  windowMs: Number.isFinite(loginWindowMs) && loginWindowMs > 0 ? loginWindowMs : 60000,
  max: Number.isFinite(loginMax) && loginMax > 0 ? loginMax : 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => sendRateLimitError(res, req)
});

module.exports = { requireJwt, limiter, loginLimiter, __testHooks: { extractApiKey, SERVICE_TOKEN_PREFIX } };
