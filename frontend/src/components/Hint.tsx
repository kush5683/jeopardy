import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

// Auto-shown LLM-generated hint that explains how the clue's wordplay points to
// the answer. Polls until the server reports the hint is ready, then renders it.
// Silent on failure — hints are a nice-to-have and must not get in the way.
//
// Generation was kicked off when the clue was first shown (see Practice.tsx),
// so by the time this mounts on the result panel the hint is often already
// cached and the first poll returns immediately.
export function Hint({ clueId }: { clueId: number }) {
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setText(null);
    setPending(true);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const POLL_MS = 1200;
    const MAX_POLLS = 25; // ~30s ceiling — after that, give up quietly
    let polls = 0;

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
