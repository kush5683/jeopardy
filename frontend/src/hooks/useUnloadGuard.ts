import { useEffect } from "react";

// Trigger the browser's native "leave site?" dialog when `active` is true.
// Modern browsers ignore custom strings and show their own message — calling
// preventDefault() and setting returnValue is enough to opt in.
/**
 * Provides the unload guard React hook behavior.
 *
 * Parameters:
 * - `active` (`boolean`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function useUnloadGuard(active: boolean): void {
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
    if (!active) return;
    /**
     * Handles the handler workflow.
     *
     * Parameters:
     * - `e` (`BeforeUnloadEvent`): Browser or React event object read for form, keyboard, or pointer state.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Performs control-flow checks and returns or mutates values without additional structural transformation.
     */
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
