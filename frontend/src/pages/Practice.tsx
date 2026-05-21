import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { WikiBlurb } from "../components/WikiBlurb";
import { Hint } from "../components/Hint";
import { TimerBar } from "../components/TimerBar";
import { MetaCategoryChips } from "../components/MetaCategoryChips";
import { useVoiceRecognition } from "../hooks/useVoiceRecognition";
import { useTextToSpeech } from "../hooks/useTextToSpeech";
import { useMetaCategories } from "../hooks/useMetaCategories";
import { useTtsMode } from "../hooks/useTtsMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const PRACTICE_TIME_MS = 15000;
const VOICE_MODE_KEY = "jeopardy_voice_mode";

type Clue = {
  id: number;
  question: string;
  value: number;
  round: string;
  category: string;
  dailyDouble: boolean;
};

export function Practice() {
  useDocumentTitle("Practice");
  const { user } = useAuth();
  const { enabled: enabledMeta } = useMetaCategories();
  const [clue, setClue] = useState<Clue | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<{
    correct: boolean;
    canonical: string;
    typed: string;
    responseId: string;
    value: number;
    responseTimeMs: number;
    timedOut?: boolean;
    // null = LLM judge was not invoked (deterministic matcher already decided).
    // true/false = LLM was invoked and gave this verdict.
    llmVerdict?: boolean | null;
  } | null>(null);
  const [shownAt, setShownAt] = useState<number>(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [markingResponseId, setMarkingResponseId] = useState<string | null>(null);
  const [weakMode, setWeakMode] = useState<boolean>(false);
  const [weakCategories, setWeakCategories] = useState<
    { id: number; name: string; accuracy: number; attempts: number }[]
  >([]);
  const [voiceMode, setVoiceMode] = useState<boolean>(
    () => typeof window !== "undefined" && localStorage.getItem(VOICE_MODE_KEY) === "true",
  );
  useEffect(() => {
    localStorage.setItem(VOICE_MODE_KEY, String(voiceMode));
  }, [voiceMode]);
  const { enabled: ttsMode, setEnabled: setTtsMode } = useTtsMode();
  const tts = useTextToSpeech();

  async function nextClue() {
    setLoading(true);
    setMarkingResponseId(null);
    setResult(null);
    setAnswer("");
    if (weakMode) {
      const { data } = await api.get("/clues/weak?limit=1");
      setWeakCategories(data.weakCategories ?? []);
      if (data.clues.length === 0) {
        setClue(null);
        setLoading(false);
        return;
      }
      setClue(data.clues[0]);
      setShownAt(Date.now());
      setLoading(false);
      return;
    }
    const params = new URLSearchParams({ limit: "1" });
    if (enabledMeta.length > 0) {
      params.set("metaCategories", enabledMeta.join(","));
    }
    const { data } = await api.get(`/clues/random?${params.toString()}`);
    if (data.clues.length === 0) {
      setClue(null);
      setLoading(false);
      return;
    }
    setClue(data.clues[0]);
    setShownAt(Date.now());
    setLoading(false);
  }

  useEffect(() => {
    nextClue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weakMode]);

  // Fire-and-forget hint kickoff. Server starts (or no-ops if cached/in-flight)
  // and the result panel will poll when needed. Errors are silent — hints are
  // a nice-to-have and must not get in the way of the user's flow.
  useEffect(() => {
    if (!clue) return;
    void api.post(`/clues/${clue.id}/hint/prepare`).catch(() => {});
  }, [clue?.id]);

  const voice = useVoiceRecognition({
    onInterim: (text) => setAnswer(text),
    onFinal: (text) => {
      setAnswer(text);
      submitAnswer(text);
    },
  });

  // Auto-start voice recognition when a new clue appears and voice mode is on.
  useEffect(() => {
    if (!voiceMode || !clue || result || !voice.supported) return;
    const id = setTimeout(() => voice.start(), 200);
    return () => {
      clearTimeout(id);
      voice.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode, clue?.id, result]);

  // Read the clue aloud when TTS is on. Cancel on result/clue-change.
  useEffect(() => {
    if (!ttsMode || !clue || result || !tts.supported) {
      tts.cancel();
      return;
    }
    tts.speak(`${clue.category}, for $${clue.value}. ${clue.question}`);
    return () => tts.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsMode, clue?.id, result]);

  useEffect(() => {
    if (!result || markingResponseId === result.responseId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        nextClue();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nextClue is stable in the result lifetime
  }, [result, markingResponseId]);

  async function submitAnswer(text: string) {
    if (!clue || result || submitting) return;
    // Clamp to the timer window — Date.now() keeps ticking while the tab is
    // backgrounded, so an unattended tab would otherwise report minutes of
    // "response time" once focus returns.
    const responseTimeMs = Math.min(Date.now() - shownAt, PRACTICE_TIME_MS);
    setSubmitting(true);
    try {
      if (user) {
        const { data } = await api.post("/clues/submit", {
          clueId: clue.id,
          answer: text,
          responseTimeMs,
          mode: "PRACTICE",
        });
        setResult({
          correct: data.correct,
          canonical: data.canonicalAnswer,
          typed: text,
          responseId: data.responseId,
          value: clue.value,
          responseTimeMs,
          llmVerdict: data.llmVerdict ?? null,
        });
        setScore((s) => s + data.valueDelta);
        setStreak((st) => (data.correct ? st + 1 : 0));
      } else {
        const { data } = await api.post("/clues/check", {
          clueId: clue.id,
          answer: text,
        });
        const delta = data.correct ? clue.value : -clue.value;
        setResult({
          correct: data.correct,
          canonical: data.canonicalAnswer,
          typed: text,
          responseId: "",
          value: clue.value,
          responseTimeMs,
          llmVerdict: data.llmVerdict ?? null,
        });
        setScore((s) => s + delta);
        setStreak((st) => (data.correct ? st + 1 : 0));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await submitAnswer(answer);
  }

  async function handleTimeout() {
    if (!clue || result) return;
    if (user) {
      const { data } = await api.post("/clues/submit", {
        clueId: clue.id,
        answer: "",
        responseTimeMs: PRACTICE_TIME_MS,
        mode: "PRACTICE",
      });
      setResult({
        correct: false,
        canonical: data.canonicalAnswer,
        typed: "",
        responseId: data.responseId,
        value: clue.value,
        responseTimeMs: PRACTICE_TIME_MS,
        timedOut: true,
      });
      setScore((s) => s + data.valueDelta);
    } else {
      const { data } = await api.post("/clues/check", {
        clueId: clue.id,
        answer: "",
      });
      setResult({
        correct: false,
        canonical: data.canonicalAnswer,
        typed: "",
        responseId: "",
        value: clue.value,
        responseTimeMs: PRACTICE_TIME_MS,
        timedOut: true,
      });
      setScore((s) => s - clue.value);
    }
    setStreak(0);
  }

  async function markAsGotIt() {
    if (!result || !result.responseId) return;
    const responseId = result.responseId;
    if (markingResponseId === responseId) return;
    setMarkingResponseId(responseId);
    try {
      const { data } = await api.post(`/clues/mark-correct/${responseId}`);
      if (data.alreadyCorrect) return;
      // Reverse the wrong-answer score change (+value to undo -value, then add +value for the credit)
      setScore((s) => s + 2 * (data.valueDelta || result.value));
      setStreak((st) => st + 1);
      setResult((cur) =>
        cur && cur.responseId === responseId ? { ...cur, correct: true } : cur,
      );
    } finally {
      setMarkingResponseId((cur) => (cur === responseId ? null : cur));
    }
  }

  async function markAsDidntGetIt() {
    if (!result || !result.responseId) return;
    const responseId = result.responseId;
    if (markingResponseId === responseId) return;
    setMarkingResponseId(responseId);
    try {
      const { data } = await api.post(`/clues/mark-incorrect/${responseId}`);
      if (data.alreadyIncorrect) return;
      setScore((s) => s - 2 * (data.valueDelta || result.value));
      setStreak(0);
      setResult((cur) =>
        cur && cur.responseId === responseId ? { ...cur, correct: false } : cur,
      );
    } finally {
      setMarkingResponseId((cur) => (cur === responseId ? null : cur));
    }
  }

  const resultMarking = result != null && markingResponseId === result.responseId;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {!user && (
        <div className="bg-jeopardy-gold/10 border border-jeopardy-gold/40 rounded px-3 py-2 text-xs text-center text-white/80">
          Playing as guest — score isn't saved.{" "}
          <Link to="/login" className="text-jeopardy-gold underline">
            Log in
          </Link>{" "}
          to track stats and unlock review.
        </div>
      )}
      <div className="flex justify-between items-center text-sm flex-wrap gap-2">
        <span>Score: <span className="dollar text-2xl">${score}</span></span>
        <div className="flex items-center gap-3">
          {tts.supported && (
            <button
              onClick={() => {
                if (ttsMode) tts.cancel();
                setTtsMode((v) => !v);
              }}
              className={`px-3 py-2 rounded border text-xs min-h-[36px] ${
                ttsMode
                  ? "bg-jeopardy-gold text-black border-jeopardy-gold"
                  : "border-white/30 hover:bg-white/10"
              }`}
              title={ttsMode ? "TTS on — click to disable" : "TTS off — click to enable"}
            >
              🔊 {ttsMode ? "TTS on" : "TTS off"}
            </button>
          )}
          {voice.supported && (
            <button
              onClick={() => {
                if (voiceMode) voice.stop();
                setVoiceMode((v) => !v);
              }}
              className={`px-3 py-2 rounded border text-xs min-h-[36px] ${
                voiceMode
                  ? "bg-jeopardy-gold text-black border-jeopardy-gold"
                  : "border-white/30 hover:bg-white/10"
              }`}
              title={voiceMode ? "Voice mode on — click to disable" : "Voice mode off — click to enable"}
            >
              🎤 {voiceMode ? "Voice on" : "Voice off"}
            </button>
          )}
          <span>Streak: <span className="text-jeopardy-gold font-bold">{streak}</span></span>
        </div>
      </div>
      {voiceMode && voice.listening && !result && (
        <div className="text-center text-xs text-jeopardy-gold">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1 animate-pulse" />
          Listening…
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {user && (
          <button
            onClick={() => setWeakMode((m) => !m)}
            className={`px-3 py-2 rounded border text-xs min-h-[36px] ${
              weakMode
                ? "bg-jeopardy-gold text-black border-jeopardy-gold"
                : "border-white/30 hover:bg-white/10"
            }`}
            title="Drill your weakest categories"
          >
            🎯 Weak drill {weakMode ? "on" : "off"}
          </button>
        )}
        {weakMode && weakCategories.length > 0 && (
          <span className="text-xs text-white/60">
            {weakCategories.length} weakest:{" "}
            {weakCategories
              .slice(0, 3)
              .map((w) => `${w.name} (${Math.round(w.accuracy * 100)}%)`)
              .join(", ")}
            {weakCategories.length > 3 ? "…" : ""}
          </span>
        )}
      </div>
      {!weakMode && <MetaCategoryChips onChange={() => { if (!result) nextClue(); }} />}
      {weakMode && weakCategories.length === 0 && !loading && (
        <div className="text-center text-white/60 text-sm py-4">
          Not enough data yet — answer at least 3 clues in a category for it to qualify as "weak".
        </div>
      )}
      {!clue && !loading && (
        <div className="text-center text-white/70 py-12">
          No clues found for the selected categories.
        </div>
      )}
      {clue && (
        <div className="space-y-4">
          <div className="category-banner text-center py-3 sm:py-4 text-2xl sm:text-4xl">
            {clue.category} — <span className="dollar">${clue.value || "?"}</span>
            {clue.dailyDouble && <span className="ml-3 text-jeopardy-gold">★ Daily Double</span>}
          </div>
          <div className="clue-tile p-10 text-center min-h-[200px] flex items-center justify-center rounded">
            <p className="text-2xl">{clue.question}</p>
          </div>
          <TimerBar
            totalMs={PRACTICE_TIME_MS}
            resetKey={clue.id}
            paused={!!result}
            onExpire={() => {
              // Only auto-fail if they haven't started typing — if they're mid-answer,
              // let them finish and submit.
              if (answer.trim().length === 0) handleTimeout();
            }}
          />
          {!result && (
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
          {result && (
            <div className={`p-4 rounded text-center ${result.correct ? "bg-green-700/40" : result.timedOut ? "bg-yellow-700/40" : "bg-red-700/40"}`}>
              <p className="text-xl">
                {result.correct ? "✓ Correct!" : result.timedOut ? "⏱ Time's up" : "✗ Incorrect"}
              </p>
              <p className="text-sm mt-2 text-white/70">{clue.question}</p>
              <p className="text-sm mt-2 text-white/80">Answer: <span className="font-bold">{result.canonical}</span></p>
              {!result.correct && !result.timedOut && result.typed && (
                <p className="text-xs mt-1 text-white/60">You typed: <span className="italic">{result.typed}</span></p>
              )}
              <p className="text-xs mt-1 text-white/50">Time: {(result.responseTimeMs / 1000).toFixed(1)}s</p>
              {result.llmVerdict != null && (
                <p className="text-[10px] mt-0.5 text-white/40">
                  LLM invoked: {result.llmVerdict ? "YES" : "NO"}
                </p>
              )}
              <div className="mt-4 flex gap-2 justify-center flex-wrap">
                {/* Mark-correct/incorrect rely on a server-persisted response — only available when logged in. */}
                {user && !result.correct && (
                  <button
                    onClick={markAsGotIt}
                    disabled={resultMarking}
                    className="px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/30 rounded text-sm min-h-[40px]"
                  >
                    {resultMarking ? "Updating…" : "Mark as got it"}
                  </button>
                )}
                {user && result.correct && (
                  <button
                    onClick={markAsDidntGetIt}
                    disabled={resultMarking}
                    className="px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/30 rounded text-sm min-h-[40px]"
                  >
                    {resultMarking ? "Updating…" : "Didn't get it"}
                  </button>
                )}
                <button
                  onClick={nextClue}
                  disabled={loading || resultMarking}
                  className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
                >
                  Next clue →
                </button>
              </div>
              <WikiBlurb clueId={clue.id} />
              <Hint clueId={clue.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
