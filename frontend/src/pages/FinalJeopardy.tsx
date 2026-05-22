import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useTextToSpeech } from "../hooks/useTextToSpeech";
import { TimerBar } from "../components/TimerBar";
import { WikiBlurb } from "../components/WikiBlurb";
import { Hint } from "../components/Hint";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useUnloadGuard } from "../hooks/useUnloadGuard";

type Clue = {
  id: number;
  question: string;
  value: number;
  round: string;
  category: string;
};

type Phase =
  | { kind: "stake" }
  | { kind: "wager"; clue: Clue; stake: number }
  | { kind: "answer"; clue: Clue; wager: number }
  | { kind: "result"; clue: Clue; wager: number; correct: boolean; canonical: string; typed: string; responseId: string; llmVerdict?: boolean | null };

const ANSWER_TIME_MS = 30000;

type FinalSave = {
  score: number;
  // Set while a clue is on-screen mid-answer. If the user refreshes here, that
  // counts as a forfeit — the wager is debited from the tournament total.
  inFlight?: { wager: number } | null;
};

const FINAL_SAVE_KEY = "final-jeopardy-v1";

/**
 * Loads final save data.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `FinalSave | null`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function loadFinalSave(): FinalSave | null {
  try {
    const raw = localStorage.getItem(FINAL_SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.score === "number") return parsed;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Persists final data.
 *
 * Parameters:
 * - `s` (`FinalSave`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function saveFinal(s: FinalSave): void {
  try {
    localStorage.setItem(FINAL_SAVE_KEY, JSON.stringify(s));
  } catch {
    // non-fatal
  }
}

/**
 * Renders the FinalJeopardy React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function FinalJeopardy() {
  useDocumentTitle("Final Jeopardy!");
  const { user } = useAuth();
  const tts = useTextToSpeech();
  const [phase, setPhase] = useState<Phase>({ kind: "stake" });
  const [stake, setStake] = useState<number>(20000);
  const [wagerInput, setWagerInput] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");
  const [score, setScore] = useState<number>(0);
  const [shownAt, setShownAt] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [wagerError, setWagerError] = useState<string | null>(null);
  const [forfeitNotice, setForfeitNotice] = useState<number | null>(null);

  // Restore tournament score on mount. Forfeit any in-flight clue —
  // refreshing during the answer phase would otherwise let you look up the
  // answer and resume.
  // The answer phase is the only one where leaving counts as forfeit; warn
  // before the user accidentally closes the tab.
  useUnloadGuard(phase.kind === "answer");

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  useEffect(() => {
    const saved = loadFinalSave();
    if (!saved) return;
    if (saved.inFlight) {
      const newScore = saved.score - saved.inFlight.wager;
      setScore(newScore);
      setForfeitNotice(saved.inFlight.wager);
      saveFinal({ score: newScore, inFlight: null });
    } else {
      setScore(saved.score);
    }
  }, []);

  // Kick off hint generation once the final clue is on screen.
  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    if (phase.kind !== "wager" && phase.kind !== "answer") return;
    void api.post(`/clues/${phase.clue.id}/hint/prepare`).catch(() => {});
  }, [phase.kind === "wager" || phase.kind === "answer" ? phase.clue.id : null]);

  /**
   * Implements the start round function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function startRound() {
    setStartError(null);
    setForfeitNotice(null);
    try {
      const { data } = await api.get("/clues/random?limit=1&round=FINAL_JEOPARDY");
      if (data.clues.length === 0) {
        setStartError("No Final Jeopardy clues available right now.");
        return;
      }
      setPhase({ kind: "wager", clue: data.clues[0], stake });
      setWagerInput("");
      setWagerError(null);
    } catch {
      setStartError("Couldn't load a Final clue. Try again.");
    }
  }

  /**
   * Implements the confirm wager function.
   *
   * Parameters:
   * - `e` (`FormEvent`): Browser or React event object read for form, keyboard, or pointer state.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
  function confirmWager(e: FormEvent) {
    e.preventDefault();
    if (phase.kind !== "wager") return;
    const w = parseInt(wagerInput, 10);
    if (!Number.isFinite(w) || w < 0 || w > phase.stake) {
      setWagerError(`Wager must be between $0 and $${phase.stake.toLocaleString()}.`);
      return;
    }
    setWagerError(null);
    setShownAt(Date.now());
    setPhase({ kind: "answer", clue: phase.clue, wager: w });
    // Mark the clue as in-flight so a refresh now forfeits the wager.
    saveFinal({ score, inFlight: { wager: w } });
    tts.speak(`Final Jeopardy category: ${phase.clue.category}. ${phase.clue.question}`);
  }

  /**
   * Implements the submit final answer function.
   *
   * Parameters:
   * - `e` (`FormEvent`): Browser or React event object read for form, keyboard, or pointer state.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
  async function submitFinalAnswer(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (phase.kind !== "answer") return;
    tts.cancel();
    setSubmitting(true);
    try {
      const responseTimeMs = Math.min(Date.now() - shownAt, ANSWER_TIME_MS);
      const { data } = await api.post("/clues/submit", {
        clueId: phase.clue.id,
        answer,
        responseTimeMs,
        mode: "FINAL",
        wager: phase.wager,
      });
      setPhase({
        kind: "result",
        clue: phase.clue,
        wager: phase.wager,
        correct: data.correct,
        canonical: data.canonicalAnswer,
        typed: answer,
        responseId: data.responseId,
        llmVerdict: data.llmVerdict ?? null,
      });
      const newScore = score + (data.correct ? phase.wager : -phase.wager);
      setScore(newScore);
      saveFinal({ score: newScore, inFlight: null });
      setAnswer("");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Handles the timeout workflow.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  function handleTimeout() {
    if (phase.kind !== "answer") return;
    /**
     * Implements the prevent default function.
     *
     * Parameters:
     * - None.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Performs control-flow checks and returns or mutates values without additional structural transformation.
     */
    submitFinalAnswer({ preventDefault: () => {} } as FormEvent);
  }

  /**
   * Implements the reset function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function reset() {
    tts.cancel();
    setPhase({ kind: "stake" });
    setWagerInput("");
    setAnswer("");
  }

  if (!user) {
    return (
      <div className="max-w-md mx-auto text-center">
        <h1 className="font-category text-4xl text-jeopardy-gold">Final Jeopardy!</h1>
        <p className="mt-4 text-white/80">Log in to play Final Jeopardy.</p>
      </div>
    );
  }

  if (phase.kind === "stake") {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="font-category text-5xl text-jeopardy-gold text-center">Final Jeopardy!</h1>
        {forfeitNotice !== null && (
          <div className="bg-red-900/30 border border-red-500/40 rounded p-3 text-center text-sm">
            Your previous Final was abandoned — forfeited{" "}
            <span className="dollar">${forfeitNotice.toLocaleString()}</span> from your tournament total.
          </div>
        )}
        <p className="text-center text-white/80">
          Pick a stake — your wagerable bankroll. You'll see the category, choose your wager (0 to stake), then see the clue.
          30 seconds to answer. Wager math coach included.
        </p>
        <div className="flex justify-center gap-4 flex-wrap">
          {[5000, 10000, 20000, 40000].map((s) => (
            <button
              key={s}
              onClick={() => setStake(s)}
              className={`px-6 py-3 rounded font-semibold ${
                stake === s ? "bg-jeopardy-gold text-black" : "bg-white/10 hover:bg-white/20"
              }`}
            >
              ${s.toLocaleString()}
            </button>
          ))}
        </div>
        <div className="text-center text-sm text-white/60">
          Running tournament score: <span className="dollar text-xl">${score}</span>
        </div>
        <div className="text-center">
          <button onClick={startRound} className="px-8 py-3 bg-jeopardy-gold text-black font-semibold rounded">
            Reveal category
          </button>
        </div>
        {startError && (
          <p className="text-center text-sm text-red-300" role="alert">
            {startError}
          </p>
        )}
      </div>
    );
  }

  if (phase.kind === "wager") {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="category-banner text-center py-4 sm:py-6 text-2xl sm:text-4xl">
          {phase.clue.category}
        </div>
        <div className="text-center text-white/80">
          Your stake: <span className="dollar text-2xl">${phase.stake.toLocaleString()}</span>
        </div>
        <WagerCoach stake={phase.stake} category={phase.clue.category} />
        <form onSubmit={confirmWager} className="flex gap-2 max-w-md mx-auto">
          <input
            autoFocus
            aria-label="Final Jeopardy wager"
            type="number"
            min={0}
            max={phase.stake}
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
            className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
            placeholder={`Wager (0 to ${phase.stake})`}
          />
          <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
            Lock in wager
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

  if (phase.kind === "answer") {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="category-banner text-center py-3 sm:py-4 text-xl sm:text-3xl">
          {phase.clue.category}
        </div>
        <div className="clue-tile p-10 text-center min-h-[200px] flex items-center justify-center rounded">
          <p className="text-2xl">{phase.clue.question}</p>
        </div>
        <TimerBar
          totalMs={ANSWER_TIME_MS}
          resetKey={phase.clue.id}
          paused={false}
          onExpire={handleTimeout}
        />
        <form onSubmit={submitFinalAnswer} className="flex gap-2">
          <input
            autoFocus
            aria-label="Your answer"
            autoComplete="off"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="What is..."
            className="flex-1 px-3 py-3 rounded bg-white/10"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
          >
            {submitting ? "…" : "Submit"}
          </button>
        </form>
        <div className="text-center text-sm text-white/60">
          Wager: <span className="dollar">${phase.wager.toLocaleString()}</span>
        </div>
      </div>
    );
  }

  // result
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="category-banner text-center py-3 sm:py-4 text-xl sm:text-3xl">
        {phase.clue.category}
      </div>
      <div className={`p-6 rounded text-center ${phase.correct ? "bg-green-700/40" : "bg-red-700/40"}`}>
        <p className="text-3xl">
          {phase.correct ? "✓ Correct!" : "✗ Incorrect"}
        </p>
        <p className="mt-3 text-white/70">{phase.clue.question}</p>
        <p className="mt-3 text-white/80">
          Answer: <span className="font-bold">{phase.canonical}</span>
        </p>
        {phase.typed && (
          <p className="text-sm mt-1 text-white/60">You typed: <span className="italic">{phase.typed || "(no answer)"}</span></p>
        )}
        <p className="mt-4 text-2xl">
          {phase.correct ? "+" : "−"} <span className="dollar">${phase.wager.toLocaleString()}</span>
        </p>
        <p className="mt-2 text-sm text-white/70">
          Tournament total: <span className="dollar text-xl">${score.toLocaleString()}</span>
        </p>
        <button
          onClick={reset}
          className="mt-6 px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded"
        >
          Play another Final →
        </button>
        {phase.kind === "result" && phase.llmVerdict != null && (
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

// Wager coach — show the three classic Final wagering brackets given a stake.
/**
 * Renders the WagerCoach React component.
 *
 * Parameters:
 * - `{ stake, category }` (`{ stake: number; category: string }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function WagerCoach({ stake, category }: { stake: number; category: string }) {
  const half = Math.floor(stake / 2);
  const oneThird = Math.floor(stake / 3);
  return (
    <details className="bg-white/5 rounded p-3 text-sm">
      <summary className="cursor-pointer text-jeopardy-gold font-semibold">
        Wagering math ▸
      </summary>
      <div className="mt-2 space-y-1 text-white/80">
        <p><strong>Conservative</strong> (uncertain on the category): ~⅓ of stake → <span className="dollar">${oneThird.toLocaleString()}</span></p>
        <p><strong>Standard</strong> (decent shot): ~½ of stake → <span className="dollar">${half.toLocaleString()}</span></p>
        <p><strong>All-in</strong> (your wheelhouse): full stake → <span className="dollar">${stake.toLocaleString()}</span></p>
        <p className="mt-2 text-xs text-white/60">
          On the show: if you'd cover the leader by winning, wager $1 more than what they'd have at double-up.
          Category <span className="font-bold">"{category}"</span> — adjust based on your accuracy in this topic.
        </p>
      </div>
    </details>
  );
}
