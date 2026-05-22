import { useEffect, useRef } from "react";

// Browser-native SpeechSynthesis. Speaks a string; cancels on unmount or new
// utterance. No external service, no cost, no latency.
/**
 * Provides the text to speech React hook behavior.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `{ supported: boolean; speak: (text: string) => void; cancel: () => void; }`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function useTextToSpeech() {
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  /**
   * Implements the speak function.
   *
   * Parameters:
   * - `text` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  function speak(text: string) {
    if (!supported || !text) return;
    cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 1.0;
    u.pitch = 1.0;
    utterRef.current = u;
    window.speechSynthesis.speak(u);
  }

  /**
   * Checks the cancel condition.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  function cancel() {
    if (!supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    utterRef.current = null;
  }

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
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  useEffect(() => {
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { supported, speak, cancel };
}
