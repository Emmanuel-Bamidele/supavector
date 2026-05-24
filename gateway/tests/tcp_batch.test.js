const assert = require("assert/strict");

const { buildVdelPrefix, buildVsearchAnn, buildVsearchAnnIn, __testHooks } = require("../tcp");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testExtractReplyLinesWithRemainder() {
  const parsed = __testHooks.extractReplyLines("OK new\r\n1\npartial");
  assert.deepEqual(parsed.lines, ["OK new", "1"]);
  assert.equal(parsed.remainder, "partial");
}

function testExtractReplyLinesHandlesMultipleChunks() {
  const first = __testHooks.extractReplyLines("OK updated\nERR bad");
  assert.deepEqual(first.lines, ["OK updated"]);
  assert.equal(first.remainder, "ERR bad");

  const second = __testHooks.extractReplyLines(first.remainder + "\n0\n");
  assert.deepEqual(second.lines, ["ERR bad", "0"]);
  assert.equal(second.remainder, "");
}

async function testInactivityTimerExtendsDeadlineOnProgress() {
  let fired = 0;
  const timer = __testHooks.createInactivityTimer(25, () => {
    fired += 1;
  });

  timer.start();
  await sleep(15);
  timer.bump();
  await sleep(15);
  assert.equal(fired, 0);
  await sleep(20);
  assert.equal(fired, 1);
  timer.clear();
}

function testBuildVdelPrefix() {
  assert.equal(buildVdelPrefix("doc-1#"), "VDELPREFIX doc-1#");
  assert.equal(__testHooks.buildVdelPrefix("mem_1#"), "VDELPREFIX mem_1#");
}

function testBuildVsearchAnn() {
  assert.equal(buildVsearchAnn(3, [0.1, 0.2], 9), "VSEARCHANN 3 2 0.1 0.2 9");
  assert.equal(buildVsearchAnnIn(2, [0.4, 0.5], ["a#1", "b#2"], 7), "VSEARCHANNIN 2 2 0.4 0.5 7 2 a#1 b#2");
  assert.equal(buildVsearchAnnIn(2, [0.4, 0.5], [], 7), "VSEARCHANNIN 2 2 0.4 0.5 7 0");
}

async function main() {
  testExtractReplyLinesWithRemainder();
  testExtractReplyLinesHandlesMultipleChunks();
  testBuildVdelPrefix();
  testBuildVsearchAnn();
  await testInactivityTimerExtendsDeadlineOnProgress();
  console.log("tcp batch tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
