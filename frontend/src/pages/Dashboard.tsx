import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RetryPanel } from "../components/RetryPanel";

type Stats = {
  totalAnswered: number;
  correctCount: number;
  accuracy: number;
  bestCoryat: number;
  recentBuzzer: { id: string; coryatScore: number; correctCount: number; totalClues: number; createdAt: string }[];
  byRound: Record<string, { total: number; correct: number }>;
  topCategories: { id: number; name: string; total: number; correct: number; accuracy: number }[];
  daily: {
    playedCount: number;
    bestScore: number;
    averageScore: number;
    accuracy: number;
    streak: number;
    recent: Array<{
      id: string;
      date: string;
      score: number;
      totalCorrect: number;
      totalClues: number;
      completedAt: string;
    }>;
  };
};

export function Dashboard() {
  useDocumentTitle("Dashboard");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setStats(null);
    api
      .get("/stats/me")
      .then((res) => setStats(res.data))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <RetryPanel onRetry={load} message="Couldn't load your stats." />;
  if (!stats) return <p className="text-white/60 text-center py-12">Loading…</p>;

  return (
    <div className="space-y-8">
      <h1 className="font-category text-4xl text-jeopardy-gold">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Answered" value={stats.totalAnswered} />
        <Stat label="Correct" value={stats.correctCount} />
        <Stat label="Accuracy" value={`${(stats.accuracy * 100).toFixed(0)}%`} />
        <Stat label="Best Coryat" value={`$${stats.bestCoryat}`} highlight />
      </div>

      <section>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="font-category text-2xl text-jeopardy-gold">Daily performance</h2>
          <Link to="/daily" className="text-sm text-jeopardy-gold underline">
            Play daily
          </Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat label="Played" value={stats.daily.playedCount} />
          <Stat label="Best score" value={`$${stats.daily.bestScore}`} highlight />
          <Stat label="Average score" value={`$${Math.round(stats.daily.averageScore)}`} />
          <Stat label="Daily accuracy" value={`${(stats.daily.accuracy * 100).toFixed(0)}%`} />
          <Stat label="Streak" value={`${stats.daily.streak} day${stats.daily.streak === 1 ? "" : "s"}`} />
        </div>
        {stats.daily.recent.length === 0 ? (
          <p className="mt-3 text-white/60 text-sm">No completed dailies yet.</p>
        ) : (
          <div className="mt-3 bg-white/5 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/10 text-xs uppercase">
                <tr>
                  <th className="text-left px-2 sm:px-3 py-2">Date</th>
                  <th className="text-right px-2 sm:px-3 py-2">Score</th>
                  <th className="text-right px-2 sm:px-3 py-2">Correct</th>
                  <th className="text-right px-2 sm:px-3 py-2">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {stats.daily.recent.map((attempt) => (
                  <tr key={attempt.id} className="border-t border-white/5">
                    <td className="px-2 sm:px-3 py-2">
                      <Link to={`/daily/${attempt.date}`} className="text-jeopardy-gold underline">
                        {new Date(`${attempt.date}T00:00:00Z`).toLocaleDateString()}
                      </Link>
                    </td>
                    <td className="px-2 sm:px-3 py-2 text-right dollar text-base">${attempt.score}</td>
                    <td className="px-2 sm:px-3 py-2 text-right whitespace-nowrap">{attempt.totalCorrect}/{attempt.totalClues}</td>
                    <td className="px-2 sm:px-3 py-2 text-right">
                      {((attempt.totalCorrect / Math.max(1, attempt.totalClues)) * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-category text-2xl text-jeopardy-gold mb-3">By round</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {Object.entries(stats.byRound).map(([k, v]) => (
            <div key={k} className="bg-white/5 rounded p-4">
              <div className="text-xs uppercase text-white/60">{k.replace(/_/g, " ")}</div>
              <div className="text-2xl font-bold mt-1">
                {v.correct}/{v.total} <span className="text-sm text-white/60">({((v.correct / Math.max(1, v.total)) * 100).toFixed(0)}%)</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-category text-2xl text-jeopardy-gold mb-3">Top categories</h2>
        {stats.topCategories.length === 0 ? (
          <p className="text-white/60 text-sm">No data yet.</p>
        ) : (
          <div className="bg-white/5 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/10 text-xs uppercase">
                <tr>
                  <th className="text-left px-2 sm:px-3 py-2">Category</th>
                  <th className="text-right px-2 sm:px-3 py-2">Answered</th>
                  <th className="text-right px-2 sm:px-3 py-2">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {stats.topCategories.map((c) => (
                  <tr key={c.id} className="border-t border-white/5">
                    <td className="px-2 sm:px-3 py-2 break-words">{c.name}</td>
                    <td className="px-2 sm:px-3 py-2 text-right">{c.total}</td>
                    <td className="px-2 sm:px-3 py-2 text-right">{(c.accuracy * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-category text-2xl text-jeopardy-gold mb-3">Recent buzzer sessions</h2>
        {stats.recentBuzzer.length === 0 ? (
          <p className="text-white/60 text-sm">No buzzer sessions yet.</p>
        ) : (
          <div className="space-y-2">
            {stats.recentBuzzer.slice(0, 8).map((s) => (
              <div key={s.id} className="bg-white/5 rounded px-3 py-2 flex items-center justify-between gap-2 flex-wrap text-sm">
                <span className="text-white/60">{new Date(s.createdAt).toLocaleDateString()}</span>
                <span>{s.correctCount}/{s.totalClues} correct</span>
                <span className="dollar text-base">${s.coryatScore}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`rounded p-4 ${highlight ? "bg-jeopardy-gold/20 border border-jeopardy-gold/40" : "bg-white/5"}`}>
      <div className="text-xs uppercase tracking-wide text-white/60">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
