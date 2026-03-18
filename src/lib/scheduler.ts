import type { Card, CardState, Question, Settings } from "./types";
import { ensureState } from "./db";
import { makeId } from "./id.ts";
import { topSimilarIndices } from "./similarity";

const DAY = 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

export function makePromptAnswer(card: Card, settings: Settings): { prompt: string; answer: string } {
  const prompt = settings.swap ? card.sideB : card.sideA;
  const answer = settings.swap ? card.sideA : card.sideB;
  return { prompt, answer };
}

function normalizeAnswer(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[?.()!;\-_'~]/g, "");
}

export function gradeWrite(typed: string, expected: string, trim: boolean): boolean {
  const t = trim ? normalizeAnswer(typed).trim() : normalizeAnswer(typed);
  const e = trim ? normalizeAnswer(expected).trim() : normalizeAnswer(expected);
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
   PRACTICE MODE (OLD ANKI-LIKE GLOBAL PICKER)
   ========================================================= */

function pickNextCardIdPractice(cards: Card[], states: Record<string, CardState>): string | null {
  const t = now();

  const learnedDue: CardState[] = [];
  const learnedNotDue: CardState[] = [];
  const newIds: string[] = [];

  for (const c of cards) {
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

  // Anti-repeat: don't show the most recently shown card if we have alternatives
  let mostRecentId: string | null = null;
  let mostRecentShown = -1;
  for (const c of cards) {
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

/* =========================================================
   LEARNING MODE (PRIORITISED ROUND ROBIN IN A SLIDING BOX)
   ========================================================= */

function isEasy(st: CardState): boolean {
  return st.reps >= 3 && st.ease >= 2.5 && st.intervalDays >= 15;
}

function allEasyPool(ids: string[], states: Record<string, CardState>): boolean {
  if (ids.length === 0) return true;
  for (const id of ids) {
    if (!isEasy(ensureState(states, id))) return false;
  }
  return true;
}

const BOX_SIZE = 10;
const SLIDE_BY = 5;
const BOX_PTR_KEY_PREFIX = "hfl_box_ptr_v1:";

function boxPtrKey(scope?: string): string {
  return `${BOX_PTR_KEY_PREFIX}${scope ?? "global"}`;
}

function loadBoxPtr(scope?: string): number {
  try {
    const raw = localStorage.getItem(boxPtrKey(scope));
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function saveBoxPtr(ptr: number, scope?: string) {
  try {
    localStorage.setItem(boxPtrKey(scope), String(Math.max(0, Math.floor(ptr))));
  } catch {
    // ignore
  }
}

/**
 * Build a pool starting from ptr, with up to BOX_SIZE cards.
 * Prefer NOT-easy cards first, but always fill to BOX_SIZE (wrapping around).
 */
function buildPoolFromPtr(cards: Card[], states: Record<string, CardState>, ptr: number): string[] {
  const pool: string[] = [];

  // 1) take NOT-easy first
  for (let i = ptr; i < cards.length && pool.length < BOX_SIZE; i++) {
    const id = cards[i].id;
    if (!isEasy(ensureState(states, id))) pool.push(id);
  }

  // 2) fill with remaining (even if easy)
  for (let i = ptr; i < cards.length && pool.length < BOX_SIZE; i++) {
    const id = cards[i].id;
    if (!pool.includes(id)) pool.push(id);
  }

  // 3) wrap
  for (let i = 0; i < ptr && pool.length < BOX_SIZE; i++) {
    const id = cards[i].id;
    if (!pool.includes(id)) pool.push(id);
  }

  return pool;
}

function pickNextCardIdInPool(cards: Card[], states: Record<string, CardState>, poolIds: string[]): string | null {
  const t = now();
  const pool = new Set(poolIds);

  type Item = { id: string; st: CardState; easy: boolean; isNew: boolean; due: boolean };
  const items: Item[] = [];

  for (const c of cards) {
    if (!pool.has(c.id)) continue;
    const st = ensureState(states, c.id);
    items.push({
      id: c.id,
      st,
      easy: isEasy(st),
      isNew: st.lastReviewedAt === 0,
      due: st.lastReviewedAt !== 0 && st.dueAt <= t,
    });
  }
  if (items.length === 0) return null;

  // 1) due inside pool
  const due = items.filter((x) => x.due);
  if (due.length > 0) {
    due.sort((a, b) => a.st.dueAt - b.st.dueAt || a.st.lastShownAt - b.st.lastShownAt);
    return due[0].id;
  }

  // most recent inside pool
  let mostRecentId: string | null = null;
  let mostRecentShown = -1;
  for (const it of items) {
    if (it.st.lastShownAt > mostRecentShown) {
      mostRecentShown = it.st.lastShownAt;
      mostRecentId = it.id;
    }
  }

  // 2) round-robin by least recently shown, with a small bias toward not-easy/new
  items.sort((a, b) => {
    const aBias = (a.easy ? 0 : -1) + (a.isNew ? -0.5 : 0);
    const bBias = (b.easy ? 0 : -1) + (b.isNew ? -0.5 : 0);
    const lr = a.st.lastShownAt - b.st.lastShownAt;
    if (lr !== 0) return lr;
    return aBias - bBias;
  });

  // 3) cooldown anti-repeat
  if (mostRecentId && items.length > 1 && items[0].id === mostRecentId) {
    return items[1].id;
  }

  return items[0].id;
}

/* =========================================================
   PUBLIC API (used by App.tsx)
   - settings.schedulingMode selects the algorithm.
   ========================================================= */

export function buildChunk(
  cards: Card[],
  states: Record<string, CardState>,
  settings: Settings,
  scope?: string
): string[] {
  if (settings.schedulingMode === "practice") {
    // Old scheduler never used chunks.
    return [];
  }

  // learning: build the active pool
  if (cards.length === 0) return [];
  let ptr = loadBoxPtr(scope);
  if (ptr >= cards.length) ptr = 0;
  return buildPoolFromPtr(cards, states, ptr);
}

export function makeQuestion(
  cards: Card[],
  states: Record<string, CardState>,
  settings: Settings,
  chunkIds: string[] = [],
  scope?: string
): Question | null {
  if (cards.length === 0) return null;

  // PRACTICE (old behavior)
  if (settings.schedulingMode === "practice") {
    const id = pickNextCardIdPractice(cards, states);
    if (!id) return null;

    const card = cards.find((c) => c.id === id);
    if (!card) return null;

    ensureState(states, id).lastShownAt = now();
    return makeQuestionFromCard(card, cards, settings);
  }

  // LEARNING (box)
  const poolIds = chunkIds.length > 0 ? chunkIds : buildChunk(cards, states, settings, scope);
  if (poolIds.length === 0) return null;

  // if current box is complete => slide + force rebuild
  if (allEasyPool(poolIds, states)) {
    const ptr = loadBoxPtr(scope);
    saveBoxPtr(ptr + SLIDE_BY, scope);
    return null;
  }

  const id = pickNextCardIdInPool(cards, states, poolIds);
  if (!id) return null;

  const card = cards.find((c) => c.id === id);
  if (!card) return null;

  ensureState(states, id).lastShownAt = now();
  return makeQuestionFromCard(card, cards, settings);
}

function makeQuestionFromCard(card: Card, cards: Card[], settings: Settings): Question {
  const { prompt, answer } = makePromptAnswer(card, settings);

  const mode = settings.mode === "mix" ? (Math.random() < 0.5 ? "mc" : "write") : settings.mode;
  const qid = makeId();

  if (mode === "write") {
    return { kind: "write", qid, cardId: card.id, prompt, expected: answer };
  }

  // MC: dist similarity on answer side
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
