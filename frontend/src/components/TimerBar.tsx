import { useEffect, useRef, useState } from "react";

const SEGMENTS = 10;
const PAIRS = SEGMENTS / 2;
const TICK_MS = 80;

// Segmented countdown bar that shrinks symmetrically from both ends, like the
// Jeopardy clue board's edge lights. Each pair of outermost segments goes dark
// in sync. Calls onExpire exactly once when the bar empties.
//
/**
 * Renders the TimerBar React component.
 *
 * Parameters:
 * - `{ totalMs, initialTimeLeftMs, resetKey, paused, onExpire }` (`{ totalMs: number; initialTimeLeftMs?: number; resetKey: string | number; paused?: boolean; onExpire: () => void; }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
export function TimerBar({
  totalMs,
  initialTimeLeftMs,
  resetKey,
  paused = false,
  onExpire,
}: {
  totalMs: number;
  initialTimeLeftMs?: number;
  resetKey: string | number;
  paused?: boolean;
  onExpire: () => void;
}) {
  const safeTotalMs = Math.max(1, totalMs);
  const safeInitialTimeLeftMs = Math.min(
    safeTotalMs,
    Math.max(0, initialTimeLeftMs ?? safeTotalMs),
  );
  const [timer, setTimer] = useState({
    durationMs: safeTotalMs,
    timeLeftMs: safeInitialTimeLeftMs,
  });
  const timerConfigRef = useRef({
    durationMs: safeTotalMs,
    timeLeftMs: safeInitialTimeLeftMs,
  });
  timerConfigRef.current = {
    durationMs: safeTotalMs,
    timeLeftMs: safeInitialTimeLeftMs,
  };
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const firedRef = useRef(false);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `() => void`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
  useEffect(() => {
    // Only reset the animation when resetKey changes, usually a new deadline.
    const { durationMs, timeLeftMs } = timerConfigRef.current;
    setTimer({ durationMs, timeLeftMs });
    firedRef.current = false;
    if (paused) return;
    const startedAt = Date.now();
    /**
     * Runs the delayed setInterval timer callback.
     *
     * Parameters:
     * - None.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Updates application/browser state, cookies, or persistent browser storage from computed values.
     * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
     * - Computes numeric bounds, random values, or cryptographic tokens.
     */
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, timeLeftMs - elapsed);
      setTimer({ durationMs, timeLeftMs: remaining });
      if (remaining <= 0 && !firedRef.current) {
        firedRef.current = true;
        clearInterval(id);
        onExpireRef.current();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [resetKey, paused]);

  const progress = timer.timeLeftMs / timer.durationMs;
  const pairsOff = Math.min(PAIRS, Math.floor((1 - progress) * PAIRS));

  const segments = Array.from({ length: SEGMENTS }, (_, i) => {
    const distFromEdge = Math.min(i, SEGMENTS - 1 - i);
    return distFromEdge >= pairsOff;
  });

  return (
    <div className="flex gap-1 h-2">
      {segments.map((lit, i) => (
        <div
          key={i}
          className={`flex-1 rounded-sm transition-colors duration-200 ${
            lit ? "bg-jeopardy-gold" : "bg-white/10"
          }`}
        />
      ))}
    </div>
  );
}
