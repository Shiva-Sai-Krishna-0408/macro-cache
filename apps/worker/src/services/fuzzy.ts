/** Small, dependency-free fuzzy matcher for a single user's food list. */

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = new Set<string>();
  const p = `  ${s} `;
  for (let i = 0; i < p.length - 2; i++) t.add(p.slice(i, i + 3));
  return t;
}

/** 1 − normalized Levenshtein distance. */
function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  return inter / (ta.size + tb.size - inter || 1);
}

/** Score 0–1 of how well `query` matches any of the candidate strings. */
export function fuzzyScore(query: string, candidates: (string | null | undefined)[]): number {
  const q = normalize(query);
  if (!q) return 0;
  const qTokens = q.split(" ");
  let best = 0;
  for (const raw of candidates) {
    if (!raw) continue;
    const c = normalize(raw);
    if (!c) continue;
    let s: number;
    if (c === q) s = 1;
    else if (c.startsWith(q)) s = 0.92;
    else if (c.includes(q)) s = 0.85;
    else {
      const cTokens = c.split(" ");
      const tokenHits = qTokens.filter((t) => cTokens.some((ct) => ct.startsWith(t) || (t.length > 3 && editSimilarity(t, ct) >= 0.75))).length;
      s = 0.75 * (tokenHits / qTokens.length) * 0.9 + 0.25 * trigramSimilarity(q, c);
    }
    best = Math.max(best, s);
  }
  return best;
}
