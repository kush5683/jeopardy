import { describe, it, expect } from "vitest";
import { newAgent, registerUser, seedClue, authHeader } from "./helpers";

describe("clues/submit + mark-correct/incorrect", () => {
  it("scores a correct answer with positive valueDelta", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const { clueId, value } = await seedClue({
      answer: "Iowa",
      value: 600,
    });
    const res = await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({
        clueId,
        answer: "Iowa",
        responseTimeMs: 1234,
        mode: "PRACTICE",
      })
      .expect(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.valueDelta).toBe(value);
    expect(res.body.canonicalAnswer).toBe("Iowa");
    expect(res.body.responseId).toBeTruthy();
  });

  it("scores an incorrect answer with negative valueDelta + enrolls in review", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const { clueId } = await seedClue({ answer: "Iowa", value: 400 });
    const res = await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({ clueId, answer: "wrong", responseTimeMs: 500, mode: "PRACTICE" })
      .expect(200);
    expect(res.body.correct).toBe(false);
    expect(res.body.valueDelta).toBe(-400);

    // Wrong submission should schedule a review
    const due = await agent
      .get("/api/review/stats")
      .set(authHeader(token))
      .expect(200);
    expect(due.body.total).toBe(1);
  });

  it("mark-correct flips the score and removes the review schedule", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const { clueId } = await seedClue({ answer: "Iowa", value: 400 });
    const submit = await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({ clueId, answer: "wrong", responseTimeMs: 500, mode: "PRACTICE" })
      .expect(200);
    expect(submit.body.correct).toBe(false);

    const mark = await agent
      .post(`/api/clues/mark-correct/${submit.body.responseId}`)
      .set(authHeader(token))
      .expect(200);
    expect(mark.body.valueDelta).toBe(400);

    const stats = await agent.get("/api/review/stats").set(authHeader(token));
    expect(stats.body.total).toBe(0);
  });

  it("applies wager on a Daily Double", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const { clueId } = await seedClue({ answer: "Iowa", value: 400, dailyDouble: true });
    const res = await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({
        clueId,
        answer: "Iowa",
        responseTimeMs: 1000,
        mode: "BOARD",
        wager: 1500,
      })
      .expect(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.valueDelta).toBe(1500);
  });

  it("allows wager in BOARD mode even on a non-DD clue (mixed-game DDs aren't in the DB)", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const { clueId } = await seedClue({ answer: "Iowa", value: 400, dailyDouble: false });
    const res = await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({
        clueId,
        answer: "Iowa",
        responseTimeMs: 1000,
        mode: "BOARD",
        wager: 1200,
      })
      .expect(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.valueDelta).toBe(1200);
  });

  it("rejects wager on a non-DD clue in non-FINAL mode", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const { clueId } = await seedClue({ answer: "Iowa", value: 400 });
    await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({
        clueId,
        answer: "Iowa",
        responseTimeMs: 1000,
        mode: "PRACTICE",
        wager: 99999,
      })
      .expect(400);
  });

  it("404s on missing clue", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({ clueId: 999999, answer: "x", responseTimeMs: 100, mode: "PRACTICE" })
      .expect(404);
  });

  it("requires auth on submit", async () => {
    const agent = newAgent();
    const { clueId } = await seedClue({ answer: "Iowa" });
    await agent
      .post("/api/clues/submit")
      .send({ clueId, answer: "Iowa", responseTimeMs: 100, mode: "PRACTICE" })
      .expect(401);
  });
});
