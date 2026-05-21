import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { WikiBlurb } from "../components/WikiBlurb";
import { Hint } from "../components/Hint";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useUnloadGuard } from "../hooks/useUnloadGuard";
import { RetryPanel } from "../components/RetryPanel";

type Clue = {
  id: number;
  question: string;
  value: number;
  round: string;
  category: string;
  dailyDouble: boolean;
};

type Row = {
  userId: string;
  displayName: string;
  score: number;
  totalCorrect: number;
  totalClues: number;
  completedAt: string;
};

type GuestProgress = { idx: number; score: number; correctCount: number };

const GUEST_KEY_PREFIX = "daily-guest:";
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTDOWN_TICK_MS = 1000;

function loadGuestProgress(date: string): GuestProgress | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY_PREFIX + date);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.idx === "number" &&
      typeof parsed?.score === "number" &&
      typeof parsed?.correctCount === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveGuestProgress(date: string, progress: GuestProgress): void {
  if (!date) return;
  try {
    localStorage.setItem(GUEST_KEY_PREFIX + date, JSON.stringify(progress));
  } catch {
    // Storage may be unavailable (private mode, disabled) — fall back silently;
    // the user just loses refresh-resistance.
  }
}

function getNextDailyResetAt(date: string): number | null {
  const currentSetStart = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(currentSetStart)) return null;
  return currentSetStart + DAY_MS;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function utcTodayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function validDateKey(value: string | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(time)) return date;
  return new Date(time + days * DAY_MS).toISOString().slice(0, 10);
}

