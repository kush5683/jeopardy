import { useEffect, useState } from "react";

const LS_KEY = "jeopardy_tts_mode";

// Shared TTS preference across modes (Practice, Board, …). Persisted to
// localStorage so it survives reloads and is consistent between pages.
export function useTtsMode() {
  const [enabled, setEnabled] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      localStorage.getItem(LS_KEY) === "true",
  );
  useEffect(() => {
    localStorage.setItem(LS_KEY, String(enabled));
  }, [enabled]);
  return { enabled, setEnabled };
}
