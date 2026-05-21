import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useTextToSpeech } from "../hooks/useTextToSpeech";
import { useTtsMode } from "../hooks/useTtsMode";
import { TimerBar } from "../components/TimerBar";
import { WikiBlurb } from "../components/WikiBlurb";
import { Hint } from "../components/Hint";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useUnloadGuard } from "../hooks/useUnloadGuard";

type Cell = {
  id: number;
  question: string;
  value: number;
  round: string;
  category: string;
  dailyDouble: boolean;
} | null;

type RoundBoard = {
  values: number[];
  categories: { name: string; cells: Cell[] }[];
};

type FinalClue = {
  id: number;
  question: string;
  value: number;
  round: string;
  category: string;
  dailyDouble: boolean;
};

type Episode = {
  date?: string;
  jeopardy: RoundBoard;
  doubleJeopardy: RoundBoard;
  finalJeopardy: FinalClue | null;
};

type GameMode = "episode" | "mixed";
type RoundKind = "JEOPARDY" | "DOUBLE_JEOPARDY";
type PlayedSet = Set<number>;

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "board"; round: RoundKind }
  | { kind: "wager"; cell: NonNullable<Cell>; round: RoundKind; max: number }
  | { kind: "reading"; cell: NonNullable<Cell>; round: RoundKind }
  | { kind: "ready"; cell: NonNullable<Cell>; round: RoundKind }
  | { kind: "lockedOut"; cell: NonNullable<Cell>; round: RoundKind }
  | { kind: "answering"; cell: NonNullable<Cell>; round: RoundKind; wager: number | null }
  | { kind: "passed"; cell: NonNullable<Cell>; round: RoundKind; canonical: string }
  | {
      kind: "result";
      cell: NonNullable<Cell>;
      round: RoundKind;
      correct: boolean;
      canonical: string;
      typed: string;
      delta: number;
      responseId: string;
      llmVerdict?: boolean | null;
    }
  | { kind: "final-wager"; clue: FinalClue }
  | { kind: "final-answer"; clue: FinalClue; wager: number }
  | {
      kind: "final-result";
      clue: FinalClue;
      wager: number;
      correct: boolean;
      canonical: string;
      typed: string;
      responseId: string;
      llmVerdict?: boolean | null;
    }
  | { kind: "done"; total: number; reason?: "ineligibleForFinal" };

const READING_RATE_MS_PER_WORD = 280;
const LOCKOUT_MS = 250;
const BUZZ_WINDOW_MS = 5000;
const ANSWER_WINDOW_MS = 5000;
const DD_ANSWER_MS = 15000;
const FINAL_TIME_MS = 30000;

type SavedBoardGame = {
  episode: Episode;
  played: number[];
  score: number;
  finalDone: boolean;
  shareCode?: string | null;
};

const BOARD_SAVE_KEY = "board-game-v1";

function normalizeShareCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatShareCode(raw: string): string {
  return normalizeShareCode(raw).replace(/(.{4})(?=.)/g, "$1-");
}

function loadSavedBoard(): SavedBoardGame | null {
  try {
    const raw = localStorage.getItem(BOARD_SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed?.episode?.jeopardy &&
      parsed?.episode?.doubleJeopardy &&
      Array.isArray(parsed?.played) &&
      typeof parsed?.score === "number"
    ) {
      return {
        episode: parsed.episode,
        played: parsed.played,
        score: parsed.score,
        finalDone: Boolean(parsed.finalDone),
        shareCode:
          typeof parsed?.shareCode === "string"
            ? normalizeShareCode(parsed.shareCode)
            : null,
      };
    }
  } catch {
    // ignore corrupt save
  }
  return null;
}

function saveBoardGame(s: SavedBoardGame): void {
  try {
    localStorage.setItem(BOARD_SAVE_KEY, JSON.stringify(s));
  } catch {
    // non-fatal
  }
}

function clearBoardSave(): void {
  try {
    localStorage.removeItem(BOARD_SAVE_KEY);
  } catch {
    // non-fatal
  }
}

function roundHasUnplayed(round: RoundBoard, played: Set<number>): boolean {
  for (const cat of round.categories) {
    for (const cell of cat.cells) {
      if (cell && !played.has(cell.id)) return true;
    }
  }
  return false;
}

function canPlayFinal(total: number): boolean {
  return total >= 0;
}

