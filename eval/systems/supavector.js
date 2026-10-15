// SupaVector gateway adapter: indexes a dataset through /v1/docs/bulk and
// answers through /v1/search and /v1/ask, exactly as an API caller would.

const crypto = require("crypto");
const { requestJson, mapLimit } = require("../lib/http");

const BULK_SIZE = 25;

const GENERATION_UNAVAILABLE = "I couldn't generate a grounded answer right now because answer generation is unavailable.";

function createSupavectorSystem({ baseUrl, token, collection, k = 10, answerK, provider, model, citationMode = "metadata", rerank = true }) {
  const headers = { authorization: `Bearer ${token}` };
  const url = (p) => `${baseUrl.replace(/\/$/, "")}${p}`;
  const unwrap = (payload) => (payload?.ok === true && "data" in payload ? payload.data : payload);

  async function indexedDocIds() {
    try {
      const data = unwrap(await requestJson(url(`/v1/docs?collection=${encodeURIComponent(collection)}`), { headers, timeoutMs: 300_000 }));
      return new Set((data?.docs || []).map((d) => d.docId));
    } catch {
      return new Set();
    }
  }

  return {
    name: "supavector",
    collection,

    async prepare(allDocs, { reindex = false, log = () => {} } = {}) {
      if (reindex) {
        // Synchronous on the gateway and slow for big collections: wait for
        // it, or the delete keeps running and removes freshly indexed docs.
        await requestJson(url(`/v1/collections/${encodeURIComponent(collection)}`), { method: "DELETE", headers, timeoutMs: 1_800_000, attempts: 1 })
          .catch((err) => { if (err.status !== 404) throw err; });
      }
      // Per-run nonce: retries inside this run replay safely, but a new run
      // never receives a cached "done" for batches an earlier run indexed.
      const runNonce = crypto.randomBytes(8).toString("hex");
      // Resumable: only documents the collection doesn't already hold.
      const existing = reindex ? new Set() : await indexedDocIds();
      const docs = allDocs.filter((d) => !existing.has(d.docId));
      if (!docs.length) {
        log(`collection ${collection} already holds all ${allDocs.length} docs; reuse (pass --reindex to rebuild)`);
        return;
      }
      log(`indexing ${docs.length} docs (${existing.size} already present)`);
      const batches = [];
      for (let i = 0; i < docs.length; i += BULK_SIZE) batches.push(docs.slice(i, i + BULK_SIZE));
      let done = 0;
      await mapLimit(batches, Number(process.env.EVAL_INDEX_CONCURRENCY || 16), async (batch) => {
        const data = unwrap(await requestJson(url("/v1/docs/bulk"), {
          method: "POST",
          headers: { ...headers, "idempotency-key": `eval-${crypto.createHash("sha256").update(runNonce + collection + batch.map((d) => d.docId).join(",")).digest("hex").slice(0, 40)}` },
          body: { collection, documents: batch.map((d) => ({ docId: d.docId, text: d.text, title: d.title ? d.title.slice(0, 190) : undefined })) },
          timeoutMs: 600_000
        }));
        const failed = (data?.results || []).filter((r) => !r.ok);
        if (failed.length) throw new Error(`bulk index failed: ${JSON.stringify(failed[0]).slice(0, 300)}`);
        done += batch.length;
        if (done % 500 < BULK_SIZE) log(`indexed ${done}/${docs.length}`);
      });
    },

    async retrieve(query, { limit = Math.max(k, 20) } = {}) {
      const data = unwrap(await requestJson(
        url(`/v1/search?collection=${encodeURIComponent(collection)}&k=${limit}&rerank=${rerank ? 1 : 0}&q=${encodeURIComponent(query.text)}${query.docIds?.length ? `&docIds=${encodeURIComponent(query.docIds.join(","))}` : ""}`),
        { headers, attempts: 2 }
      ));
      return (data?.results || []).map((r) => ({ docId: r.docId, chunkId: r.chunkId, score: r.score, text: r.preview }));
    },

    async answer(query) {
      const data = unwrap(await requestJson(url("/v1/ask"), {
        method: "POST",
        headers,
        body: {
          collection,
          question: query.text,
          k: answerK || undefined,
          docIds: query.docIds?.length ? query.docIds : undefined,
          history: query.history?.length ? query.history : undefined,
          citationMode,
          provider,
          model,
          // As the product sends them: the AI's voice, and the visitor's clock.
          persona: query.persona || undefined,
          background: query.persona ? `Current date and time (UTC): ${new Date().toUTCString()}.` : undefined
        },
        timeoutMs: 180_000,
        attempts: 2
      }));
      // The gateway answers 200 with this sentence when the model call fails
      // (quota, outage). That is a failed question, not a wrong answer.
      if (String(data?.answer || "").trim() === GENERATION_UNAVAILABLE) throw new Error("gateway answer generation unavailable");
      return {
        text: String(data?.answer || ""),
        retrievalQuery: data?.retrievalQuery || null,
        citations: (data?.citations || []).map((c) => (typeof c === "string" ? { chunkId: c } : c)),
        contexts: (data?.supportingChunks || []).map((c) => ({ docId: c.docId, text: c.text }))
      };
    }
  };
}

module.exports = { createSupavectorSystem };
