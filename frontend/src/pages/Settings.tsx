import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RetryPanel } from "../components/RetryPanel";

type Me = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  hasPassword: boolean;
  hasGoogle: boolean;
};

export function Settings() {
  useDocumentTitle("Settings");
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState(false);

  function load() {
    setLoadError(false);
    api
      .get("/auth/me")
      .then((res) => setMe(res.data.user))
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    load();
  }, []);

  if (!user) {
    return (
      <p className="text-white/80 text-center py-12">
        Log in to manage your account.
      </p>
    );
  }
  if (loadError) {
    return <RetryPanel onRetry={load} message="Couldn't load your account." />;
  }
  if (!me) {
    return <p className="text-white/60 text-center py-12">Loading…</p>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-10">
      <header>
        <h1 className="font-category text-4xl text-jeopardy-gold">Settings</h1>
        <p className="text-sm text-white/60 mt-1">
          {me.email}
          {me.hasGoogle && (
            <span className="ml-2 text-xs text-white/50">(Google account)</span>
          )}
        </p>
      </header>

      <ProfileSection me={me} onUpdated={(m) => setMe(m)} />
      <PasswordSection me={me} onUpdated={load} />
      <DangerSection
        onDeleted={() => {
          logout();
          nav("/", { replace: true });
        }}
      />
    </div>
  );
}

function ProfileSection({
  me,
  onUpdated,
}: {
  me: Me;
  onUpdated: (m: Me) => void;
}) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg(null);
    setBusy(true);
    try {
      const { data } = await api.patch("/auth/me", { displayName });
      onUpdated({ ...me, displayName: data.user.displayName });
      // Keep the persisted user in sync with the new name.
      const stored = localStorage.getItem("jeopardy_user");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          parsed.displayName = data.user.displayName;
          localStorage.setItem("jeopardy_user", JSON.stringify(parsed));
        } catch {
          // ignore
        }
      }
      setMsg({ kind: "ok", text: "Saved." });
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setMsg({
        kind: "err",
        text: typeof raw === "string" ? raw : "Couldn't save.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-category text-xl text-jeopardy-gold">Profile</h2>
      <form onSubmit={onSubmit} className="space-y-3 bg-white/5 rounded p-4">
        <label className="block text-xs uppercase tracking-wider text-white/60">
          Display name
        </label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          minLength={1}
          maxLength={40}
          className="w-full px-3 py-3 rounded bg-white/10"
        />
        {msg && (
          <p
            className={`text-sm ${msg.kind === "ok" ? "text-green-300" : "text-red-300"}`}
            role="status"
          >
            {msg.text}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || displayName === me.displayName}
          className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  );
}

function PasswordSection({ me, onUpdated }: { me: Me; onUpdated: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg(null);
    setBusy(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword: me.hasPassword ? currentPassword : undefined,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setMsg({
        kind: "ok",
        text: me.hasPassword
          ? "Password updated."
          : "Password set — you can now log in with email + password.",
      });
      onUpdated();
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setMsg({
        kind: "err",
        text: typeof raw === "string" ? raw : "Couldn't update password.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-category text-xl text-jeopardy-gold">
        {me.hasPassword ? "Change password" : "Set a password"}
      </h2>
      {!me.hasPassword && (
        <p className="text-sm text-white/60">
          Your account currently signs in with Google only. Set a password to
          enable email + password login as a backup.
        </p>
      )}
      <form onSubmit={onSubmit} className="space-y-3 bg-white/5 rounded p-4">
        {me.hasPassword && (
          <>
            <label className="block text-xs uppercase tracking-wider text-white/60">
              Current password
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-3 py-3 rounded bg-white/10"
            />
          </>
        )}
        <label className="block text-xs uppercase tracking-wider text-white/60">
          New password (8+ chars)
        </label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full px-3 py-3 rounded bg-white/10"
        />
        {msg && (
          <p
            className={`text-sm ${msg.kind === "ok" ? "text-green-300" : "text-red-300"}`}
            role="status"
          >
            {msg.text}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-50"
        >
          {busy ? "Updating…" : me.hasPassword ? "Update password" : "Set password"}
        </button>
      </form>
    </section>
  );
}

function DangerSection({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onDelete() {
    if (busy || typed !== "DELETE") return;
    setBusy(true);
    setErr(null);
    try {
      await api.delete("/auth/me", { data: { confirm: "DELETE" } });
      onDeleted();
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setErr(typeof raw === "string" ? raw : "Couldn't delete account.");
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-category text-xl text-red-300">Delete account</h2>
      <div className="bg-red-900/20 border border-red-500/30 rounded p-4 space-y-3">
        <p className="text-sm text-white/80">
          Permanently delete your account and all associated data — responses,
          stats, friends, leaderboard entries, review queue. This can't be
          undone.
        </p>
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            className="px-4 py-2 border border-red-500/50 text-red-200 rounded hover:bg-red-900/30"
          >
            Delete my account…
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-white/80">
              Type <span className="font-mono text-red-200">DELETE</span> to confirm.
            </p>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full px-3 py-3 rounded bg-white/10 font-mono"
              placeholder="DELETE"
              autoComplete="off"
            />
            {err && <p className="text-sm text-red-300">{err}</p>}
            <div className="flex gap-2">
              <button
                onClick={onDelete}
                disabled={busy || typed !== "DELETE"}
                className="px-4 py-2 bg-red-700 text-white font-semibold rounded disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Permanently delete"}
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  setTyped("");
                  setErr(null);
                }}
                className="px-4 py-2 border border-white/30 hover:bg-white/10 rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