export function Board() {
  useDocumentTitle("Board");
  const { user } = useAuth();
  const tts = useTextToSpeech();
  const { enabled: ttsMode, setEnabled: setTtsMode } = useTtsMode();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [played, setPlayed] = useState<PlayedSet>(new Set());
  const [score, setScore] = useState(0);
  const [answer, setAnswer] = useState("");
  const [wagerInput, setWagerInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [passing, setPassing] = useState(false);
  const [wagerError, setWagerError] = useState<string | null>(null);
  const [shareCodeInput, setShareCodeInput] = useState("");
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const buzzedAt = useRef<number>(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const passingRef = useRef(false);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const episodeRef = useRef<Episode | null>(episode);
  episodeRef.current = episode;
  const playedRef = useRef<PlayedSet>(played);
  playedRef.current = played;
  const scoreRef = useRef<number>(score);
  scoreRef.current = score;
  const [pendingResume, setPendingResume] = useState<SavedBoardGame | null>(null);
  const formattedShareCode = shareCode ? formatShareCode(shareCode) : null;

  useEffect(() => {
    setPendingResume(loadSavedBoard());
  }, []);

  // Guard during the most-disruptive phases. Leaving mid-clue means losing the
  // current answer or wager input; the per-clue save covers everything else.
  useUnloadGuard(
    phase.kind === "answering" ||
      phase.kind === "reading" ||
      phase.kind === "ready" ||
      phase.kind === "wager" ||
      phase.kind === "final-wager" ||
      phase.kind === "final-answer",
  );

  // Snapshot the game state to localStorage. Called after every state change
  // (cell played, score change, final answered) so a refresh can resume.
  function persist(opts: {
    nextPlayed?: PlayedSet;
    nextScore?: number;
    nextEpisode?: Episode | null;
    finalDone?: boolean;
    nextShareCode?: string | null;
  }) {
    const ep = opts.nextEpisode ?? episode;
    if (!ep) return;
    saveBoardGame({
      episode: ep,
      played: Array.from(opts.nextPlayed ?? played),
      score: opts.nextScore ?? score,
      finalDone: opts.finalDone ?? false,
      shareCode: opts.nextShareCode ?? shareCode,
    });
  }

  function clearTimers() {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  }

  async function startGame(mode: GameMode) {
    setPhase({ kind: "loading" });
    clearBoardSave();
    setPendingResume(null);
    setShareCode(null);
    setShareCodeInput("");
    setShareError(null);
    setShareStatus(null);
    const endpoint = mode === "episode" ? "/clues/episode" : "/clues/mixed-board";
    const { data } = await api.get(endpoint);
    const ep = data as Episode;
    setEpisode(ep);
    setPlayed(new Set());
    setScore(0);
    setPhase({ kind: "board", round: "JEOPARDY" });
    saveBoardGame({
      episode: ep,
      played: [],
      score: 0,
      finalDone: false,
      shareCode: null,
    });
  }

  function resumeBoardGame() {
    if (!pendingResume) return;
    const ep = pendingResume.episode;
    const playedSet = new Set(pendingResume.played);
    setEpisode(ep);
    setPlayed(playedSet);
    setScore(pendingResume.score);
    setShareCode(pendingResume.shareCode ?? null);
    setShareError(null);
    setShareStatus(null);
    setPendingResume(null);
    // Pick the right phase based on what's still unfinished.
    if (roundHasUnplayed(ep.jeopardy, playedSet)) {
      setPhase({ kind: "board", round: "JEOPARDY" });
    } else if (roundHasUnplayed(ep.doubleJeopardy, playedSet)) {
      setPhase({ kind: "board", round: "DOUBLE_JEOPARDY" });
    } else if (ep.finalJeopardy && !pendingResume.finalDone && canPlayFinal(pendingResume.score)) {
      setPhase({ kind: "final-wager", clue: ep.finalJeopardy });
      setWagerInput("");
    } else if (ep.finalJeopardy && !pendingResume.finalDone) {
      setPhase({ kind: "done", total: pendingResume.score, reason: "ineligibleForFinal" });
    } else {
      setPhase({ kind: "done", total: pendingResume.score });
    }
  }

  function discardBoardSave() {
    clearBoardSave();
    setPendingResume(null);
    setShareCode(null);
    setShareError(null);
    setShareStatus(null);
  }

  async function copyShareCode(raw: string) {
    const formatted = formatShareCode(raw);
    try {
      await navigator.clipboard.writeText(formatted);
      setShareStatus(`Copied share code ${formatted}.`);
      setShareError(null);
    } catch {
      setShareStatus(`Share code: ${formatted}`);
      setShareError(null);
    }
  }

  async function createBoardShare() {
    if (!episode || shareBusy) return;
    if (shareCode) {
      await copyShareCode(shareCode);
      return;
    }
    setShareBusy(true);
    setShareError(null);
    setShareStatus(null);
    try {
      const { data } = await api.post("/clues/board-share", { episode });
      const code = normalizeShareCode(data.code);
      setShareCode(code);
      persist({ nextEpisode: episode, nextShareCode: code });
      await copyShareCode(code);
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setShareError(
        typeof raw === "string" ? raw : "Couldn't create a share code.",
      );
    } finally {
      setShareBusy(false);
    }
  }

  async function loadSharedBoard(e: FormEvent) {
    e.preventDefault();
    const code = normalizeShareCode(shareCodeInput);
    if (!code || shareBusy) return;
    setShareBusy(true);
    setShareError(null);
    setShareStatus(null);
    try {
      tts.cancel();
      clearTimers();
      const { data } = await api.get(`/clues/board-share/${code}`);
      const ep = data.episode as Episode;
      clearBoardSave();
      setPendingResume(null);
      setEpisode(ep);
      setPlayed(new Set());
      setScore(0);
      setShareCode(code);
      setShareCodeInput("");
      setPhase({ kind: "board", round: "JEOPARDY" });
      setShareStatus(`Loaded shared board ${formatShareCode(code)}.`);
      saveBoardGame({
        episode: ep,
        played: [],
        score: 0,
        finalDone: false,
        shareCode: code,
      });
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setShareError(
        typeof raw === "string" ? raw : "Couldn't load that share code.",
      );
    } finally {
      setShareBusy(false);
    }
  }

  function currentBoard(): RoundBoard | null {
    if (!episode || phase.kind !== "board") return null;
    return phase.round === "JEOPARDY" ? episode.jeopardy : episode.doubleJeopardy;
  }

  function selectCell(cell: Cell) {
    if (!cell || phase.kind !== "board") return;
    if (played.has(cell.id)) return;
    if (cell.dailyDouble) {
      const max = Math.max(score, phase.round === "JEOPARDY" ? 1000 : 2000);
      setPhase({ kind: "wager", cell, round: phase.round, max });
      setWagerInput("");
      return;
    }
    startReading(cell, phase.round);
  }

  function startReading(cell: NonNullable<Cell>, round: RoundKind) {
    clearTimers();
    setAnswer("");
    setPhase({ kind: "reading", cell, round });
    if (ttsMode) tts.speak(`${cell.category}, for $${cell.value}. ${cell.question}`);
    const wordCount = cell.question.split(/\s+/).length;
    const readMs = Math.max(1500, wordCount * READING_RATE_MS_PER_WORD);
    timers.current.push(
      setTimeout(() => {
        setPhase((cur) =>
          cur.kind === "reading" && cur.cell.id === cell.id
            ? { kind: "ready", cell, round }
            : cur,
        );
        timers.current.push(
          setTimeout(() => {
            const cur = phaseRef.current;
            if (cur.kind === "ready" && cur.cell.id === cell.id) {
              passClue(cell, round);
            }
          }, BUZZ_WINDOW_MS),
        );
      }, readMs),
    );
  }

  function buzz() {
    const cur = phaseRef.current;
    if (cur.kind === "reading") {
      clearTimers();
      tts.cancel();
      setPhase({ kind: "lockedOut", cell: cur.cell, round: cur.round });
      timers.current.push(
        setTimeout(() => {
          const c = phaseRef.current;
          if (c.kind !== "lockedOut") return;
          setPhase({ kind: "reading", cell: c.cell, round: c.round });
          if (ttsMode) tts.speak(c.cell.question);
          const wordCount = c.cell.question.split(/\s+/).length;
          const remainingReadMs = Math.max(800, Math.floor(wordCount * READING_RATE_MS_PER_WORD * 0.4));
          timers.current.push(
            setTimeout(() => {
              setPhase((p) =>
                p.kind === "reading" && p.cell.id === c.cell.id
                  ? { kind: "ready", cell: c.cell, round: c.round }
                  : p,
              );
              timers.current.push(
                setTimeout(() => {
                  const p = phaseRef.current;
                  if (p.kind === "ready" && p.cell.id === c.cell.id) {
                    passClue(c.cell, c.round);
                  }
                }, BUZZ_WINDOW_MS),
              );
            }, remainingReadMs),
          );
        }, LOCKOUT_MS),
      );
      return;
    }
    if (cur.kind === "ready") {
      clearTimers();
      tts.cancel();
      buzzedAt.current = Date.now();
      setPhase({ kind: "answering", cell: cur.cell, round: cur.round, wager: null });
    }
  }

  async function passClue(cell: NonNullable<Cell>, round: RoundKind) {
    if (passingRef.current) return;
    passingRef.current = true;
    setPassing(true);
    clearTimers();
    tts.cancel();
    const nextPlayed = new Set(played);
    nextPlayed.add(cell.id);
    try {
      const { data } = await api.post("/clues/check", { clueId: cell.id, answer: "" });
      setPlayed(nextPlayed);
      persist({ nextPlayed });
      setPhase({ kind: "passed", cell, round, canonical: data.canonicalAnswer });
    } catch {
      setPlayed(nextPlayed);
      persist({ nextPlayed });
      setPhase({ kind: "passed", cell, round, canonical: "(unavailable)" });
    } finally {
      passingRef.current = false;
      setPassing(false);
    }
  }

  function skipClue() {
    const cur = phaseRef.current;
    if (cur.kind !== "reading" && cur.kind !== "ready" && cur.kind !== "lockedOut") return;
    void passClue(cur.cell, cur.round);
  }

  function confirmDDWager(e: FormEvent) {
    e.preventDefault();
    if (phase.kind !== "wager") return;
    const w = parseInt(wagerInput, 10);
    if (!Number.isFinite(w) || w < 5 || w > phase.max) {
      setWagerError(`Wager must be $5 to $${phase.max.toLocaleString()}.`);
      return;
    }
    setWagerError(null);
    buzzedAt.current = Date.now();
    setPhase({ kind: "answering", cell: phase.cell, round: phase.round, wager: w });
    if (ttsMode) tts.speak(`Daily Double! ${phase.cell.category}. ${phase.cell.question}`);
  }

  async function submitClueAnswer(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (phase.kind !== "answering") return;
    clearTimers();
    tts.cancel();
    setSubmitting(true);
    try {
      const maxMs = phase.wager !== null && phase.cell.dailyDouble ? DD_ANSWER_MS : ANSWER_WINDOW_MS;
      const responseTimeMs = Math.min(Date.now() - buzzedAt.current, maxMs);
      const { data } = await api.post("/clues/submit", {
        clueId: phase.cell.id,
        answer,
        responseTimeMs,
        mode: "BOARD",
        wager: phase.wager,
      });
      const nextScore = score + data.valueDelta;
      const nextPlayed = new Set(played);
      nextPlayed.add(phase.cell.id);
      setScore(nextScore);
      setPlayed(nextPlayed);
      persist({ nextPlayed, nextScore });
      setPhase({
        kind: "result",
        cell: phase.cell,
        round: phase.round,
        correct: data.correct,
        canonical: data.canonicalAnswer,
        typed: answer,
        delta: data.valueDelta,
        responseId: data.responseId,
        llmVerdict: data.llmVerdict ?? null,
      });
      setAnswer("");
    } finally {
      setSubmitting(false);
    }
  }

  function handleAnswerTimeout() {
    if (phase.kind !== "answering") return;
    submitClueAnswer({ preventDefault: () => {} } as FormEvent);
  }

  function backToBoard() {
    const cur = phaseRef.current;
    const curEpisode = episodeRef.current;
    const curPlayed = playedRef.current;
    const curScore = scoreRef.current;
    if ((cur.kind !== "result" && cur.kind !== "passed") || !curEpisode) return;
    const round = cur.round;
    const board = round === "JEOPARDY" ? curEpisode.jeopardy : curEpisode.doubleJeopardy;
    const remaining = board.categories.flatMap((c) =>
      c.cells.filter((cell): cell is NonNullable<Cell> => cell !== null && !curPlayed.has(cell.id)),
    );
    if (remaining.length === 0) {
      if (round === "JEOPARDY") {
        setPhase({ kind: "board", round: "DOUBLE_JEOPARDY" });
      } else if (curEpisode.finalJeopardy && canPlayFinal(curScore)) {
        setPhase({ kind: "final-wager", clue: curEpisode.finalJeopardy });
        setWagerInput("");
      } else if (curEpisode.finalJeopardy) {
        setPhase({ kind: "done", total: curScore, reason: "ineligibleForFinal" });
      } else {
        setPhase({ kind: "done", total: curScore });
      }
      return;
    }
    setPhase({ kind: "board", round });
  }

  function confirmFinalWager(e: FormEvent) {
    e.preventDefault();
    if (phase.kind !== "final-wager") return;
    if (!canPlayFinal(score)) {
      setPhase({ kind: "done", total: score, reason: "ineligibleForFinal" });
      return;
    }
    const max = Math.max(0, score);
    const w = parseInt(wagerInput, 10);
    if (!Number.isFinite(w) || w < 0 || w > max) {
      setWagerError(`Wager must be $0 to $${max.toLocaleString()}.`);
      return;
    }
    setWagerError(null);
    buzzedAt.current = Date.now();
    setPhase({ kind: "final-answer", clue: phase.clue, wager: w });
    if (ttsMode) tts.speak(`Final Jeopardy. ${phase.clue.category}. ${phase.clue.question}`);
  }

  async function submitFinalAnswer(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (phase.kind !== "final-answer") return;
    tts.cancel();
    setSubmitting(true);
    try {
      const responseTimeMs = Math.min(Date.now() - buzzedAt.current, FINAL_TIME_MS);
      const { data } = await api.post("/clues/submit", {
        clueId: phase.clue.id,
        answer,
        responseTimeMs,
        mode: "FINAL",
        wager: phase.wager,
      });
      const nextScore = score + (data.correct ? phase.wager : -phase.wager);
      setScore(nextScore);
      persist({ nextScore, finalDone: true });
      setPhase({
        kind: "final-result",
        clue: phase.clue,
        wager: phase.wager,
        correct: data.correct,
        canonical: data.canonicalAnswer,
        typed: answer,
        responseId: data.responseId,
        llmVerdict: data.llmVerdict ?? null,
      });
      setAnswer("");
    } finally {
      setSubmitting(false);
    }
  }

  function newGame() {
    tts.cancel();
    clearTimers();
    clearBoardSave();
    setEpisode(null);
    setPlayed(new Set());
    setScore(0);
    setAnswer("");
    setWagerInput("");
    setShareCode(null);
    setShareCodeInput("");
    setShareError(null);
    setShareStatus(null);
    setPhase({ kind: "idle" });
  }

  // Kick off hint generation as soon as a clue is on screen. Re-fire when
  // moving into result/passed for the same clue so we recover from any missed
  // earlier kickoff; endpoint is idempotent.
  useEffect(() => {
    let id: number | null = null;
    if (
      phase.kind === "reading" ||
      phase.kind === "ready" ||
      phase.kind === "answering" ||
      phase.kind === "result" ||
      phase.kind === "passed"
    ) {
      id = phase.cell.id;
    } else if (phase.kind === "final-answer" || phase.kind === "final-result") {
      id = phase.clue.id;
    }
    if (id == null) return;
    void api.post(`/clues/${id}/hint/prepare`).catch(() => {});
  }, [phase.kind, phase.kind === "final-answer" || phase.kind === "final-result" ? phase.clue.id : phase.kind === "reading" || phase.kind === "ready" || phase.kind === "answering" || phase.kind === "result" || phase.kind === "passed" ? phase.cell.id : null]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cur = phaseRef.current;
      if (e.code === "Space") {
        if (cur.kind === "reading" || cur.kind === "ready") {
          e.preventDefault();
          buzz();
        }
      } else if (e.key === "Enter") {
        if (cur.kind === "result" || cur.kind === "passed") {
          e.preventDefault();
          backToBoard();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler reads phaseRef, not state
  }, []);

  useEffect(() => () => clearTimers(), []);

  if (!user) {
    return (
      <div className="max-w-md mx-auto text-center">
        <h1 className="font-category text-4xl text-jeopardy-gold">Full Board</h1>
        <p className="mt-4 text-white/80">Log in to play a full Jeopardy game.</p>
      </div>
    );
  }

  if (phase.kind === "idle") {
    return (
      <div className="max-w-3xl mx-auto text-center space-y-6">
        <h1 className="font-category text-5xl text-jeopardy-gold">Full Board</h1>
        <p className="text-white/80">
          A full Jeopardy game just like the show: pick a clue, wait for the host to finish reading, then
          <kbd className="mx-1 px-2 py-0.5 bg-white/20 rounded text-xs">SPACE</kbd>
          to buzz in. Buzz early and you're locked out for 250ms. Use Don't know to pass immediately.
        </p>
        {pendingResume && (
          <div className="bg-jeopardy-gold/10 border border-jeopardy-gold/40 rounded p-4 space-y-3">
            <p className="text-sm">
              You have an unfinished game — score{" "}
              <span className="dollar">${pendingResume.score.toLocaleString()}</span>
              {pendingResume.episode.date ? ` (${pendingResume.episode.date})` : ""}.
            </p>
            <div className="flex gap-2 justify-center flex-wrap">
              <button
                onClick={resumeBoardGame}
                className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded"
              >
                Resume game
              </button>
              <button
                onClick={discardBoardSave}
                className="px-6 py-2 border border-white/30 hover:bg-white/10 rounded text-sm"
              >
                Discard
              </button>
            </div>
          </div>
        )}
        <div className="grid md:grid-cols-2 gap-4 mt-6">
          <button
            onClick={() => startGame("episode")}
            className="clue-tile p-6 rounded text-left hover:scale-[1.02] transition"
          >
            <h2 className="font-category text-2xl text-jeopardy-gold">Real episode</h2>
            <p className="text-white/85 mt-2 text-sm">
              A random aired episode — exact categories, values, and Daily Doubles from one night's broadcast.
            </p>
          </button>
          <button
            onClick={() => startGame("mixed")}
            className="clue-tile p-6 rounded text-left hover:scale-[1.02] transition"
          >
            <h2 className="font-category text-2xl text-jeopardy-gold">Mixed categories</h2>
            <p className="text-white/85 mt-2 text-sm">
              6 random categories per round drawn from across all episodes, plus a random Final. Daily Doubles placed randomly.
            </p>
          </button>
        </div>
        <div className="max-w-md mx-auto bg-white/5 rounded p-4 space-y-3 text-left">
          <h2 className="font-category text-2xl text-jeopardy-gold text-center">
            Have a share code?
          </h2>
          <form onSubmit={loadSharedBoard} className="flex gap-2">
            <input
              aria-label="Board share code"
              autoComplete="off"
              value={shareCodeInput}
              onChange={(e) => setShareCodeInput(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              className="flex-1 px-3 py-3 rounded bg-white/10 uppercase tracking-[0.2em] text-center"
            />
            <button
              type="submit"
              disabled={shareBusy || normalizeShareCode(shareCodeInput).length !== 8}
              className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
            >
              {shareBusy ? "…" : "Load"}
            </button>
          </form>
          {shareError && (
            <p className="text-sm text-red-300 text-center" role="alert">
              {shareError}
            </p>
          )}
          {shareStatus && (
            <p className="text-sm text-green-300 text-center" role="status">
              {shareStatus}
            </p>
          )}
        </div>
        {tts.supported && (
          <div className="flex justify-center pt-2">
            <button
              onClick={() => {
                if (ttsMode) tts.cancel();
                setTtsMode(!ttsMode);
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
          </div>
        )}
      </div>
    );
  }

  if (phase.kind === "loading") {
    return <p className="text-center text-white/60 py-12">Loading episode…</p>;
  }

  if (phase.kind === "done") {
    return (
      <div className="max-w-3xl mx-auto text-center space-y-6">
        <h1 className="font-category text-5xl text-jeopardy-gold">Game over</h1>
        {phase.reason === "ineligibleForFinal" && (
          <p className="text-white/75">
            You finished Double Jeopardy with a negative score, so Final Jeopardy is skipped.
          </p>
        )}
        <p className="text-3xl">
          Final score: <span className="dollar">${phase.total.toLocaleString()}</span>
        </p>
        {episode && (
          <div className="space-y-2">
            <button
              onClick={() => void createBoardShare()}
              disabled={shareBusy}
              className="px-6 py-2 border border-white/30 hover:bg-white/10 rounded text-sm disabled:opacity-60 disabled:cursor-wait"
            >
              {shareBusy ? "Sharing…" : formattedShareCode ? "Copy share code" : "Share this board"}
            </button>
            {formattedShareCode && (
              <p className="text-sm text-white/70">
                <span className="font-mono tracking-[0.2em]">{formattedShareCode}</span>
              </p>
            )}
            {(shareError || shareStatus) && (
              <p
                className={`text-sm ${shareError ? "text-red-300" : "text-green-300"}`}
                role={shareError ? "alert" : "status"}
              >
                {shareError ?? shareStatus}
              </p>
            )}
          </div>
        )}
        <button onClick={newGame} className="px-8 py-3 bg-jeopardy-gold text-black font-semibold rounded">
          New episode
        </button>
      </div>
    );
  }

  if (phase.kind === "board" && episode) {
    const board = currentBoard();
    if (!board) return null;
    const isDJ = phase.round === "DOUBLE_JEOPARDY";
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-category text-2xl text-jeopardy-gold">
              {isDJ ? "Double Jeopardy!" : "Jeopardy!"}
            </h2>
            <p className="text-xs text-white/40">
              {episode.date ? `Episode aired ${episode.date}` : "Mixed categories"}
            </p>
            {formattedShareCode && (
              <p className="text-xs text-white/60 mt-1">
                Share code:{" "}
                <span className="font-mono tracking-[0.2em]">{formattedShareCode}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {tts.supported && (
              <button
                onClick={() => {
                  if (ttsMode) tts.cancel();
                  setTtsMode(!ttsMode);
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
            <button
              onClick={() => void createBoardShare()}
              disabled={shareBusy}
              className="px-3 py-2 rounded border border-white/30 hover:bg-white/10 text-xs min-h-[36px] disabled:opacity-60 disabled:cursor-wait"
              title={formattedShareCode ? "Copy the current board share code" : "Create a share code for this board"}
            >
              {shareBusy ? "Sharing…" : formattedShareCode ? "Copy code" : "Share board"}
            </button>
            <span>Score: <span className="dollar text-2xl">${score.toLocaleString()}</span></span>
          </div>
        </div>
        {(shareError || shareStatus) && (
          <p
            className={`text-sm ${shareError ? "text-red-300" : "text-green-300"}`}
            role={shareError ? "alert" : "status"}
          >
            {shareError ?? shareStatus}
          </p>
        )}
        <div className="grid grid-cols-6 gap-1 max-w-7xl mx-auto">
          {board.categories.map((cat, ci) => (
            <div
              key={ci}
              className="category-banner py-2 md:py-3 text-center text-[10px] sm:text-sm md:text-base h-full flex items-center justify-center min-h-[60px] sm:min-h-[80px] px-0.5 sm:px-1"
            >
              {cat.name}
            </div>
          ))}
          {board.values.map((v, vi) =>
            board.categories.map((cat, ci) => {
              const cell = cat.cells[vi];
              if (!cell) {
                return (
                  <div
                    key={`${vi}-${ci}-empty`}
                    className="min-h-[60px] sm:min-h-[80px] rounded bg-white/5 text-center flex items-center justify-center text-white/30 text-xs"
                  >
                    —
                  </div>
                );
              }
              const isPlayed = played.has(cell.id);
              return (
                <button
                  key={`${vi}-${ci}-${cell.id}`}
                  onClick={() => selectCell(cell)}
                  disabled={isPlayed}
                  className={`clue-tile min-h-[60px] sm:min-h-[80px] text-center rounded transition ${
                    isPlayed ? "opacity-20 cursor-default" : "hover:scale-105"
                  }`}
                >
                  <span className="dollar text-lg sm:text-2xl md:text-3xl">
                    {isPlayed ? "" : `$${v}`}
                  </span>
                </button>
              );
            }),
          )}
        </div>
      </div>
    );
  }

  if (phase.kind === "wager") {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <h2 className="font-category text-4xl text-jeopardy-gold text-center">★ Daily Double!</h2>
        <p className="text-center text-white/80">
          Category: <span className="font-bold">{phase.cell.category}</span>
        </p>
        <p className="text-center">
          Current score: <span className="dollar text-2xl">${score.toLocaleString()}</span>
        </p>
        <p className="text-center text-sm text-white/60">
          Wager $5 to ${phase.max.toLocaleString()}
        </p>
        <form onSubmit={confirmDDWager} className="flex gap-2 max-w-md mx-auto">
          <input
            autoFocus
            aria-label="Daily Double wager"
            type="number"
            min={5}
            max={phase.max}
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
            placeholder="Wager"
            className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
          />
          <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
            Lock in
          </button>
        </form>
        {wagerError && (
          <p className="text-center text-sm text-red-300" role="alert">
            {wagerError}
          </p>
        )}
      </div>
    );
  }

  if (phase.kind === "reading" || phase.kind === "ready" || phase.kind === "lockedOut") {
    const isSkipping = passing;
    const buzzColor =
      isSkipping ? "bg-white/10 text-white/40"
      : phase.kind === "ready" ? "bg-jeopardy-gold text-black"
      : phase.kind === "lockedOut" ? "bg-red-700 text-white"
      : "bg-white/10 text-white/60";
    const buzzLabel =
      isSkipping ? "Skipping clue..."
      : phase.kind === "ready" ? "BUZZ! (Space)"
      : phase.kind === "lockedOut" ? "LOCKED OUT — too early"
      : "wait for the lights…";
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex justify-between text-sm">
          <span>Score: <span className="dollar text-xl">${score.toLocaleString()}</span></span>
          <span>{phase.cell.category} — <span className="dollar">${phase.cell.value}</span></span>
        </div>
        <div className="clue-tile p-4 sm:p-10 text-center min-h-[60vh] flex items-center justify-center rounded">
          <p className="text-3xl sm:text-4xl md:text-6xl leading-tight font-category break-words">
            {phase.cell.question}
          </p>
        </div>
        {phase.kind === "ready" && (
          <TimerBar
            totalMs={BUZZ_WINDOW_MS}
            resetKey={`buzz-${phase.cell.id}`}
            paused={false}
            onExpire={() => {}}
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            onClick={buzz}
            disabled={phase.kind === "lockedOut" || isSkipping}
            className={`w-full py-6 font-bold text-2xl rounded transition disabled:cursor-wait disabled:opacity-70 ${buzzColor}`}
          >
            {buzzLabel}
          </button>
          <button
            onClick={skipClue}
            disabled={isSkipping}
            className="w-full py-6 font-bold text-2xl rounded transition bg-red-700 text-white hover:bg-red-600 disabled:cursor-wait disabled:opacity-70"
          >
            {isSkipping ? "Skipping clue..." : "Don't know"}
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "answering") {
    const isDD = phase.wager !== null && phase.cell.dailyDouble;
    const totalMs = isDD ? DD_ANSWER_MS : ANSWER_WINDOW_MS;
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex justify-between text-sm">
          <span>Score: <span className="dollar text-xl">${score.toLocaleString()}</span></span>
          {phase.wager !== null && (
            <span>Wager: <span className="dollar">${phase.wager.toLocaleString()}</span></span>
          )}
          <span>{phase.cell.category} — <span className="dollar">${phase.cell.value}</span></span>
        </div>
        <div className="clue-tile p-4 sm:p-10 text-center min-h-[55vh] flex items-center justify-center rounded">
          <p className="text-3xl sm:text-4xl md:text-6xl leading-tight font-category break-words">
            {phase.cell.question}
          </p>
        </div>
        <TimerBar
          totalMs={totalMs}
          resetKey={`ans-${phase.cell.id}`}
          paused={false}
          onExpire={() => answer.trim().length === 0 && handleAnswerTimeout()}
        />
        <form onSubmit={submitClueAnswer} className="flex gap-2">
          <input
            autoFocus
            aria-label="Your answer"
            autoComplete="off"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="What is..."
            className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
          >
            {submitting ? "…" : "Submit"}
          </button>
        </form>
      </div>
    );
  }

  if (phase.kind === "passed") {
    return (
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="p-6 rounded text-center bg-white/10">
          <p className="text-2xl text-white/80">No buzz — the clue passes.</p>
          <p className="mt-3 text-white/70">{phase.cell.question}</p>
          <p className="mt-3 text-white/80">
            Answer: <span className="font-bold">{phase.canonical}</span>
          </p>
          <p className="mt-2 text-sm text-white/50">No money changes hands.</p>
          <button
            onClick={backToBoard}
            className="mt-4 px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded"
          >
            Back to board → (Enter)
          </button>
          <WikiBlurb clueId={phase.cell.id} />
          <Hint clueId={phase.cell.id} />
        </div>
      </div>
    );
  }

  if (phase.kind === "result") {
    return (
      <div className="max-w-5xl mx-auto space-y-4">
        <div className={`p-6 rounded text-center ${phase.correct ? "bg-green-700/40" : "bg-red-700/40"}`}>
          <p className="text-2xl">{phase.correct ? "✓ Correct!" : "✗ Incorrect"}</p>
          <p className="mt-3 text-white/70">{phase.cell.question}</p>
          <p className="mt-2 text-white/80">Answer: <span className="font-bold">{phase.canonical}</span></p>
          {phase.typed && (
            <p className="text-xs mt-1 text-white/60">You typed: <span className="italic">{phase.typed}</span></p>
          )}
          <p className="mt-3 text-xl">
            {phase.delta >= 0 ? "+" : "−"}
            <span className="dollar">${Math.abs(phase.delta).toLocaleString()}</span>
          </p>
          <p className="mt-1 text-sm">
            Score: <span className="dollar">${score.toLocaleString()}</span>
          </p>
          <button onClick={backToBoard} className="mt-4 px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
            Back to board → (Enter)
          </button>
          {phase.llmVerdict != null && (
            <p className="text-[10px] mt-1 text-white/40">
              LLM invoked: {phase.llmVerdict ? "YES" : "NO"}
            </p>
          )}
          <WikiBlurb clueId={phase.cell.id} />
          <Hint clueId={phase.cell.id} />
        </div>
      </div>
    );
  }

  if (phase.kind === "final-wager") {
    const max = Math.max(0, score);
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <h2 className="font-category text-5xl text-jeopardy-gold text-center">Final Jeopardy!</h2>
        <div className="category-banner text-center py-3 sm:py-4 text-xl sm:text-3xl">
          {phase.clue.category}
        </div>
        <p className="text-center">
          Going in with <span className="dollar text-2xl">${score.toLocaleString()}</span>
        </p>
        <form onSubmit={confirmFinalWager} className="flex gap-2 max-w-md mx-auto">
          <input
            autoFocus
            aria-label="Final Jeopardy wager"
            type="number"
            min={0}
            max={max}
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
            placeholder={`Wager (0 to ${max})`}
            className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
          />
          <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
            Lock in
          </button>
        </form>
        {wagerError && (
          <p className="text-center text-sm text-red-300" role="alert">
            {wagerError}
          </p>
        )}
      </div>
    );
  }

  if (phase.kind === "final-answer") {
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="category-banner text-center py-3 sm:py-4 text-xl sm:text-3xl">
          {phase.clue.category}
        </div>
        <div className="clue-tile p-4 sm:p-10 text-center min-h-[55vh] flex items-center justify-center rounded">
          <p className="text-3xl sm:text-4xl md:text-6xl leading-tight font-category break-words">{phase.clue.question}</p>
        </div>
        <TimerBar
          totalMs={FINAL_TIME_MS}
          resetKey={phase.clue.id}
          paused={false}
          onExpire={() => answer.trim().length === 0 && submitFinalAnswer({ preventDefault: () => {} } as FormEvent)}
        />
        <form onSubmit={submitFinalAnswer} className="flex gap-2">
          <input
            autoFocus
            aria-label="Your answer"
            autoComplete="off"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="What is..."
            className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
          >
            {submitting ? "…" : "Submit"}
          </button>
        </form>
      </div>
    );
  }

  if (phase.kind === "final-result") {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div className={`p-6 rounded text-center ${phase.correct ? "bg-green-700/40" : "bg-red-700/40"}`}>
          <p className="text-3xl">{phase.correct ? "✓ Correct!" : "✗ Incorrect"}</p>
          <p className="mt-3 text-white/70">{phase.clue.question}</p>
          <p className="mt-3 text-white/80">Answer: <span className="font-bold">{phase.canonical}</span></p>
          {phase.typed && (
            <p className="text-sm mt-1 text-white/60">You typed: <span className="italic">{phase.typed || "(no answer)"}</span></p>
          )}
          <p className="mt-3 text-2xl">
            {phase.correct ? "+" : "−"} <span className="dollar">${phase.wager.toLocaleString()}</span>
          </p>
          <p className="mt-2 text-xl">
            Final total: <span className="dollar">${score.toLocaleString()}</span>
          </p>
          <button onClick={newGame} className="mt-6 px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
            New episode
          </button>
          {phase.llmVerdict != null && (
            <p className="text-[10px] mt-1 text-white/40">
              LLM invoked: {phase.llmVerdict ? "YES" : "NO"}
            </p>
          )}
          <WikiBlurb clueId={phase.clue.id} />
          <Hint clueId={phase.clue.id} />
        </div>
      </div>
    );
  }

  return null;
}
