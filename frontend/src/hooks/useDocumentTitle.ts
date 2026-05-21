import { useEffect } from "react";

const SUFFIX = "Jeopardy! Training";

export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} — ${SUFFIX}` : SUFFIX;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
