import { useEffect, useState } from "react";
import { api } from "../api/client";

type Wiki = {
  title: string | null;
  extract: string | null;
  url: string | null;
  thumb: string | null;
};

/**
 * Renders the WikiBlurb React component.
 *
 * Parameters:
 * - `{ clueId }` (`{ clueId: number }`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts component state and props into JSX UI output.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function WikiBlurb({ clueId }: { clueId: number }) {
  const [data, setData] = useState<Wiki | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

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
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    setData(null);
    api
      .get(`/clues/${clueId}/wiki`)
      .then((res) => {
        if (!cancelled) {
          setData(res.data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrored(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clueId]);

  if (loading) {
    return <div className="mt-4 text-xs text-white/40 text-left">Loading context…</div>;
  }
  if (errored || !data?.extract) return null;

  return (
    <div className="mt-4 p-4 bg-black/30 rounded text-left flex gap-3 border border-white/10">
      {data.thumb && (
        <img
          src={data.thumb}
          alt=""
          className="w-16 h-16 rounded object-cover flex-shrink-0"
        />
      )}
      <div className="text-sm min-w-0 flex-1">
        <a
          href={data.url ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-jeopardy-gold hover:underline"
        >
          {data.title} ↗
        </a>
        <p className="text-white/75 mt-1 leading-snug">{data.extract}</p>
      </div>
    </div>
  );
}
