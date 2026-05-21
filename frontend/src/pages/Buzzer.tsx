import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { WikiBlurb } from "../components/WikiBlurb";
import { Hint } from "../components/Hint";
import { useMetaCategories } from "../hooks/useMetaCategories";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useUnloadGuard } from "../hooks/useUnloadGuard";

type Clue = {
  id: number;
  question: string;
  value: number;
  round: string;
  category: string;
  dailyDouble: boolean;
};

const ROUND_LENGTH = 10;
const LOCKOUT_MS = 250;       // penalty for buzzing before the lights
const ANSWER_WINDOW_MS = 5000; // time to type after buzzing (per show)
const READING_RATE_MS_PER_WORD = 280; // approximation of a host's read rate

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }       // clue being "read" — early buzz = lockout
  | { kind: "ready" }         // lights on — can buzz
  | { kind: "lockedOut" }     // buzzed too early; locked for 250ms
  | { kind: "answering" }     // buzzed in time; type answer
  | { kind: "result"; correct: boolean; canonical: string; typed: string; responseId: string | null; value: number; timedOut?: boolean; llmVerdict?: boolean | null }
  | { kind: "done" };

type Result = { correct: boolean; value: number; ms: number; lockouts: number; responseId: string | null };

type SavedRound = {
  sessionId: string;
  clues: Clue[];
  results: Result[];
};

const BUZZER_SAVE_KEY = "buzzer-round-v1";

function loadSavedRound(): SavedRound | null {
  try {
    const raw = localStorage.getItem(BUZZER_SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.sessionId === "string" &&
      Array.isArray(parsed?.clues) &&
      Array.isArray(parsed?.results)
    ) {
      return parsed;
    }
  } catch {
    // ignore corrupt save
  }
  return null;
}

function saveRound(s: SavedRound): void {
  try {
    localStorage.setItem(BUZZER_SAVE_KEY, JSON.stringify(s));
  } catch {
    // private mode / quota; non-fatal
  }
}

function clearSavedRound(): void {
  try {
    localStorage.removeItem(BUZZER_SAVE_KEY);
  } catch {
    // non-fatal
  }
}

