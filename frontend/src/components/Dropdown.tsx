import { ReactNode, useEffect, useId, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";

export type DropdownItem = {
  to: string;
  label: string;
};

type Props = {
  label: ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
  // Controlled by the parent so sibling dropdowns can coordinate (opening one
  // closes the others immediately, no overlap window).
  open: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onToggle: () => void;
};

export function Dropdown({
  label,
  items,
  align = "left",
  open,
  onActivate,
  onDeactivate,
  onToggle,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const location = useLocation();

  // Close on route change.
  useEffect(() => {
    if (open) onDeactivate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Click-outside + Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) onDeactivate();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDeactivate();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onDeactivate]);

  // Highlight the trigger when any child route is active.
  const isActive = items.some((it) => location.pathname === it.to);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={`px-3 py-1 rounded inline-flex items-center gap-1 ${
          isActive || open
            ? "bg-jeopardy-gold text-black"
            : "hover:bg-white/10"
        }`}
      >
        <span>{label}</span>
        <span
          aria-hidden
          className={`text-xs transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className={`absolute z-20 top-full min-w-[10rem] rounded border border-white/15 bg-jeopardy-darkblue shadow-lg overflow-hidden ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              role="menuitem"
              className={({ isActive: active }) =>
                `block px-3 py-2 text-sm whitespace-nowrap ${
                  active
                    ? "bg-jeopardy-gold text-black"
                    : "hover:bg-white/10"
                }`
              }
            >
              {it.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
