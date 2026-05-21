import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { WikiBlurb } from "../components/WikiBlurb";
import { Hint } from "../components/Hint";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RetryPanel } from "../components/RetryPanel";

type Clue = {
  id: number;
  question: string;
  value: number;
  category: string;
  reviewCount: number;
  intervalDays: number;
};

type ReviewStats = {
  due: number;
  total: number;
  nextReviewAt: string | null;
};

export function Review() {
  useDocumentTitle("Review");
  const { user } = useAuth();
  const [clues, setClues] = useState<Clue[]>([]);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<{
    correct: boolean;
    canonical: string;
    intervalDays: number;
    typed: string;
    responseId: string;
    llmVerdict?: boolean | null;
  } | null>(null);
  const [shownAt, setShownAt] = useState(0);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [markingResponseId, setMarkingResponseId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user]);

  // Kick off hint generation in the background when a clue is shown.
  useEffect(() => {
    const c = clues[idx];
    if (!c) return;
    void api.post(`/clues/${c.id}/hint/prepare`).catch(() => {});
  }, [clues, idx]);

  async function refresh() {
    try {
      const [a, b] = await Promise.all([
        api.get("/review/due?limit=20"),
        api.get("/review/stats"),
      ]);
      setClues(a.data.clues);
      setStats(b.data);
      setIdx(0);
      setResult(null);
      setMarkingResponseId(null);
      setAnswer("");
      setShownAt(Date.now());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    if (!result || markingResponseId === result.responseId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- next() captures latest idx/clues via closure
  }, [result, idx, markingResponseId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const clue = clues[idx];
    if (!clue) return;
    setSubmitting(true);
    try {
      // Bounded — backgrounded tabs throttle Date.now() updates.
      const responseTimeMs = Math.min(Date.now() - shownAt, 60_000);
      const submitRes = await api.post("/clues/submit", {
        clueId: clue.id,
        answer,
        responseTimeMs,
        mode: "REVIEW",
      });
      const sched = await api.post("/review/result", {
        clueId: clue.id,
        correct: submitRes.data.correct,
      });
      setResult({
        correct: submitRes.data.correct,
        canonical: submitRes.data.canonicalAnswer,
        intervalDays: sched.data.schedule.intervalDays,
        typed: answer,
        responseId: submitRes.data.responseId,
        llmVerdict: submitRes.data.llmVerdict ?? null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function markAsGotIt() {
    if (!result || result.correct) return;
    const clue = clues[idx];
    const responseId = result.responseId;
    if (!clue || !responseId || markingResponseId === responseId) return;
    setMarkingResponseId(responseId);
    try {
      await api.post(`/clues/mark-correct/${responseId}`);
      // Reschedule the SRS row to match the attested correctness so the next
      // review interval reflects "knew it" instead of "got it wrong".
      const sched = await api.post("/review/result", {
        clueId: clue.id,
        correct: true,
      });
      setResult((cur) =>
        cur && cur.responseId === responseId
          ? {
              ...cur,
              correct: true,
              intervalDays: sched.data.schedule.intervalDays,
            }
          : cur,
      );
    } finally {
      setMarkingResponseId((cur) => (cur === responseId ? null : cur));
    }
  }

  async function markAsDidntGetIt() {
    if (!result || !result.correct) return;
    const clue = clues[idx];
    const responseId = result.responseId;
    if (!clue || !responseId || markingResponseId === responseId) return;
    setMarkingResponseId(responseId);
    try {
      await api.post(`/clues/mark-incorrect/${responseId}`);
      const sched = await api.post("/review/result", {
        clueId: clue.id,
        correct: false,
      });
      setResult((cur) =>
        cur && cur.responseId === responseId
          ? {
              ...cur,
              correct: false,
              intervalDays: sched.data.schedule.intervalDays,
            }
          : cur,
      );
    } finally {
      setMarkingResponseId((cur) => (cur === responseId ? null : cur));
    }
  }

  function next() {
    if (idx + 1 >= clues.length) {
      refresh();
      return;
    }
    setIdx(idx + 1);
    setMarkingResponseId(null);
    setResult(null);
    setAnswer("");
    setShownAt(Date.now());
  }

  if (!user) {
    return (
      <div className="max-w-md mx-auto text-center">
        <h1 className="font-category text-4xl text-jeopardy-gold">Review</h1>
        <p className="mt-4 text-white/80">Log in to review clues you've gotten wrong.</p>
      </div>
    );
  }

  if (loadError) {
    return <RetryPanel onRetry={refresh} message="Couldn't load your review queue." />;
  }

  if (!stats) return <p className="text-white/60 text-center py-12">Loading…</p>;

  if (clues.length === 0) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-category text-4xl text-jeopardy-gold">Review</h1>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Due now" value={stats.due} />
          <Stat label="In queue" value={stats.total} />
          <Stat label="Next due" value={stats.nextReviewAt ? new Date(stats.nextReviewAt).toLocaleDateString() : "—"} />
        </div>
        <p className="text-white/70 text-sm">
          {stats.total === 0
            ? "Get some clues wrong in Practice or Buzzer mode and they'll show up here for spaced review."
            : "Nothing due right now. Come back later — wrong clues come back tomorrow, then on a growing interval."}
        </p>
      </div>
    );
  }

  const clue = clues[idx];
  const resultMarking = result != null && markingResponseId === result.responseId;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between text-sm">
        <span>Review — Clue {idx + 1} / {clues.length}</span>
        <span className="text-white/60">{stats.due} due • interval {clue.intervalDays}d</span>
      </div>
      <div className="category-banner text-center py-3 sm:py-4 text-2xl sm:text-4xl">
        {clue.category} — <span className="dollar">${clue.value}</span>
      </div>
      <div className="clue-tile p-10 text-center min-h-[200px] flex items-center justify-center rounded">
        <p className="text-2xl">{clue.question}</p>
      </div>
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
        <div className={`p-4 rounded text-center ${result.correct ? "bg-green-700/40" : "bg-red-700/40"}`}>
          <p className="text-xl">{result.correct ? "✓ Correct!" : "✗ Incorrect"}</p>
          <p className="text-sm mt-2 text-white/70">{clue.question}</p>
          <p className="text-sm mt-2 text-white/80">Answer: <span className="font-bold">{result.canonical}</span></p>
          {!result.correct && result.typed && (
            <p className="text-xs mt-1 text-white/60">You typed: <span className="italic">{result.typed}</span></p>
          )}
          <p className="text-xs mt-1 text-white/60">
            {result.correct
              ? `Next review in ${result.intervalDays} day${result.intervalDays === 1 ? "" : "s"}.`
              : "Reset to 1 day — see you tomorrow."}
          </p>
          <div className="mt-4 flex gap-2 justify-center flex-wrap">
            {!result.correct && (
              <button
                onClick={markAsGotIt}
                disabled={resultMarking}
                className="px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/30 rounded text-sm min-h-[40px]"
              >
                {resultMarking ? "Updating…" : "Mark as got it"}
              </button>
            )}
            {result.correct && (
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
              {idx + 1 >= clues.length ? "Done (Enter)" : "Next clue → (Enter)"}
            </button>
          </div>
          {result.llmVerdict != null && (
            <p className="text-[10px] mt-1 text-white/40">
              LLM invoked: {result.llmVerdict ? "YES" : "NO"}
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
    <div className="bg-white/5 rounded p-3 sm:p-4 min-w-0">
      <div className="text-xs uppercase tracking-wide text-white/60">{label}</div>
      <div className="text-base sm:text-xl font-bold mt-1 truncate">{value}</div>
    </div>
  );
}
