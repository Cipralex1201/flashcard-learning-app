import { useEffect, useMemo, useRef, useState } from "react";
import { loadDB, saveDB, ensureState } from "./lib/db";
import { parseTSV } from "./lib/tsv";
import type { Card, Question, Settings, CardState } from "./lib/types";
import { buildChunk, makeQuestion, applyAnswer, gradeWrite } from "./lib/scheduler";
import { diffTypedToExpected } from "./lib/diff";
import { speak } from "./lib/tts";

/**
 * Returns per-character highlighting for the EXPECTED string.
 * Any character that differs from what the user typed (missing or substituted) is marked "diff".
 */
type ExpectedStep =
  | { t: "match"; typedIndex: number; expectedIndex: number }
  | { t: "sub"; typedIndex: number; expectedIndex: number }
  | { t: "ins"; typedIndex: number }
  | { t: "del"; expectedIndex: number };

type ExpectedRawChar = {
  raw: string;
  comparable: string | null;
};

const IGNORE_RE = /[\u0591-\u05C7?.()!;\-_'~]/;

function toComparableCharsExpected(s: string): ExpectedRawChar[] {
  return Array.from(s.normalize("NFC")).map((ch) => ({
    raw: ch,
    comparable: IGNORE_RE.test(ch) ? null : ch,
  }));
}

/**
 * Returns per-character highlighting for the EXPECTED string.
 * Missing/substituted real chars are diff=true.
 * Ignored chars stay visible but are never marked diff.
 */
function diffExpectedVsTyped(
  typedRaw: string,
  expectedRaw: string
): Array<{ ch: string; diff: boolean; ignored: boolean }> {
  const typedChars = toComparableCharsExpected(typedRaw);
  const expectedChars = toComparableCharsExpected(expectedRaw);

  const typedComparable: Array<{ ch: string; rawIndex: number }> = [];
  const expectedComparable: Array<{ ch: string; rawIndex: number }> = [];

  for (let i = 0; i < typedChars.length; i++) {
    if (typedChars[i].comparable !== null) {
      typedComparable.push({ ch: typedChars[i].comparable!, rawIndex: i });
    }
  }

  for (let i = 0; i < expectedChars.length; i++) {
    if (expectedChars[i].comparable !== null) {
      expectedComparable.push({ ch: expectedChars[i].comparable!, rawIndex: i });
    }
  }

  const n = typedComparable.length;
  const m = expectedComparable.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = typedComparable[i - 1].ch === expectedComparable[j - 1].ch ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const steps: ExpectedStep[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = typedComparable[i - 1].ch === expectedComparable[j - 1].ch ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        steps.push(
          cost === 0
            ? { t: "match", typedIndex: i - 1, expectedIndex: j - 1 }
            : { t: "sub", typedIndex: i - 1, expectedIndex: j - 1 }
        );
        i--;
        j--;
        continue;
      }
    }

    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      steps.push({ t: "ins", typedIndex: i - 1 });
      i--;
      continue;
    }

    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      steps.push({ t: "del", expectedIndex: j - 1 });
      j--;
      continue;
    }

    if (j > 0) {
      steps.push({ t: "del", expectedIndex: j - 1 });
      j--;
    } else {
      steps.push({ t: "ins", typedIndex: i - 1 });
      i--;
    }
  }

  steps.reverse();

  const rawDiff = expectedChars.map((ch) => ch.comparable === null ? false : false);
  const rawIgnored = expectedChars.map((ch) => ch.comparable === null);

  for (const st of steps) {
    if (st.t === "sub" || st.t === "del") {
      const rawIndex = expectedComparable[st.expectedIndex].rawIndex;
      rawDiff[rawIndex] = true;
    }
  }

  return expectedChars.map((item, idx) => ({
    ch: item.raw,
    diff: rawDiff[idx],
    ignored: rawIgnored[idx],
  }));
}

const SAMPLE = `term1
tts1
definition1

term2
tts2
definition2

term3
tts3
definition3`;

type WriteInputHandle = {
  getValue: () => string;
  clear: () => void;
  focus: () => void;
};

