import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-red-900/60 border-b border-red-500/50 text-center text-sm py-1.5 px-3 text-red-100"
    >
      You're offline — answers and progress won't save until your connection comes back.
    </div>
  );
}
