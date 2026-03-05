export type Card = {
  id: string;
  sideA: string;      // term (e.g., Hungarian)
  sideB: string;      // definition (e.g., Hebrew without nikud)
  tts: string;        // column 3 (Hebrew with nikud) - ALWAYS used for TTS
};

export type CardState = {
  id: string;
  seen: boolean;
  streak: number;     // consecutive correct
  lapses: number;     // total wrong
  dueAt: number;      // ms epoch; earlier = more urgent
  lastReviewedAt: number;
};

export type Settings = {
  swap: boolean;          // if true, prompt=sideB and answer=sideA
  ttsEnabled: boolean;
  ttsLang: string;        // default "he-IL"
  preferredVoiceURI: string | null;
  chunkSize: number;      // e.g. 10
  newPerChunk: number;    // e.g. 3
  mode: "mix" | "mc" | "write";
  writeTrim: boolean;     // you said yes (trim)
};

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

export type AnswerResult = {
  correct: boolean;
  cardId: string;
};
