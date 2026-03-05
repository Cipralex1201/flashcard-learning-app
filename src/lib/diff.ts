type Step =
  | { t: "match"; ch: string }
  | { t: "sub"; typed: string; expected: string }
  | { t: "ins"; ch: string } // typed inserted
  | { t: "del"; ch: string }; // expected deleted

function normalize(s: string): string {
  return s.normalize("NFC");
}

/**
 * Returns per-character coloring for the USER'S typed string.
 * "badly typed letters in red": any inserted/substituted typed char is red.
 */
export function diffTypedToExpected(typedRaw: string, expectedRaw: string): Array<{ ch: string; ok: boolean }> {
  const typed = normalize(typedRaw);
  const expected = normalize(expectedRaw);
  const n = typed.length;
  const m = expected.length;

  // dp[i][j] = edit distance for typed[0..i) vs expected[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = typed[i - 1] === expected[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,        // delete from typed (i.e., insertion relative to expected)
        dp[i][j - 1] + 1,        // insert into typed (i.e., deletion relative to expected)
        dp[i - 1][j - 1] + cost  // sub/match
      );
    }
  }

  // Backtrack to steps
  const steps: Step[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = typed[i - 1] === expected[j - 1] ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        if (cost === 0) steps.push({ t: "match", ch: typed[i - 1] });
        else steps.push({ t: "sub", typed: typed[i - 1], expected: expected[j - 1] });
        i--; j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      steps.push({ t: "ins", ch: typed[i - 1] });
      i--;
      continue;
    }
    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      steps.push({ t: "del", ch: expected[j - 1] });
      j--;
      continue;
    }
    // fallback (shouldn't happen)
    if (i > 0) { steps.push({ t: "ins", ch: typed[i - 1] }); i--; }
    else { steps.push({ t: "del", ch: expected[j - 1] }); j--; }
  }
  steps.reverse();

  // Build coloring for typed characters only
  const out: Array<{ ch: string; ok: boolean }> = [];
  for (const st of steps) {
    if (st.t === "match") out.push({ ch: st.ch, ok: true });
    if (st.t === "sub") out.push({ ch: st.typed, ok: false });
    if (st.t === "ins") out.push({ ch: st.ch, ok: false });
    // deletion doesn't add a typed char
  }
  return out;
}
