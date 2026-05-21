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

function getSpeechRecognition(): (new () => SR) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

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

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { listening, start, stop, supported };
}
