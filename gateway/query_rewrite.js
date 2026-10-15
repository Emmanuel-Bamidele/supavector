// Conversational query rewriting for retrieval.
//
// Chat history used to reach only the answer model; retrieval searched the
// raw follow-up ("how much is it?"), which matches nothing useful. When there
// is history, a small fast model turns the latest message into a standalone
// search query first. Any failure, timeout or odd output falls back to the
// original question, so rewriting can improve retrieval but never block it.

const { generateProviderText } = require("./provider_clients");

const REWRITE_ENABLED = process.env.QUERY_REWRITE_ENABLED !== "0";
const REWRITE_PROVIDER = String(process.env.QUERY_REWRITE_PROVIDER || "openai").trim().toLowerCase();
const REWRITE_MODEL = String(process.env.QUERY_REWRITE_MODEL || "gpt-4.1-mini").trim();
const REWRITE_TIMEOUT_MS = parseInt(process.env.QUERY_REWRITE_TIMEOUT_MS || "6000", 10);
const MAX_HISTORY_TURNS = 6;

const REWRITE_INSTRUCTIONS = `You turn the latest message in a conversation into ONE standalone search query for a document search engine.
- Resolve pronouns and references ("it", "that", "the second one", "they") using the conversation.
- Keep every name, number, date, product and technical term exactly as written.
- If the latest message already stands on its own, return it unchanged.
- Output the query only. No quotes, no labels, no explanation.`;

function formatHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((turn) => turn?.text)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${String(turn.text).replace(/\s+/g, " ").trim().slice(0, 600)}`)
    .join("\n");
}

function acceptRewrite(candidate, question) {
  const clean = String(candidate || "").replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.length > Math.max(400, question.length * 4)) return null;
  if (/^(i\s|sorry|as an ai|i'm sorry|query:)/i.test(clean)) return null;
  return clean;
}

/**
 * @returns {Promise<{query: string, rewritten: boolean, usage: object|null, error?: string}>}
 */
async function rewriteQueryForRetrieval({ question, history, answerProvider, answerApiKey }) {
  const cleanQuestion = String(question || "").trim();
  const conversation = formatHistory(history);
  if (!REWRITE_ENABLED || !cleanQuestion || !conversation) {
    return { query: cleanQuestion, rewritten: false, usage: null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);
  try {
    const result = await generateProviderText({
      provider: REWRITE_PROVIDER,
      model: REWRITE_MODEL,
      // A caller's own provider key is only valid for that same provider.
      apiKey: answerProvider === REWRITE_PROVIDER ? answerApiKey : undefined,
      input: {
        system: REWRITE_INSTRUCTIONS,
        user: `Conversation:\n${conversation}\n\nLatest message: ${cleanQuestion}\n\nStandalone search query:`
      },
      temperature: 0,
      maxTokens: 120,
      maxRetries: 0,
      signal: controller.signal
    });
    const accepted = acceptRewrite(result?.text, cleanQuestion);
    return accepted
      ? { query: accepted, rewritten: accepted !== cleanQuestion, usage: result?.usage || null }
      : { query: cleanQuestion, rewritten: false, usage: result?.usage || null };
  } catch (err) {
    return { query: cleanQuestion, rewritten: false, usage: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Retrieval planning (the deep path). A question about several things —
// comparisons, multiple entities, time order — is searched one part at a
// time and the results merged; one small-model call both makes the question
// standalone and splits it. Questions that look simple and carry no history
// skip the call entirely.
const MULTI_PART_RE = /\b(and|vs\.?|versus|compare[ds]?|comparison|both|either|neither|differ(?:s|ence)?|same|before|after|between|while|whereas|than|which (?:one|of))\b/i;
const MAX_SUBQUERIES = 4;

const PLAN_INSTRUCTIONS = `You plan searches over a document collection to answer the latest message in a conversation.
Return JSON: {"query": "<the latest message rewritten as one standalone search query>", "subqueries": ["..."]}
- query: resolve references ("it", "that", "the second one") from the conversation; keep names, numbers, dates and terms exactly as written; if it already stands alone, repeat it.
- subqueries: when answering needs facts about several different things (a comparison, several entities, steps, or what happened before or after something), write one focused search query per thing, at most 4. Otherwise return [].`;

function looksMultiPart(question) {
  const words = String(question || "").trim().split(/\s+/).filter(Boolean).length;
  return words >= 10 && MULTI_PART_RE.test(question);
}

/**
 * @returns {Promise<{query: string, subqueries: string[], rewritten: boolean, usage: object|null, error?: string}>}
 */
async function planRetrieval({ question, history, answerProvider, answerApiKey }) {
  const cleanQuestion = String(question || "").trim();
  const conversation = formatHistory(history);
  const none = { query: cleanQuestion, subqueries: [], rewritten: false, usage: null };
  if (!REWRITE_ENABLED || !cleanQuestion || (!conversation && !looksMultiPart(cleanQuestion))) return none;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);
  try {
    const result = await generateProviderText({
      provider: REWRITE_PROVIDER,
      model: REWRITE_MODEL,
      apiKey: answerProvider === REWRITE_PROVIDER ? answerApiKey : undefined,
      input: {
        system: PLAN_INSTRUCTIONS,
        user: `${conversation ? `Conversation:\n${conversation}\n\n` : ""}Latest message: ${cleanQuestion}`
      },
      temperature: 0,
      jsonMode: true,
      maxTokens: 260,
      maxRetries: 0,
      signal: controller.signal
    });
    const parsed = JSON.parse(result?.text || "{}");
    const query = acceptRewrite(parsed.query, cleanQuestion) || cleanQuestion;
    const subqueries = (Array.isArray(parsed.subqueries) ? parsed.subqueries : [])
      .map((q) => acceptRewrite(q, cleanQuestion))
      .filter(Boolean)
      .slice(0, MAX_SUBQUERIES);
    return { query, subqueries: subqueries.length > 1 ? subqueries : [], rewritten: query !== cleanQuestion, usage: result?.usage || null };
  } catch (err) {
    // Visible on purpose: a silent fallback here searches follow-ups literally.
    console.warn(`[retrieval-plan] fell back to the original question: ${String(err?.message || err).slice(0, 200)}`);
    return { ...none, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { rewriteQueryForRetrieval, planRetrieval, looksMultiPart, acceptRewrite, formatHistory };
