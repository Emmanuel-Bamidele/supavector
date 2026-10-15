// Chunk context ("contextual retrieval").
//
// A bare chunk often lacks what makes it findable: which document it is from,
// which section, which product or year "it" refers to. Each chunk gets:
//   - a deterministic header: the document title and the section path; and
//   - when a model is configured, one or two sentences situating the chunk in
//     its document, written in batches with the document as a shared prefix
//     (short documents in full; long ones as a synopsis plus the nearby text).
// The context is embedded and keyword-indexed with the chunk and shown to the
// answer model, but stored apart from the chunk's own text. Any failure falls
// back to the header alone: ingest never fails because of context.

const { generateProviderText } = require("./provider_clients");

const ENABLED = process.env.CHUNK_CONTEXT_ENABLED !== "0";
const PROVIDER = String(process.env.CHUNK_CONTEXT_PROVIDER || "openai").trim().toLowerCase();
const MODEL = String(process.env.CHUNK_CONTEXT_MODEL || "gpt-4.1-mini").trim();
const FULL_DOC_CHARS = parseInt(process.env.CHUNK_CONTEXT_FULL_DOC_CHARS || "60000", 10);
const BATCH_SIZE = parseInt(process.env.CHUNK_CONTEXT_BATCH || "10", 10);
const CONCURRENCY = parseInt(process.env.CHUNK_CONTEXT_CONCURRENCY || "4", 10);
const TIMEOUT_MS = parseInt(process.env.CHUNK_CONTEXT_TIMEOUT_MS || "60000", 10);

const CONTEXT_INSTRUCTIONS = `You write retrieval context for excerpts of a document.
For EACH excerpt, write one or two sentences (at most 60 words) that situate it within the whole document: what the document is, which part or topic the excerpt belongs to, and what it is about. When the document states its date, author or publisher, include them. Name the entities, products, people, places, dates or terms the excerpt refers to only implicitly ("it", "this policy", "the second step"). Do not restate the excerpt and do not add facts that are not in the document.
Return JSON: {"contexts": ["...", "..."]} with exactly one entry per excerpt, in order.`;

const SYNOPSIS_INSTRUCTIONS = `Describe this document for someone who will read isolated excerpts of it: what it is, who wrote or published it and when (if stated), who it is for, its structure and its main topics, in at most 120 words. Plain prose, no lists.`;

function modelAvailable() {
  if (!ENABLED) return false;
  if (PROVIDER === "openai") return Boolean(process.env.OPENAI_API_KEY);
  if (PROVIDER === "gemini") return Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API);
  if (PROVIDER === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  return false;
}

const oneLine = (text) => String(text || "").replace(/\s+/g, " ").trim();

function headerFor(title, heading, date) {
  return [
    title ? `Document: ${oneLine(title)}` : null,
    date ? `Date: ${oneLine(date)}` : null,
    heading ? `Section: ${oneLine(heading)}` : null
  ].filter(Boolean).join("\n");
}

// A document's own date (published / dated / updated), so every chunk knows
// when its document is from, not only the first one: metadata first, else a
// labelled date line near the top of the text.
const DATE_METADATA_KEYS = ["publishedAt", "published_at", "date", "effectiveAt", "effective_at", "updatedAt", "updated_at"];
const DATE_LINE_RE = /^\s*(?:published|publication date|date|dated|posted|updated|last updated)\s*[:\-–]\s*(.{4,60})$/im;
function documentDate(text, metadata) {
  for (const key of DATE_METADATA_KEYS) {
    const value = metadata && typeof metadata === "object" ? metadata[key] : null;
    if (value && String(value).trim()) return String(value).trim().slice(0, 60);
  }
  const head = String(text || "").slice(0, 800);
  const match = head.match(DATE_LINE_RE);
  return match ? match[1].trim() : null;
}

function addUsage(total, usage) {
  if (!usage) return;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  total.input_tokens += input;
  total.output_tokens += output;
  total.total_tokens += Number(usage.total_tokens ?? input + output);
}

async function generate(system, user, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await generateProviderText({
      provider: PROVIDER,
      model: MODEL,
      input: { system, user },
      temperature: 0,
      jsonMode: system === CONTEXT_INSTRUCTIONS,
      maxTokens,
      maxRetries: 1,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Synopsis of a long document from its opening, middle and end. */
async function synopsisFor(title, text, usage) {
  const third = Math.floor(FULL_DOC_CHARS / 3);
  const middle = Math.max(0, Math.floor(text.length / 2) - third / 2);
  const sample = `${text.slice(0, third)}\n[...]\n${text.slice(middle, middle + third)}\n[...]\n${text.slice(-third)}`;
  const result = await generate(SYNOPSIS_INSTRUCTIONS, `<document title="${oneLine(title)}">\n${sample}\n</document>`, 240);
  addUsage(usage, result?.usage);
  return oneLine(result?.text);
}

/**
 * @param {{title: string, text: string, chunks: Array<{text: string, heading?: string}>}} doc
 * @returns {Promise<{contexts: string[], usage: object|null, generated: number}>}
 */
async function buildChunkContexts({ title, text, chunks, metadata = null, allowModel = true }) {
  const list = Array.isArray(chunks) ? chunks : [];
  const date = documentDate(text, metadata);
  const headers = list.map((c) => headerFor(title, c.heading, date));
  if (!allowModel || !modelAvailable() || !list.length) {
    return { contexts: headers, usage: null, generated: 0 };
  }
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const sentences = new Array(list.length).fill("");
  try {
    const fullDoc = text.length <= FULL_DOC_CHARS;
    const prefix = fullDoc
      ? `<document title="${oneLine(title)}">\n${text}\n</document>`
      : `<document title="${oneLine(title)}">\nSynopsis: ${await synopsisFor(title, text, usage)}\n</document>`;
    const batches = [];
    for (let i = 0; i < list.length; i += BATCH_SIZE) batches.push(i);
    let next = 0;
    const lane = async () => {
      while (next < batches.length) {
        const start = batches[next++];
        const slice = list.slice(start, start + BATCH_SIZE);
        // Long documents also see the text just before the batch.
        const before = fullDoc || start === 0 ? "" : `\n\nText just before these excerpts:\n${list[start - 1].text.slice(-1500)}`;
        const excerpts = slice.map((c, j) => `[${j + 1}]${c.heading ? ` (section: ${oneLine(c.heading)})` : ""}\n${c.text}`).join("\n\n");
        try {
          const result = await generate(CONTEXT_INSTRUCTIONS, `${prefix}${before}\n\nExcerpts:\n${excerpts}`, 90 * slice.length + 40);
          addUsage(usage, result?.usage);
          const contexts = JSON.parse(result?.text || "{}").contexts;
          if (Array.isArray(contexts)) {
            slice.forEach((_, j) => { sentences[start + j] = oneLine(contexts[j]).slice(0, 400); });
          }
        } catch {
          // This batch keeps its headers only.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, batches.length)) }, lane));
  } catch {
    return { contexts: headers, usage: usage.total_tokens ? usage : null, generated: 0 };
  }
  const contexts = headers.map((header, i) => [header, sentences[i]].filter(Boolean).join("\n"));
  return { contexts, usage: usage.total_tokens ? usage : null, generated: sentences.filter(Boolean).length };
}

module.exports = { buildChunkContexts, headerFor, documentDate };
