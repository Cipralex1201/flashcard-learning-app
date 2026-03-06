import type { Card, CardState, Settings } from "./types";

type DBShape = {
  cards: Card[];
  states: Record<string, CardState>;
  settings: Settings;
};

// Bump key so old incompatible state doesn't break things.
// (You can keep migration too, but bumping prevents weirdness.)
const DB_KEY = "hebrew_flash_db_v2_sm2";

const defaultSettings: Settings = {
  swap: false,
  ttsEnabled: true,
  ttsLang: "he-IL",
  preferredVoiceURI: null,
  chunkSize: 10,
  newPerChunk: 3,
  mode: "mix",
  writeTrim: true,
};

function defaultCardState(cardId: string): CardState {
  const now = Date.now();
  return {
    id: cardId,

    // scheduling
    dueAt: now, // due immediately
    lastReviewedAt: 0,
    lastShownAt: 0,

    // SM-2 core
    reps: 0,
    intervalDays: 0,
    ease: 2.5,

    // stats
    lapses: 0,
  };
}

export function loadDB(): DBShape {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) return { cards: [], states: {}, settings: defaultSettings };

  try {
    const parsed = JSON.parse(raw) as DBShape;
    return {
      cards: parsed.cards ?? [],
      states: parsed.states ?? {},
      settings: { ...defaultSettings, ...(parsed.settings ?? {}) },
    };
  } catch {
    return { cards: [], states: {}, settings: defaultSettings };
  }
}

export function saveDB(db: DBShape) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

/**
 * Ensure state exists + migrate missing SM-2 fields.
 * This makes you resilient if you change shape again later.
 */
export function ensureState(states: Record<string, CardState>, cardId: string): CardState {
  if (!states[cardId]) {
    states[cardId] = defaultCardState(cardId);
    return states[cardId];
  }

  const s = states[cardId] as unknown as Partial<CardState> & Record<string, unknown>;

  // scheduling
  if (typeof s.dueAt !== "number") s.dueAt = Date.now();
  if (typeof s.lastReviewedAt !== "number") s.lastReviewedAt = 0;
  if (typeof s.lastShownAt !== "number") s.lastShownAt = 0;

  // SM-2 core
  if (typeof s.reps !== "number") s.reps = 0;
  if (typeof s.intervalDays !== "number") s.intervalDays = 0;
  if (typeof s.ease !== "number") s.ease = 2.5;

  // stats
  if (typeof s.lapses !== "number") s.lapses = 0;

  // Clamp ease to SM-2 minimum
  if (typeof s.ease === "number" && s.ease < 1.3) s.ease = 1.3;

  states[cardId] = s as unknown as CardState;
  return states[cardId];
}

export function resetProgressKeepCards(): DBShape {
  const db = loadDB();
  const newStates: Record<string, CardState> = {};
  for (const c of db.cards) {
    newStates[c.id] = defaultCardState(c.id);
  }
  db.states = newStates;
  saveDB(db);
  return db;
}

