import { useEffect, useState } from "react";

/**
 * Renders the OfflineBanner React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

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
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  useEffect(() => {
    /**
     * Implements the up function.
     *
     * Parameters:
     * - None.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Updates application/browser state, cookies, or persistent browser storage from computed values.
     */
    const up = () => setOnline(true);
    /**
     * Implements the down function.
     *
     * Parameters:
     * - None.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Updates application/browser state, cookies, or persistent browser storage from computed values.
     */
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-red-900/60 border-b border-red-500/50 text-center text-sm py-1.5 px-3 text-red-100"
    >
      You're offline — answers and progress won't save until your connection comes back.
    </div>
  );
}
