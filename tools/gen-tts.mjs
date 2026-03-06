import fs from "fs";
import path from "path";
import crypto from "crypto";
import textToSpeech from "@google-cloud/text-to-speech";

const client = new textToSpeech.TextToSpeechClient();

/* ================= CLI ARG PARSING ================= */

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(
      [
        "Usage: node tools/gen-tts.mjs <inputfile> [-o <outputfile>] [-l <lang>]",
        "",
        "Options:",
        "  -o, --output <file>   Output file (default: with_audio_<input>.txt in same dir)",
        "  -l, --lang <lang>     TTS language: he (default), en, de",
        "                        (also accepts full codes like en-US, de-DE, he-IL)",
        "",
        "Examples:",
        "  node tools/gen-tts.mjs data/mydeck.txt",
        "  node tools/gen-tts.mjs data/mydeck.txt -l en",
        "  node tools/gen-tts.mjs data/mydeck.txt --lang de --output out.txt",
      ].join("\n")
    );
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

  let lang = "he"; // default Hebrew
  const lIndex =
    args.indexOf("-l") !== -1 ? args.indexOf("-l") : args.indexOf("--lang");
  if (lIndex !== -1 && args[lIndex + 1]) {
    lang = args[lIndex + 1];
  }

  return { inputFile, outputFile, lang };
}

function resolveLanguageCode(langRaw) {
  const lang = (langRaw ?? "").toString().trim().toLowerCase();

  // Allow full BCP-47-like codes (e.g., en-US, de-DE, he-IL)
  if (lang.includes("-")) return lang;

  // Short aliases
  if (lang === "" || lang === "he" || lang === "heb" || lang === "hebrew") return "he-IL";
  if (lang === "en" || lang === "eng" || lang === "english") return "en-US";
  if (lang === "de" || lang === "ger" || lang === "deu" || lang === "german") return "de-DE";

  throw new Error(
    `Unsupported --lang "${langRaw}". Use: he (default), en, de, or a full code like en-US/de-DE/he-IL.`
  );
}

const { inputFile, outputFile, lang } = parseArgs();
const languageCode = resolveLanguageCode(lang);

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

function idForRow(a, def, ttsText, languageCode) {
  const base = `${languageCode}||${a}||${def}||${ttsText}`;
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

  // If the 2nd line already points to an audio file, keep it.
  if (isAudioFile(ttsField)) {
    outBlocks.push(`${term}\n${ttsField}\n${definition}\n`);
    continue;
  }

  const ttsText = ttsField || definition;
  const fid = idForRow(term, definition, ttsText, languageCode);
  const fname = `${fid}.mp3`;
  const outFile = path.join("public", "audio", fname);

  if (!fs.existsSync(outFile)) {
    const [res] = await client.synthesizeSpeech({
      input: { text: ttsText },
      voice: { languageCode },
      audioConfig: { audioEncoding: "MP3" },
    });

    fs.writeFileSync(outFile, res.audioContent, "binary");
    console.log("Wrote", outFile, `(lang=${languageCode})`);
  } else {
    console.log("Exists", outFile, `(lang=${languageCode})`);
  }

  outBlocks.push(`${term}\n${fname}\n${definition}\n`);
}

fs.writeFileSync(outputFile, outBlocks.join("\n"), "utf8");

console.log("\nDone.");
console.log("Language:", languageCode);
console.log("Output written to:", outputFile);