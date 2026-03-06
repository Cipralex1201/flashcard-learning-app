import type { Card, CardState, Question, Settings } from "./types";
import { ensureState } from "./db";
import { topSimilarIndices } from "./similarity";

const DAY = 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

function normTrim(s: string): string {
  return s.normalize("NFC").trim();
}

export function makePromptAnswer(card: Card, settings: Settings): { prompt: string; answer: string } {
  const prompt = settings.swap ? card.sideB : card.sideA;
  const answer = settings.swap ? card.sideA : card.sideB;
  return { prompt, answer };
}

export function gradeWrite(typed: string, expected: string, trim: boolean): boolean {
  const t = trim ? normTrim(typed) : typed.normalize("NFC");
  const e = trim ? normTrim(expected) : expected.normalize("NFC");
  return t === e;
}

/**
 * SM-2 update:
 * quality 0..5
 */
function sm2Review(st: CardState, quality: number) {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const t = now();

  st.lastReviewedAt = t;

  if (q < 3) {
    st.lapses += 1;
    st.reps = 0;
    st.intervalDays = 0;
    // re-ask soon, but not instantly
    st.dueAt = t + 60_000; // 1 min
    // ease is not changed on failure in classic SM-2
    return;
  }

  st.reps += 1;

  if (st.reps === 1) st.intervalDays = 1;
  else if (st.reps === 2) st.intervalDays = 6;
  else st.intervalDays = st.intervalDays * st.ease;

  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  st.ease = Math.max(1.3, st.ease + delta);

  st.dueAt = t + st.intervalDays * DAY;
}

/**
 * Your rule:
 * - MC wrong => Again (2)
 * - MC correct => Good (4)
 * - WRITE wrong => Again (2)
 * - WRITE correct => Easy (5)
 */
function autoQuality(kind: "mc" | "write", correct: boolean): number {
  if (!correct) return 2;
  return kind === "write" ? 5 : 4;
}

export function applyAnswer(
  states: Record<string, CardState>,
  cardId: string,
  kind: "mc" | "write",
  correct: boolean
) {
  const st = ensureState(states, cardId);
  sm2Review(st, autoQuality(kind, correct));
}

/* =========================================================
   SLIDING-BOX SELECTION ("keep asking the same 10")

   Goal:
   - Work within a small active "box" (default 10 cards).
   - Do NOT pull in more new cards until the whole box is "easy".
   - When the current box is all easy, slide forward by 5:
       drop 5, add 5 new.
   - When the entire set becomes easy, the box becomes the entire set.

   This keeps brand-new sets from flooding you with new words.
   ========================================================= */

const BOX_SIZE = 10;
const SLIDE_BY = 5;

function isEasy(st: CardState): boolean {
  // Keep this consistent with the UI's "Easy" counter.
  return st.reps >= 3 && st.ease >= 2.5 && st.intervalDays >= 15;
}

function allEasyInPool(states: Record<string, CardState>, ids: string[]): boolean {
  return ids.length > 0 && ids.every((id) => isEasy(ensureState(states, id)));
}

function allEasyInDeck(cards: Card[], states: Record<string, CardState>): boolean {
  return cards.length > 0 && cards.every((c) => isEasy(ensureState(states, c.id)));
}


/**
 * Pick next card only from the active pool (chunkIds).
 *
 * Priority INSIDE the pool:
 * 1) due reviews (including failed cards due soon)
 * 2) new cards inside the box
 * 3) earliest upcoming review inside the box
 *
 * Anti-repeat: avoid showing the exact same card twice in a row if possible.
 */
function pickNextCardId(cards: Card[], states: Record<string, CardState>, poolIds: string[]): string | null {
  const t = now();
  if (poolIds.length === 0) return null;

  const pool = new Set(poolIds);

  const learnedDue: CardState[] = [];
  const learnedNotDue: CardState[] = [];
  const newIds: string[] = [];

  for (const c of cards) {
    if (!pool.has(c.id)) continue;
    const s = ensureState(states, c.id);

    if (s.lastReviewedAt === 0) {
      newIds.push(c.id);
      continue;
    }

    if (s.dueAt <= t) learnedDue.push(s);
    else learnedNotDue.push(s);
  }

  learnedDue.sort((a, b) => a.dueAt - b.dueAt || a.lastShownAt - b.lastShownAt);
  newIds.sort((a, b) => ensureState(states, a).lastShownAt - ensureState(states, b).lastShownAt);
  learnedNotDue.sort((a, b) => a.dueAt - b.dueAt || a.lastShownAt - b.lastShownAt);

  const candidates =
    learnedDue.length > 0
      ? learnedDue.map((s) => s.id)
      : newIds.length > 0
        ? newIds
        : learnedNotDue.length > 0
          ? learnedNotDue.map((s) => s.id)
          : [];

  if (candidates.length === 0) return null;

  // Anti-repeat within pool
  let mostRecentId: string | null = null;
  let mostRecentShown = -1;
  for (const c of cards) {
    if (!pool.has(c.id)) continue;
    const s = ensureState(states, c.id);
    if (s.lastShownAt > mostRecentShown) {
      mostRecentShown = s.lastShownAt;
      mostRecentId = c.id;
    }
  }

  if (mostRecentId && candidates.length > 1 && candidates[0] === mostRecentId) {
    return candidates[1];
  }

  return candidates[0];
}

export function makeQuestion(
  cards: Card[],
  states: Record<string, CardState>,
  settings: Settings,
  chunkIds: string[] = []
): Question | null {
  if (cards.length === 0) return null;

  const poolIds = chunkIds.length > 0 ? chunkIds : cards.map((c) => c.id);
  
  // If we're in sliding-box mode (chunkIds provided) and the current box is fully easy,
  // force a rebuild so buildChunk() can slide forward — unless the whole deck is easy.
  if (chunkIds.length > 0 && allEasyInPool(states, chunkIds) && !allEasyInDeck(cards, states)) {
    return null;
  }
  const id = pickNextCardId(cards, states, poolIds);
  if (!id) return null;

  const card = cards.find((c) => c.id === id);
  if (!card) return null;

  // mark shown for anti-repeat + fairness
  ensureState(states, id).lastShownAt = now();

  const { prompt, answer } = makePromptAnswer(card, settings);

  const mode = settings.mode === "mix" ? (Math.random() < 0.5 ? "mc" : "write") : settings.mode;
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

/**
 * Build the current "sliding box" (active pool) of card ids.
 *
 * - Starts at 10 cards.
 * - Only slides when the entire current box is "easy".
 * - Slides forward by 5.
 * - If all cards are easy, returns the entire set.
 */
export function buildChunk(cards: Card[], states: Record<string, CardState>, _settings: Settings): string[] {
  if (cards.length === 0) return [];
  if (cards.length <= BOX_SIZE) return cards.map((c) => c.id);

  // If EVERYTHING is easy → box becomes whole set ("practice mode").
  let allEasy = true;
  for (const c of cards) {
    if (!isEasy(ensureState(states, c.id))) {
      allEasy = false;
      break;
    }
  }
  if (allEasy) return cards.map((c) => c.id);

  // Find the earliest window where previous windows are all easy.
  // Window starts: 0, 5, 10, 15, ...
  for (let start = 0; start < cards.length; start += SLIDE_BY) {
    const window = cards.slice(start, start + BOX_SIZE);
    if (window.length === 0) break;

    const windowAllEasy = window.every((c) => isEasy(ensureState(states, c.id)));
    if (!windowAllEasy) {
      return window.map((c) => c.id);
    }
  }

  // Safe fallback
  return cards.map((c) => c.id);
}
