import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RetryPanel } from "../components/RetryPanel";

type Friend = {
  id: string;
  displayName: string;
  friendshipId: string;
};
type PendingPerson = { id: string; displayName: string };
type Pending = {
  incoming: { id: string; from: PendingPerson; createdAt: string }[];
  outgoing: { id: string; to: PendingPerson; createdAt: string }[];
};

export function Friends() {
  useDocumentTitle("Friends");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pending, setPending] = useState<Pending>({ incoming: [], outgoing: [] });
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  async function refresh() {
    try {
      const [a, b] = await Promise.all([
        api.get("/friends"),
        api.get("/friends/pending"),
      ]);
      setFriends(a.data.friends);
      setPending(b.data);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setInitialLoad(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function sendRequest(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg(null);
    setBusy(true);
    try {
      await api.post("/friends/request", { email });
      setEmail("");
      setMsg({ kind: "ok", text: "Request sent." });
      refresh();
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setMsg({
        kind: "err",
        text: typeof raw === "string" ? raw : "Failed to send request.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function respond(id: string, accept: boolean) {
    await api.post(`/friends/respond/${id}`, { accept });
    refresh();
  }

  async function cancelOutgoing(friendshipId: string) {
    await api.delete(`/friends/${friendshipId}`).catch(() => {});
    refresh();
  }

  async function removeFriend(friend: Friend) {
    const ok = window.confirm(
      `Remove ${friend.displayName} from your friends? You'll both stop seeing each other on the friends leaderboard.`,
    );
    if (!ok) return;
    await api.delete(`/friends/${friend.friendshipId}`).catch(() => {});
    refresh();
  }

  if (initialLoad) {
    return <p className="text-white/60 text-center py-12">Loading…</p>;
  }
  if (loadError) {
    return <RetryPanel onRetry={refresh} message="Couldn't load your friends." />;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="font-category text-4xl text-jeopardy-gold">Friends</h1>
        <p className="text-sm text-white/60 mt-1">Add friends by email — they need an account.</p>
      </div>

      <form onSubmit={sendRequest} className="flex gap-2">
        <input
          aria-label="Friend's email address"
          autoComplete="email"
          className="flex-1 px-3 py-3 rounded bg-white/10"
          placeholder="friend@example.com"
          value={email}
          type="email"
          required
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
      {msg && (
        <p
          className={`text-sm ${msg.kind === "ok" ? "text-green-300" : "text-red-300"}`}
          role="status"
        >
          {msg.text}
        </p>
      )}

      {pending.incoming.length > 0 && (
        <section>
          <h2 className="font-category text-xl text-jeopardy-gold mb-2">Incoming requests</h2>
          <div className="space-y-2">
            {pending.incoming.map((p) => (
              <div key={p.id} className="flex items-center justify-between bg-white/5 px-3 py-2 rounded">
                <div>
                  <div className="font-semibold">{p.from.displayName}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => respond(p.id, true)} className="px-3 py-2 bg-green-700/60 rounded text-sm min-h-[40px]">Accept</button>
                  <button onClick={() => respond(p.id, false)} className="px-3 py-2 bg-red-700/60 rounded text-sm min-h-[40px]">Decline</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {pending.outgoing.length > 0 && (
        <section>
          <h2 className="font-category text-xl text-jeopardy-gold mb-2">Pending (sent)</h2>
          <div className="space-y-2">
            {pending.outgoing.map((p) => (
              <div
                key={p.id}
                className="bg-white/5 px-3 py-2 rounded text-sm flex items-center justify-between gap-2"
              >
                <span className="min-w-0 break-words">{p.to.displayName}</span>
                <button
                  onClick={() => cancelOutgoing(p.id)}
                  className="px-3 py-1.5 text-xs border border-white/30 hover:bg-white/10 rounded shrink-0"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-category text-xl text-jeopardy-gold mb-2">Your friends</h2>
        {friends.length === 0 ? (
          <p className="text-white/60 text-sm">No friends yet. Send a request above.</p>
        ) : (
          <div className="space-y-2">
            {friends.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-2 bg-white/5 px-3 py-2 rounded">
                <div className="min-w-0">
                  <div className="font-semibold break-words">{f.displayName}</div>
                </div>
                <button
                  onClick={() => removeFriend(f)}
                  className="px-3 py-1.5 text-xs border border-white/30 hover:bg-red-900/40 hover:border-red-500/50 rounded shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
