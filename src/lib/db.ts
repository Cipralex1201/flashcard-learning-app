import type { Card, CardState, Settings } from "./types";

type DeckShape = {
  cards: Card[];
  states: Record<string, CardState>;
};

export type DBShape = {
  /** The currently selected deck (null means no deck selected yet) */
  activeDeckId: string | null;
  /** Active deck data (cards+states) */
  cards: Card[];
  states: Record<string, CardState>;
  /** Global settings shared across decks */
  settings: Settings;
};

// Legacy single-deck key (pre deck separation)
const LEGACY_DB_KEY = "hebrew_flash_db_v2_sm2";

// New, per-scope keys
const SETTINGS_KEY = "hfl_settings_v1";
const ACTIVE_DECK_KEY = "hfl_active_deck_v1";
const DECK_KEY_PREFIX = "hfl_deck_v1:";
const LEGACY_DECK_ID = "legacy";

function deckKey(deckId: string): string {
  return `${DECK_KEY_PREFIX}${deckId}`;
}

const defaultSettings: Settings = {
  swap: false,
  ttsEnabled: true,
  ttsLang: "he-IL",
  preferredVoiceURI: null,
  chunkSize: 10,
  newPerChunk: 3,
  mode: "mix",
  writeTrim: true,
  schedulingMode: "learning",
  lastShownAt: 0
};

function readJSON(key: string): unknown | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function hasAnyNewFormatData(): boolean {
  try {
    if (localStorage.getItem(SETTINGS_KEY)) return true;
    if (localStorage.getItem(ACTIVE_DECK_KEY)) return true;

    // detect at least one per-deck entry
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DECK_KEY_PREFIX)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * One-time migration:
 * - Moves legacy single-deck DB into a named deck ("legacy")
 * - Stores settings globally
 * - Sets activeDeckId to "legacy" when legacy contained cards
 */
function maybeMigrateLegacy() {
  if (hasAnyNewFormatData()) return;

  const legacy = readJSON(LEGACY_DB_KEY) as
    | { cards?: Card[]; states?: Record<string, CardState>; settings?: Partial<Settings> }
    | null;
  if (!legacy) return;

  const cards = Array.isArray(legacy.cards) ? legacy.cards : [];
  const states = (legacy.states && typeof legacy.states === "object")
    ? (legacy.states as Record<string, CardState>)
    : {};
  const settings = { ...defaultSettings, ...(legacy.settings ?? {}) };

  try {
    writeJSON(SETTINGS_KEY, settings);
    writeJSON(deckKey(LEGACY_DECK_ID), { cards, states } satisfies DeckShape);
    localStorage.setItem(ACTIVE_DECK_KEY, cards.length ? LEGACY_DECK_ID : "");
  } catch {
    // ignore migration failures (e.g. storage disabled)
  }
}

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

export function loadSettings(): Settings {
  maybeMigrateLegacy();
  const raw = readJSON(SETTINGS_KEY) as Partial<Settings> | null;
  return { ...defaultSettings, ...(raw ?? {}) };
}

export function saveSettings(settings: Settings) {
  maybeMigrateLegacy();
  writeJSON(SETTINGS_KEY, settings);
}

export function loadActiveDeckId(): string | null {
  maybeMigrateLegacy();
  try {
    const raw = localStorage.getItem(ACTIVE_DECK_KEY);
    const id = raw && raw.trim().length ? raw.trim() : null;
    return id;
  } catch {
    return null;
  }
}

export function saveActiveDeckId(deckId: string | null) {
  maybeMigrateLegacy();
  try {
    localStorage.setItem(ACTIVE_DECK_KEY, deckId ?? "");
  } catch {
    // ignore
  }
}

export function loadDeck(deckId: string): DeckShape | null {
  maybeMigrateLegacy();
  const raw = readJSON(deckKey(deckId)) as Partial<DeckShape> | null;
  if (!raw) return null;
  const cards = Array.isArray(raw.cards) ? (raw.cards as Card[]) : [];
  const states = (raw.states && typeof raw.states === "object")
    ? (raw.states as Record<string, CardState>)
    : {};
  return { cards, states };
}

export function saveDeck(deckId: string, deck: DeckShape) {
  maybeMigrateLegacy();
  writeJSON(deckKey(deckId), deck);
}

export function loadDB(): DBShape {
  const settings = loadSettings();
  const activeDeckId = loadActiveDeckId();
  const deck = activeDeckId ? loadDeck(activeDeckId) : null;
  return {
    activeDeckId,
    cards: deck?.cards ?? [],
    states: deck?.states ?? {},
    settings,
  };
}

export function saveDB(db: DBShape) {
  saveSettings(db.settings);
  saveActiveDeckId(db.activeDeckId);
  if (db.activeDeckId) saveDeck(db.activeDeckId, { cards: db.cards, states: db.states });
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

export function resetProgressKeepCards(deckId?: string): DBShape {
  const db = loadDB();
  const targetDeckId = deckId ?? db.activeDeckId;
  if (!targetDeckId) return db;
  const deck = loadDeck(targetDeckId);
  if (!deck) return db;

  const newStates: Record<string, CardState> = {};
  for (const c of deck.cards) newStates[c.id] = defaultCardState(c.id);

  saveDeck(targetDeckId, { cards: deck.cards, states: newStates });

  if (db.activeDeckId === targetDeckId) {
    return { ...db, states: newStates };
  }

  return db;
}

