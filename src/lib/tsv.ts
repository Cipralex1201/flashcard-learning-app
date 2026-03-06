import type { Card } from "./types";

function clean(s: string): string {
  return s.replace(/\r/g, "");
}

/**
 * Block format (canonical):
 *   term
 *   tts
 *   definition
 *   <blank line>
 *
 * Example:
 *   megy
 *   הוֹלֵךְ
 *   הולך
 *
 * Notes:
 * - Blank line separates records.
 * - Trailing blank line is optional.
 * - We are lenient: we ignore extra blank lines.
 */
export function parseTSV(input: string): Card[] {
  const txt = clean(input);

  // Split by blank lines (one or more)
  const blocks = txt
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const cards: Card[] = [];

  for (const block of blocks) {
    // keep internal empty lines out; user said record is 3 lines
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length < 2) continue;

    const sideA = (lines[0] ?? "").trim(); // term
    const tts = (lines[1] ?? "").trim();   // tts (text with niqqud OR mp3 filename)
    const sideB = (lines[2] ?? "").trim(); // definition

    if (!sideA) continue;

    // If definition is missing, fall back to term/tts (keeps it usable)
    const finalSideB = sideB || sideA;
    const finalTts = tts || finalSideB;

    cards.push({
      id: crypto.randomUUID(),
      sideA,
      sideB: finalSideB,
      tts: finalTts,
    });
  }

  return cards;
}

/**
 * Export in canonical block format:
 *   term
 *   tts
 *   definition
 *   <blank line>
 */
export function exportTSV(cards: Card[]): string {
  return cards
    .map((c) => `${c.sideA}\n${c.tts}\n${c.sideB}\n`)
    .join("\n"); // keeps a blank line between records
}

