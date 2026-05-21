import { prisma } from "./prisma";
import { fetchWikipedia } from "./wikipedia";

// Process-wide set of clue IDs currently being warmed. Prevents two requests
// firing the same Wikipedia lookup concurrently (which would race on the DB
// update and waste API budget).
const inFlight = new Set<number>();

type ClueLike = {
  id: number;
  answer: string;
  question: string;
  wikiFetchedAt: Date | null;
  category: { name: string };
};

// Fire-and-forget warming. Returns immediately; the lookup + DB update happens
// in the background. Safe to call multiple times with overlapping clue lists.
export function warmWikiCache(clues: ClueLike[]): void {
  const todo = clues.filter((c) => !c.wikiFetchedAt && !inFlight.has(c.id));
  if (todo.length === 0) return;
  for (const c of todo) inFlight.add(c.id);

  void (async () => {
    for (const c of todo) {
      try {
        // Re-check freshness: another request may have warmed this clue between
        // the caller's fetch and our turn through the queue.
        const fresh = await prisma.clue.findUnique({
          where: { id: c.id },
          select: { wikiFetchedAt: true },
        });
        if (!fresh) continue; // clue deleted (e.g. by a test) — skip
        if (fresh.wikiFetchedAt) continue;

        const { ok, transient, data } = await fetchWikipedia(c.answer, c.category.name, c.question);
        if (!ok || transient) continue;
        await prisma.clue.update({
          where: { id: c.id },
          data: {
            wikiFetchedAt: new Date(),
            wikiTitle: data?.title ?? null,
            wikiExtract: data?.extract ?? null,
            wikiUrl: data?.url ?? null,
            wikiThumb: data?.thumb ?? null,
            wikiAliases: data?.aliases ?? [],
          },
        });
      } catch {
        // Background work — never let a transient error (deleted clue, DB
        // hiccup, Wikipedia outage) crash the loop or surface to callers.
      } finally {
        inFlight.delete(c.id);
      }
    }
  })();
}
