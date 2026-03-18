#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function titleFromId(idRaw) {
  const id = idRaw
    .replace(/^with-audio-/, "")
    .replace(/[-_]+/g, " ")
    .trim();

  // Preserve common suffix patterns in a readable way
  const words = id.split(/\s+/g).filter(Boolean);
  return words
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rootDir = process.cwd();
  const decksDir = path.resolve(rootDir, args.dir ?? "public/decks");
  const outFile = path.resolve(rootDir, args.out ?? "public/decks/index.json");

  const entries = await fs.readdir(decksDir, { withFileTypes: true });

  const deckFiles = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.(txt|tsv)$/i.test(name))
    .filter((name) => name.toLowerCase() !== "index.json")
    .sort((a, b) => a.localeCompare(b));

  const decks = deckFiles.map((file) => {
    const base = file.replace(/\.(txt|tsv)$/i, "");
    return {
      id: base,
      title: titleFromId(base),
      path: `/decks/${file}`,
    };
  });

  const json = JSON.stringify(decks, null, 2) + "\n";
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, json, "utf8");

  process.stdout.write(
    `Wrote ${decks.length} deck(s) to ${path.relative(rootDir, outFile)}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
