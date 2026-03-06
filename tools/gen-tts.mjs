import fs from "fs";
import path from "path";
import crypto from "crypto";
import textToSpeech from "@google-cloud/text-to-speech";

const client = new textToSpeech.TextToSpeechClient();

function clean(s) {
  return (s ?? "").toString().replace(/\r/g, "");
}
function norm(s) {
  return (s ?? "").toString().replace(/\r/g, "").trim();
}

function isAudioFile(s) {
  return /\.(mp3|wav|ogg)$/i.test((s ?? "").trim());
}

function idForRow(a, def, ttsText) {
  // Stable filename based on content (term+definition+tts text)
  const base = `${a}||${def}||${ttsText}`;
  return crypto.createHash("sha1").update(base, "utf8").digest("hex").slice(0, 12);
}

/**
 * Parse block format:
 *   term
 *   tts
 *   definition
 *   <blank line>
 *
 * We are tolerant:
 * - extra blank lines are ignored
 * - if a block has only 2 lines: term + definition (tts defaults to definition)
 */
function parseBlocks(txt) {
  const blocks = clean(txt)
    .split(/\n\s*\n+/)      // one or more blank lines
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const records = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length < 2) continue;

    const term = norm(lines[0]);
    const line2 = norm(lines[1]);
    const line3 = norm(lines[2]);

    // Canonical: term, tts, definition
    // Fallback (2 lines): term, definition (tts := definition)
    const definition = line3 || line2;
    const tts = line3 ? line2 : definition;

    if (!term || !definition) continue;

    records.push({ term, tts, definition });
  }

  return records;
}

const inPath = process.argv[2];
if (!inPath) {
  console.error("Usage: node tools/gen-tts.mjs <input.txt>");
  console.error("Expected format: term\\ntts\\ndefinition\\n\\n ...");
  process.exit(1);
}

fs.mkdirSync("public/audio", { recursive: true });

const inputText = fs.readFileSync(inPath, "utf8");
const records = parseBlocks(inputText);

const outBlocks = [];

for (const r of records) {
  const term = r.term;
  const definition = r.definition;
  const ttsField = r.tts;

  // If already an audio filename, pass through unchanged
  if (isAudioFile(ttsField)) {
    outBlocks.push(`${term}\n${ttsField}\n${definition}\n`);
    continue;
  }

  const ttsText = ttsField || definition;
  const fid = idForRow(term, definition, ttsText);
  const fname = `${fid}.mp3`;
  const outFile = path.join("public", "audio", fname);

  if (!fs.existsSync(outFile)) {
    const [res] = await client.synthesizeSpeech({
      input: { text: ttsText },
      voice: {
        languageCode: "he-IL",
        // Optional:
        // name: "he-IL-Wavenet-A",
      },
      audioConfig: { audioEncoding: "MP3" },
    });

    fs.writeFileSync(outFile, res.audioContent, "binary");
    console.log("Wrote", outFile);
  } else {
    console.log("Exists", outFile);
  }

  // Output in block format: term, mp3 filename, definition
  outBlocks.push(`${term}\n${fname}\n${definition}\n`);
}

fs.writeFileSync("with-audio.txt", outBlocks.join("\n"), "utf8");
console.log("\nDone. Import with-audio.txt");

