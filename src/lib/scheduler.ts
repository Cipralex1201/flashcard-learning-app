import type { Card, CardState, Question, Settings } from "./types";
import { similarity, topSimilarIndices } from "./similarity";
import { ensureState } from "./db";

function now() { return Date.now(); }

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

function priorityScore(st: CardState): number {
  // bigger = more urgent
  const overdue = Math.max(0, now() - st.dueAt);
  return overdue / 1000 + st.lapses * 50 - st.streak * 5 + (st.seen ? 0 : 30);
}

function scheduleAfterAnswer(st: CardState, correct: boolean) {
  st.lastReviewedAt = now();
  st.seen = true;

  if (correct) {
    st.streak += 1;
    // Simple interval growth; keep it "Learn"-style (not pure Anki)
    const base = 20_000; // 20s
    const mult = Math.min(60, Math.pow(2, Math.min(10, st.streak))); // caps
    const next = base * mult; // grows quickly
    st.dueAt = now() + next;
  } else {
    st.streak = 0;
    st.lapses += 1;
    // Re-ask soon
    st.dueAt = now() + 10_000; // 10s
  }
}

export function applyAnswer(states: Record<string, CardState>, cardId: string, correct: boolean) {
  const st = ensureState(states, cardId);
  scheduleAfterAnswer(st, correct);
}

// Select new cards as a "similarity chunk" (confusable together)
function pickNewBySimilarity(cards: Card[], states: Record<string, CardState>, settings: Settings): string[] {
  const unseen = cards.filter(c => !ensureState(states, c.id).seen);
  if (unseen.length === 0) return [];

  const want = Math.min(settings.newPerChunk, unseen.length);

  // build strings on the ANSWER side (depends on swap)
  const unseenAnswers = unseen.map(c => makePromptAnswer(c, settings).answer);

  // seed: first unseen (could also randomize)
  const chosen: Card[] = [unseen[0]];

  while (chosen.length < want) {
    const seed = chosen[0];
    const seedAns = makePromptAnswer(seed, settings).answer;

    // pick the unseen card most similar to seed answer, excluding already chosen
    let best: Card | null = null;
    let bestS = -1;
    for (const c of unseen) {
      if (chosen.some(x => x.id === c.id)) continue;
      const s = similarity(seedAns, makePromptAnswer(c, settings).answer);
      if (s > bestS) { bestS = s; best = c; }
    }
    if (!best) break;
    chosen.push(best);
  }

  return chosen.map(c => c.id);
}

function pickReview(cards: Card[], states: Record<string, CardState>, maxCount: number): string[] {
  const scored = cards
    .map(c => ensureState(states, c.id))
    .filter(st => st.seen)
    .map(st => ({ id: st.id, score: priorityScore(st) }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map(x => x.id);
}

export function buildChunk(cards: Card[], states: Record<string, CardState>, settings: Settings): string[] {
  const review = pickReview(cards, states, Math.max(0, settings.chunkSize - settings.newPerChunk));
  const fresh = pickNewBySimilarity(cards, states, settings);

  // Merge and de-dupe
  const merged = [...review, ...fresh];
  return [...new Set(merged)].slice(0, settings.chunkSize);
}

export function makeQuestion(
  cards: Card[],
  states: Record<string, CardState>,
  settings: Settings,
  chunkIds: string[]
): Question | null {
  if (chunkIds.length === 0) return null;

  // pick most urgent within chunk
  let bestId = chunkIds[0];
  let bestScore = -Infinity;
  for (const id of chunkIds) {
    const st = ensureState(states, id);
    const s = priorityScore(st);
    if (s > bestScore) { bestScore = s; bestId = id; }
  }

  const card = cards.find(c => c.id === bestId);
  if (!card) return null;

  const { prompt, answer } = makePromptAnswer(card, settings);

  const mode =
    settings.mode === "mix"
      ? (Math.random() < 0.5 ? "mc" : "write")
      : settings.mode;

  if (mode === "write") {
    return { kind: "write", cardId: card.id, prompt, expected: answer };
  }

  // MC: pick distractors by similarity on the answer side
  const answers = cards.map(c => makePromptAnswer(c, settings).answer);
  const idx = cards.findIndex(c => c.id === card.id);
  const similarIdx = topSimilarIndices(answers, idx, 12);
  const distractorIdx = similarIdx.slice(0, 3);

  // fallback if not enough
  while (distractorIdx.length < 3 && distractorIdx.length < cards.length - 1) {
    const r = Math.floor(Math.random() * cards.length);
    if (r !== idx && !distractorIdx.includes(r)) distractorIdx.push(r);
  }

  const options = [answer, ...distractorIdx.map(i => answers[i])].sort(() => Math.random() - 0.5);
  return { kind: "mc", cardId: card.id, prompt, correct: answer, options };
}
