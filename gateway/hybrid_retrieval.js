function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeRangeScore(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max <= min) return 1;
  return (value - min) / (max - min);
}

function resolveHybridFusionMode(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (clean === "weighted" || clean === "score" || clean === "normalized") return "weighted";
  return "rrf";
}

function resolveHybridFusionWeights({ useHybrid, vectorWeight, lexicalWeight }) {
  let resolvedVectorWeight = useHybrid ? clampNumber(vectorWeight, 0, 1) : 1;
  let resolvedLexicalWeight = useHybrid ? clampNumber(lexicalWeight, 0, 1) : 0;
  if ((resolvedVectorWeight + resolvedLexicalWeight) === 0) {
    resolvedVectorWeight = 1;
    resolvedLexicalWeight = 0;
  }
  const totalWeight = resolvedVectorWeight + resolvedLexicalWeight;
  return {
    vectorWeight: resolvedVectorWeight / totalWeight,
    lexicalWeight: resolvedLexicalWeight / totalWeight
  };
}

function tokenizeForRerank(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9_]+/g) || [];
}

function computeTokenOverlapScore(queryTokens, text) {
  if (!queryTokens || queryTokens.length === 0) return 0;
  const textTokens = new Set(tokenizeForRerank(text));
  if (textTokens.size === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

function reciprocalRankContribution(rank, rankConstant) {
  const cleanRank = Number(rank);
  const cleanRankConstant = Number.isFinite(Number(rankConstant)) && Number(rankConstant) >= 1
    ? Number(rankConstant)
    : 60;
  if (!Number.isFinite(cleanRank) || cleanRank < 1) return 0;
  return 1 / (cleanRankConstant + cleanRank);
}

function sortRankAscending(left, right) {
  const a = Number.isFinite(left) ? left : Number.POSITIVE_INFINITY;
  const b = Number.isFinite(right) ? right : Number.POSITIVE_INFINITY;
  return a - b;
}

function rankSearchCandidates(candidates, {
  query,
  useHybrid,
  fusionMode,
  vectorWeight,
  lexicalWeight,
  rankConstant,
  overlapBoostScale,
  exactBoostScale,
  favorRecency,
  candidateTypes,
  rrfBoostScale = 1,
  recencyWeight,
  recencyHalfLifeDays,
  determineRecencyBoostMode,
  computeMemoryRetrievalRecencyScore
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const denseScores = [];
  const lexicalScores = [];
  for (const candidate of list) {
    if (Number.isFinite(candidate?.vectorScore)) denseScores.push(candidate.vectorScore);
    if (Number.isFinite(candidate?.lexicalScore)) lexicalScores.push(candidate.lexicalScore);
  }
  const denseMin = denseScores.length ? Math.min(...denseScores) : 0;
  const denseMax = denseScores.length ? Math.max(...denseScores) : 0;
  const lexicalMin = lexicalScores.length ? Math.min(...lexicalScores) : 0;
  const lexicalMax = lexicalScores.length ? Math.max(...lexicalScores) : 0;
  const weights = resolveHybridFusionWeights({ useHybrid, vectorWeight, lexicalWeight });
  const cleanQuery = String(query || "").trim().toLowerCase();
  const queryTokens = useHybrid ? tokenizeForRerank(cleanQuery) : [];
  const recencyNow = Date.now();
  const cleanFusionMode = useHybrid ? resolveHybridFusionMode(fusionMode) : "weighted";
  const cleanRankConstant = Number.isFinite(Number(rankConstant)) && Number(rankConstant) >= 1
    ? Number(rankConstant)
    : 60;
  const cleanRecencyWeight = clampNumber(recencyWeight, 0, 0.8);
  const resolveRecencyMode = typeof determineRecencyBoostMode === "function"
    ? determineRecencyBoostMode
    : () => "off";
  const resolveRecencyScore = typeof computeMemoryRetrievalRecencyScore === "function"
    ? computeMemoryRetrievalRecencyScore
    : () => 0;

  const ranked = list.map((candidate) => {
    const vectorNorm = Number.isFinite(candidate?.vectorScore)
      ? normalizeRangeScore(candidate.vectorScore, denseMin, denseMax)
      : 0;
    const lexicalNorm = Number.isFinite(candidate?.lexicalScore)
      ? normalizeRangeScore(candidate.lexicalScore, lexicalMin, lexicalMax)
      : 0;

    let baseFusionScore = vectorNorm;
    if (useHybrid && cleanFusionMode === "rrf") {
      baseFusionScore = (
        reciprocalRankContribution(candidate?.vectorRank, cleanRankConstant) * weights.vectorWeight
      ) + (
        reciprocalRankContribution(candidate?.lexicalRank, cleanRankConstant) * weights.lexicalWeight
      );
    } else if (useHybrid) {
      baseFusionScore = (vectorNorm * weights.vectorWeight) + (lexicalNorm * weights.lexicalWeight);
    }

    const overlapScore = useHybrid ? computeTokenOverlapScore(queryTokens, candidate?.row?.text) : 0;
    const hasExactMatch = useHybrid
      && cleanQuery.length >= 8
      && String(candidate?.row?.text || "").toLowerCase().includes(cleanQuery);
    // Boosts are tie-breakers on the fusion's own scale. RRF scores are about
    // 1/(k+1) (~0.016 at k=60), so unscaled boosts of 0.12/0.08 used to swamp
    // both rankers and let raw word overlap decide the order (on BEIR SciFact
    // that cost ~0.12 nDCG@10).
    // rrfBoostScale tunes how much those tie-breakers can move a result
    // (1 = one RRF step; larger favours exact-term matches).
    const boostUnit = cleanFusionMode === "rrf" ? clampNumber(rrfBoostScale, 0, 200) / (cleanRankConstant + 1) : 1;
    const fusedScore = baseFusionScore
      + (overlapScore * clampNumber(overlapBoostScale, 0, 1) * boostUnit)
      + (hasExactMatch ? clampNumber(exactBoostScale, 0, 1) * boostUnit : 0);
    const recencyMode = resolveRecencyMode({
      explicitFavorRecency: favorRecency,
      memory: candidate?.memory,
      candidateTypes
    });
    const recencyScore = recencyMode === "off"
      ? 0
      : resolveRecencyScore(candidate?.memory, recencyNow, recencyHalfLifeDays);
    const finalScore = recencyMode === "off"
      ? fusedScore
      : ((fusedScore * (1 - cleanRecencyWeight)) + (recencyScore * cleanRecencyWeight));

    return {
      ...candidate,
      fusionMode: cleanFusionMode,
      baseFusionScore,
      fusedScore,
      recencyMode,
      recencyScore,
      finalScore,
      vectorNorm,
      lexicalNorm,
      overlapScore,
      exactMatch: hasExactMatch
    };
  });

  ranked.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    if (b.recencyScore !== a.recencyScore) return b.recencyScore - a.recencyScore;
    const vectorRankDiff = sortRankAscending(a.vectorRank, b.vectorRank);
    if (vectorRankDiff !== 0) return vectorRankDiff;
    const av = Number.isFinite(a.vectorScore) ? a.vectorScore : -Infinity;
    const bv = Number.isFinite(b.vectorScore) ? b.vectorScore : -Infinity;
    if (bv !== av) return bv - av;
    const lexicalRankDiff = sortRankAscending(a.lexicalRank, b.lexicalRank);
    if (lexicalRankDiff !== 0) return lexicalRankDiff;
    const al = Number.isFinite(a.lexicalScore) ? a.lexicalScore : -Infinity;
    const bl = Number.isFinite(b.lexicalScore) ? b.lexicalScore : -Infinity;
    if (bl !== al) return bl - al;
    return (a?.row?.idx || 0) - (b?.row?.idx || 0);
  });

  return ranked;
}

module.exports = {
  normalizeRangeScore,
  resolveHybridFusionMode,
  resolveHybridFusionWeights,
  tokenizeForRerank,
  computeTokenOverlapScore,
  reciprocalRankContribution,
  rankSearchCandidates
};