export function Daily() {
  useDocumentTitle("Daily");
  const { user } = useAuth();
  const nav = useNavigate();
  const { date: dateParam } = useParams();
  const requestedDate = validDateKey(dateParam);
  const [date, setDate] = useState<string>("");
  const [clues, setClues] = useState<Clue[]>([]);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<{ correct: boolean; canonical: string; typed: string; llmVerdict?: boolean | null } | null>(null);
  const [score, setScore] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [shownAt, setShownAt] = useState(0);
  const [done, setDone] = useState(false);
  const [alreadyPlayed, setAlreadyPlayed] = useState<Row | null>(null);
  const [board, setBoard] = useState<Row[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);

  // Warn before tab close while the user is mid-daily — answers are saved per
  // submission, but in-flight typing isn't.
  useUnloadGuard(!done && clues.length > 0 && idx < clues.length);

  useEffect(() => {
    let cancelled = false;
    setDate("");
    setClues([]);
    setIdx(0);
    setAnswer("");
    setResult(null);
    setScore(0);
    setCorrectCount(0);
    setDone(false);
    setAlreadyPlayed(null);
    setBoard([]);
    setLoadError(false);
    (async () => {
      let todayRes;
      const query = requestedDate ? `?date=${encodeURIComponent(requestedDate)}` : "";
      try {
        todayRes = await api.get(`/daily/today${query}`);
      } catch {
        if (!cancelled) setLoadError(true);
        return;
      }
      if (cancelled) return;
      setLoadError(false);
      const dayDate: string = todayRes.data.date;
      const dayClues: Clue[] = todayRes.data.clues;
      setDate(dayDate);
      setClues(dayClues);
      setShownAt(Date.now());

      const lb = await api.get(`/daily/leaderboard?date=${encodeURIComponent(dayDate)}`);
      if (!cancelled) setBoard(lb.data.rows);

      if (user) {
        const meRes = await api.get(`/daily/me?date=${encodeURIComponent(dayDate)}`);
        if (cancelled) return;
        if (meRes.data.attempt) {
          setAlreadyPlayed(meRes.data.attempt);
          setDone(true);
          setScore(meRes.data.attempt.score);
          setCorrectCount(meRes.data.attempt.totalCorrect);
        } else if (meRes.data.progress) {
          const p = meRes.data.progress;
          setScore(p.score);
          setCorrectCount(p.correctCount);
          if (p.idx >= dayClues.length) {
            // All clues answered but /finish wasn't called (closed tab after
            // last submit). Finalize now.
            const { data } = await api.post("/daily/finish", { date: dayDate });
            if (!cancelled && data.attempt) {
              setScore(data.attempt.score);
              setCorrectCount(data.attempt.totalCorrect);
              setAlreadyPlayed(data.attempt);
            }
            const lb2 = await api.get(`/daily/leaderboard?date=${encodeURIComponent(dayDate)}`);
            if (!cancelled) {
              setBoard(lb2.data.rows);
              setDone(true);
            }
          } else {
            setIdx(p.idx);
          }
        }
      } else {
        const stored = loadGuestProgress(dayDate);
        if (cancelled || !stored) return;
        setScore(stored.score);
        setCorrectCount(stored.correctCount);
        if (stored.idx >= dayClues.length) {
          setDone(true);
        } else {
          setIdx(stored.idx);
        }
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [requestedDate, user, retryKey]);

  // Move focus to the Next button when the result appears. Enter on a focused
  // button activates it naturally — more reliable than a window keydown listener,
  // which can be defeated if something else captures focus (e.g. a Wiki link in
  // the blurb below the result).
  useEffect(() => {
    if (result) nextBtnRef.current?.focus();
  }, [result]);

  // Kick off hint generation in the background as soon as a clue is shown,
  // so it's likely cached by the time the user finishes answering.
  useEffect(() => {
    const c = clues[idx];
    if (!c) return;
    void api.post(`/clues/${c.id}/hint/prepare`).catch(() => {});
  }, [clues, idx]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const clue = clues[idx];
    if (!clue) return;
    setSubmitting(true);
    try {
      if (user) {
        // Bounded so a backgrounded tab doesn't report wall-clock minutes.
        const responseTimeMs = Math.min(Date.now() - shownAt, 60_000);
        const { data } = await api.post("/clues/submit", {
          clueId: clue.id,
          answer,
          responseTimeMs,
          mode: "DAILY",
          dailyDate: date,
        });
        setResult({ correct: data.correct, canonical: data.canonicalAnswer, typed: answer, llmVerdict: data.llmVerdict ?? null });
        setScore((s) => s + data.valueDelta);
        if (data.correct) setCorrectCount((c) => c + 1);
      } else {
        // Anonymous play: check correctness without persisting server-side.
        const { data } = await api.post("/clues/check", {
          clueId: clue.id,
          answer,
        });
        setResult({ correct: data.correct, canonical: data.canonicalAnswer, typed: answer, llmVerdict: data.llmVerdict ?? null });
        const delta = data.correct ? clue.value : -clue.value;
        const newScore = score + delta;
        const newCorrect = correctCount + (data.correct ? 1 : 0);
        setScore(newScore);
        setCorrectCount(newCorrect);
        // Persist immediately so a refresh before clicking Next can't retry this clue.
        // idx + 1 because this clue is now answered; on resume we show the next one.
        saveGuestProgress(date, {
          idx: idx + 1,
          score: newScore,
          correctCount: newCorrect,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function nextClue() {
    setResult(null);
    setAnswer("");
    if (idx + 1 >= clues.length) {
      if (user) {
        const { data } = await api.post("/daily/finish", { date });
        // Server-authoritative score — sync local display to what was recorded.
        if (data.attempt) {
          setScore(data.attempt.score);
          setCorrectCount(data.attempt.totalCorrect);
          setAlreadyPlayed(data.attempt);
        }
        const lb = await api.get(`/daily/leaderboard?date=${encodeURIComponent(date)}`);
        setBoard(lb.data.rows);
      }
      // Guest progress already saved in onSubmit with idx = clues.length, so
      // a refresh on the done screen lands back on done.
      setDone(true);
      return;
    }
    setIdx(idx + 1);
    setShownAt(Date.now());
  }

  if (done) {
    const isToday = date === utcTodayKey();
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-category text-3xl sm:text-4xl leading-tight text-jeopardy-gold break-words">
          Daily Challenge — {date}
        </h1>
        <DailyDateNav date={date} onJump={(nextDate) => nav(nextDate === utcTodayKey() ? "/daily" : `/daily/${nextDate}`)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          <Stat label="Score" value={`$${score}`} highlight />
          <Stat label="Correct" value={`${correctCount}/${clues.length}`} />
          <Stat label="Status" value={user ? (alreadyPlayed ? "Submitted" : "Done") : "Guest"} />
        </div>
        {user ? (
          <p className="text-white/60 text-sm text-center">
            {alreadyPlayed
              ? "You've already played this challenge."
              : isToday
                ? "Result submitted. Come back tomorrow for a new set."
                : "Result submitted."}
          </p>
        ) : (
          <div className="bg-jeopardy-gold/10 border border-jeopardy-gold/40 rounded p-4 text-center">
            <p className="text-white/90 text-sm">
              Playing as guest — your score isn't saved.{" "}
              <Link to="/register" className="text-jeopardy-gold underline">
                Sign up
              </Link>{" "}
              or{" "}
              <Link to="/login" className="text-jeopardy-gold underline">
                log in
              </Link>{" "}
              to join the leaderboard.
            </p>
          </div>
        )}
        {isToday && <NextSetCountdown date={date} />}
        <h2 className="font-category text-2xl text-jeopardy-gold">
          {isToday ? "Today's Leaderboard" : "Leaderboard"}
        </h2>
        <Leaderboard rows={board} userId={user?.id ?? null} />
      </div>
    );
  }

  if (loadError) {
    return (
      <RetryPanel
        onRetry={() => setRetryKey((k) => k + 1)}
        message="Couldn't load today's daily."
      />
    );
  }
  const clue = clues[idx];
  if (!clue) return <p className="text-white/60 text-center py-12">Loading…</p>;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <DailyDateNav date={date} onJump={(nextDate) => nav(nextDate === utcTodayKey() ? "/daily" : `/daily/${nextDate}`)} />
      <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 break-words">{date} — Clue {idx + 1} / {clues.length}</span>
        <span>Score: <span className="dollar text-2xl">${score}</span></span>
      </div>
      <div className="category-banner px-4 text-center py-3 sm:py-4 text-xl sm:text-4xl">
        {clue.category} — <span className="dollar">${clue.value || "?"}</span>
      </div>
      <div className="clue-tile p-6 sm:p-10 text-center min-h-[180px] sm:min-h-[200px] flex items-center justify-center rounded">
        <p className="text-xl sm:text-2xl break-words">{clue.question}</p>
      </div>
      {!result && (
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
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
            className="px-4 py-3 bg-jeopardy-gold text-black font-semibold rounded min-h-[48px] disabled:opacity-60 disabled:cursor-wait"
          >
            {submitting ? "…" : "Submit"}
          </button>
        </form>
      )}
      {result && (
        <div className={`p-4 rounded text-center overflow-hidden ${result.correct ? "bg-green-700/40" : "bg-red-700/40"}`}>
          <p className="text-lg sm:text-xl">{result.correct ? "✓ Correct!" : "✗ Incorrect"}</p>
          <p className="text-sm mt-2 text-white/70 break-words">{clue.question}</p>
          <p className="text-sm mt-2 text-white/80 break-words">
            Answer: <span className="font-bold">{result.canonical}</span>
          </p>
          {!result.correct && result.typed && (
            <p className="text-xs mt-1 text-white/60 break-words">
              You typed: <span className="italic">{result.typed}</span>
            </p>
          )}
          <button
            ref={nextBtnRef}
            onClick={nextClue}
            className="mt-4 w-full sm:w-auto px-6 py-3 bg-jeopardy-gold text-black font-semibold rounded min-h-[48px] focus:outline focus:outline-2 focus:outline-jeopardy-gold/60"
          >
            {idx + 1 >= clues.length ? "Finish (Enter)" : "Next clue → (Enter)"}
          </button>
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

function DailyDateNav({ date, onJump }: { date: string; onJump: (date: string) => void }) {
  const today = utcTodayKey();
  const isToday = date === today;
  if (!date) return null;

  return (
    <div className="flex flex-col gap-2 rounded border border-white/10 bg-white/5 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <Link
          to={`/daily/${addDays(date, -1)}`}
          className="rounded border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
        >
          Previous
        </Link>
        <Link
          to={isToday ? "/daily" : `/daily/${addDays(date, 1)}`}
          aria-disabled={isToday}
          className={`rounded border border-white/20 px-3 py-2 text-sm ${
            isToday ? "pointer-events-none opacity-40" : "hover:bg-white/10"
          }`}
        >
          Next
        </Link>
        {!isToday && (
          <Link to="/daily" className="rounded border border-jeopardy-gold/40 px-3 py-2 text-sm text-jeopardy-gold hover:bg-jeopardy-gold/10">
            Today
          </Link>
        )}
      </div>
      <input
        type="date"
        max={today}
        value={date}
        onChange={(e) => {
          if (e.currentTarget.value) onJump(e.currentTarget.value);
        }}
        className="rounded bg-white/10 px-3 py-2 text-sm"
        aria-label="Daily challenge date"
      />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`rounded p-3 sm:p-4 min-w-0 ${highlight ? "bg-jeopardy-gold/20 border border-jeopardy-gold/40" : "bg-white/5"}`}>
      <div className="text-xs uppercase tracking-wide text-white/60">{label}</div>
      <div className="text-lg sm:text-2xl font-bold mt-1 break-words">{value}</div>
    </div>
  );
}

function NextSetCountdown({ date }: { date: string }) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    const nextResetAt = getNextDailyResetAt(date);
    if (nextResetAt === null) {
      setRemainingMs(null);
      return;
    }

    const syncRemaining = () => {
      setRemainingMs(Math.max(0, nextResetAt - Date.now()));
    };

    syncRemaining();
    const intervalId = window.setInterval(syncRemaining, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [date]);

  if (remainingMs === null) return null;

  return (
    <div className="rounded border border-white/10 bg-white/5 px-4 py-5 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-white/50">New set available in</p>
      <p className="mt-2 font-category text-3xl text-jeopardy-gold tabular-nums sm:text-4xl">
        {formatCountdown(remainingMs)}
      </p>
      <p className="mt-2 text-xs text-white/50">
        {remainingMs > 0 ? "Daily resets at midnight UTC." : "Refresh to load the next daily set."}
      </p>
    </div>
  );
}

function Leaderboard({ rows, userId }: { rows: Row[]; userId: string | null }) {
  if (rows.length === 0) {
    return <p className="text-white/60 text-sm">Be the first to finish today's challenge.</p>;
  }
  return (
    <div className="bg-white/5 rounded overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-white/10 text-xs uppercase">
          <tr>
            <th className="text-left px-2 sm:px-3 py-2">#</th>
            <th className="text-left px-2 sm:px-3 py-2">Player</th>
            <th className="text-right px-2 sm:px-3 py-2">Score</th>
            <th className="text-right px-2 sm:px-3 py-2">Correct</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.userId} className={`border-t border-white/5 ${userId === r.userId ? "bg-jeopardy-gold/10" : ""}`}>
              <td className="px-2 sm:px-3 py-2">{i + 1}</td>
              <td className="px-2 sm:px-3 py-2 break-words max-w-[140px] sm:max-w-none">{r.displayName}</td>
              <td className="px-2 sm:px-3 py-2 text-right dollar text-base">${r.score}</td>
              <td className="px-2 sm:px-3 py-2 text-right whitespace-nowrap">{r.totalCorrect}/{r.totalClues}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
