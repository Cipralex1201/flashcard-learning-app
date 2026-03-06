import { useEffect, useMemo, useRef, useState } from "react";
import { loadDB, saveDB, ensureState, resetProgressKeepCards } from "./lib/db";
import { parseTSV, exportTSV } from "./lib/tsv";
import type { Card, Question, Settings } from "./lib/types";
import { buildChunk, makeQuestion, applyAnswer, gradeWrite } from "./lib/scheduler";
import { diffTypedToExpected } from "./lib/diff";
import { listVoices, speak } from "./lib/tts";

const SAMPLE = `megy
הוֹלֵךְ
הולך

ül
יוֹשֵׁב
יושב

eszik
אוֹכֵל
אוכל

iszik
שׁוֹתֶה
שותה

tanul
לוֹמֵד
לומד

dolgozik
עוֹבֵד
עובד`;


function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

type WriteInputHandle = {
  getValue: () => string;
  clear: () => void;
  focus: () => void;
};

function WriteInputUncontrolled(props: {
  disabled: boolean;
  resetKey: string; // change this to reset when question changes (q.cardId)
  onEnter: () => void;
  handleRef: React.MutableRefObject<WriteInputHandle | null>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.value = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetKey]);

  useEffect(() => {
    props.handleRef.current = {
      getValue: () => inputRef.current?.value ?? "",
      clear: () => {
        if (inputRef.current) inputRef.current.value = "";
      },
      focus: () => {
        inputRef.current?.focus();
      },
    };
    return () => {
      props.handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <input
      ref={inputRef}
      className="in"
      placeholder="Type the answer…"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !props.disabled) props.onEnter();
      }}
      disabled={props.disabled}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
    />
  );
}

