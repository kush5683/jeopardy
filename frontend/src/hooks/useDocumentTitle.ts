import { useEffect } from "react";

const SUFFIX = "Jeopardy! Training";

/**
 * Provides the document title React hook behavior.
 *
 * Parameters:
 * - `title` (`string | null`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function useDocumentTitle(title: string | null): void {
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
    const prev = document.title;
    document.title = title ? `${title} — ${SUFFIX}` : SUFFIX;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
