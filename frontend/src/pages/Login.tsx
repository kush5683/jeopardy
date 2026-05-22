import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { api } from "../api/client";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

declare global {
  interface Window {
    google?: any;
  }
}

// Only follow returnTo if it's a same-site relative path. Refusing absolute
// URLs and protocol-relative URLs prevents open-redirect attacks via a crafted
// link like /login?returnTo=https://evil.example.com.
/**
 * Implements the safe return to function.
 *
 * Parameters:
 * - `raw` (`string | null`): Untrusted or loosely typed input normalized before the rest of the function uses it.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function safeReturnTo(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

/**
 * Renders the Login React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function Login() {
  useDocumentTitle("Log in");
  const { login, loginWithGoogle } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const sessionExpired = params.get("sessionExpired") === "1";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
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
   */
  useEffect(() => {
    api.get("/auth/config").then((res) => {
      setGoogleClientId(res.data.googleClientId);
    });
  }, []);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    if (!googleClientId || !window.google) return;
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      /**
       * Implements the callback function.
       *
       * Parameters:
       * - `response` (`{ credential: string }`): HTTP response writer used to set status codes, headers, and JSON payloads.
       *
       * Output:
       * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
       *
       * Data transformations:
       * - Updates application/browser state, cookies, or persistent browser storage from computed values.
       * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
       */
      callback: async (response: { credential: string }) => {
        try {
          await loginWithGoogle(response.credential);
          nav(returnTo, { replace: true });
        } catch (e: any) {
          const raw = e?.response?.data?.error;
          setErr(typeof raw === "string" ? raw : "google login failed");
        }
      },
    });
    const el = document.getElementById("google-btn");
    if (el) {
      window.google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot init when GSI loads; callback closes over current props
  }, [googleClientId]);

  /**
   * Handles the submit event.
   *
   * Parameters:
   * - `e` (`FormEvent`): Browser or React event object read for form, keyboard, or pointer state.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      await login(email, password);
      nav(returnTo, { replace: true });
    } catch (e: any) {
      const raw = e?.response?.data?.error;
      setErr(typeof raw === "string" ? raw : "login failed");
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto">
      <h1 className="font-category text-4xl text-jeopardy-gold mb-6 text-center">Log in</h1>
      {sessionExpired && (
        <div className="mb-4 p-3 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-200 text-sm text-center">
          Your session expired — log in again to pick up where you left off.
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-3">
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
          autoComplete="current-password"
          className="w-full px-3 py-3 rounded bg-white/10"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          required
        />
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-3 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      {googleClientId && (
        <>
          <div className="my-6 text-center text-white/50 text-sm">or</div>
          <div id="google-btn" className="flex justify-center"></div>
        </>
      )}
      <p className="mt-6 text-sm text-white/70 text-center">
        Don't have an account? <Link to="/register" className="text-jeopardy-gold underline">Sign up</Link>
      </p>
    </div>
  );
}
