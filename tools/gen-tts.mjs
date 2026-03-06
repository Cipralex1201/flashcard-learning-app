import fs from "fs";
import path from "path";
import crypto from "crypto";
import textToSpeech from "@google-cloud/text-to-speech";

const client = new textToSpeech.TextToSpeechClient();

/* ================= CLI ARG PARSING ================= */

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node tools/gen-tts.mjs <inputfile> [-o <outputfile>]");
    process.exit(0);
  }

  const inputFile = args[0];

  let outputFile;
  const oIndex =
    args.indexOf("-o") !== -1
      ? args.indexOf("-o")
      : args.indexOf("--output");

  if (oIndex !== -1 && args[oIndex + 1]) {
    outputFile = args[oIndex + 1];
  } else {
    const dir = path.dirname(inputFile);
    const base = path.basename(inputFile, path.extname(inputFile));
    outputFile = path.join(dir, `with_audio_${base}.txt`);
  }

  return { inputFile, outputFile };
}

const { inputFile, outputFile } = parseArgs();

/* ================= UTILITIES ================= */

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
  const base = `${a}||${def}||${ttsText}`;
  return crypto.createHash("sha1").update(base, "utf8").digest("hex").slice(0, 12);
}

/**
 * Parse block format:
 *   term
 *   tts
 *   definition
 *   <blank line>
 */
function parseBlocks(txt) {
  const blocks = clean(txt)
    .split(/\n\s*\n+/)
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

    const definition = line3 || line2;
    const tts = line3 ? line2 : definition;

    if (!term || !definition) continue;

    records.push({ term, tts, definition });
  }

  return records;
}

/* ================= MAIN ================= */

if (!fs.existsSync(inputFile)) {
  console.error("Input file does not exist:", inputFile);
  process.exit(1);
}

fs.mkdirSync("public/audio", { recursive: true });

const inputText = fs.readFileSync(inputFile, "utf8");
const records = parseBlocks(inputText);

const outBlocks = [];

for (const r of records) {
  const term = r.term;
  const definition = r.definition;
  const ttsField = r.tts;

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
      },
      audioConfig: { audioEncoding: "MP3" },
    });

    fs.writeFileSync(outFile, res.audioContent, "binary");
    console.log("Wrote", outFile);
  } else {
    console.log("Exists", outFile);
  }

  outBlocks.push(`${term}\n${fname}\n${definition}\n`);
}

fs.writeFileSync(outputFile, outBlocks.join("\n"), "utf8");

console.log("\nDone.");
console.log("Output written to:", outputFile);