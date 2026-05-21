import { describe, it, expect } from "vitest";
import { newAgent, registerUser, seedClue, authHeader } from "./helpers";

describe("daily/finish server-side recompute", () => {
  it("ignores client body and recomputes from ClueResponse rows", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    // Seed enough clues that /daily/today returns a usable set.
    for (let i = 0; i < 60; i++) {
      await seedClue({ answer: `Answer-${i}`, value: 200 });
    }
    // Discover which clues are today's daily set
    const today = await agent.get("/api/daily/today").expect(200);
    const dailyClues = today.body.clues as Array<{ id: number; value: number }>;
    expect(dailyClues.length).toBeGreaterThan(0);

    // Pull canonical answers from the DB (the /today response intentionally
    // doesn't include them).
    const half = Math.floor(dailyClues.length / 2);
    const { prisma } = await import("../src/lib/prisma");
    const fullClues = await prisma.clue.findMany({
      where: { id: { in: dailyClues.map((c) => c.id) } },
      select: { id: true, answer: true, value: true },
    });
    const byId = new Map(fullClues.map((c) => [c.id, c]));

    let expectedCorrect = 0;
    let expectedScore = 0;
    for (let i = 0; i < dailyClues.length; i++) {
      const c = byId.get(dailyClues[i].id)!;
      const shouldGetCorrect = i < half;
      await agent.post("/api/clues/submit").set(authHeader(token)).send({
        clueId: c.id,
        answer: shouldGetCorrect ? c.answer : "definitely-wrong-xyz",
        responseTimeMs: 1000,
        mode: "DAILY",
      }).expect(200);
      if (shouldGetCorrect) {
        expectedCorrect += 1;
        expectedScore += c.value;
      } else {
        expectedScore -= c.value;
      }
    }

    // Client lies about score — server should ignore.
    const finish = await agent
      .post("/api/daily/finish")
      .set(authHeader(token))
      .send({ score: 999999, totalCorrect: 9999, totalClues: 1 })
      .expect(200);

    expect(finish.body.attempt.score).toBe(expectedScore);
    expect(finish.body.attempt.totalCorrect).toBe(expectedCorrect);
    expect(finish.body.attempt.totalClues).toBe(dailyClues.length);
  });

  it("only counts DAILY-mode responses for today's daily clue set", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    for (let i = 0; i < 60; i++) await seedClue({ answer: `A-${i}` });
    const today = await agent.get("/api/daily/today");
    const dailyIds = (today.body.clues as Array<{ id: number }>).map((c) => c.id);
    const { prisma } = await import("../src/lib/prisma");

    // Submit a correct answer in PRACTICE mode — should not contribute
    const c = await prisma.clue.findUnique({ where: { id: dailyIds[0] } });
    await agent.post("/api/clues/submit").set(authHeader(token)).send({
      clueId: c!.id,
      answer: c!.answer,
      responseTimeMs: 1000,
      mode: "PRACTICE",
    }).expect(200);

    const finish = await agent.post("/api/daily/finish").set(authHeader(token)).send({}).expect(200);
    expect(finish.body.attempt.score).toBe(0);
    expect(finish.body.attempt.totalCorrect).toBe(0);
  });

  it("tracks progress and finish by requested daily date", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    for (let i = 0; i < 60; i++) {
      await seedClue({ answer: `Past-${i}`, value: 200 });
    }
    const date = "2024-01-01";
    const daily = await agent
      .get(`/api/daily/today?date=${date}`)
      .expect(200);
    const first = daily.body.clues[0] as { id: number; value: number };

    const { prisma } = await import("../src/lib/prisma");
    const clue = await prisma.clue.findUnique({ where: { id: first.id } });
    expect(clue).toBeTruthy();

    await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({
        clueId: first.id,
        answer: clue!.answer,
        responseTimeMs: 1000,
        mode: "DAILY",
        dailyDate: date,
      })
      .expect(200);

    const progress = await agent
      .get(`/api/daily/me?date=${date}`)
      .set(authHeader(token))
      .expect(200);
    expect(progress.body.progress.idx).toBe(1);
    expect(progress.body.progress.score).toBe(first.value);

    const finished = await agent
      .post("/api/daily/finish")
      .set(authHeader(token))
      .send({ date })
      .expect(200);
    expect(finished.body.attempt.score).toBe(first.value);
    expect(finished.body.attempt.totalCorrect).toBe(1);
    expect(finished.body.attempt.date).toContain(date);
  });
});
