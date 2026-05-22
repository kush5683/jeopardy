import { describe, it, expect } from "vitest";
import { newAgent, registerUser, seedClue, authHeader } from "./helpers";

/**
 * Runs the describe "buzzer session flow" test callback.
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
describe("buzzer session flow", () => {
  /**
   * Runs the it "server recomputes totals from tagged responses, ignoring client claims" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  it("server recomputes totals from tagged responses, ignoring client claims", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const c1 = await seedClue({ answer: "Iowa", value: 400 });
    const c2 = await seedClue({ answer: "Ohio", value: 600 });
    const c3 = await seedClue({ answer: "Texas", value: 800 });

    const start = await agent
      .post("/api/buzzer/start")
      .set(authHeader(token))
      .expect(200);
    const sessionId = start.body.sessionId;
    expect(sessionId).toBeTruthy();

    // Two correct, one wrong
    await agent.post("/api/clues/submit").set(authHeader(token)).send({
      clueId: c1.clueId,
      answer: "Iowa",
      responseTimeMs: 1000,
      mode: "BUZZER",
      buzzerSessionId: sessionId,
    }).expect(200);
    await agent.post("/api/clues/submit").set(authHeader(token)).send({
      clueId: c2.clueId,
      answer: "Ohio",
      responseTimeMs: 1500,
      mode: "BUZZER",
      buzzerSessionId: sessionId,
    }).expect(200);
    await agent.post("/api/clues/submit").set(authHeader(token)).send({
      clueId: c3.clueId,
      answer: "wrong",
      responseTimeMs: 2000,
      mode: "BUZZER",
      buzzerSessionId: sessionId,
    }).expect(200);

    const finish = await agent
      .post("/api/buzzer/finish")
      .set(authHeader(token))
      .send({ sessionId })
      .expect(200);

    expect(finish.body.session.totalClues).toBe(3);
    expect(finish.body.session.correctCount).toBe(2);
    expect(finish.body.session.coryatScore).toBe(400 + 600 - 800);
    expect(finish.body.session.avgResponseMs).toBe(1500);
  });

  /**
   * Runs the it "rejects replay of same sessionId" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  it("rejects replay of same sessionId", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const c = await seedClue({ answer: "Iowa", value: 400 });
    const start = await agent.post("/api/buzzer/start").set(authHeader(token));
    const sessionId = start.body.sessionId;
    await agent.post("/api/clues/submit").set(authHeader(token)).send({
      clueId: c.clueId,
      answer: "Iowa",
      responseTimeMs: 1000,
      mode: "BUZZER",
      buzzerSessionId: sessionId,
    });
    await agent.post("/api/buzzer/finish").set(authHeader(token)).send({ sessionId }).expect(200);
    await agent.post("/api/buzzer/finish").set(authHeader(token)).send({ sessionId }).expect(409);
  });

  /**
   * Runs the it "rejects finish with no responses for the session" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  it("rejects finish with no responses for the session", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const start = await agent.post("/api/buzzer/start").set(authHeader(token));
    await agent
      .post("/api/buzzer/finish")
      .set(authHeader(token))
      .send({ sessionId: start.body.sessionId })
      .expect(400);
  });

  /**
   * Runs the it "only counts responses tagged with the matching sessionId for the current user" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  it("only counts responses tagged with the matching sessionId for the current user", async () => {
    const agent = newAgent();
    const a = await registerUser(agent);
    const b = await registerUser(agent);
    const c = await seedClue({ answer: "Iowa", value: 400 });

    const aStart = await agent.post("/api/buzzer/start").set(authHeader(a.token));
    // User B submits to user A's sessionId — should be ignored by /finish for A
    await agent.post("/api/clues/submit").set(authHeader(b.token)).send({
      clueId: c.clueId,
      answer: "Iowa",
      responseTimeMs: 1000,
      mode: "BUZZER",
      buzzerSessionId: aStart.body.sessionId,
    }).expect(200);
    // User A submits a real one
    await agent.post("/api/clues/submit").set(authHeader(a.token)).send({
      clueId: c.clueId,
      answer: "wrong",
      responseTimeMs: 1000,
      mode: "BUZZER",
      buzzerSessionId: aStart.body.sessionId,
    }).expect(200);

    const finish = await agent.post("/api/buzzer/finish").set(authHeader(a.token)).send({ sessionId: aStart.body.sessionId }).expect(200);
    // Only A's wrong answer counts
    expect(finish.body.session.totalClues).toBe(1);
    expect(finish.body.session.correctCount).toBe(0);
    expect(finish.body.session.coryatScore).toBe(-400);
  });
});
