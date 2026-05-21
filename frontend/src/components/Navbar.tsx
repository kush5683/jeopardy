import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Dropdown, DropdownItem } from "./Dropdown";

const HOVER_CLOSE_DELAY_MS = 60;

type MenuId = "play" | "compete";

export function Navbar() {
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useLocation();
  const nav = useNavigate();

  function handleLogout() {
    logout();
    setMobileOpen(false);
    nav("/", { replace: true });
  }

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const activate = useCallback(
    (id: MenuId) => {
      clearCloseTimer();
      setOpenMenu(id);
    },
    [clearCloseTimer],
  );

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(
      () => setOpenMenu(null),
      HOVER_CLOSE_DELAY_MS,
    );
  }, [clearCloseTimer]);

  const toggle = useCallback(
    (id: MenuId) => {
      clearCloseTimer();
      setOpenMenu((cur) => (cur === id ? null : id));
    },
    [clearCloseTimer],
  );

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // Close mobile drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Lock body scroll when drawer is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const play: DropdownItem[] = [
    { to: "/daily", label: "Daily" },
    { to: "/practice", label: "Practice" },
    ...(user ? [{ to: "/buzzer", label: "Buzzer" }] : []),
    ...(user ? [{ to: "/board", label: "Board" }] : []),
    ...(user ? [{ to: "/final", label: "Final" }] : []),
    ...(user ? [{ to: "/review", label: "Review" }] : []),
    { to: "/flashcards", label: "Flashcards" },
  ];

  const compete: DropdownItem[] = [
    { to: "/leaderboard", label: "Leaderboard" },
    ...(user ? [{ to: "/friends", label: "Friends" }] : []),
    ...(user ? [{ to: "/dashboard", label: "Dashboard" }] : []),
  ];

  return (
    <nav className="border-b border-white/10 bg-jeopardy-darkblue">
      <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-4">
        <Link to="/" className="font-category text-2xl text-jeopardy-gold tracking-wide">
          JEOPARDY!
        </Link>

        {/* Desktop: dropdown groups */}
        <div className="hidden md:flex gap-1 text-sm">
          <Dropdown
            label="Play"
            items={play}
            open={openMenu === "play"}
            onActivate={() => activate("play")}
            onDeactivate={scheduleClose}
            onToggle={() => toggle("play")}
          />
          <Dropdown
            label="Compete"
            items={compete}
            open={openMenu === "compete"}
            onActivate={() => activate("compete")}
            onDeactivate={scheduleClose}
            onToggle={() => toggle("compete")}
          />
        </div>

        {/* Right side: account info (desktop) */}
        <div className="hidden md:flex ml-auto items-center gap-3 text-sm">
          {user ? (
            <>
              <Link
                to="/settings"
                className="text-white/70 hover:text-white"
                title="Account settings"
              >
                {user.displayName}
              </Link>
              <button
                onClick={handleLogout}
                className="px-3 py-1 rounded border border-white/30 hover:bg-white/10"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="px-3 py-1 rounded border border-white/30 hover:bg-white/10">
                Log in
              </Link>
              <Link to="/register" className="px-3 py-1 rounded bg-jeopardy-gold text-black font-semibold">
                Sign up
              </Link>
            </>
          )}
        </div>

        {/* Mobile: hamburger */}
        <button
          type="button"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="md:hidden ml-auto p-3 rounded hover:bg-white/10"
        >
          <span className="block w-5 h-[2px] bg-white mb-1" />
          <span className="block w-5 h-[2px] bg-white mb-1" />
          <span className="block w-5 h-[2px] bg-white" />
        </button>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden border-t border-white/10 bg-jeopardy-darkblue">
          <div className="max-w-screen-2xl mx-auto px-4 py-3 space-y-4">
            <MobileSection title="Play" items={play} />
            <MobileSection title="Compete" items={compete} />
            <div className="pt-3 border-t border-white/10">
              {user ? (
                <div className="flex items-center justify-between gap-2">
                  <Link
                    to="/settings"
                    className="text-white/70 hover:text-white text-sm flex-1"
                  >
                    {user.displayName} · Settings
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="px-3 py-1 rounded border border-white/30 hover:bg-white/10 text-sm"
                  >
                    Log out
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Link
                    to="/login"
                    className="flex-1 text-center px-3 py-2 rounded border border-white/30 hover:bg-white/10 text-sm"
                  >
                    Log in
                  </Link>
                  <Link
                    to="/register"
                    className="flex-1 text-center px-3 py-2 rounded bg-jeopardy-gold text-black font-semibold text-sm"
                  >
                    Sign up
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

function MobileSection({ title, items }: { title: string; items: DropdownItem[] }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-white/40 mb-1">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-1">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              `px-3 py-2.5 rounded text-sm min-h-[40px] flex items-center ${
                isActive ? "bg-jeopardy-gold text-black" : "bg-white/5 hover:bg-white/10"
              }`
            }
          >
            {it.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
