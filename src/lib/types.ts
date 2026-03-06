export interface Card {
  id: string;
  sideA: string;
  sideB: string;
  tts: string;
}

/**
 * SM-2 scheduling state (per card)
 *
 * Key ideas:
 * - ease starts around 2.5 and is adjusted after each review
 * - reps counts consecutive successful reviews (quality >= 3)
 * - intervalDays grows as you succeed
 * - dueAt is the next scheduled time (epoch ms)
 */
export interface CardState {
  id: string;
  reps: number;
  lapses: number;
  ease: number;        // EF, starts ~2.5
  intervalDays: number;
  dueAt: number;
  lastReviewedAt: number;
}


export interface Settings {
  swap: boolean;
  ttsEnabled: boolean;
  ttsLang: string;
  preferredVoiceURI: string | null;

  // chunk settings can remain (you can later decide to ignore/repurpose them)
  chunkSize: number;
  newPerChunk: number;

  mode: "mix" | "mc" | "write";
  writeTrim: boolean;
}

/**
 * Add qid so we can reset inputs even if the same card repeats.
 * (Fixes "text input field is pre-filled" when the same card is asked again.)
 */
export type Question =
  | {
      kind: "mc";
      qid: string;
      cardId: string;
      prompt: string;
      correct: string;
      options: string[];
    }
  | {
      kind: "write";
      qid: string;
      cardId: string;
      prompt: string;
      expected: string;
    };

/**
 * SM-2 grade (quality 0..5)
 * - 0..2: fail
 * - 3: hard
 * - 4: good
 * - 5: easy
 */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

