import { useEffect, useMemo, useState } from "react";
import { loadDB, saveDB, ensureState, resetProgressKeepCards } from "./lib/db";
import { parseTSV, exportTSV } from "./lib/tsv";
import { Card, Question, Settings } from "./lib/types";
import { buildChunk, makeQuestion, applyAnswer, gradeWrite } from "./lib/scheduler";
import { diffTypedToExpected } from "./lib/diff";
import { listVoices, speak } from "./lib/tts";

const SAMPLE = `megy\tהולך\tהוֹלֵךְ
ül\tיושב\tיוֹשֵׁב
eszik\tאוכל\tאוֹכֵל
iszik\tשותה\tשׁוֹתֶה
tanul\tלומד\tלוֹמֵד
dolgozik\tעובד\tעוֹבֵד`;

function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export default function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [states, setStates] = useState(loadDB().states);
  const [settings, setSettings] = useState<Settings>(loadDB().settings);

  const [chunkIds, setChunkIds] = useState<string[]>([]);
  const [q, setQ] = useState<Question | null>(null);

  const [typed, setTyped] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; expected?: string; correct?: string } | null>(null);

  const [tsvText, setTsvText] = useState("");
  const [showImport, setShowImport] = useState(cards.length === 0);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  // Load DB once
  useEffect(() => {
    const db = loadDB();
    setCards(db.cards);
    setStates(db.states);
    setSettings(db.settings);
  }, []);

  // Keep DB saved
  useEffect(() => {
    saveDB({ cards, states, settings });
  }, [cards, states, settings]);

  // Voices can appear async
  useEffect(() => {
    const refresh = () => setVoices(listVoices());
    refresh();
    window.speechSynthesis.onvoiceschanged = refresh;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, []);

  // Ensure state objects exist
  useEffect(() => {
    if (cards.length === 0) return;
    const next = { ...states };
    for (const c of cards) ensureState(next, c.id);
    setStates(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length]);

  const progress = useMemo(() => {
    const seen = cards.filter(c => ensureState(states, c.id).seen).length;
    const total = cards.length;
    const dueNow = cards.filter(c => ensureState(states, c.id).seen && ensureState(states, c.id).dueAt <= Date.now()).length;
    return { seen, total, dueNow };
  }, [cards, states]);

  function newChunkAndQuestion() {
    const chunk = buildChunk(cards, { ...states }, settings);
    setChunkIds(chunk);
    const nq = makeQuestion(cards, { ...states }, settings, chunk);
    setQ(nq);
    setTyped("");
    setFeedback(null);
  }

  useEffect(() => {
    if (cards.length === 0) return;
    if (!q) newChunkAndQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length, settings.swap, settings.mode]);

  function afterAnswer(cardId: string, correct: boolean) {
    const nextStates = { ...states };
    applyAnswer(nextStates, cardId, correct);
    setStates(nextStates);

    // Speak column 3 always
    const card = cards.find(c => c.id === cardId);
    if (card) speak(card.tts, settings);
  }

  function nextQuestionMaybeRebuild() {
    // If chunk becomes "boring" or empty, rebuild
    const nq = makeQuestion(cards, { ...states }, settings, chunkIds);
    if (!nq) {
      newChunkAndQuestion();
    } else {
      setQ(nq);
      setTyped("");
      setFeedback(null);
    }
  }

  function submitWrite() {
    if (!q || q.kind !== "write") return;
    const ok = gradeWrite(typed, q.expected, settings.writeTrim);
    setFeedback({ ok, expected: q.expected });
    afterAnswer(q.cardId, ok);
  }

  function chooseMC(opt: string) {
    if (!q || q.kind !== "mc") return;
    const ok = opt.normalize("NFC") === q.correct.normalize("NFC");
    setFeedback({ ok, correct: q.correct });
    afterAnswer(q.cardId, ok);
  }

  function importTSV() {
    const incoming = parseTSV(tsvText || SAMPLE);
    if (incoming.length === 0) return;

    // Merge (simple): append; you can later add "dedupe"
    const merged = [...cards, ...incoming];
    setCards(merged);

    const nextStates = { ...states };
    for (const c of incoming) ensureState(nextStates, c.id);
    setStates(nextStates);

    setShowImport(false);
    setTsvText("");
    setTimeout(() => newChunkAndQuestion(), 0);
  }

  function doResetProgress() {
    const db = resetProgressKeepCards();
    setStates(db.states);
    setSettings(db.settings);
    setTimeout(() => newChunkAndQuestion(), 0);
  }

  if (showImport) {
    return (
      <div className="wrap">
        <h1>Hebrew Flash Learn</h1>
        <p className="muted">
          Paste your set as: <code>term&lt;TAB&gt;definition&lt;TAB&gt;definition sound</code>
          <br />
          Example: <code>megy\tהולך\tהוֹלֵךְ</code>
        </p>

        <textarea
          className="ta"
          value={tsvText}
          onChange={(e) => setTsvText(e.target.value)}
          placeholder={SAMPLE}
        />

        <div className="row">
          <button onClick={importTSV}>Import</button>
          <button className="ghost" onClick={() => { setTsvText(SAMPLE); }}>
            Fill sample
          </button>
        </div>

        <p className="muted small">
          Runs locally in your browser. Data is saved in your browser storage.
        </p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <h1>Hebrew Flash Learn</h1>
          <div className="muted">
            Seen: <b>{progress.seen}</b> / {progress.total} · Due now: <b>{progress.dueNow}</b> · Chunk: <b>{chunkIds.length}</b>
          </div>
        </div>

        <div className="row">
          <button className="ghost" onClick={() => setShowImport(true)}>Import TSV</button>
          <button className="ghost" onClick={doResetProgress}>Reset progress</button>
        </div>
      </header>

      <section className="card">
        <div className="row space">
          <div className="pill">
            Mode:{" "}
            <select
              value={settings.mode}
              onChange={(e) => setSettings({ ...settings, mode: e.target.value as any })}
            >
              <option value="mix">Mix</option>
              <option value="mc">Multiple choice</option>
              <option value="write">Writing</option>
            </select>
          </div>

          <div className="pill">
            Swap:{" "}
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.swap}
                onChange={(e) => setSettings({ ...settings, swap: e.target.checked })}
              />
              <span />
            </label>
          </div>

          <div className="pill">
            Chunk size:{" "}
            <input
              type="number"
              min={4}
              max={30}
              value={settings.chunkSize}
              onChange={(e) => setSettings({ ...settings, chunkSize: clampInt(Number(e.target.value || 10), 4, 30) })}
            />
          </div>

          <div className="pill">
            New/chunk:{" "}
            <input
              type="number"
              min={0}
              max={10}
              value={settings.newPerChunk}
              onChange={(e) => setSettings({ ...settings, newPerChunk: clampInt(Number(e.target.value || 3), 0, 10) })}
            />
          </div>
        </div>

        <div className="row space" style={{ marginTop: 10 }}>
          <div className="pill">
            TTS:{" "}
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.ttsEnabled}
                onChange={(e) => setSettings({ ...settings, ttsEnabled: e.target.checked })}
              />
              <span />
            </label>
          </div>

          <div className="pill">
            Lang:{" "}
            <input
              value={settings.ttsLang}
              onChange={(e) => setSettings({ ...settings, ttsLang: e.target.value })}
              style={{ width: 90 }}
            />
          </div>

          <div className="pill">
            Voice:{" "}
            <select
              value={settings.preferredVoiceURI ?? ""}
              onChange={(e) =>
                setSettings({ ...settings, preferredVoiceURI: e.target.value || null })
              }
            >
              <option value="">(default)</option>
              {voices.map(v => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} {v.lang ? `(${v.lang})` : ""}
                </option>
              ))}
            </select>
          </div>

          <button className="ghost" onClick={() => q && speak(cards.find(c => c.id === q.cardId)?.tts ?? "", settings)}>
            ▶ Speak (col 3)
          </button>
        </div>

        <hr />

        {!q ? (
          <div className="muted">No question available. Import some cards.</div>
        ) : (
          <>
            <div className="prompt">
              <div className="label">Prompt</div>
              <div className="big">{q.prompt}</div>
            </div>

            {q.kind === "mc" && (
              <div className="grid">
                {q.options.map((opt, i) => (
                  <button
                    key={i}
                    className="opt"
                    onClick={() => chooseMC(opt)}
                    disabled={!!feedback}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {q.kind === "write" && (
              <div>
                <input
                  className="in"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Type the answer…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !feedback) submitWrite();
                  }}
                  disabled={!!feedback}
                />
                <div className="row" style={{ marginTop: 10 }}>
                  <button onClick={submitWrite} disabled={!!feedback}>Check</button>
                  <button className="ghost" onClick={() => { setTyped(""); setFeedback(null); }}>Clear</button>
                </div>
              </div>
            )}

            {feedback && (
              <div className={"fb " + (feedback.ok ? "ok" : "bad")}>
                <div className="row space">
                  <div>
                    <b>{feedback.ok ? "Correct" : "Wrong"}</b>
                    {q.kind === "mc" && !feedback.ok && (
                      <div className="muted">Correct: {feedback.correct}</div>
                    )}
                    {q.kind === "write" && (
                      <div className="muted">Expected: {feedback.expected}</div>
                    )}
                  </div>
                  <button onClick={nextQuestionMaybeRebuild}>Next</button>
                </div>

                {q.kind === "write" && (
                  <div className="typed">
                    <div className="muted small">Your typed answer (wrong letters are red):</div>
                    <div className="typedLine">
                      {diffTypedToExpected(
                        settings.writeTrim ? typed.trim() : typed,
                        settings.writeTrim ? (feedback.expected ?? "").trim() : (feedback.expected ?? "")
                      ).map((x, idx) => (
                        <span key={idx} className={x.ok ? "okCh" : "badCh"}>{x.ch || " "}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <footer className="muted small">
        Export current set:
        <button
          className="ghost"
          onClick={() => {
            const text = exportTSV(cards);
            navigator.clipboard.writeText(text);
            alert("Copied TSV to clipboard.");
          }}
          style={{ marginLeft: 8 }}
        >
          Copy TSV
        </button>
      </footer>
    </div>
  );
}

