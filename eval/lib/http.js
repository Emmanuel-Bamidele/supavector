// Minimal JSON-over-HTTP helper for the eval harness: bounded retries on
// transient failures, a timeout on every call, and errors that keep the body.

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 120_000, attempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
          ...headers
        },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
      if (!res.ok) {
        const err = new Error(`${method} ${url} -> ${res.status}: ${String(text).slice(0, 400)}`);
        err.status = res.status;
        err.payload = payload;
        if (!RETRYABLE.has(res.status) || attempt === attempts) throw err;
        lastErr = err;
      } else {
        return payload;
      }
    } catch (err) {
      lastErr = err;
      // "fetch failed" covers resets and undici's own header timeout on slow responses.
      const transient = err.name === "AbortError" || (err.name === "TypeError" && /fetch failed/i.test(String(err.message)));
      if ((!transient && !RETRYABLE.has(err.status)) || attempt === attempts) throw err;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  throw lastErr;
}

/** Run `worker` over `items` with at most `limit` in flight; keeps input order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

module.exports = { requestJson, mapLimit };
