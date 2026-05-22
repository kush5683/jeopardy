import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

// Auto-shown LLM-generated hint that explains how the clue's wordplay points to
// the answer. Polls until the server reports the hint is ready, then renders it.
// Silent on failure — hints are a nice-to-have and must not get in the way.
//
// Generation was kicked off when the clue was first shown (see Practice.tsx),
// so by the time this mounts on the result panel the hint is often already
// cached and the first poll returns immediately.
/**
 * Renders the Hint React component.
 *
 * Parameters:
 * - `{ clueId }` (`{ clueId: number }`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function Hint({ clueId }: { clueId: number }) {
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const cancelledRef = useRef(false);

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
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    cancelledRef.current = false;
    setText(null);
    setPending(true);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const POLL_MS = 1200;
    const MAX_POLLS = 25; // ~30s ceiling — after that, give up quietly
    let polls = 0;

    /**
     * Implements the tick function.
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
    async function tick() {
      if (cancelledRef.current) return;
      try {
        const { data } = await api.get(`/clues/${clueId}/hint`);
        if (cancelledRef.current) return;
        if (data.status === "ready") {
          setText(data.hint ?? null);
          setPending(false);
          return;
        }
        polls++;
        if (polls < MAX_POLLS) {
          timer = setTimeout(tick, POLL_MS);
        } else {
          setPending(false); // give up — hide the "Generating..." indicator
        }
      } catch {
        setPending(false);
      }
    }
    tick();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [clueId]);

  if (pending) {
    return (
      <p className="text-xs mt-3 text-white/40 italic">Generating hint…</p>
    );
  }
  if (!text) return null;
  return (
    <p className="text-xs mt-3 text-white/60 italic leading-relaxed">
      <span className="text-white/40 not-italic">Why: </span>
      {text}
    </p>
  );
}
