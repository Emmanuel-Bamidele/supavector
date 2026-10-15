// Gemini File Search adapter (Gemini API file search stores), run through the
// same harness as SupaVector. One store document per corpus document, with
// the dataset's docId as its display name, so grounding chunks map back to
// relevance labels. Google's default chunking; the answer model must be a
// Gemini model, which the report states.
//
// File Search has no retrieval-only endpoint, so this system answers but does
// not run --mode retrieval. Context recall comes from the answer's grounding
// chunks.

const fs = require("fs");
const path = require("path");
const { requestJson, mapLimit } = require("../lib/http");

const API = "https://generativelanguage.googleapis.com";
// Same instruction as the OpenAI file search adapter.
const INSTRUCTIONS = "Answer the question using only the attached files. Be concise. If the files do not contain the answer, say you don't know.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createGeminiFileSearchSystem({ name, model = "gemini-4-argon", apiKey = process.env.GEMINI_API_KEY, stateDir }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for gemini-file-search");
  const headers = { "x-goog-api-key": apiKey };
  const stateFile = path.join(stateDir, `gemini-${name}.json`);
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
  const saveState = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  };

  // Resumable upload: a start call returns the upload URL in a header, then
  // one call sends the bytes and finalizes. Returns the indexing operation.
  async function uploadDocument(doc) {
    const bytes = Buffer.from(doc.text, "utf8");
    for (let attempt = 1; ; attempt += 1) {
      try {
        const start = await fetch(`${API}/upload/v1beta/${state.storeName}:uploadToFileSearchStore`, {
          method: "POST",
          headers: {
            ...headers,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(bytes.length),
            "X-Goog-Upload-Header-Content-Type": "text/plain",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ displayName: doc.docId })
        });
        const uploadUrl = start.headers.get("x-goog-upload-url");
        if (!start.ok || !uploadUrl) {
          const err = new Error(`upload start -> ${start.status}: ${(await start.text()).slice(0, 300)}`);
          err.status = start.status;
          throw err;
        }
        const done = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
          body: bytes
        });
        const text = await done.text();
        if (!done.ok) {
          const err = new Error(`upload finalize -> ${done.status}: ${text.slice(0, 300)}`);
          err.status = done.status;
          throw err;
        }
        return text ? JSON.parse(text) : {};
      } catch (err) {
        const transient = err.status === 429 || err.status >= 500 || /fetch failed/i.test(String(err.message));
        if (!transient || attempt >= 8) throw err;
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
      }
    }
  }

  async function waitForOperation(operation) {
    let op = operation;
    for (let i = 0; op?.name && !op.done; i += 1) {
      if (i > 300) throw new Error(`indexing operation ${op.name} did not finish`);
      await sleep(2_000);
      op = await requestJson(`${API}/v1beta/${op.name}`, { headers });
    }
    if (op?.error) throw new Error(`indexing failed: ${JSON.stringify(op.error).slice(0, 300)}`);
    return op;
  }

  return {
    name: "gemini-file-search",
    model,

    async prepare(docs, { reindex = false, log = () => {} } = {}) {
      if (state?.storeName && state.complete && !reindex) {
        log(`reusing file search store ${state.storeName}`);
        return;
      }
      if (!state?.storeName || reindex) {
        const store = await requestJson(`${API}/v1beta/fileSearchStores`, {
          method: "POST", headers, body: { displayName: `supavector-eval-${name}`.slice(0, 120) }
        });
        state = { storeName: store.name, uploaded: {}, complete: false };
        saveState();
      }
      const pending = docs.filter((doc) => !state.uploaded[doc.docId]);
      log(`uploading ${pending.length} documents (${docs.length - pending.length} already indexed)`);
      let count = 0;
      await mapLimit(pending, 4, async (doc) => {
        await waitForOperation(await uploadDocument(doc));
        state.uploaded[doc.docId] = true;
        count += 1;
        if (count % 50 === 0) { log(`indexed ${count}/${pending.length}`); saveState(); }
      });
      state.complete = true;
      saveState();
    },

    async retrieve() {
      throw new Error("gemini-file-search has no retrieval-only endpoint; run it with --mode answer");
    },

    async answer(query) {
      const contents = [
        ...(query.history || []).map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content || t.text }] })),
        { role: "user", parts: [{ text: query.text }] }
      ];
      const res = await requestJson(`${API}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers,
        body: {
          systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
          contents,
          tools: [{ fileSearch: { fileSearchStoreNames: [state.storeName] } }]
        },
        timeoutMs: 180_000,
        attempts: 3
      });
      const candidate = res?.candidates?.[0] || {};
      const text = (candidate.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      const chunks = candidate.groundingMetadata?.groundingChunks || [];
      const contexts = chunks.map((c) => ({ docId: c.retrievedContext?.title || null, text: c.retrievedContext?.text || "" }));
      const cited = new Set();
      for (const s of candidate.groundingMetadata?.groundingSupports || []) {
        for (const i of s.groundingChunkIndices || []) if (contexts[i]?.docId) cited.add(contexts[i].docId);
      }
      return { text, citations: [...cited].map((docId) => ({ docId })), contexts };
    },

    async destroy() {
      if (!state?.storeName) return;
      await requestJson(`${API}/v1beta/${state.storeName}?force=true`, { method: "DELETE", headers });
      fs.rmSync(stateFile, { force: true });
      state = null;
    }
  };
}

module.exports = { createGeminiFileSearchSystem };
