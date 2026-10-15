// Structure-aware chunking.
//
// Chunks follow the document's own sections: headings are detected (markdown,
// numbered, ALL-CAPS and title-like lines), each chunk carries its heading
// path, and paragraphs fill a chunk up to a word budget without ever crossing
// a section boundary. There is no overlap: neighbouring chunks are fetched at
// answer time instead, and joining a document's chunks in order reproduces
// its text, which callers rely on to rebuild documents.

const DEFAULT_MAX_WORDS = 300;
const DEFAULT_MIN_WORDS = 60;
const MAX_HEADING_CHARS = 90;

const wordCount = (text) => (String(text || "").match(/\S+/g) || []).length;

/** Returns {level, title} when `line` reads as a heading, else null. */
function detectHeading(line, prevBlank, nextBlank) {
  const clean = String(line || "").trim();
  if (!clean || clean.length > MAX_HEADING_CHARS) return null;
  const md = clean.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  if (md) return { level: md[1].length, title: md[2].trim() };
  const numbered = clean.match(/^((?:\d+\.){0,3}\d+)\.?\s+([A-Z][^.!?]{1,80})$/);
  if (numbered && !/[.:;,]$/.test(clean)) return { level: Math.min(6, numbered[1].split(".").length + 1), title: clean };
  const letters = clean.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && wordCount(clean) <= 10 && !/[.!?,;]$/.test(clean)) {
    return { level: 2, title: clean };
  }
  // A short Title Case line standing alone between blank lines.
  if (prevBlank && nextBlank && wordCount(clean) <= 10 && !/[.!?,;:]$/.test(clean)) {
    const words = clean.split(/\s+/);
    const capitalised = words.filter((w) => /^[A-Z0-9]/.test(w)).length;
    if (capitalised / words.length >= 0.6) return { level: 3, title: clean };
  }
  return null;
}

/** Split text into sections: [{path: string[], body: string}]. */
function splitSections(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  const stack = [];
  let body = [];
  const flush = () => {
    const joined = body.join("\n").trim();
    if (joined) sections.push({ path: stack.map((h) => h.title), body: joined });
    body = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const heading = detectHeading(lines[i], i === 0 || !lines[i - 1].trim(), i === lines.length - 1 || !lines[i + 1].trim());
    if (!heading) {
      body.push(lines[i]);
      continue;
    }
    flush();
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    stack.push(heading);
    // The heading line stays in the text so a rebuilt document keeps it.
    body.push(lines[i]);
  }
  flush();
  return sections;
}

/** Break one long paragraph at sentence ends (then at words) within budget. */
function splitParagraph(paragraph, maxWords) {
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) || [paragraph];
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && wordCount(current) + wordCount(sentence) > maxWords) {
      parts.push(current.trim());
      current = "";
    }
    if (wordCount(sentence) > maxWords) {
      const words = sentence.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += maxWords) parts.push(words.slice(i, i + maxWords).join(" "));
      continue;
    }
    current += sentence;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function chunkStructured(text, { maxWords = DEFAULT_MAX_WORDS, minWords = DEFAULT_MIN_WORDS } = {}) {
  const chunks = [];
  for (const section of splitSections(text)) {
    const heading = section.path.join(" › ");
    const paragraphs = section.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .flatMap((p) => (wordCount(p) > maxWords ? splitParagraph(p, maxWords) : [p]));
    let current = [];
    let words = 0;
    for (const p of paragraphs) {
      const n = wordCount(p);
      if (current.length && words + n > maxWords) {
        chunks.push({ text: current.join("\n\n"), heading });
        current = [];
        words = 0;
      }
      current.push(p);
      words += n;
    }
    if (current.length) chunks.push({ text: current.join("\n\n"), heading });
  }
  // A lone heading or one-line remainder never becomes its own search target:
  // fold a tiny chunk forward into the next chunk of its section, else back
  // into the previous one, allowing a modest overflow of the word budget.
  const limit = maxWords * 1.25;
  const forward = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = { ...chunks[i] };
    const next = chunks[i + 1];
    if (next && next.heading === chunk.heading && wordCount(chunk.text) < minWords && wordCount(chunk.text) + wordCount(next.text) <= limit) {
      chunks[i + 1] = { ...next, text: `${chunk.text}\n\n${next.text}` };
      continue;
    }
    forward.push(chunk);
  }
  const merged = [];
  for (const chunk of forward) {
    const prev = merged.at(-1);
    if (prev && prev.heading === chunk.heading && wordCount(chunk.text) < minWords && wordCount(prev.text) + wordCount(chunk.text) <= limit) {
      prev.text = `${prev.text}\n\n${chunk.text}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

module.exports = { chunkStructured, splitSections, detectHeading, wordCount };
