import { useCallback, useEffect, useRef, useState } from "react";

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
type SREvent = {
  results: { [i: number]: { transcript: string }; isFinal: boolean; length: number }[];
};

/**
 * Implements the get speech recognition function.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `(new () => SR) | null`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function getSpeechRecognition(): (new () => SR) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/**
 * Provides the voice recognition React hook behavior.
 *
 * Parameters:
 * - `opts` (`{ onInterim?: (text: string) => void; onFinal: (text: string) => void; }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `{ listening: boolean; start: () => void; stop: () => void; supported: boolean; }`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function useVoiceRecognition(opts: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SR | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const SR = getSpeechRecognition();
  const supported = !!SR;

  /**
   * Implements the stop function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  const stop = useCallback(() => {
    if (recRef.current) {
      try {
        recRef.current.abort();
      } catch {
        // ignore
      }
      recRef.current = null;
    }
    setListening(false);
  }, []);

  /**
   * Implements the start function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  const start = useCallback(() => {
    if (!SR || recRef.current) return;
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e: SREvent) => {
      const last = e.results[e.results.length - 1];
      const text = last[0].transcript.trim();
      if (last.isFinal) {
        optsRef.current.onFinal(text);
        recRef.current = null;
        setListening(false);
      } else {
        optsRef.current.onInterim?.(text);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };
    rec.onerror = () => {
      recRef.current = null;
      setListening(false);
    };
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch {
      // permission denied / already in use — leave listening=false so the
      // caller's auto-start effect can retry on the next clue.
    }
  }, [SR]);

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
    return () => stop();
  }, [stop]);

  return { listening, start, stop, supported };
}
