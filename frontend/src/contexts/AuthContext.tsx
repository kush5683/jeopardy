/* eslint-disable react-refresh/only-export-components -- co-locating useAuth with AuthProvider; HMR-perf trade-off is acceptable */
import {
  createContext,
  ReactNode,
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
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("jeopardy_user");
    if (stored) {
      try {
        setUser(JSON.parse(stored));
      } catch {
        // ignore
      }
    }
    setLoading(false);
  }, []);

  function persist(token: string, u: User) {
    localStorage.setItem("jeopardy_token", token);
    localStorage.setItem("jeopardy_user", JSON.stringify(u));
    setUser(u);
  }

  async function login(email: string, password: string) {
    const { data } = await api.post("/auth/login", { email, password });
    persist(data.token, data.user);
  }

  async function register(email: string, password: string, displayName: string) {
    const { data } = await api.post("/auth/register", {
      email,
      password,
      displayName,
    });
    persist(data.token, data.user);
  }

  async function loginWithGoogle(credential: string) {
    const { data } = await api.post("/auth/google", { credential });
    persist(data.token, data.user);
  }

  function logout() {
    localStorage.removeItem("jeopardy_token");
    localStorage.removeItem("jeopardy_user");
    setUser(null);
  }

  return (
    <Ctx.Provider
      value={{ user, loading, login, register, loginWithGoogle, logout }}
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
