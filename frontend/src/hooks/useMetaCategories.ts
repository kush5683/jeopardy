import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";

export const META_CATEGORIES = [
  "Geography",
  "US History",
  "World History",
  "Science",
  "Math",
  "Literature",
  "Wordplay",
  "Sports",
  "Entertainment",
  "Food & Drink",
  "Religion",
  "Other",
] as const;

export type MetaCategory = (typeof META_CATEGORIES)[number];

const LS_KEY = "jeopardy_disabled_meta_categories";

/**
 * Implements the read cache function.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `MetaCategory[] | null`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function readCache(): MetaCategory[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is MetaCategory =>
      (META_CATEGORIES as readonly string[]).includes(v as string),
    );
  } catch {
    return null;
  }
}

/**
 * Implements the write cache function.
 *
 * Parameters:
 * - `disabled` (`MetaCategory[]`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 */
function writeCache(disabled: MetaCategory[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_KEY, JSON.stringify(disabled));
}

/**
 * Provides the meta categories React hook behavior.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `{ disabled: ("Geography" | "US History" | "World History" | "Science" | "Math" | "Literature" | "Wordplay" | "Sports" | "Entertainment" | "Food & Drink" | "R...`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function useMetaCategories() {
  const { user } = useAuth();
  const [disabled, setDisabled] = useState<MetaCategory[]>(
    () => readCache() ?? [],
  );

  // Hydrate from server when authenticated. localStorage is the fast first paint;
  // the server value wins if they disagree.
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
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<{ disabledMetaCategories: string[] }>(
          "/preferences",
        );
        if (cancelled) return;
        const valid = data.disabledMetaCategories.filter((v): v is MetaCategory =>
          (META_CATEGORIES as readonly string[]).includes(v),
        );
        setDisabled(valid);
        writeCache(valid);
      } catch {
        // keep localStorage value
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch on user identity change, not on every user object reference change
  }, [user?.id]);

  /**
   * Implements the enable all function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  function enableAll() {
    setDisabled((prev) => {
      if (prev.length === 0) return prev;
      writeCache([]);
      if (user) {
        api.put("/preferences", { disabledMetaCategories: [] }).catch(() => {});
      }
      return [];
    });
  }

  /**
   * Implements the toggle function.
   *
   * Parameters:
   * - `meta` (`MetaCategory`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  function toggle(meta: MetaCategory) {
    setDisabled((prev) => {
      const turningOff = !prev.includes(meta);
      // Refuse the toggle that would leave zero chips enabled — otherwise the
      // user is asking for an empty pool. Components should also visually
      // disable the last-on chip, but this guards against bypass.
      if (turningOff && prev.length + 1 >= META_CATEGORIES.length) {
        return prev;
      }
      const next = turningOff
        ? [...prev, meta]
        : prev.filter((m) => m !== meta);
      writeCache(next);
      if (user) {
        // Fire-and-forget — UI updates immediately; failures fall back to cache on next load.
        api
          .put("/preferences", { disabledMetaCategories: next })
          .catch(() => {});
      }
      return next;
    });
  }

  const enabled = META_CATEGORIES.filter((m) => !disabled.includes(m));

  return { disabled, enabled, toggle, enableAll };
}
