// OpenAI file search adapter (Responses API + vector stores), run through the
// same harness as SupaVector. One file per corpus document, named
// `<docId>.txt`, so retrieved files map back to the dataset's relevance labels.

const fs = require("fs");
const path = require("path");
const { requestJson, mapLimit } = require("../lib/http");

const API = "https://api.openai.com/v1";
const INSTRUCTIONS = "Answer the question using only the attached files. Be concise. If the files do not contain the answer, say you don't know.";

function createOpenAiFileSearchSystem({ name, model = "gpt-5.2", apiKey = process.env.OPENAI_API_KEY, stateDir }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for openai-file-search");
  const headers = { authorization: `Bearer ${apiKey}` };
  const stateFile = path.join(stateDir, `openai-${name}.json`);
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
  const saveState = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  };
  const docIdOf = (fileId, filename) => state?.files?.[fileId] || String(filename || "").replace(/\.txt$/, "") || null;

  async function waitForBatch(storeId, batchId, log) {
    for (;;) {
      const batch = await requestJson(`${API}/vector_stores/${storeId}/file_batches/${batchId}`, { headers });
      if (batch.status === "completed") return batch;
      if (batch.status === "failed" || batch.status === "cancelled") throw new Error(`file batch ${batch.status}`);
      log(`file batch: ${batch.file_counts?.completed || 0}/${batch.file_counts?.total || "?"} processed`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  return {
    name: "openai-file-search",

    async prepare(docs, { reindex = false, log = () => {} } = {}) {
      if (state?.vectorStoreId && state.complete && !reindex) {
        log(`reusing vector store ${state.vectorStoreId}`);
        return;
      }
      // Resume a partial upload: files already sent stay; only the rest go.
      if (!state?.vectorStoreId || reindex) {
        const store = await requestJson(`${API}/vector_stores`, { method: "POST", headers, body: { name: `supavector-eval-${name}` } });
        state = { vectorStoreId: store.id, files: {}, complete: false };
        saveState();
      }
      const done = new Set(Object.values(state.files));
      const pending = docs.filter((doc) => !done.has(doc.docId));
      log(`uploading ${pending.length} files (${done.size} already uploaded)`);
      // The files endpoint allows ~1000 uploads a minute: pace to ~12/s and
      // wait out a 429 instead of failing the run.
      let uploaded = 0;
      let nextSlot = Date.now();
      await mapLimit(pending, 8, async (doc) => {
        const wait = Math.max(0, nextSlot - Date.now());
        nextSlot = Math.max(nextSlot, Date.now()) + 85;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        for (let attempt = 1; ; attempt += 1) {
          const form = new FormData();
          form.append("purpose", "assistants");
          form.append("file", new Blob([doc.text], { type: "text/plain" }), `${doc.docId}.txt`);
          try {
            const file = await requestJson(`${API}/files`, { method: "POST", headers, body: form, timeoutMs: 120_000, attempts: 1 });
            state.files[file.id] = doc.docId;
            break;
          } catch (err) {
            if (err.status !== 429 || attempt >= 8) throw err;
            await new Promise((r) => setTimeout(r, 15_000));
          }
        }
        uploaded += 1;
        if (uploaded % 250 === 0) { log(`uploaded ${uploaded}/${pending.length}`); saveState(); }
      });
      saveState();
      const attached = new Set(state.attached || []);
      const fileIds = Object.keys(state.files).filter((id) => !attached.has(id));
      for (let i = 0; i < fileIds.length; i += 500) {
        const batch = await requestJson(`${API}/vector_stores/${state.vectorStoreId}/file_batches`, {
          method: "POST", headers, body: { file_ids: fileIds.slice(i, i + 500) }
        });
        await waitForBatch(state.vectorStoreId, batch.id, log);
        state.attached = [...attached, ...fileIds.slice(0, i + 500)];
        saveState();
      }
      state.complete = true;
      saveState();
    },

    async retrieve(query, { limit = 20 } = {}) {
      const res = await requestJson(`${API}/vector_stores/${state.vectorStoreId}/search`, {
        method: "POST", headers, body: { query: query.text, max_num_results: Math.min(50, limit) }, attempts: 3
      });
      return (res.data || []).map((r) => ({ docId: docIdOf(r.file_id, r.filename), score: r.score, text: r.content?.[0]?.text }));
    },

    async answer(query) {
      const input = [
        ...(query.history || []).map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: t.content || t.text })),
        { role: "user", content: query.text }
      ];
      const res = await requestJson(`${API}/responses`, {
        method: "POST",
        headers,
        body: {
          model,
          instructions: INSTRUCTIONS,
          input,
          tools: [{ type: "file_search", vector_store_ids: [state.vectorStoreId], max_num_results: 20 }],
          include: ["file_search_call.results"]
        },
        timeoutMs: 180_000,
        attempts: 2
      });
      let text = "";
      const citations = [];
      const contexts = [];
      for (const item of res.output || []) {
        if (item.type === "file_search_call") {
          for (const r of item.results || []) contexts.push({ docId: docIdOf(r.file_id, r.filename), text: r.text });
        }
        if (item.type === "message") {
          for (const part of item.content || []) {
            if (part.type !== "output_text") continue;
            text += part.text;
            for (const a of part.annotations || []) {
              if (a.type === "file_citation") citations.push({ docId: docIdOf(a.file_id, a.filename) });
            }
          }
        }
      }
      return { text: text.trim(), citations, contexts };
    }
  };
}

module.exports = { createOpenAiFileSearchSystem };
