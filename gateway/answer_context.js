// Neighbour expansion for answer context ("small-to-big").
//
// Retrieval is most precise on small chunks; answers are best written from
// the passage around a match. The top hits get their adjacent chunks from the
// same document attached. A neighbour that is itself a lower-ranked hit is
// absorbed instead of repeated, so no text reaches the model twice.

const TOP_N = parseInt(process.env.ANSWER_NEIGHBOR_TOP_N || "4", 10);
const RADIUS = parseInt(process.env.ANSWER_NEIGHBOR_RADIUS || "1", 10);

function splitChunkId(chunkId) {
  const raw = String(chunkId || "");
  const hash = raw.lastIndexOf("#");
  if (hash < 0) return null;
  const idx = Number(raw.slice(hash + 1));
  return Number.isInteger(idx) ? { base: raw.slice(0, hash), idx } : null;
}

/**
 * @param {Array} chunks ranked answer chunks (rows with chunk_id, text, ...)
 * @param {(ids: string[]) => Promise<Map<string, object>>} fetchByIds
 */
async function expandWithNeighbors(chunks, fetchByIds, { topN = TOP_N, radius = RADIUS } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length || topN <= 0 || radius <= 0) return list;
  const hitIds = new Set(list.map((c) => c.chunk_id));
  const wanted = new Set();
  for (const chunk of list.slice(0, topN)) {
    const parts = splitChunkId(chunk.chunk_id);
    if (!parts) continue;
    for (let d = -radius; d <= radius; d += 1) {
      if (d !== 0 && parts.idx + d >= 0) wanted.add(`${parts.base}#${parts.idx + d}`);
    }
  }
  const rowsById = new Map(list.map((c) => [c.chunk_id, c]));
  const missing = [...wanted].filter((id) => !rowsById.has(id));
  if (missing.length) {
    const fetched = await fetchByIds(missing);
    for (const [id, row] of fetched) rowsById.set(id, row);
  }
  const absorbed = new Set();
  const out = [];
  list.forEach((chunk, rank) => {
    if (absorbed.has(chunk.chunk_id)) return;
    const parts = rank < topN ? splitChunkId(chunk.chunk_id) : null;
    if (!parts) {
      out.push(chunk);
      return;
    }
    const pieces = [];
    for (let d = -radius; d <= radius; d += 1) {
      const id = d === 0 ? chunk.chunk_id : `${parts.base}#${parts.idx + d}`;
      const row = rowsById.get(id);
      if (!row || (d !== 0 && absorbed.has(id))) continue;
      pieces.push(row.text);
      if (d !== 0 && hitIds.has(id)) absorbed.add(id);
      if (d !== 0) absorbed.add(id);
    }
    // hit_text keeps the matched chunk alone, so a citation's snippet shows
    // the passage that was cited rather than a neighbour.
    out.push({ ...chunk, text: pieces.join("\n\n"), hit_text: chunk.text, expanded: pieces.length > 1 });
  });
  return out;
}

/**
 * Multi-part questions: every part keeps its best passage. The reranker
 * judges candidates against the whole question, so one part's many strong
 * passages can crowd out the only passage that answers another part.
 * @param {Array} chosen selected results, in order
 * @param {Array<Array>} partLists one result list per part, best first
 * @param {(item: object) => string} idOf
 * @param {number} perPart how many of each list's best to keep
 */
function withPartCoverage(chosen, partLists, idOf, perPart = 1) {
  const out = [...chosen];
  const ids = new Set(out.map(idOf));
  for (const list of partLists) {
    for (const item of (Array.isArray(list) ? list : []).slice(0, perPart)) {
      if (!item || ids.has(idOf(item))) continue;
      out.push(item);
      ids.add(idOf(item));
    }
  }
  return out;
}

module.exports = { expandWithNeighbors, splitChunkId, withPartCoverage };
