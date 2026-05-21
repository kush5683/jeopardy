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
            className={`px-3 py-2 rounded text-sm min-h-[36px] ${scope === "global" ? "bg-jeopardy-gold text-black" : ""}`}
          >
            Global
          </button>
          <button
            onClick={() => setScope("friends")}
            disabled={!user}
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
                <th className="text-left px-2 sm:px-3 py-2">#</th>
                <th className="text-left px-2 sm:px-3 py-2">Player</th>
                <th className="text-right px-2 sm:px-3 py-2">Best Coryat</th>
                <th className="text-right px-2 sm:px-3 py-2">Accuracy</th>
                <th className="text-right px-2 sm:px-3 py-2 hidden sm:table-cell">Answered</th>
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
