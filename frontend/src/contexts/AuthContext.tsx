/* eslint-disable react-refresh/only-export-components -- co-locating useAuth with AuthProvider; HMR-perf trade-off is acceptable */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "../api/client";

export type User = { id: string; email: string; displayName: string };

type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => void;
  replaceUser: (u: User | null) => void;
};

const Ctx = createContext<AuthCtx | null>(null);

/**
 * Renders the AuthProvider React component.
 *
 * Parameters:
 * - `{ children }` (`{ children: ReactNode }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Implements the replace user function.
   *
   * Parameters:
   * - `u` (`User | null`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  const replaceUser = useCallback((u: User | null) => {
    setUser(u);
  }, []);

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
    api
      .get("/auth/me", { headers: { "X-Skip-Auth-Redirect": "1" } })
      .then((res) => {
        if (!cancelled) replaceUser(res.data.user);
      })
      .catch(() => {
        if (!cancelled) replaceUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [replaceUser]);

  /**
   * Implements the login function.
   *
   * Parameters:
   * - `email` (`string`): Caller-provided value consumed by the function body.
   * - `password` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   */
  async function login(email: string, password: string) {
    const { data } = await api.post("/auth/login", { email, password });
    replaceUser(data.user);
  }

  /**
   * Implements the register function.
   *
   * Parameters:
   * - `email` (`string`): Caller-provided value consumed by the function body.
   * - `password` (`string`): Caller-provided value consumed by the function body.
   * - `displayName` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   */
  async function register(email: string, password: string, displayName: string) {
    const { data } = await api.post("/auth/register", {
      email,
      password,
      displayName,
    });
    replaceUser(data.user);
  }

  /**
   * Implements the login with google function.
   *
   * Parameters:
   * - `credential` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   */
  async function loginWithGoogle(credential: string) {
    const { data } = await api.post("/auth/google", { credential });
    replaceUser(data.user);
  }

  /**
   * Implements the logout function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Transforms credentials or session data into hashes, tokens, or cookies.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  function logout() {
    replaceUser(null);
    void api.post("/auth/logout").catch(() => {
      // The local auth state is already cleared; a failed logout request only
      // leaves an expired or stale cookie behind, which the server rejects.
    });
  }

  return (
    <Ctx.Provider
      value={{
        user,
        loading,
        login,
        register,
        loginWithGoogle,
        logout,
        replaceUser,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

/**
 * Provides the auth React hook behavior.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `AuthCtx`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
