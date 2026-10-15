// BM25 keyword search over chunks, portable to any Postgres (no extensions).
//
// The previous keyword leg used websearch_to_tsquery('simple', q), which ANDs
// every word and never stems: "how do I reset my password" could not match the
// chunk that answers it. Here:
//   1. the query is stemmed with the English config (stopwords dropped);
//   2. stage one OR-matches those terms against the stored `search_tsv`
//      (GIN index) and keeps the best `poolSize` rows by ts_rank_cd;
//   3. stage two rescores that pool with Okapi BM25, using each term's
//      document frequency within the same scope, so rare terms outweigh
//      common ones the way every modern lexical retriever does.

const K1 = 1.2;
const B = 0.75;
const MAX_QUERY_TERMS = 32;
const SCOPE_COUNT_TTL_MS = 60_000;
const SAFE_LEXEME_RE = /^[^'\\\s:&|!()<>*]+$/;
const scopeCountCache = new Map();

function buildScope({ tenantPrefix, collectionPrefix, namespacedDocIds }, params) {
  if (Array.isArray(namespacedDocIds) && namespacedDocIds.length) {
    params.push(namespacedDocIds);
    return { sql: `c.doc_id = ANY($${params.length})`, key: `ids:${namespacedDocIds.length}:${namespacedDocIds[0]}:${namespacedDocIds.at(-1)}` };
  }
  params.push(tenantPrefix.length, tenantPrefix);
  const clauses = [`LEFT(c.doc_id, $${params.length - 1}) = $${params.length}`];
  if (collectionPrefix) {
    params.push(collectionPrefix);
    clauses.push(`c.doc_id LIKE $${params.length}`);
  }
  return { sql: clauses.join(" AND "), key: `prefix:${collectionPrefix || tenantPrefix}` };
}

/** Parse a tsvector's text form ('lex':1,4A 'other':2) into term frequencies. */
function parseTsvector(text) {
  const tf = new Map();
  let length = 0;
  const re = /'((?:[^']|'')+)'(?::([0-9A-D,]+))?/g;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const lexeme = match[1].replace(/''/g, "'");
    const count = match[2] ? match[2].split(",").length : 1;
    tf.set(lexeme, count);
    length += count;
  }
  return { tf, length };
}

function bm25Score({ tf, length }, terms, df, totalDocs, avgLength) {
  let score = 0;
  for (const term of terms) {
    const freq = tf.get(term) || 0;
    if (!freq) continue;
    const n = df.get(term) || 0;
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
    score += idf * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (length / (avgLength || 1))));
  }
  return score;
}

async function queryTerms(pool, query) {
  const res = await pool.query(
    "SELECT unnest(tsvector_to_array(to_tsvector('english'::regconfig, $1))) AS lexeme",
    [String(query || "").slice(0, 4000)]
  );
  return [...new Set(res.rows.map((r) => r.lexeme).filter((l) => SAFE_LEXEME_RE.test(l)))].slice(0, MAX_QUERY_TERMS);
}

async function scopeCount(pool, scope, params) {
  const cached = scopeCountCache.get(scope.key);
  if (cached && cached.expires > Date.now()) return cached.count;
  const res = await pool.query(`SELECT COUNT(*)::bigint AS n FROM chunks c WHERE ${scope.sql}`, params);
  const count = Number(res.rows[0]?.n || 0);
  scopeCountCache.set(scope.key, { count, expires: Date.now() + SCOPE_COUNT_TTL_MS });
  if (scopeCountCache.size > 2000) scopeCountCache.delete(scopeCountCache.keys().next().value);
  return count;
}

async function searchChunksBm25(pool, { tenantPrefix, collectionPrefix, query, limit, namespacedDocIds, poolSize }) {
  const terms = await queryTerms(pool, query);
  if (!terms.length) return [];
  const cleanLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const candidatePool = Math.max(cleanLimit, Math.min(Number(poolSize) || cleanLimit * 6, 600));
  const orQuery = terms.map((t) => `'${t}'`).join(" | ");

  const scopeParams = [];
  const scope = buildScope({ tenantPrefix, collectionPrefix, namespacedDocIds }, scopeParams);

  const poolParams = [...scopeParams, orQuery, candidatePool];
  const candidates = await pool.query(
    `SELECT c.chunk_id, c.doc_id, c.idx, c.text, c.context, c.search_tsv::text AS tsv
     FROM chunks c
     WHERE ${scope.sql} AND c.search_tsv @@ to_tsquery('simple', $${poolParams.length - 1})
     ORDER BY ts_rank_cd(c.search_tsv, to_tsquery('simple', $${poolParams.length - 1}), 1) DESC, c.idx ASC
     LIMIT $${poolParams.length}`,
    poolParams
  );
  if (!candidates.rows.length) return [];

  const dfParams = [...scopeParams, terms];
  const dfRes = await pool.query(
    `SELECT t.lexeme,
            (SELECT COUNT(*) FROM chunks c
              WHERE ${scope.sql} AND c.search_tsv @@ to_tsquery('simple', quote_literal(t.lexeme)))::bigint AS df
     FROM unnest($${dfParams.length}::text[]) AS t(lexeme)`,
    dfParams
  );
  const df = new Map(dfRes.rows.map((r) => [r.lexeme, Number(r.df || 0)]));
  const totalDocs = Math.max(await scopeCount(pool, scope, scopeParams), candidates.rows.length);

  const parsed = candidates.rows.map((row) => ({ row, vec: parseTsvector(row.tsv) }));
  const avgLength = parsed.reduce((sum, p) => sum + p.vec.length, 0) / parsed.length;
  return parsed
    .map(({ row, vec }) => ({
      chunk_id: row.chunk_id,
      doc_id: row.doc_id,
      idx: row.idx,
      text: row.text,
      context: row.context,
      lexical_score: bm25Score(vec, terms, df, totalDocs, avgLength)
    }))
    .sort((a, b) => b.lexical_score - a.lexical_score || a.idx - b.idx)
    .slice(0, cleanLimit);
}

module.exports = { searchChunksBm25, parseTsvector, bm25Score };
