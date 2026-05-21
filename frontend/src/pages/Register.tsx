import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function safeReturnTo(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export function Register() {
  useDocumentTitle("Sign up");
  const { register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      await register(email, password, displayName);
      nav(returnTo, { replace: true });
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setErr(typeof raw === "string" ? raw : "registration failed");
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto">
      <h1 className="font-category text-4xl text-jeopardy-gold mb-6 text-center">Sign up</h1>
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          aria-label="Display name"
          autoComplete="nickname"
          className="w-full px-3 py-3 rounded bg-white/10"
          placeholder="display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
        <input
          aria-label="Email"
          autoComplete="email"
          className="w-full px-3 py-3 rounded bg-white/10"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
        />
        <input
          aria-label="Password"
          autoComplete="new-password"
          className="w-full px-3 py-3 rounded bg-white/10"
          placeholder="password (8+ chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          required
          minLength={8}
        />
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-3 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="mt-6 text-sm text-white/70 text-center">
        Already have an account? <Link to="/login" className="text-jeopardy-gold underline">Log in</Link>
      </p>
    </div>
  );
}
