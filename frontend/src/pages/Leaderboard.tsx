import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RetryPanel } from "../components/RetryPanel";

type Row = {
  userId: string;
  displayName: string;
  totalAnswered: number;
  correctCount: number;
  accuracy: number;
  bestCoryat: number;
};

type TooltipProps = {
  label: string;
  children: string;
  align?: "left" | "right";
};

function InfoTooltip({ label, children, align = "left" }: TooltipProps) {
  const placement =
    align === "right"
      ? "right-0 origin-top-right"
      : "left-0 origin-top-left";

  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/30 text-[10px] font-bold leading-none text-white/70 hover:border-jeopardy-gold hover:text-jeopardy-gold focus:outline-none focus:ring-1 focus:ring-jeopardy-gold"
      >
        i
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-5 z-20 hidden w-64 rounded border border-white/10 bg-[#07091f] px-3 py-2 text-left text-xs font-normal normal-case leading-snug text-white shadow-xl group-hover:block group-focus-within:block ${placement}`}
      >
        {children}
      </span>
    </span>
  );
}

function HeaderWithTooltip({
  children,
  tooltip,
  align = "left",
}: {
  children: string;
  tooltip: string;
  align?: "left" | "right";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 ${
        align === "right" ? "justify-end" : "justify-start"
      }`}
    >
      {children}
      <InfoTooltip label={`${children} explanation`} align={align}>
        {tooltip}
      </InfoTooltip>
    </span>
  );
}

export function Leaderboard() {
  useDocumentTitle("Leaderboard");
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [me, setMe] = useState<{ rank: number; row: Row } | null>(null);
  const [scope, setScope] = useState<"global" | "friends">("global");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    if (scope === "friends" && !user) {
      setRows([]);
      setMe(null);
      setLoading(false);
      setError(false);
      return;
    }
    const path = scope === "global" ? "/leaderboard/global" : "/leaderboard/friends";
    setLoading(true);
    setError(false);
    api
      .get(path)
      .then((res) => {
        setRows(res.data.rows);
        setMe(res.data.me ?? null);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [scope, user]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-category text-4xl text-jeopardy-gold">Leaderboard</h1>
        <div className="flex gap-1 bg-white/5 rounded p-1">
          <button
            onClick={() => setScope("global")}
            title="Shows public rankings. Your position improves first through completed Buzzer rounds, then by answering more accurately."
            className={`px-3 py-2 rounded text-sm min-h-[36px] ${scope === "global" ? "bg-jeopardy-gold text-black" : ""}`}
          >
            Global
          </button>
          <button
            onClick={() => setScope("friends")}
            disabled={!user}
            title={
              user
                ? "Shows the same ranking, limited to you and accepted friends."
                : "Sign in to see the friends leaderboard."
            }
            className={`px-3 py-2 rounded text-sm min-h-[36px] disabled:opacity-50 ${scope === "friends" ? "bg-jeopardy-gold text-black" : ""}`}
          >
            Friends
          </button>
        </div>
      </div>
      {error ? (
        <RetryPanel onRetry={load} message="Couldn't load the leaderboard." />
      ) : (
        <div className="bg-white/5 rounded overflow-x-auto relative">
          {loading && (
            <div className="absolute inset-x-0 top-0 h-0.5 bg-jeopardy-gold/30 animate-pulse" />
          )}
          <table className="w-full text-sm">
            <thead className="bg-white/10 text-xs uppercase">
              <tr>
                <th className="text-left px-2 sm:px-3 py-2">
                  <HeaderWithTooltip tooltip="Rank is ordered by Best Coryat first, then Accuracy, then Answered. Finish strong Buzzer rounds to move up fastest; accurate clue answers break ties.">
                    #
                  </HeaderWithTooltip>
                </th>
                <th className="text-left px-2 sm:px-3 py-2">
                  <HeaderWithTooltip tooltip="Player is the display name on the account. Update it in settings if you want a different name shown here.">
                    Player
                  </HeaderWithTooltip>
                </th>
                <th className="text-right px-2 sm:px-3 py-2">
                  <HeaderWithTooltip
                    align="right"
                    tooltip="Best Coryat is your highest completed Buzzer round score. Correct answers add the clue value; wrong answers and timeouts subtract it."
                  >
                    Best Coryat
                  </HeaderWithTooltip>
                </th>
                <th className="text-right px-2 sm:px-3 py-2">
                  <HeaderWithTooltip
                    align="right"
                    tooltip="Accuracy is the percent of signed-in clue answers judged correct across Practice, Board, Final, Daily, Review, Buzzer, and multiplayer play."
                  >
                    Accuracy
                  </HeaderWithTooltip>
                </th>
                <th className="text-right px-2 sm:px-3 py-2 hidden sm:table-cell">
                  <HeaderWithTooltip
                    align="right"
                    tooltip="Answered is the number of signed-in clue answers submitted across play modes. Anonymous checks do not count."
                  >
                    Answered
                  </HeaderWithTooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.userId} className={`border-t border-white/5 ${user?.id === r.userId ? "bg-jeopardy-gold/10" : ""}`}>
                  <td className="px-2 sm:px-3 py-2">{i + 1}</td>
                  <td className="px-2 sm:px-3 py-2 break-words max-w-[140px] sm:max-w-none">{r.displayName}</td>
                  <td className="px-2 sm:px-3 py-2 text-right dollar text-base">${r.bestCoryat}</td>
                  <td className="px-2 sm:px-3 py-2 text-right">{(r.accuracy * 100).toFixed(0)}%</td>
                  <td className="px-2 sm:px-3 py-2 text-right hidden sm:table-cell">{r.totalAnswered}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 sm:px-3 py-6 text-center text-white/50">
                    No data yet — go play some clues.
                  </td>
                </tr>
              )}
              {me && (
                <tr className="border-t-2 border-jeopardy-gold/40 bg-jeopardy-gold/10">
                  <td className="px-2 sm:px-3 py-2">{me.rank}</td>
                  <td className="px-2 sm:px-3 py-2 break-words max-w-[140px] sm:max-w-none">
                    {me.row.displayName}{" "}
                    <span className="text-xs text-white/60">(you)</span>
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-right dollar text-base">
                    ${me.row.bestCoryat}
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-right">
                    {(me.row.accuracy * 100).toFixed(0)}%
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-right hidden sm:table-cell">
                    {me.row.totalAnswered}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
