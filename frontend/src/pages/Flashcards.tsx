import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RetryPanel } from "../components/RetryPanel";

type DeckSummary = {
  id: number;
  name: string;
  description: string | null;
  cardCount: number;
};
type MetaDeckSummary = { name: string; cardCount: number };

type Card = {
  id: number;
  front: string;
  back: string;
  hint: string | null;
};

type ActiveDeck = {
  // null id ⇒ meta-category deck (no per-card progress persistence).
  id: number | null;
  name: string;
  cards: Card[];
};

/**
 * Renders the Flashcards React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts component state and props into JSX UI output.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function Flashcards() {
  useDocumentTitle("Flashcards");
  const { user } = useAuth();
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [metaDecks, setMetaDecks] = useState<MetaDeckSummary[]>([]);
  const [activeDeck, setActiveDeck] = useState<ActiveDeck | null>(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ratings, setRatings] = useState<{ hard: number; ok: number; easy: number }>(
    { hard: 0, ok: 0, easy: 0 },
  );
  const [deckComplete, setDeckComplete] = useState(false);
  const [decksError, setDecksError] = useState(false);
  const [decksLoading, setDecksLoading] = useState(true);

  /**
   * Loads decks data.
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
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  function loadDecks() {
    setDecksError(false);
    setDecksLoading(true);
    Promise.all([
      api.get("/flashcards/decks"),
      api.get("/flashcards/meta-decks"),
    ])
      .then(([d, m]) => {
        setDecks(d.data.decks);
        setMetaDecks(m.data.decks);
      })
      .catch(() => setDecksError(true))
      .finally(() => setDecksLoading(false));
  }

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
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  useEffect(() => {
    loadDecks();
  }, []);

  /**
   * Implements the reset deck state function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function resetDeckState() {
    setIdx(0);
    setFlipped(false);
    setRatings({ hard: 0, ok: 0, easy: 0 });
    setDeckComplete(false);
  }

  /**
   * Implements the open curated deck function.
   *
   * Parameters:
   * - `id` (`number`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  async function openCuratedDeck(id: number) {
    setLoading(true);
    const { data } = await api.get(`/flashcards/decks/${id}`);
    setActiveDeck({ id: data.deck.id, name: data.deck.name, cards: data.deck.cards });
    resetDeckState();
    setLoading(false);
  }

  /**
   * Implements the open meta deck function.
   *
   * Parameters:
   * - `name` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  async function openMetaDeck(name: string) {
    setLoading(true);
    const { data } = await api.get(
      `/flashcards/meta-decks/${encodeURIComponent(name)}?limit=30`,
    );
    setActiveDeck({ id: null, name: data.deck.name, cards: data.deck.cards });
    resetDeckState();
    setLoading(false);
  }

  /**
   * Implements the rate function.
   *
   * Parameters:
   * - `level` (`number`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function rate(level: number) {
    if (!activeDeck) return;
    const card = activeDeck.cards[idx];
    // Persist progress only for curated decks where the card has a real
    // Flashcard row. Meta-deck cards are clue IDs, not Flashcard IDs.
    if (card && user && activeDeck.id !== null) {
      await api
        .post("/flashcards/review", {
          flashcardId: card.id,
          knownLevel: level,
        })
        .catch(() => {});
    }
    setRatings((r) => ({
      ...r,
      hard: r.hard + (level <= 1 ? 1 : 0),
      ok: r.ok + (level === 3 ? 1 : 0),
      easy: r.easy + (level >= 5 ? 1 : 0),
    }));
    next();
  }

  /**
   * Implements the next function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function next() {
    if (!activeDeck) return;
    setFlipped(false);
    if (idx + 1 >= activeDeck.cards.length) {
      setDeckComplete(true);
      return;
    }
    setIdx(idx + 1);
  }

  if (!activeDeck) {
    if (decksError) {
      return <RetryPanel onRetry={loadDecks} message="Couldn't load the decks." />;
    }
    if (decksLoading) {
      return <p className="text-white/60 text-center py-12">Loading…</p>;
    }
    return (
      <div className="space-y-8">
        <h1 className="font-category text-4xl text-jeopardy-gold">Flashcards</h1>

        <section>
          <div className="flex items-baseline gap-3 mb-3">
            <h2 className="font-category text-2xl text-jeopardy-gold tracking-wide">
              Curated decks
            </h2>
            <span className="text-xs text-white/50">
              hand-picked sets for high-frequency Jeopardy topics
            </span>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {decks.map((d) => (
              <button
                key={d.id}
                onClick={() => openCuratedDeck(d.id)}
                className="clue-tile p-6 rounded text-left hover:scale-[1.02] transition"
              >
                <h3 className="font-category text-2xl text-jeopardy-gold">{d.name}</h3>
                {d.description && (
                  <p className="text-white/80 mt-2 text-sm">{d.description}</p>
                )}
                <p className="text-xs mt-3 text-white/60">{d.cardCount} cards</p>
              </button>
            ))}
          </div>
        </section>

        {metaDecks.length > 0 && (
          <section>
            <div className="flex items-baseline gap-3 mb-3">
              <h2 className="font-category text-2xl text-jeopardy-gold tracking-wide">
                By category
              </h2>
              <span className="text-xs text-white/50">
                drawn from the full corpus, 30 random clues per session
              </span>
            </div>
            <div className="grid md:grid-cols-3 lg:grid-cols-4 gap-3">
              {metaDecks.map((d) => (
                <button
                  key={d.name}
                  onClick={() => openMetaDeck(d.name)}
                  className="clue-tile p-4 rounded text-left hover:scale-[1.02] transition"
                >
                  <h3 className="font-category text-xl text-jeopardy-gold">
                    {d.name}
                  </h3>
                  <p className="text-xs mt-2 text-white/60">
                    {d.cardCount.toLocaleString()} clues
                  </p>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (loading || activeDeck.cards.length === 0) {
    return <p className="text-white/60 text-center py-12">Loading…</p>;
  }

  if (deckComplete) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 text-center">
        <h1 className="font-category text-4xl text-jeopardy-gold">
          Deck complete
        </h1>
        <p className="text-white/80">
          You reviewed all {activeDeck.cards.length} cards in{" "}
          <span className="text-jeopardy-gold">{activeDeck.name}</span>.
        </p>
        <div className="grid grid-cols-3 gap-3 max-w-md mx-auto">
          <div className="bg-red-700/30 rounded p-3">
            <div className="text-xs uppercase text-white/60">Hard</div>
            <div className="text-2xl font-bold mt-1">{ratings.hard}</div>
          </div>
          <div className="bg-yellow-600/30 rounded p-3">
            <div className="text-xs uppercase text-white/60">OK</div>
            <div className="text-2xl font-bold mt-1">{ratings.ok}</div>
          </div>
          <div className="bg-green-700/30 rounded p-3">
            <div className="text-xs uppercase text-white/60">Easy</div>
            <div className="text-2xl font-bold mt-1">{ratings.easy}</div>
          </div>
        </div>
        <div className="flex justify-center gap-3 flex-wrap">
          <button
            onClick={resetDeckState}
            className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded"
          >
            Run it again
          </button>
          <button
            onClick={() => setActiveDeck(null)}
            className="px-6 py-2 border border-white/30 hover:bg-white/10 rounded"
          >
            Back to decks
          </button>
        </div>
      </div>
    );
  }

  const card = activeDeck.cards[idx];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setActiveDeck(null)}
          className="text-sm text-white/60 hover:text-white"
        >
          ← back to decks
        </button>
        <h2 className="font-category text-2xl text-jeopardy-gold">
          {activeDeck.name}
        </h2>
        <span className="ml-auto text-sm text-white/60">
          {idx + 1} / {activeDeck.cards.length}
        </span>
      </div>
      <div
        onClick={() => setFlipped((f) => !f)}
        className="clue-tile p-10 rounded min-h-[260px] flex flex-col items-center justify-center cursor-pointer text-center"
      >
        {!flipped ? (
          <>
            <p className="text-2xl">{card.front}</p>
            {card.hint && (
              <p className="text-sm text-white/50 mt-4">{card.hint}</p>
            )}
            <p className="text-xs text-white/40 mt-6">click to reveal</p>
          </>
        ) : (
          <p className="text-2xl text-jeopardy-gold">{card.back}</p>
        )}
      </div>
      {flipped ? (
        <div className="grid grid-cols-3 gap-2">
          <RateButton onClick={() => rate(1)} label="Hard" color="bg-red-700/60" />
          <RateButton onClick={() => rate(3)} label="OK" color="bg-yellow-600/60" />
          <RateButton onClick={() => rate(5)} label="Easy" color="bg-green-700/60" />
        </div>
      ) : (
        <button
          onClick={() => setFlipped(true)}
          className="w-full py-3 bg-jeopardy-gold text-black font-semibold rounded"
        >
          Reveal answer
        </button>
      )}
    </div>
  );
}

/**
 * Renders the RateButton React component.
 *
 * Parameters:
 * - `{ onClick, label, color }` (`{ onClick: () => void; label: string; color: string; }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function RateButton({
  onClick,
  label,
  color,
}: {
  onClick: () => void;
  label: string;
  color: string;
}) {
  return (
    <button onClick={onClick} className={`py-3 ${color} rounded font-semibold`}>
      {label}
    </button>
  );
}
