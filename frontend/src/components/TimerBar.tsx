import { useEffect, useRef, useState } from "react";

const SEGMENTS = 10;
const PAIRS = SEGMENTS / 2;
const TICK_MS = 80;

// Segmented countdown bar that shrinks symmetrically from both ends, like the
// Jeopardy clue board's edge lights. Each pair of outermost segments goes dark
// in sync. Calls onExpire exactly once when the bar empties.
//
// `paused` is one-shot: setting it true freezes the bar, but flipping back to
// false RESETS to totalMs (the effect re-runs and restarts the timer). Callers
// don't currently round-trip the pause state — change `resetKey` to start a
// fresh countdown for the next clue.
export function TimerBar({
  totalMs,
  resetKey,
  paused = false,
  onExpire,
}: {
  totalMs: number;
  resetKey: string | number;
  paused?: boolean;
  onExpire: () => void;
}) {
  const [timeLeft, setTimeLeft] = useState(totalMs);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const firedRef = useRef(false);

  useEffect(() => {
    setTimeLeft(totalMs);
    firedRef.current = false;
    if (paused) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, totalMs - elapsed);
      setTimeLeft(remaining);
      if (remaining <= 0 && !firedRef.current) {
        firedRef.current = true;
        clearInterval(id);
        onExpireRef.current();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [resetKey, totalMs, paused]);

  const progress = timeLeft / totalMs;
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
