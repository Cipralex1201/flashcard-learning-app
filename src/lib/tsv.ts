import type { Card } from "./types";

function clean(s: string): string {
  return s.replace(/\r/g, "");
}

export function parseTSV(tsv: string): Card[] {
  const lines = clean(tsv)
    .split("\n")
    .map(l => l.trimEnd())
    .filter(l => l.length > 0);

  const cards: Card[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 2) continue;

    const sideA = (parts[0] ?? "").trim();
    const sideB = (parts[1] ?? "").trim();
    const tts = (parts[2] ?? parts[1] ?? "").trim();

    if (!sideA || !sideB) continue;

    cards.push({
      id: crypto.randomUUID(),
      sideA,
      sideB,
      tts,
    });
  }
  return cards;
}

export function exportTSV(cards: Card[]): string {
  return cards
    .map(c => `${c.sideA}\t${c.sideB}\t${c.tts}`)
    .join("\n");
}
