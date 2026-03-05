import { Card, CardState, Settings } from "./types";

type DBShape = {
  cards: Card[];
  states: Record<string, CardState>;
  settings: Settings;
};

const DB_KEY = "hebrew_flash_db_v1";

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

export function loadDB(): DBShape {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) {
    return { cards: [], states: {}, settings: defaultSettings };
  }
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

export function ensureState(states: Record<string, CardState>, cardId: string): CardState {
  if (!states[cardId]) {
    states[cardId] = {
      id: cardId,
      seen: false,
      streak: 0,
      lapses: 0,
      dueAt: Date.now(),
      lastReviewedAt: 0,
    };
  }
  return states[cardId];
}

export function resetProgressKeepCards(): DBShape {
  const db = loadDB();
  const newStates: Record<string, CardState> = {};
  for (const c of db.cards) {
    newStates[c.id] = {
      id: c.id,
      seen: false,
      streak: 0,
      lapses: 0,
      dueAt: Date.now(),
      lastReviewedAt: 0,
    };
  }
  db.states = newStates;
  saveDB(db);
  return db;
}
