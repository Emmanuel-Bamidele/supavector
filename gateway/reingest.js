// Re-ingestion: move existing documents onto the current pipeline
// (structure-aware chunks, chunk context, current embedding model).
//
// Unlike a vector reindex, which only re-embeds stored chunk text and clears
// the whole store first, this re-runs indexDocument per document from its
// original text (stored, or rebuilt from its chunks for documents indexed
// before texts were kept). Each document swaps atomically on its own, so
// search keeps serving every other document throughout.

const { joinChunkTexts } = require("./doc_text");

function createReingestJob({ listArtifacts, getDocExports, getChunksByDocId, indexDocument, log = console.log }) {
  let state = { running: false };

  async function reingestOne(item) {
    const exports = await getDocExports([item.namespace_id]);
    let text = exports.get(item.namespace_id)?.text || null;
    if (!text) {
      const chunks = await getChunksByDocId(item.namespace_id);
      text = joinChunkTexts(chunks.map((chunk) => chunk.text));
    }
    if (!String(text || "").trim()) throw new Error("no text to re-ingest");
    await indexDocument(item.tenant_id, item.collection, item.external_id, text, {
      type: item.source_type || "text",
      title: item.title || item.external_id,
      url: item.source_url || null,
      metadata: item.metadata || null,
      tags: item.tags || null,
      visibility: item.visibility || undefined,
      acl: item.acl_principals || undefined,
      agentId: item.agent_id || null,
      principalId: item.principal_id || null,
      expiresAt: item.expires_at || null
    }, { telemetry: { source: "reingest" } });
  }

  async function run({ tenantId, collection, concurrency = 2 }) {
    let afterId = null;
    for (;;) {
      const batch = await listArtifacts({ tenantId, collection, afterId, limit: 100 });
      if (!batch.length) break;
      afterId = batch.at(-1).id;
      state.total += batch.length;
      let next = 0;
      const lane = async () => {
        while (next < batch.length) {
          const item = batch[next++];
          try {
            await reingestOne(item);
            state.done += 1;
          } catch (err) {
            state.failed += 1;
            state.lastError = `${item.namespace_id}: ${String(err?.message || err).slice(0, 300)}`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
      log(`[reingest] ${state.done} done, ${state.failed} failed of ${state.total} so far`);
    }
  }

  return {
    status: () => ({ ...state }),
    start({ tenantId = null, collection = null, concurrency } = {}) {
      if (state.running) return { started: false, ...state };
      state = { running: true, tenantId, collection, total: 0, done: 0, failed: 0, lastError: null, startedAt: new Date().toISOString(), finishedAt: null };
      run({ tenantId, collection, concurrency })
        .catch((err) => { state.lastError = String(err?.message || err); })
        .finally(() => { state.running = false; state.finishedAt = new Date().toISOString(); });
      return { started: true, ...state };
    }
  };
}

module.exports = { createReingestJob };
