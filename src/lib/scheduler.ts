import type { Card, CardState, Question, Settings } from "./types";
import { similarity, topSimilarIndices } from "./similarity";
import { ensureState } from "./db";

const DAY = 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

function normTrim(s: string): string {
  return s.normalize("NFC").trim();
}

export function makePromptAnswer(card: Card, settings: Settings): { prompt: string; answer: string } {
  const a = settings.swap ? card.sideB : card.sideA;
  const b = settings.swap ? card.sideA : card.sideB;
  return { prompt: a, answer: b };
}

export function gradeWrite(typed: string, expected: string, trim: boolean): boolean {
  const t = trim ? normTrim(typed) : typed.normalize("NFC");
  const e = trim ? normTrim(expected) : expected.normalize("NFC");
  return t === e;
}

/**
 * SM-2 review update.
 * quality: 0..5
 * - <3 => lapse (reps reset, due soon)
 * - >=3 => success (interval grows, ease updated)
 */
function sm2Review(st: CardState, quality: number) {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const t = now();

  st.lastReviewedAt = t;

  if (q < 3) {
    st.lapses += 1;
    st.reps = 0;
    st.intervalDays = 0;
    // due again soon (but not immediately back-to-back)
    st.dueAt = t + 60_000; // 1 minute
    return;
  }

  // success
  st.reps += 1;

  if (st.reps === 1) st.intervalDays = 1;
  else if (st.reps === 2) st.intervalDays = 6;
  else st.intervalDays = st.intervalDays * st.ease;

  // Ease factor update (classic SM-2)
  // EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02))
  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  st.ease = Math.max(1.3, st.ease + delta);

  st.dueAt = t + st.intervalDays * DAY;
}

/**
 * Your mapping:
 * MC correct => 4 (Good)
 * WRITE correct => 5 (Easy)
 * Any wrong => 2 (Again)
 */
function autoQuality(kind: "mc" | "write", correct: boolean): number {
  if (!correct) return 2;
  return kind === "write" ? 5 : 4;
}

/**
 * Apply graded result to a card.
 * NOTE: signature changed vs your old code.
 */
export function applyAnswer(
  states: Record<string, CardState>,
  cardId: string,
  kind: "mc" | "write",
  correct: boolean
) {
  const st = ensureState(states, cardId);
  sm2Review(st, autoQuality(kind, correct));
}

/**
 * Chunk building (kept for your UI), but now driven by SM-2:
 * - always include due cards (dueAt <= now)
 * - fill remaining with "new" cards (never reviewed) grouped by similarity
 */
function pickDue(cards: Card[], states: Record<string, CardState>): string[] {
  const t = now();
  const due = cards
    .map((c) => ensureState(states, c.id))
    .filter((s) => s.dueAt <= t)
    .sort((a, b) => a.dueAt - b.dueAt || a.lastShownAt - b.lastShownAt)
    .map((s) => s.id);
  return due;
}

// New = never reviewed
function pickNew(cards: Card[], states: Record<string, CardState>): Card[] {
  return cards.filter((c) => ensureState(states, c.id).lastReviewedAt === 0);
}

