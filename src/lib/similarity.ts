function normalize(s: string): string {
  return s.normalize("NFC");
}

export function levenshtein(aRaw: string, bRaw: string): number {
  const a = normalize(aRaw);
  const b = normalize(bRaw);
  const n = a.length;
  const m = b.length;

  if (n === 0) return m;
  if (m === 0) return n;

  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,      // deletion
        dp[j - 1] + 1,  // insertion
        prev + cost     // substitution
      );
      prev = tmp;
    }
  }
  return dp[m];
}

export function normalizedLevSim(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length, 1);
  const d = levenshtein(a, b);
  return 1 - d / maxLen; // 1 = identical
}

function bigrams(sRaw: string): string[] {
  const s = normalize(sRaw);
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

export function bigramJaccard(a: string, b: string): number {
  const A = new Set(bigrams(a));
  const B = new Set(bigrams(b));
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

export function similarity(a: string, b: string): number {
  // Weighted to favor "looks similar"
  const lev = normalizedLevSim(a, b);
  const jac = bigramJaccard(a, b);
  return 0.65 * lev + 0.35 * jac;
}

export function topSimilarIndices(
  all: string[],
  targetIndex: number,
  k: number
): number[] {
  const target = all[targetIndex];
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < all.length; i++) {
    if (i === targetIndex) continue;
    scored.push({ i, s: similarity(target, all[i]) });
  }
  scored.sort((x, y) => y.s - x.s);
  return scored.slice(0, k).map(x => x.i);
}
