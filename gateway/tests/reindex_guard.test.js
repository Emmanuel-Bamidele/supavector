const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "test-cookie-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const { __testHooks } = require("../index");

function testSkipsWhenVectorStoreMatchesCurrentChunksAndDims() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 17,
    vectorDims: 3072,
    expectedVectorDim: 3072
  });

  assert.equal(decision.shouldReindex, false);
  assert.equal(decision.clearFirst, false);
  assert.equal(decision.reason, "up_to_date");
}

function testClearsOnlyOnDimensionChange() {
  for (const mode of ["auto", "always"]) {
    const decision = __testHooks.shouldReindexStoredVectors({
      mode,
      totalChunks: 17,
      vectorCount: 17,
      vectorDims: 1536,
      expectedVectorDim: 3072
    });
    assert.equal(decision.shouldReindex, true);
    assert.equal(decision.clearFirst, true, `${mode}: one store holds one dimension`);
    assert.equal(decision.reason, "dimension_mismatch");
  }
}

function testMissingVectorsRebuildInPlace() {
  const partial = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 11,
    vectorDims: 1536,
    expectedVectorDim: 1536
  });
  assert.equal(partial.shouldReindex, true);
  assert.equal(partial.clearFirst, false, "search keeps serving while it rebuilds");
  assert.equal(partial.reason, "count_mismatch");

  const empty = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 0,
    vectorDims: 0,
    expectedVectorDim: 1536
  });
  assert.equal(empty.shouldReindex, true);
  assert.equal(empty.clearFirst, false);
  assert.equal(empty.reason, "missing_vectors");
}

function testExtraVectorsDoNotTriggerARebuild() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "auto",
    totalChunks: 17,
    vectorCount: 20,
    vectorDims: 1536,
    expectedVectorDim: 1536
  });
  assert.equal(decision.shouldReindex, false);
  assert.equal(decision.clearFirst, false);
  assert.equal(decision.reason, "extra_vectors");
}

function testForcedRebuildOverwritesInPlace() {
  const decision = __testHooks.shouldReindexStoredVectors({
    mode: "always",
    totalChunks: 17,
    vectorCount: 17,
    vectorDims: 1536,
    expectedVectorDim: 1536
  });
  assert.equal(decision.shouldReindex, true);
  assert.equal(decision.clearFirst, false);
  assert.equal(decision.reason, "forced");
}

function main() {
  testSkipsWhenVectorStoreMatchesCurrentChunksAndDims();
  testClearsOnlyOnDimensionChange();
  testMissingVectorsRebuildInPlace();
  testExtraVectorsDoNotTriggerARebuild();
  testForcedRebuildOverwritesInPlace();
  console.log("reindex guard tests passed");
}

main();
