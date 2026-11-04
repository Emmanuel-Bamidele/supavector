// LLM judge for answer correctness. One fixed prompt and one fixed model for
// every system compared, so a score difference is the systems, not the judge.
// OpenAI models grade by default; a `claude-*` model grades through the
// Anthropic API, so results can be checked by a judge from another vendor.

const { requestJson } = require("./http");

const JUDGE_PROMPT = `You grade answers to questions against a reference answer.

Rules:
- "correct" when the candidate states the same fact as the reference. Wording, extra detail and formatting do not matter; a contradicting or missing key fact does.
- When the reference says the information is insufficient or unknown, the candidate is correct ONLY if it declines to answer or says it does not know. Any confident answer is incorrect.
- When the reference has a real answer and the candidate declines or says it does not know, it is incorrect.
- Yes/no questions: the candidate must commit to the same yes or no.

Reply with JSON only: {"correct": true|false, "abstained": true|false, "reason": "<one short sentence>"}`;

const userMessage = ({ question, reference, candidate }) =>
  `Question: ${question}\n\nReference answer: ${reference}\n\nCandidate answer: ${candidate || "(empty)"}`;

// Behaviour grading for questions whose right answer depends on the AI's
// knowledge scope (decline, flag general knowledge, answer part of it, small
// talk). The set states the expected behaviour per scope instead of a fact.
const BEHAVIOUR_PROMPT = `You grade how an AI assistant handled one visitor message. The assistant speaks for its owner and is meant to answer from the owner's documents. You are told the behaviour that counts as right for this message.

Rules:
- "correct" only when the reply does what the expected behaviour says. A reply that states facts the expected behaviour says it must not state is incorrect, however accurate those facts are.
- "abstained": the reply says, for the whole message or part of it, that it does not have or know that information.
- "general_flagged": the reply explicitly says that some of what it says comes from general knowledge rather than its own knowledge, documents or sources.

Reply with JSON only: {"correct": true|false, "abstained": true|false, "general_flagged": true|false, "reason": "<one short sentence>"}`;

const behaviourMessage = ({ question, expected, reference, history, candidate }) =>
  `${history ? `Earlier in the conversation:\n${history}\n\n` : ""}Visitor message: ${question}\n\nExpected behaviour: ${expected}${reference ? `\n\nReference facts: ${reference}` : ""}\n\nAssistant reply: ${candidate || "(empty)"}`;

// Length is judged apart from correctness: a right answer can still be twice
// as long as the question needs, which is the failure this catches.
const LENGTH_PROMPT = `You judge whether an AI assistant's chat reply is the right LENGTH for the visitor's question. Do not judge whether it is correct.

A reply of the right length answers what was asked as directly as it can. A question after a single fact, number, name or yes/no gets a sentence or two. A how, why or step-by-step question gets what the visitor needs to understand it or do it, and no more.
- "too_long": it adds tips, caveats, background, alternatives or offers the visitor did not ask for and does not need, or says the same thing twice.
- "too_short": it leaves out something the question needs, such as a step, the reason asked for, or a part of the question.
- "right": neither.

Reply with JSON only: {"fit": "too_short"|"right"|"too_long", "reason": "<one short sentence>"}`;

const lengthMessage = ({ question, candidate }) => `Visitor question: ${question}\n\nAssistant reply: ${candidate || "(empty)"}`;

// Formatting, judged on its own: does the reply's structure fit its content,
// the way a good chat app formats? The reply is shown as raw Markdown.
const FORMAT_PROMPT = `You judge whether an AI assistant's chat reply is FORMATTED well for its content. Do not judge correctness or length. The reply is raw Markdown, which the chat renders.

Good formatting follows the content: a simple answer is a sentence or a short paragraph with no formatting; a procedure is numbered steps; several separate options or points are bullets; a comparison of a few things on the same attributes may be a small table; bold marks at most the one or two facts that matter most; headings appear only in a long answer with distinct parts.
- "over": structure where prose would read better, such as bullets for one or two points, a heading on a short answer, a table for something that is not a comparison, or bold scattered through the text.
- "under": a reply that crams steps, several options or a comparison into a paragraph where a list or table would clearly help.
- "right": neither.

Reply with JSON only: {"fit": "over"|"right"|"under", "reason": "<one short sentence>"}`;

