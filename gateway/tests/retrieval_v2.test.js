// Retrieval v2 unit tests: BM25 keyword scoring, numbered citations, and
// conversational query rewriting. No services needed.

const assert = require("assert/strict");
const { parseTsvector, bm25Score } = require("../lexical_bm25");
const { resolveNumberedCitations, stripCitationMarkers, createMarkerRenumberer } = require("../citations");
const { acceptRewrite, formatHistory } = require("../query_rewrite");
const { generateAnswer, __testHooks } = require("../answer");

const CHUNKS = [
  { chunk_id: "t::c::policy#0", text: "Refunds are issued within 14 days of purchase.", title: "Refund policy" },
  { chunk_id: "t::c::policy#1", text: "Store credit never expires.", title: "Refund policy" },
  { chunk_id: "t::c::faq#0", text: "Support is open weekdays from 9am to 5pm.", title: "FAQ" }
];

function testParseTsvectorCountsPositions() {
  const vec = parseTsvector("'password':3A 'reset':2,9 'set':5");
  assert.equal(vec.tf.get("reset"), 2);
  assert.equal(vec.tf.get("password"), 1);
  assert.equal(vec.length, 4);
}

function testBm25RareTermOutweighsCommonTerm() {
  const df = new Map([["warranty", 2], ["product", 900]]);
  const rare = parseTsvector("'warranty':4 'other':1");
  const common = parseTsvector("'product':4 'other':1");
  const rareScore = bm25Score(rare, ["warranty", "product"], df, 1000, 2);
  const commonScore = bm25Score(common, ["warranty", "product"], df, 1000, 2);
  assert.ok(rareScore > commonScore * 5, `rare ${rareScore} should dominate common ${commonScore}`);
}

function testBm25MissingTermsScoreZero() {
  assert.equal(bm25Score(parseTsvector("'other':1"), ["absent"], new Map(), 10, 1), 0);
}

function testNumberedCitationsRenumberInOrderAndDropInvalid() {
  const { answer, citations } = resolveNumberedCitations(
    "Support runs weekdays [3]. Refunds take 14 days [1][3]. Nothing at [9].\nCitations: 1, 3",
    CHUNKS
  );
  assert.equal(answer, "Support runs weekdays [1]. Refunds take 14 days [2][1]. Nothing at.");
  assert.deepEqual(citations, ["t::c::faq#0", "t::c::policy#0"]);
}

function testNumberedCitationsHandleCommaGroupsAndDuplicates() {
  const { answer, citations } = resolveNumberedCitations("Both apply [1, 2][2].", CHUNKS);
  assert.equal(answer, "Both apply [1][2][2].");
  assert.deepEqual(citations, ["t::c::policy#0", "t::c::policy#1"]);
}

function testNoMarkersMeansNoCitations() {
  assert.deepEqual(resolveNumberedCitations("I don't have that information.", CHUNKS).citations, []);
}

function testStreamedMarkersMatchTheFinalAnswer() {
  const full = "Water deeply [3]. Feed often [1, 3][9]. Done [2].";
  const renumberer = createMarkerRenumberer(CHUNKS.length);
  let streamed = "";
  for (const piece of ["Water deeply [", "3]. Feed often [1", ", 3][9]. Done [", "2]."]) streamed += renumberer.push(piece);
  streamed += renumberer.flush();
  assert.equal(streamed, resolveNumberedCitations(full, CHUNKS).answer);
}

async function testGenerateAnswerStreamsRenumberedMarkers() {
  const deltas = [];
  await generateAnswer("Q?", CHUNKS, {
    citationMode: "numbered",
    onToken: (delta) => { deltas.push(delta); },
    generateText: async ({ onToken }) => {
      for (const piece of ["Support runs weekdays [", "3]. Refunds [1", "]."]) await onToken(piece);
      return { text: "Support runs weekdays [3]. Refunds [1].", usage: null };
    }
  });
  assert.equal(deltas.join(""), "Support runs weekdays [1]. Refunds [2].");
}