export default function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [states, setStates] = useState(loadDB().states);
  const [settings, setSettings] = useState<Settings>(loadDB().settings);

  const [chunkIds, setChunkIds] = useState<string[]>([]);
  const [q, setQ] = useState<Question | null>(null);

  // store only the last submitted typed answer (for diff display)
  const [lastTyped, setLastTyped] = useState("");

  const [feedback, setFeedback] = useState<{ ok: boolean; expected?: string; correct?: string } | null>(null);

  const [tsvText, setTsvText] = useState("");
  const [isImportOpen, setIsImportOpen] = useState(false);
  const showImport = isImportOpen || cards.length === 0;


  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  // Handle to uncontrolled input (so buttons can read/clear it)
  const writeHandleRef = useRef<WriteInputHandle | null>(null);

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
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
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
    const seen = cards.filter((c) => ensureState(states, c.id).seen).length;
    const total = cards.length;
    const dueNow = cards.filter(
      (c) => ensureState(states, c.id).seen && ensureState(states, c.id).dueAt <= Date.now()
    ).length;
    return { seen, total, dueNow };
  }, [cards, states]);

  function newChunkAndQuestion() {
    const chunk = buildChunk(cards, { ...states }, settings);
    setChunkIds(chunk);
    const nq = makeQuestion(cards, { ...states }, settings, chunk);
    setQ(nq);
    setLastTyped("");
    setFeedback(null);
    // input resets via resetKey (q.cardId) when q changes
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
    const card = cards.find((c) => c.id === cardId);
    if (card) speak(card.tts, settings);
  }

  function nextQuestionMaybeRebuild() {
    const nq = makeQuestion(cards, { ...states }, settings, chunkIds);
    if (!nq) {
      newChunkAndQuestion();
    } else {
      setQ(nq);
      setLastTyped("");
      setFeedback(null);
      // input resets via resetKey (q.cardId)
    }
  }

  function submitWriteFromInput() {
    if (!q || q.kind !== "write") return;

    const typedNow = writeHandleRef.current?.getValue() ?? "";
    setLastTyped(typedNow);

    const ok = gradeWrite(typedNow, q.expected, settings.writeTrim);
    setFeedback({ ok, expected: q.expected });
    afterAnswer(q.cardId, ok);
  }

  function clearWrite() {
    writeHandleRef.current?.clear();
    setLastTyped("");
    setFeedback(null);
    writeHandleRef.current?.focus();
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

    const merged = [...cards, ...incoming];
    setCards(merged);

    const nextStates = { ...states };
    for (const c of incoming) ensureState(nextStates, c.id);
    setStates(nextStates);

    setShowImport(false);setIsImportOpen(false);

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
          Paste your set as: <code>term newline tts newline definition newline blank line</code>
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
          <button className="ghost" onClick={() => setTsvText(SAMPLE)}>
            Fill sample
          </button>
          {cards.length > 0 && (
            <button className="ghost" onClick={() => setIsImportOpen(false)}>
              Close
            </button>
          )}
        </div>


        <p className="muted small">Runs locally in your browser. Data is saved in your browser storage.</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <h1>Hebrew Flash Learn</h1>
          <div className="muted">
            Seen: <b>{progress.seen}</b> / {progress.total} · Due now: <b>{progress.dueNow}</b> · Chunk:{" "}
            <b>{chunkIds.length}</b>
          </div>
        </div>

        <div className="row">
          <button className="ghost" onClick={() => setIsImportOpen(true)}>
            Import TSV
          </button>

          <button className="ghost" onClick={doResetProgress}>
            Reset progress
          </button>
        </div>
      </header>

      <section className="card">
        <div className="row space">
          <div className="pill">
            Mode:{" "}
            <select value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value as any })}>
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
              onChange={(e) =>
                setSettings({ ...settings, chunkSize: clampInt(Number(e.target.value || 10), 4, 30) })
              }
            />
          </div>

          <div className="pill">
            New/chunk:{" "}
            <input
              type="number"
              min={0}
              max={10}
              value={settings.newPerChunk}
              onChange={(e) =>
                setSettings({ ...settings, newPerChunk: clampInt(Number(e.target.value || 3), 0, 10) })
              }
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
              onChange={(e) => setSettings({ ...settings, preferredVoiceURI: e.target.value || null })}
            >
              <option value="">(default)</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} {v.lang ? `(${v.lang})` : ""}
                </option>
              ))}
            </select>
          </div>

          <button className="ghost" onClick={() => q && speak(cards.find((c) => c.id === q.cardId)?.tts ?? "", settings)}>
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
                  <button key={i} className="opt" onClick={() => chooseMC(opt)} disabled={!!feedback}>
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {q.kind === "write" && (
              <div>
                <WriteInputUncontrolled
                  disabled={!!feedback}
                  resetKey={q.cardId}
                  onEnter={submitWriteFromInput}
                  handleRef={writeHandleRef}
                />
                <div className="row" style={{ marginTop: 10 }}>
                  <button onClick={submitWriteFromInput} disabled={!!feedback}>
                    Check
                  </button>
                  <button className="ghost" onClick={clearWrite}>
                    Clear
                  </button>
                </div>
              </div>
            )}

            {feedback && (
              <div className={"fb " + (feedback.ok ? "ok" : "bad")}>
                <div className="row space">
                  <div>
                    <b>{feedback.ok ? "Correct" : "Wrong"}</b>
                    {q.kind === "mc" && !feedback.ok && <div className="muted">Correct: {feedback.correct}</div>}
                    {q.kind === "write" && <div className="muted">Expected: {feedback.expected}</div>}
                  </div>
                  <button onClick={nextQuestionMaybeRebuild}>Next</button>
                </div>

                {q.kind === "write" && (
                  <div className="typed">
                    <div className="muted small">Your typed answer (wrong letters are red):</div>
                    <div className="typedLine">
                      {diffTypedToExpected(
                        settings.writeTrim ? lastTyped.trim() : lastTyped,
                        settings.writeTrim ? (feedback.expected ?? "").trim() : (feedback.expected ?? "")
                      ).map((x, idx) => (
                        <span key={idx} className={x.ok ? "okCh" : "badCh"}>
                          {x.ch || " "}
                        </span>
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