function WriteInputUncontrolled(props: {
  disabled: boolean;
  resetKey: string;
  onEnter: () => void;
  handleRef: React.MutableRefObject<WriteInputHandle | null>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.value = "";
  }, [props.resetKey]);

  useEffect(() => {
    props.handleRef.current = {
      getValue: () => inputRef.current?.value ?? "",
      clear: () => {
        if (inputRef.current) inputRef.current.value = "";
      },
      focus: () => inputRef.current?.focus(),
    };
    return () => {
      props.handleRef.current = null;
    };
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

  const [lastTyped, setLastTyped] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; expected?: string; correct?: string } | null>(null);

  const [tsvText, setTsvText] = useState("");
  const [isImportOpen, setIsImportOpen] = useState(false);
  const showImport = isImportOpen || cards.length === 0;

  const writeHandleRef = useRef<WriteInputHandle | null>(null);

  useEffect(() => {
    const db = loadDB();
    setCards(db.cards);
    setStates(db.states);
    setSettings(db.settings);
  }, []);

  useEffect(() => {
    saveDB({ cards, states, settings });
  }, [cards, states, settings]);

  useEffect(() => {
    if (!cards.length) return;
    const next = { ...states };
    for (const c of cards) ensureState(next, c.id);
    setStates(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length]);

  /* ===========================
     SM-2 PROGRESS (UI)
     =========================== */
  const progress = useMemo(() => {
    const total = cards.length;
    const now = Date.now();

    const st = (c: Card) => ensureState(states, c.id) as CardState;

    const learned = cards.filter((c) => st(c).lastReviewedAt > 0).length;
    const dueNow = cards.filter((c) => st(c).dueAt <= now).length;

    const easy = cards.filter((c) => {
      const s = st(c);
      return s.reps >= 3 && s.ease >= 2.5 && s.intervalDays >= 15;
    }).length;

    return { total, learned, dueNow, easy };
  }, [cards, states]);

  function newChunkAndQuestion() {
    const chunk = buildChunk(cards, { ...states }, settings);
    setChunkIds(chunk);
    setQ(makeQuestion(cards, { ...states }, settings, chunk));
    setLastTyped("");
    setFeedback(null);
  }

  useEffect(() => {
    if (!cards.length) return;
    if (!q) newChunkAndQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length, settings.swap, settings.mode, settings.schedulingMode]);


  function afterAnswer(cardId: string, correct: boolean) {
    if (!q) return;

    const next = { ...states };
    applyAnswer(next, cardId, q.kind, correct);
    setStates(next);

    const card = cards.find((c) => c.id === cardId);
    if (card) speak(card.tts, settings);
  }

  function playCurrentAudio() {
    if (!q) return;
    const card = cards.find((c) => c.id === q.cardId);
    if (!card) return;
    speak(card.tts, settings);
  }


  function nextQuestionMaybeRebuild() {
    const nq = makeQuestion(cards, { ...states }, settings, chunkIds);
    if (!nq) newChunkAndQuestion();
    else {
      setQ(nq);
      setLastTyped("");
      setFeedback(null);
    }
  }

  function clearWrite() {
    writeHandleRef.current?.clear();
    setLastTyped("");
    setFeedback(null);
    writeHandleRef.current?.focus();
  }

  function submitWriteFromInput() {
    if (!q || q.kind !== "write") return;
    const typed = writeHandleRef.current?.getValue() ?? "";
    setLastTyped(typed);
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

    const merged = [...cards, ...incoming];
    setCards(merged);

    const nextStates = { ...states };
    for (const c of incoming) ensureState(nextStates, c.id);
    setStates(nextStates);

    setIsImportOpen(false);
    setTsvText("");
    setTimeout(() => newChunkAndQuestion(), 0);
  }

  if (showImport) {
    return (
      <div className="wrap">
        <h1>Flash Learn</h1>
        <p className="muted">
          Paste your set as: <code>term newline tts newline definition newline blank line</code>
          <br />
        </p>

        <textarea className="ta" value={tsvText} onChange={(e) => setTsvText(e.target.value)} placeholder={SAMPLE} />

        <div className="row">
          <button onClick={importTSV}>Import</button>
        </div>

        <p className="muted small">Runs locally in your browser. Data is saved in your browser storage.</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <h1>Flash Learn</h1>                        
          <div className="muted">
            Learned: <b>{progress.learned}</b> / {progress.total}
            {" · "}Due now: <b>{progress.dueNow}</b>
            {" · "}Easy: <b>{progress.easy}</b>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <div className="pill">
              <span className="muted small">Scheduling</span>
              <b>
                {settings.schedulingMode === "practice" ? "Practice" : "Learning"}
              </b>
            </div>

            <div className="pill">
              <span className="muted small">Direction</span>
              <b>{settings.swap ? "Definition → Term" : "Term → Definition"}</b>
            </div>

            <div className="pill">
              <span className="muted small">Learning</span>
              <label className="switch" title="Toggle scheduling mode">
                <input
                  type="checkbox"
                  checked={settings.schedulingMode === "practice"}
                  onChange={(e) => {
                    const schedulingMode = e.target.checked
                      ? "practice"
                      : "learning";

                    setSettings((s) => ({ ...s, schedulingMode }));

                    // force rebuild
                    setQ(null);
                  }}
                />
                <span />
              </label>
              <span className="muted small">Practice</span>
            </div>

            <div className="pill">
              <span className="muted small">Term → Def</span>
              <label className="switch" title="Toggle question direction">
                <input
                  type="checkbox"
                  checked={settings.swap}
                  onChange={(e) => {
                    const swap = e.target.checked;
                    setSettings((s) => ({ ...s, swap }));

                    // force rebuild
                    setQ(null);
                  }}
                />
                <span />
              </label>
              <span className="muted small">Def → Term</span>
            </div>
          </div>


          <div style={{ marginTop: 10 }}>
            <div className="muted small">Easy mastery</div>
            <div className="bar">
              <div
                className="barFill"
                style={{ width: `${progress.total ? (progress.easy / progress.total) * 100 : 0}%` }}
              />
            </div>

            <div className="muted small" style={{ marginTop: 8 }}>
              Queue cleared
            </div>
            <div className="bar">
              <div
                className="barFill"
                style={{
                  width: `${progress.total ? ((progress.total - progress.dueNow) / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        </div>
      </header>

      <section className="card">
        {!q ? (
          <div className="muted">
            No question available.
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={newChunkAndQuestion}>Build queue</button>
              <button
                className="ghost"
                onClick={() => {
                  console.log("cards", cards.length, "chunkIds", chunkIds.length, "dueNow", progress.dueNow);
                }}
              >
                Debug
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 10 }}>
              If this stays empty: buildChunk() returned 0 ids.
            </div>
          </div>
        ) : (
          <>
            <div className="prompt">
              <div className="label">Prompt</div>
              <div className="big">{q.prompt}</div>
            </div>

            {/* ===== MULTIPLE CHOICE ===== */}
            {q.kind === "mc" && (
              <div className="grid">
                {q.options.map((o, i) => (
                  <button key={i} className="opt" disabled={!!feedback} onClick={() => chooseMC(o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}

            {/* ===== WRITING ===== */}
            {q.kind === "write" && (
              <>
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

                  {/* optional skip, only when not answered yet */}
                  {!feedback && (
                    <button className="ghost" onClick={nextQuestionMaybeRebuild}>
                      Skip
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ===== FEEDBACK + NEXT (BOTH MODES) ===== */}
            {feedback && (
              <div className={"fb " + (feedback.ok ? "ok" : "bad")} style={{ marginTop: 12 }}>
                <div className="row space">
                  <div>
                    <b>{feedback.ok ? "Correct" : "Wrong"}</b>

                    {q.kind === "mc" && !feedback.ok && (
                      <div className="muted">Correct: {feedback.correct}</div>
                    )}

                    {/* WRITE: show YOUR answer here (where "Expected" used to be), with bad parts red */}
                    {q.kind === "write" && (
                      <div className="muted">
                        Your answer:{" "}
                        {diffTypedToExpected(
                          settings.writeTrim ? lastTyped.trim() : lastTyped,
                          settings.writeTrim ? (feedback.expected ?? "").trim() : (feedback.expected ?? "")
                        ).map((x, idx) => (
                          <span
                            key={idx}
                            className={
                              x.kind === "bad"
                                ? "badCh"
                                : x.kind === "ignored"
                                ? "ignoredCh"
                                : "okCh"
                            }
                          >
                            {x.ch || " "}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                    <button
                      className="ghost"
                      onClick={playCurrentAudio}
                      disabled={!settings.ttsEnabled}
                      title={settings.ttsEnabled ? "Play audio" : "Enable TTS in settings to play audio"}
                    >
                      Play Audio
                    </button>

                  <button onClick={nextQuestionMaybeRebuild}>Next</button>
                </div>

                {/* WRITE: show the CORRECT answer in the big line, with differing chars green */}
                {q.kind === "write" && (
                  <div className="typed" style={{ marginTop: 10 }}>
                    <div className="muted small">Correct answer (letters that differ from yours are green):</div>
                    <div className="typedLine">
                      {diffExpectedVsTyped(
                      settings.writeTrim ? lastTyped.trim() : lastTyped,
                      settings.writeTrim ? (feedback.expected ?? "").trim() : (feedback.expected ?? "")
                    ).map((x, idx) => (
                      <span
                        key={idx}
                        className={x.ignored ? "ignoredCh" : "okCh"}
                        style={x.diff ? { color: "#16a34a", fontWeight: 700 } : undefined}
                      >
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
    </div>
  );
}