function testStripCitationMarkers() {
  assert.equal(stripCitationMarkers("Refunds take 14 days [1][2]. Credit never expires [3]."), "Refunds take 14 days. Credit never expires.");
}

async function testGenerateAnswerNumberedModeUsesOnlyModelCitations() {
  let prompt = "";
  const result = await generateAnswer("How long do refunds take?", CHUNKS, {
    citationMode: "numbered",
    generateText: async ({ input }) => {
      prompt = input;
      return { text: "Refunds are issued within 14 days [1].", usage: { total_tokens: 10 } };
    }
  });
  assert.match(prompt, /SOURCE \[1\]\nTITLE: Refund policy/);
  assert.doesNotMatch(prompt, /SOURCE t::c::policy#0/);
  assert.match(prompt, /cite it by its bracketed number/);
  assert.equal(result.answer, "Refunds are issued within 14 days [1].");
  assert.deepEqual(result.citations, ["t::c::policy#0"]);
}

async function testGenerateAnswerNumberedModeNoMarkersNoFallback() {
  const result = await generateAnswer("What is the CEO's name?", CHUNKS, {
    citationMode: "numbered",
    generateText: async () => ({ text: "I don't have that information.", usage: null })
  });
  assert.deepEqual(result.citations, []);
}

async function testInlineModeDropsCitationsTheModelWasNeverShown() {
  const result = await generateAnswer("Refunds?", CHUNKS, {
    citationMode: "inline",
    generateText: async () => ({ text: "Refunds take 14 days.\nCitations: t::c::policy#0, t::c::invented#7", usage: null })
  });
  assert.deepEqual(result.citations, ["t::c::policy#0"]);
}

async function testInlineCanonicalUnknownCarriesNoCitations() {
  const result = await generateAnswer("CEO?", CHUNKS, {
    citationMode: "inline",
    generateText: async () => ({ text: "I don't know based on the provided sources.", usage: null })
  });
  assert.deepEqual(result.citations, []);
}

function testPersonaNumberedPromptAllowsMarkers() {
  const prompt = __testHooks.buildPrompt("Q?", CHUNKS, "auto", "numbered", { persona: "You are Ada." });
  assert.match(prompt, /Bracketed citation numbers such as \[1\] are not mentions of sources/);
}

function testAcceptRewriteRejectsJunk() {
  assert.equal(acceptRewrite('"refund window for annual plans"', "how long?"), "refund window for annual plans");
  assert.equal(acceptRewrite("", "how long?"), null);
  assert.equal(acceptRewrite("I'm sorry, I can't help with that", "how long?"), null);
  assert.equal(acceptRewrite("x".repeat(2000), "how long?"), null);
}

function testFormatHistoryKeepsNewestTurns() {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i}` }));
  const lines = formatHistory(history).split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines.at(-1), "Assistant: turn 9");
}

(async () => {
  testParseTsvectorCountsPositions();
  testBm25RareTermOutweighsCommonTerm();
  testBm25MissingTermsScoreZero();
  testNumberedCitationsRenumberInOrderAndDropInvalid();
  testNumberedCitationsHandleCommaGroupsAndDuplicates();
  testNoMarkersMeansNoCitations();
  testStripCitationMarkers();
  testStreamedMarkersMatchTheFinalAnswer();
  await testGenerateAnswerStreamsRenumberedMarkers();
  await testGenerateAnswerNumberedModeUsesOnlyModelCitations();
  await testGenerateAnswerNumberedModeNoMarkersNoFallback();
  await testInlineModeDropsCitationsTheModelWasNeverShown();
  await testInlineCanonicalUnknownCarriesNoCitations();
  testPersonaNumberedPromptAllowsMarkers();
  testAcceptRewriteRejectsJunk();
  testFormatHistoryKeepsNewestTurns();
  console.log("retrieval v2 tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