function parseFormat(raw) {
  try {
    const parsed = parseJson(raw);
    const fit = String(parsed.fit || "");
    return ["over", "right", "under"].includes(fit) ? { fit, reason: String(parsed.reason || "") } : null;
  } catch {
    return null;
  }
}

function parseJson(raw) {
  // Tolerate a fenced or prefixed reply: take the outermost JSON object.
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

function parseVerdict(raw) {
  try {
    const parsed = parseJson(raw);
    return { correct: parsed.correct === true, abstained: parsed.abstained === true, reason: String(parsed.reason || "") };
  } catch {
    return { correct: false, abstained: false, reason: `unparseable judge output: ${String(raw || "").slice(0, 120)}` };
  }
}

function parseBehaviour(raw) {
  try {
    const parsed = parseJson(raw);
    return {
      correct: parsed.correct === true,
      abstained: parsed.abstained === true,
      generalFlagged: parsed.general_flagged === true,
      reason: String(parsed.reason || "")
    };
  } catch {
    return { correct: false, abstained: false, generalFlagged: false, reason: `unparseable judge output: ${String(raw || "").slice(0, 120)}` };
  }
}

// An unparseable length verdict is no verdict, never a "right".
function parseLength(raw) {
  try {
    const parsed = parseJson(raw);
    const fit = String(parsed.fit || "");
    return ["too_short", "right", "too_long"].includes(fit) ? { fit, reason: String(parsed.reason || "") } : null;
  } catch {
    return null;
  }
}

const RUBRICS = {
  answer: { prompt: JUDGE_PROMPT, message: userMessage, parse: parseVerdict },
  behaviour: { prompt: BEHAVIOUR_PROMPT, message: behaviourMessage, parse: parseBehaviour },
  length: { prompt: LENGTH_PROMPT, message: lengthMessage, parse: parseLength },
  format: { prompt: FORMAT_PROMPT, message: lengthMessage, parse: parseFormat }
};

function createOpenAiJudge({ apiKey, model, baseUrl, rubric }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the answer judge");
  return {
    model,
    async grade(input) {
      const payload = await requestJson(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: {
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: rubric.prompt },
            { role: "user", content: rubric.message(input) }
          ]
        },
        timeoutMs: 60_000
      });
      return rubric.parse(payload?.choices?.[0]?.message?.content);
    }
  };
}

function createAnthropicJudge({ apiKey, model, rubric }) {
  if (!apiKey) throw new Error("ANTHROPIC_EVAL_API_KEY or ANTHROPIC_API_KEY is required for a Claude judge");
  let withTemperature = true;
  return {
    model,
    async grade(input) {
      const send = () => requestJson("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: {
          model,
          max_tokens: 400,
          ...(withTemperature ? { temperature: 0 } : {}),
          system: rubric.prompt,
          messages: [{ role: "user", content: rubric.message(input) }]
        },
        timeoutMs: 120_000
      });
      let payload;
      try {
        payload = await send();
      } catch (err) {
        // Some models fix their own sampling; grade without the setting. Requests
        // already in flight when the first one learns this retry too.
        if (err.status !== 400 || !/temperature/i.test(String(err.message))) throw err;
        withTemperature = false;
        payload = await send();
      }
      const text = (payload?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return rubric.parse(text);
    }
  };
}

/** `rubric`: "answer" (fact against a reference), "behaviour", "length" or "format". */
function createJudge({ model = process.env.EVAL_JUDGE_MODEL || "gpt-4o", apiKey, baseUrl = "https://api.openai.com", rubric = "answer" } = {}) {
  const chosen = RUBRICS[rubric];
  if (!chosen) throw new Error(`unknown judge rubric ${rubric}`);
  if (/^claude/i.test(model)) {
    return createAnthropicJudge({ apiKey: apiKey || process.env.ANTHROPIC_EVAL_API_KEY || process.env.ANTHROPIC_API_KEY, model, rubric: chosen });
  }
  return createOpenAiJudge({ apiKey: apiKey || process.env.OPENAI_API_KEY, model, baseUrl, rubric: chosen });
}

module.exports = { createJudge, JUDGE_PROMPT, BEHAVIOUR_PROMPT, LENGTH_PROMPT, FORMAT_PROMPT, parseVerdict, parseBehaviour, parseLength, parseFormat };
