import { useEffect } from "react";

// Trigger the browser's native "leave site?" dialog when `active` is true.
// Modern browsers ignore custom strings and show their own message — calling
// preventDefault() and setting returnValue is enough to opt in.
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
