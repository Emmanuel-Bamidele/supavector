// Numbered inline citations.
//
// Sources reach the model labelled [1]..[n]; the model cites them inline right
// after the sentence they support. We then keep only markers that point at a
// source the model was actually shown, drop the rest, and renumber the
// survivors 1..m in order of first appearance, so the answer's [k] always
// means citations[k-1]. An answer with no valid markers has no citations:
// nothing is attached on the model's behalf.

const MARKER_RE = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;

/** Header label for source i (0-based) in numbered mode. */
function numberedSourceLabel(index) {
  return `[${index + 1}]`;
}

/**
 * @param {string} text   model output
 * @param {Array}  chunks the sources in the order they were numbered
 * @returns {{answer: string, citations: string[]}} citations = chunk ids, citations[k-1] ↔ "[k]"
 */
function resolveNumberedCitations(text, chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const order = [];            // source index (0-based) in first-appearance order
  const renumber = new Map();  // source index -> new 1-based number
  const raw = String(text || "");
  let answer = raw.replace(MARKER_RE, (match, inner) => {
    const numbers = inner.split(/[,;]/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    const valid = [];
    for (const n of numbers) {
      const index = n - 1;
      if (index < 0 || index >= list.length || !list[index]?.chunk_id) continue;
      if (!renumber.has(index)) {
        order.push(index);
        renumber.set(index, order.length);
      }
      const mapped = renumber.get(index);
      if (!valid.includes(mapped)) valid.push(mapped);
    }
    return valid.map((n) => `[${n}]`).join("");
  });
  // Tidy what marker removal can leave behind: "word [9]." -> "word ."
  answer = answer.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  // A trailing "Citations: ..." line is not part of this mode; drop it if the model added one.
  answer = answer.replace(/\n*\s*(?:Citations|Sources|References):[^\n]*$/i, "").trim();
  return { answer, citations: order.map((index) => list[index].chunk_id) };
}

/**
 * Streaming counterpart of resolveNumberedCitations: renumbers [n] markers as
 * tokens arrive, with the same first-appearance rule, so streamed text matches
 * the final answer instead of jumping when it lands. A marker split across
 * tokens ("[" then "3]") is held back until it is complete.
 */
function createMarkerRenumberer(sourceCount) {
  const renumber = new Map();
  let pending = "";
  const map = (inner) => {
    const valid = [];
    for (const raw of inner.split(/[,;]/)) {
      const index = Number(raw.trim()) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= sourceCount) continue;
      if (!renumber.has(index)) renumber.set(index, renumber.size + 1);
      const mapped = renumber.get(index);
      if (!valid.includes(mapped)) valid.push(mapped);
    }
    return valid.map((n) => `[${n}]`).join("");
  };
  return {
    push(delta) {
      const text = pending + String(delta || "");
      // Hold back an unfinished "[12" or "[1, 3" at the end of this piece.
      const open = text.lastIndexOf("[");
      const cut = open >= 0 && text.indexOf("]", open) < 0 && /^\[[\d,;\s]{0,12}$/.test(text.slice(open)) ? open : text.length;
      pending = text.slice(cut);
      return text.slice(0, cut).replace(MARKER_RE, (m, inner) => map(inner));
    },
    flush() {
      const rest = pending;
      pending = "";
      return rest.replace(MARKER_RE, (m, inner) => map(inner));
    }
  };
}

/** Strip all [n] markers (for speech, plain-text history, share cards). */
function stripCitationMarkers(text) {
  return String(text || "").replace(MARKER_RE, "").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

module.exports = { numberedSourceLabel, resolveNumberedCitations, createMarkerRenumberer, stripCitationMarkers };
