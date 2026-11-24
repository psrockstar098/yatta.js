// Full-text search helpers: tokenization, FTS5 phrase building, synonym
// normalization, and typo correction (trigram + edit distance).
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).
// Internal to the db layer — NOT part of the public API.

// ── Full-text search helpers ───────────────────────────────────────────────
// These exist so a search query can never become SQL or FTS5 syntax. The
// query is reduced to plain word tokens first; the MATCH expression is then
// rebuilt from those tokens only, each one double-quoted. Quote marks,
// wildcards, `OR`/`AND`, `column:` prefixes, and every other FTS5 operator
// in the raw input are stripped by tokenization before they can reach the
// query — they arrive as words, or not at all.

/** Splits text into lowercase word tokens, the way FTS5's unicode61 tokenizer sees them. */
export function tokenizeText(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Renders one token as a quoted FTS5 term. The doubling is belt-and-braces: tokens carry no quotes by construction. */
export function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Renders a synonym phrase ("notebook computer") as one quoted FTS5 phrase, or a single term. */
export function ftsPhrase(tokens: string[]): string {
  if (tokens.length === 0) return `""`;
  if (tokens.length === 1) return quoteFtsTerm(tokens[0]!);
  return `"${tokens.map((t) => t.replace(/"/g, '""')).join(" ")}"`;
}

/** Normalizes a synonym map: keys lowercased, values split into token lists (one list per synonym phrase). */
export function normalizeSynonyms(
  map: Record<string, string | string[]> | undefined,
): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  if (!map) return out;
  for (const [key, value] of Object.entries(map)) {
    const phrases = (Array.isArray(value) ? value : [value])
      .map((v) => tokenizeText(v))
      .filter((t) => t.length > 0);
    if (phrases.length > 0) out.set(key.toLowerCase(), phrases);
  }
  return out;
}

/** The trigrams of a word, padded so short words still get trigrams. */
function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of two trigram sets: shared trigrams over all trigrams. */
function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared || 1);
}

/** Plain edit distance (insert, delete, substitute), for short vocabulary words. */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * Corrects one query token against the indexed vocabulary, or returns null.
 *
 * Two gates, both deliberate: the candidate must share enough trigrams with
 * the query (so unrelated words never qualify), and be within a small edit
 * distance (1 for short words, 2 for longer ones). The best candidate wins
 * on edit distance, then trigram similarity. A word with no candidate keeps
 * its original spelling and simply matches nothing — inventing a correction
 * for a genuinely unknown word would return wrong rows with confidence.
 */
export function correctTypo(token: string, vocabulary: Set<string>): string | null {
  if (token.length < 3) return null;
  const maxDistance = token.length <= 4 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = Infinity;
  let bestSimilarity = 0;
  for (const term of vocabulary) {
    if (term === token) return token;
    if (Math.abs(term.length - token.length) > maxDistance) continue;
    const similarity = trigramSimilarity(token, term);
    if (similarity < 0.3) continue;
    const distance = levenshtein(token, term);
    if (distance > maxDistance) continue;
    if (distance < bestDistance || (distance === bestDistance && similarity > bestSimilarity)) {
      best = term;
      bestDistance = distance;
      bestSimilarity = similarity;
    }
  }
  return best;
}
