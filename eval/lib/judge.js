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

function parseVerdict(raw) {
  // Tolerate a fenced or prefixed reply: take the outermost JSON object.
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  try {
    const parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
    return { correct: parsed.correct === true, abstained: parsed.abstained === true, reason: String(parsed.reason || "") };
  } catch {
    return { correct: false, abstained: false, reason: `unparseable judge output: ${text.slice(0, 120)}` };
  }
}

function createOpenAiJudge({ apiKey, model, baseUrl }) {
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
            { role: "system", content: JUDGE_PROMPT },
            { role: "user", content: userMessage(input) }
          ]
        },
        timeoutMs: 60_000
      });
      return parseVerdict(payload?.choices?.[0]?.message?.content);
    }
  };
}

function createAnthropicJudge({ apiKey, model }) {
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
          system: JUDGE_PROMPT,
          messages: [{ role: "user", content: userMessage(input) }]
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
      return parseVerdict(text);
    }
  };
}

function createJudge({ model = process.env.EVAL_JUDGE_MODEL || "gpt-4o", apiKey, baseUrl = "https://api.openai.com" } = {}) {
  if (/^claude/i.test(model)) {
    return createAnthropicJudge({ apiKey: apiKey || process.env.ANTHROPIC_EVAL_API_KEY || process.env.ANTHROPIC_API_KEY, model });
  }
  return createOpenAiJudge({ apiKey: apiKey || process.env.OPENAI_API_KEY, model, baseUrl });
}

module.exports = { createJudge, JUDGE_PROMPT, parseVerdict };
