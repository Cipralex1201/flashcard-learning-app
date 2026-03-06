export interface Card {
  id: string;
  sideA: string;
  sideB: string;
  tts: string;
}

export interface CardState {
  id: string;
  seen: boolean;
  streak: number;
  lapses: number;
  dueAt: number;
  lastReviewedAt: number;
}

export interface Settings {
  swap: boolean;
  ttsEnabled: boolean;
  ttsLang: string;
  preferredVoiceURI: string | null;
  chunkSize: number;
  newPerChunk: number;
  mode: "mix" | "mc" | "write";
  writeTrim: boolean;
}

export type Question =
  | {
      kind: "mc";
      cardId: string;
      prompt: string;
      correct: string;
      options: string[];
    }
  | {
      kind: "write";
      cardId: string;
      prompt: string;
      expected: string;
    };

export interface AnswerResult {
  correct: boolean;
  cardId: string;
}

