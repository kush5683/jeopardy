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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const replaceUser = useCallback((u: User | null) => {
    setUser(u);
  }, []);

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

  async function login(email: string, password: string) {
    const { data } = await api.post("/auth/login", { email, password });
    replaceUser(data.user);
  }

  async function register(email: string, password: string, displayName: string) {
    const { data } = await api.post("/auth/register", {
      email,
      password,
      displayName,
    });
    replaceUser(data.user);
  }

  async function loginWithGoogle(credential: string) {
    const { data } = await api.post("/auth/google", { credential });
    replaceUser(data.user);
  }

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

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
