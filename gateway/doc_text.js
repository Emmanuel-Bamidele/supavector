// Whole-document text: rebuilt from chunks for documents indexed before the
// original text was stored. Legacy "token" chunks overlap their predecessor
// by a run of whitespace tokens; that run is detected and dropped so the
// rebuilt text reads once. Chunks with no overlap are joined as paragraphs.

const MAX_OVERLAP_TOKENS = 120;

function overlapLength(prevText, nextText) {
  const prev = String(prevText || "").split(/\s+/).filter(Boolean).slice(-MAX_OVERLAP_TOKENS);
  const next = String(nextText || "").split(/\s+/).filter(Boolean).slice(0, MAX_OVERLAP_TOKENS);
  for (let k = Math.min(prev.length, next.length); k > 0; k -= 1) {
    let match = true;
    for (let i = 0; i < k; i += 1) {
      if (prev[prev.length - k + i] !== next[i]) { match = false; break; }
    }
    // A one- or two-word "overlap" is usually coincidence, not a window seam.
    if (match) return k >= 3 ? k : 0;
  }
  return 0;
}

function dropLeadingTokens(text, count) {
  let rest = String(text || "").replace(/^\s+/, "");
  for (let i = 0; i < count; i += 1) rest = rest.replace(/^\S+\s*/, "");
  return rest;
}

/** @param {string[]} texts chunk texts in idx order */
function joinChunkTexts(texts) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || "")).filter((t) => t.trim());
  if (!list.length) return "";
  let out = list[0].trim();
  for (let i = 1; i < list.length; i += 1) {
    const overlap = overlapLength(out, list[i]);
    out = overlap
      ? `${out} ${dropLeadingTokens(list[i], overlap)}`.trim()
      : `${out}\n\n${list[i].trim()}`;
  }
  return out;
}

module.exports = { joinChunkTexts, overlapLength };
