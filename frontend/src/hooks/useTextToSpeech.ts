import { useEffect, useRef } from "react";

// Browser-native SpeechSynthesis. Speaks a string; cancels on unmount or new
// utterance. No external service, no cost, no latency.
export function useTextToSpeech() {
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

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

  function cancel() {
    if (!supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    utterRef.current = null;
  }

  useEffect(() => {
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { supported, speak, cancel };
}