export function Buzzer() {
  useDocumentTitle("Buzzer");
  const { enabled: enabledMeta } = useMetaCategories();
  const [clues, setClues] = useState<Clue[]>([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [answer, setAnswer] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [lockoutsThisClue, setLockoutsThisClue] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [pendingResume, setPendingResume] = useState<SavedRound | null>(null);
  const [markingResponseId, setMarkingResponseId] = useState<string | null>(null);

  useEffect(() => {
    setPendingResume(loadSavedRound());
  }, []);

  // Guard against accidental tab-close mid-clue. The resume save covers most
  // refresh cases, but a tab close could still lose in-flight buzz timing.
  useUnloadGuard(
    phase.kind === "answering" ||
      phase.kind === "ready" ||
      phase.kind === "reading",
  );
  const lightsOnAt = useRef<number>(0);
  const buzzedAt = useRef<number>(0);
  const sessionIdRef = useRef<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers() {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  }

  async function startSession() {
    // A fresh round invalidates any older save.
    clearSavedRound();
    setPendingResume(null);
    setMarkingResponseId(null);
    const params = new URLSearchParams({ limit: String(ROUND_LENGTH) });
    if (enabledMeta.length > 0) {
      params.set("metaCategories", enabledMeta.join(","));
    }
    const [start, cluesRes] = await Promise.all([
      api.post("/buzzer/start"),
      api.get(`/clues/random?${params.toString()}`),
    ]);
    sessionIdRef.current = start.data.sessionId;
    setClues(cluesRes.data.clues);
    setIdx(0);
    setResults([]);
    presentClue(cluesRes.data.clues[0]);
  }

  function resumeSession() {
    if (!pendingResume) return;
    const { sessionId, clues: savedClues, results: savedResults } = pendingResume;
    sessionIdRef.current = sessionId;
    setClues(savedClues);
    setResults(savedResults);
    setPendingResume(null);
    setMarkingResponseId(null);
    if (savedResults.length >= savedClues.length) {
      // All answered before refresh — go straight to finalize.
      setIdx(savedClues.length - 1);
      finishSession();
      return;
    }
    const resumeIdx = savedResults.length;
    setIdx(resumeIdx);
    presentClue(savedClues[resumeIdx]);
  }

  function discardSavedRound() {
    clearSavedRound();
    setPendingResume(null);
  }

  function presentClue(c: Clue) {
    setLockoutsThisClue(0);
    setAnswer("");
    setMarkingResponseId(null);
    setPhase({ kind: "reading" });
    const wordCount = c.question.split(/\s+/).length;
    const readMs = Math.max(1500, wordCount * READING_RATE_MS_PER_WORD);
    timers.current.push(
      setTimeout(() => {
        lightsOnAt.current = Date.now();
        setPhase({ kind: "ready" });
        // If they don't buzz within answer window after lights, mark wrong
        timers.current.push(
          setTimeout(() => {
            recordTimeout();
          }, ANSWER_WINDOW_MS),
        );
      }, readMs),
    );
  }

  function buzz() {
    if (phase.kind === "reading") {
      // Early buzz → lockout
      setLockoutsThisClue((n) => n + 1);
      setPhase({ kind: "lockedOut" });
      timers.current.push(
        setTimeout(() => {
          // Resume — but only if we're still "before the lights"
          // (use timestamp check vs lightsOnAt to avoid race)
          setPhase((cur) =>
            cur.kind === "lockedOut" ? { kind: "reading" } : cur,
          );
        }, LOCKOUT_MS),
      );
      return;
    }
    if (phase.kind === "ready") {
      buzzedAt.current = Date.now();
      clearTimers();
      setPhase({ kind: "answering" });
      // Per-show 5s answering window
      timers.current.push(
        setTimeout(() => {
          recordTimeout();
        }, ANSWER_WINDOW_MS),
      );
    }
  }

  async function recordTimeout() {
    const clue = clues[idx];
    if (!clue) return;
    // Submit an empty answer so the server has a ClueResponse row for this clue
    // — otherwise the server-side coryat recompute would ignore timeouts.
    const { data } = await api.post("/clues/submit", {
      clueId: clue.id,
      answer: "",
      responseTimeMs: ANSWER_WINDOW_MS,
      mode: "BUZZER",
      buzzerSessionId: sessionIdRef.current,
    });
    const entry: Result = {
      correct: false,
      value: clue.value,
      ms: ANSWER_WINDOW_MS,
      lockouts: lockoutsThisClue,
      responseId: data.responseId ?? null,
    };
    setResults((r) => {
      const next = [...r, entry];
      if (sessionIdRef.current) {
        saveRound({ sessionId: sessionIdRef.current, clues, results: next });
      }
      return next;
    });
    setPhase({
      kind: "result",
      correct: false,
      canonical: data.canonicalAnswer ?? "(timed out)",
      typed: "",
      responseId: data.responseId ?? null,
      value: clue.value,
      timedOut: true,
      llmVerdict: data.llmVerdict ?? null,
    });
  }

  const resultMarking =
    phase.kind === "result" &&
    phase.responseId != null &&
    markingResponseId === phase.responseId;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space" && (phase.kind === "reading" || phase.kind === "ready")) {
        e.preventDefault();
        buzz();
      }
      if (e.key === "Enter" && phase.kind === "result" && !resultMarking) {
        e.preventDefault();
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buzz/next read latest closure values
  }, [phase, idx, clues, results, resultMarking]);

  useEffect(() => {
    return () => clearTimers();
  }, []);

  // Kick off hint generation in the background when a clue is shown.
  useEffect(() => {
    const c = clues[idx];
    if (!c) return;
    void api.post(`/clues/${c.id}/hint/prepare`).catch(() => {});
  }, [clues, idx]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const clue = clues[idx];
    if (!clue || phase.kind !== "answering") return;
    clearTimers();
    setSubmitting(true);
    try {
      // Clamp to the answer window; backgrounded tabs throttle Date.now() updates.
      const responseTimeMs = Math.min(Date.now() - lightsOnAt.current, ANSWER_WINDOW_MS);
      const { data } = await api.post("/clues/submit", {
        clueId: clue.id,
        answer,
        responseTimeMs,
        mode: "BUZZER",
        buzzerSessionId: sessionIdRef.current,
      });
      const entry: Result = {
        correct: data.correct,
        value: clue.value,
        ms: responseTimeMs,
        lockouts: lockoutsThisClue,
        responseId: data.responseId ?? null,
      };
      setResults((r) => {
        const next = [...r, entry];
        if (sessionIdRef.current) {
          saveRound({ sessionId: sessionIdRef.current, clues, results: next });
        }
        return next;
      });
      setPhase({
        kind: "result",
        correct: data.correct,
        canonical: data.canonicalAnswer,
        typed: answer,
        responseId: data.responseId,
        value: clue.value,
        llmVerdict: data.llmVerdict ?? null,
      });
      setAnswer("");
    } finally {
      setSubmitting(false);
    }
  }

  async function markAsGotIt() {
    if (phase.kind !== "result" || phase.correct || !phase.responseId) return;
    const responseId = phase.responseId;
    if (markingResponseId === responseId) return;
    setMarkingResponseId(responseId);
    try {
      const { data } = await api.post(`/clues/mark-correct/${responseId}`);
      if (data.alreadyCorrect) return;
      setResults((r) =>
        r.map((entry) =>
          entry.responseId === responseId ? { ...entry, correct: true } : entry,
        ),
      );
      setPhase((cur) =>
        cur.kind === "result" && cur.responseId === responseId
          ? { ...cur, correct: true }
          : cur,
      );
    } finally {
      setMarkingResponseId((cur) => (cur === responseId ? null : cur));
    }
  }

  async function markAsDidntGetIt() {
    if (phase.kind !== "result" || !phase.correct || !phase.responseId) return;
    const responseId = phase.responseId;
    if (markingResponseId === responseId) return;
    setMarkingResponseId(responseId);
    try {
      const { data } = await api.post(`/clues/mark-incorrect/${responseId}`);
      if (data.alreadyIncorrect) return;
      setResults((r) =>
        r.map((entry) =>
          entry.responseId === responseId ? { ...entry, correct: false } : entry,
        ),
      );
      setPhase((cur) =>
        cur.kind === "result" && cur.responseId === responseId
          ? { ...cur, correct: false }
          : cur,
      );
    } finally {
      setMarkingResponseId((cur) => (cur === responseId ? null : cur));
    }
  }

  function next() {
    clearTimers();
    if (idx + 1 >= clues.length) {
      finishSession();
      return;
    }
    setIdx(idx + 1);
    presentClue(clues[idx + 1]);
  }

  async function finishSession() {
    if (sessionIdRef.current) {
      try {
        await api.post("/buzzer/finish", { sessionId: sessionIdRef.current });
      } catch {
        // Already-finished or empty session; fall through to the done screen.
      }
    }
    sessionIdRef.current = null;
    clearSavedRound();
    setMarkingResponseId(null);
    setPhase({ kind: "done" });
  }

  if (phase.kind === "idle") {
    return (
      <div className="max-w-3xl mx-auto text-center space-y-6">
        <h1 className="font-category text-4xl text-jeopardy-gold">Buzzer Training</h1>
        <p className="text-white/80">
          The clue is "read" first — buzzing early locks you out for 250ms (just like the show).
          When the buzzer indicator turns gold, you have 5 seconds to buzz, then 5 seconds to answer.
          Press <kbd className="px-2 py-1 bg-white/20 rounded">SPACE</kbd> to buzz.
        </p>
        {pendingResume && pendingResume.results.length < pendingResume.clues.length && (
          <div className="bg-jeopardy-gold/10 border border-jeopardy-gold/40 rounded p-4 space-y-3">
            <p className="text-sm">
              You have an unfinished round —{" "}
              <span className="text-jeopardy-gold">
                {pendingResume.results.length}/{pendingResume.clues.length}
              </span>{" "}
              clues answered.
            </p>
            <div className="flex gap-2 justify-center flex-wrap">
              <button
                onClick={resumeSession}
                className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded"
              >
                Resume round
              </button>
              <button
                onClick={discardSavedRound}
                className="px-6 py-2 border border-white/30 hover:bg-white/10 rounded text-sm"
              >
                Discard
              </button>
            </div>
          </div>
        )}
        <button onClick={startSession} className="px-8 py-3 bg-jeopardy-gold text-black font-semibold rounded">
          Start round ({ROUND_LENGTH} clues)
        </button>
      </div>
    );
  }

  if (phase.kind === "done") {
    const correctCount = results.filter((r) => r.correct).length;
    const coryatScore = results.reduce(
      (s, r) => s + (r.correct ? r.value : -r.value),
      0,
    );
    const totalLockouts = results.reduce((s, r) => s + r.lockouts, 0);
    const avgMs = Math.round(
      results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length),
    );
    return (
      <div className="max-w-3xl mx-auto text-center space-y-6">
        <h1 className="font-category text-4xl text-jeopardy-gold">Round complete</h1>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Correct" value={`${correctCount}/${results.length}`} />
          <Stat label="Coryat" value={`$${coryatScore}`} />
          <Stat label="Avg buzz" value={`${avgMs}ms`} />
          <Stat label="Early buzzes" value={totalLockouts} />
        </div>
        <button onClick={() => setPhase({ kind: "idle" })} className="px-8 py-3 bg-jeopardy-gold text-black font-semibold rounded">
          Another round
        </button>
      </div>
    );
  }

  const clue = clues[idx];
  if (!clue) return null;

  const buzzColor =
    phase.kind === "ready" ? "bg-jeopardy-gold text-black"
    : phase.kind === "lockedOut" ? "bg-red-700 text-white"
    : phase.kind === "answering" ? "bg-green-700 text-white"
    : "bg-white/10 text-white/50";

  const buzzLabel =
    phase.kind === "ready" ? "BUZZ! (Space)"
    : phase.kind === "lockedOut" ? "LOCKED OUT"
    : phase.kind === "answering" ? "BUZZED IN"
    : phase.kind === "reading" ? "wait for the lights..."
    : "";

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between text-sm">
        <span>Clue {idx + 1} / {clues.length}</span>
        <span>Coryat: <span className="dollar">${results.reduce((s, r) => s + (r.correct ? r.value : -r.value), 0)}</span></span>
      </div>
      <div className="category-banner text-center py-3 sm:py-4 text-2xl sm:text-4xl">
        {clue.category} — <span className="dollar">${clue.value}</span>
      </div>
      <div className="clue-tile p-10 text-center min-h-[200px] flex items-center justify-center rounded">
        <p className="text-2xl">{clue.question}</p>
      </div>

      {(phase.kind === "reading" || phase.kind === "ready" || phase.kind === "lockedOut") && (
        <button
          onClick={buzz}
          disabled={phase.kind === "lockedOut"}
          className={`w-full py-6 font-bold text-2xl rounded transition ${buzzColor}`}
        >
          {buzzLabel}
        </button>
      )}

      {phase.kind === "answering" && (
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            autoFocus
            aria-label="Your answer"
            autoComplete="off"
            className="flex-1 px-3 py-3 rounded bg-white/10"
            placeholder="What is..."
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
          >
            {submitting ? "…" : "Submit"}
          </button>
        </form>
      )}

      {phase.kind === "result" && (
        <div className={`p-4 rounded text-center ${phase.correct ? "bg-green-700/40" : phase.timedOut ? "bg-yellow-700/40" : "bg-red-700/40"}`}>
          <p className="text-xl">{phase.correct ? "✓ Correct!" : phase.timedOut ? "⏱ Time's up — no buzz" : "✗ Incorrect"}</p>
          <p className="text-sm mt-2 text-white/70">{clue.question}</p>
          <p className="text-sm mt-2 text-white/80">Answer: <span className="font-bold">{phase.canonical}</span></p>
          {!phase.correct && !phase.timedOut && phase.typed && (
            <p className="text-xs mt-1 text-white/60">You typed: <span className="italic">{phase.typed}</span></p>
          )}
          <div className="mt-4 flex gap-2 justify-center flex-wrap">
            {!phase.correct && phase.responseId && (
              <button
                onClick={markAsGotIt}
                disabled={resultMarking}
                className="px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/30 rounded text-sm min-h-[40px]"
              >
                {resultMarking ? "Updating…" : "Mark as got it"}
              </button>
            )}
            {phase.correct && phase.responseId && (
              <button
                onClick={markAsDidntGetIt}
                disabled={resultMarking}
                className="px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/30 rounded text-sm min-h-[40px]"
              >
                {resultMarking ? "Updating…" : "Didn't get it"}
              </button>
            )}
            <button
              onClick={next}
              disabled={resultMarking}
              className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
            >
              {idx + 1 >= clues.length ? "Finish" : "Next clue → (Enter)"}
            </button>
          </div>
          {phase.kind === "result" && phase.llmVerdict != null && (
            <p className="text-[10px] mt-1 text-white/40">
              LLM invoked: {phase.llmVerdict ? "YES" : "NO"}
            </p>
          )}
          <WikiBlurb clueId={clue.id} />
          <Hint clueId={clue.id} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white/5 rounded p-4">
      <div className="text-xs uppercase tracking-wide text-white/60">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
