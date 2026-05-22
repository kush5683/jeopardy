import { useEffect, useState } from "react";

const LS_KEY = "jeopardy_tts_mode";

// Shared TTS preference across modes (Practice, Board, …). Persisted to
// localStorage so it survives reloads and is consistent between pages.
/**
 * Provides the tts mode React hook behavior.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `{ enabled: boolean; setEnabled: Dispatch<SetStateAction<boolean>>; }`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 */
export function useTtsMode() {
  const [enabled, setEnabled] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      localStorage.getItem(LS_KEY) === "true",
  );
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
    localStorage.setItem(LS_KEY, String(enabled));
  }, [enabled]);
  return { enabled, setEnabled };
}
