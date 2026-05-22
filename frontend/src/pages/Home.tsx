import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type Feature = {
  to: string;
  title: string;
  tagline: string;
  requiresAuth: boolean;
};

const FEATURES: Feature[] = [
  {
    to: "/daily",
    title: "Daily",
    tagline: "Same 30 clues for everyone today. Resets at midnight UTC.",
    requiresAuth: false,
  },
  {
    to: "/practice",
    title: "Practice",
    tagline: "Real Jeopardy! clues, immediate feedback, score tracking.",
    requiresAuth: false,
  },
  {
    to: "/flashcards",
    title: "Flashcards",
    tagline: "Drill the categories that win games — presidents, capitals, wordplay.",
    requiresAuth: false,
  },
  {
    to: "/leaderboard",
    title: "Leaderboard",
    tagline: "Best Coryat scores across players and friends.",
    requiresAuth: false,
  },
  {
    to: "/buzzer",
    title: "Buzzer training",
    tagline: "Lights-on timing, 250ms lockout for early buzzes. Build your Coryat score.",
    requiresAuth: true,
  },
  {
    to: "/board",
    title: "Full Board",
    tagline: "Real episode or mixed: 6×5 board, Daily Doubles, then Final Jeopardy.",
    requiresAuth: true,
  },
  {
    to: "/final",
    title: "Final Jeopardy",
    tagline: "Pick a stake, see the category, wager — then the clue. 30 seconds.",
    requiresAuth: true,
  },
  {
    to: "/review",
    title: "Review",
    tagline: "Spaced repetition on clues you got wrong. They come back smarter.",
    requiresAuth: true,
  },
  {
    to: "/friends",
    title: "Friends",
    tagline: "Add friends. Compare progress. Track who's grinding hardest.",
    requiresAuth: true,
  },
  {
    to: "/dashboard",
    title: "Dashboard",
    tagline: "Your accuracy by round, by category, recent sessions.",
    requiresAuth: true,
  },
];

/**
 * Renders the Home React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
export function Home() {
  useDocumentTitle(null);
  const { user } = useAuth();
  const openNow = FEATURES.filter((f) => !f.requiresAuth);
  const locked = FEATURES.filter((f) => f.requiresAuth);

  return (
    <div className="space-y-10">
      <header className="text-center py-12">
        <h1 className="font-category text-5xl sm:text-6xl md:text-8xl text-jeopardy-gold tracking-wider drop-shadow-[3px_3px_0_#000]">
          JEOPARDY!
        </h1>
        <p className="text-xl mt-4 text-white/80">Train to appear on the show.</p>
        {!user && (
          <div className="mt-8 flex justify-center gap-3 flex-wrap">
            <Link
              to="/daily"
              className="px-6 py-3 bg-jeopardy-gold text-black font-semibold rounded"
            >
              Play today's daily
            </Link>
            <Link
              to="/register"
              className="px-6 py-3 border border-white/30 rounded hover:bg-white/10"
            >
              Create account
            </Link>
          </div>
        )}
      </header>

      {user ? (
        <section className="grid md:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <FeatureCard key={f.to} feature={f} locked={false} />
          ))}
        </section>
      ) : (
        <>
          <section>
            <div className="flex items-baseline gap-3 mb-3">
              <h2 className="font-category text-2xl text-jeopardy-gold tracking-wide">
                Play now
              </h2>
              <span className="text-xs text-white/50">no account needed</span>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
              {openNow.map((f) => (
                <FeatureCard key={f.to} feature={f} locked={false} />
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-baseline gap-3 mb-3">
              <h2 className="font-category text-2xl text-jeopardy-gold tracking-wide">
                Unlock with an account
              </h2>
              <span className="text-xs text-white/50">
                save scores, compare with friends, spaced review
              </span>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {locked.map((f) => (
                <FeatureCard key={f.to} feature={f} locked={true} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Renders the FeatureCard React component.
 *
 * Parameters:
 * - `{ feature, locked }` (`{ feature: Feature; locked: boolean }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function FeatureCard({ feature, locked }: { feature: Feature; locked: boolean }) {
  // Locked cards land on /login (with returnTo) so the user comes straight back
  // after auth.
  const href = locked
    ? `/login?returnTo=${encodeURIComponent(feature.to)}`
    : feature.to;
  return (
    <Link
      to={href}
      className={`clue-tile p-6 rounded text-left block transition ${
        locked ? "opacity-70 hover:opacity-100" : "hover:scale-[1.02]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-category text-2xl text-jeopardy-gold tracking-wide">
          {feature.title}
        </h3>
        {locked && (
          <span
            className="text-xs uppercase tracking-wider text-jeopardy-gold/80 border border-jeopardy-gold/40 rounded px-2 py-0.5"
            aria-label="Requires account"
          >
            🔒 Log in
          </span>
        )}
      </div>
      <p className="text-white/85 mt-2 text-sm">{feature.tagline}</p>
    </Link>
  );
}
