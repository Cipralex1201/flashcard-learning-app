type Step =
  | { t: "match"; typedIndex: number; expectedIndex: number }
  | { t: "sub"; typedIndex: number; expectedIndex: number }
  | { t: "ins"; typedIndex: number }
  | { t: "del"; expectedIndex: number };

type RawChar = {
  raw: string;
  comparable: string | null;
};

export type DiffChar = {
  ch: string;
  kind: "ok" | "bad" | "ignored";
};

const IGNORE_RE = /[\u0591-\u05C7?.()!;\-_'~]/;

function toComparableChars(s: string): RawChar[] {
  return Array.from(s.normalize("NFC")).map((ch) => ({
    raw: ch,
    comparable: IGNORE_RE.test(ch) ? null : ch.toLocaleLowerCase(),
  }));
}

/**
 * Returns per-character coloring for the USER'S typed string.
 * ignored chars stay visible and get kind="ignored"
 */
export function diffTypedToExpected(
  typedRaw: string,
  expectedRaw: string
): DiffChar[] {
  const typedChars = toComparableChars(typedRaw);
  const expectedChars = toComparableChars(expectedRaw);

  const typedComparable: Array<{ ch: string; rawIndex: number }> = [];
  const expectedComparable: Array<{ ch: string; rawIndex: number }> = [];

  for (let i = 0; i < typedChars.length; i++) {
    if (typedChars[i].comparable !== null) {
      typedComparable.push({ ch: typedChars[i].comparable!, rawIndex: i });
    }
  }

  for (let i = 0; i < expectedChars.length; i++) {
    if (expectedChars[i].comparable !== null) {
      expectedComparable.push({ ch: expectedChars[i].comparable!, rawIndex: i });
    }
  }

  const n = typedComparable.length;
  const m = expectedComparable.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = typedComparable[i - 1].ch === expectedComparable[j - 1].ch ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const steps: Step[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = typedComparable[i - 1].ch === expectedComparable[j - 1].ch ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        steps.push(
          cost === 0
            ? { t: "match", typedIndex: i - 1, expectedIndex: j - 1 }
            : { t: "sub", typedIndex: i - 1, expectedIndex: j - 1 }
        );
        i--;
        j--;
        continue;
      }
    }

    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      steps.push({ t: "ins", typedIndex: i - 1 });
      i--;
      continue;
    }

    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      steps.push({ t: "del", expectedIndex: j - 1 });
      j--;
      continue;
    }

    if (i > 0) {
      steps.push({ t: "ins", typedIndex: i - 1 });
      i--;
    } else {
      steps.push({ t: "del", expectedIndex: j - 1 });
      j--;
    }
  }

  steps.reverse();

  const rawKinds: Array<"ok" | "bad" | "ignored"> = typedChars.map((ch) =>
    ch.comparable === null ? "ignored" : "ok"
  );

  for (const st of steps) {
    if (st.t === "sub" || st.t === "ins") {
      const rawIndex = typedComparable[st.typedIndex].rawIndex;
      rawKinds[rawIndex] = "bad";
    }
  }

  return typedChars.map((item, idx) => ({
    ch: item.raw,
    kind: rawKinds[idx],
  }));
}