// Select "confusable together" new cards (similar answers)
function pickNewBySimilarity(cards: Card[], states: Record<string, CardState>, settings: Settings): string[] {
  const unseen = pickNew(cards, states);
  if (unseen.length === 0) return [];

  const want = Math.min(settings.newPerChunk, unseen.length);

  const chosen: Card[] = [unseen[0]];
  while (chosen.length < want) {
    const seed = chosen[0];
    const seedAns = makePromptAnswer(seed, settings).answer;

    let best: Card | null = null;
    let bestS = -1;
    for (const c of unseen) {
      if (chosen.some((x) => x.id === c.id)) continue;
      const s = similarity(seedAns, makePromptAnswer(c, settings).answer);
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }

  return chosen.map((c) => c.id);
}

export function buildChunk(cards: Card[], states: Record<string, CardState>, settings: Settings): string[] {
  if (cards.length === 0) return [];

  const due = pickDue(cards, states);

  // Build with due first
  const out: string[] = [];
  for (const id of due) {
    if (out.length >= settings.chunkSize) break;
    out.push(id);
  }

  // Fill with new cards (similarity-grouped)
  if (out.length < settings.chunkSize) {
    const fresh = pickNewBySimilarity(cards, states, settings);
    for (const id of fresh) {
      if (out.length >= settings.chunkSize) break;
      if (!out.includes(id)) out.push(id);
    }
  }

  // Fill any remaining with not-due-yet reviewed cards (soonest due)
  if (out.length < settings.chunkSize) {
    const t = now();
    const rest = cards
      .map((c) => ensureState(states, c.id))
      .filter((s) => !out.includes(s.id))
      .sort((a, b) => a.dueAt - b.dueAt || a.lastShownAt - b.lastShownAt)
      .map((s) => s.id);

    for (const id of rest) {
      if (out.length >= settings.chunkSize) break;
      out.push(id);
    }
  }

  return out;
}

/**
 * Score within chunk using SM-2 (due time) + anti-repeat rule.
 * Lower score is better.
 */
function pickBestInChunk(chunkIds: string[], states: Record<string, CardState>): string | null {
  if (chunkIds.length === 0) return null;

  const t = now();

  // Find the most recently shown card time in this chunk
  let mostRecentShown = 0;
  for (const id of chunkIds) {
    const s = ensureState(states, id);
    if (s.lastShownAt > mostRecentShown) mostRecentShown = s.lastShownAt;
  }

  let bestId: string | null = null;
  let bestScore = Infinity;

  for (const id of chunkIds) {
    const s = ensureState(states, id);

    // Base: due soonest first (overdue wins)
    let score = s.dueAt;

    // Prefer due cards strongly
    if (s.dueAt <= t) score -= 1e12;

    // Anti-repeat: if this card was just shown most recently, penalize
    // (prevents "megy" 10x unless it’s literally the only option)
    if (s.lastShownAt === mostRecentShown && chunkIds.length > 1) {
      score += 1e12;
    }

    // Secondary: avoid cards shown very recently (last 20s)
    if (t - s.lastShownAt < 20_000) score += 5e11;

    if (score < bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  return bestId;
}

export function makeQuestion(
  cards: Card[],
  states: Record<string, CardState>,
  settings: Settings,
  chunkIds: string[]
): Question | null {
  if (chunkIds.length === 0) return null;

  const bestId = pickBestInChunk(chunkIds, states);
  if (!bestId) return null;

  const card = cards.find((c) => c.id === bestId);
  if (!card) return null;

  // mark shown (important for anti-repeat + snappy input resets via qid)
  ensureState(states, bestId).lastShownAt = now();

  const { prompt, answer } = makePromptAnswer(card, settings);

  const mode =
    settings.mode === "mix" ? (Math.random() < 0.5 ? "mc" : "write") : settings.mode;

  const qid = crypto.randomUUID();

  if (mode === "write") {
    return { kind: "write", qid, cardId: card.id, prompt, expected: answer };
  }

  // MC: distractors by similarity on answer side
  const answers = cards.map((c) => makePromptAnswer(c, settings).answer);
  const idx = cards.findIndex((c) => c.id === card.id);
  const similarIdx = topSimilarIndices(answers, idx, 12);
  const distractorIdx = similarIdx.slice(0, 3);

  while (distractorIdx.length < 3 && distractorIdx.length < cards.length - 1) {
    const r = Math.floor(Math.random() * cards.length);
    if (r !== idx && !distractorIdx.includes(r)) distractorIdx.push(r);
  }

  const options = [answer, ...distractorIdx.map((i) => answers[i])].sort(() => Math.random() - 0.5);
  return { kind: "mc", qid, cardId: card.id, prompt, correct: answer, options };
}

