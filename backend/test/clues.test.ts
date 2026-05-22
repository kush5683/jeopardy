import { describe, it, expect } from "vitest";
import { newAgent, registerUser, seedClue, authHeader } from "./helpers";

/**
 * Builds shared episode data.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `{ jeopardy: { values: number[]; categories: { name: string; cells: { id: number; question: string; value: number; round: "JEOPARDY" | "DOUBLE_JEOPARDY"; cate...`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function buildSharedEpisode() {
  let nextId = 1;
  /**
   * Builds round data.
   *
   * Parameters:
   * - `label` (`string`): Caller-provided value consumed by the function body.
   * - `round` (`"JEOPARDY" | "DOUBLE_JEOPARDY"`): Caller-provided value consumed by the function body.
   * - `values` (`number[]`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `{ values: number[]; categories: { name: string; cells: { id: number; question: string; value: number; round: "JEOPARDY" | "DOUBLE_JEOPARDY"; category: string...`: Collection value reshaped from the input data.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
  function makeRound(
    label: string,
    round: "JEOPARDY" | "DOUBLE_JEOPARDY",
    values: number[],
  ) {
    return {
      values,
      categories: Array.from({ length: 6 }, (_, catIdx) => ({
        name: `${label} Category ${catIdx + 1}`,
        cells: values.map((value, valueIdx) => ({
          id: nextId++,
          question: `${label} clue ${catIdx + 1}-${valueIdx + 1}`,
          value,
          round,
          category: `${label} Category ${catIdx + 1}`,
          dailyDouble:
            (round === "JEOPARDY" && catIdx === 1 && valueIdx === 3) ||
            (round === "DOUBLE_JEOPARDY" &&
              ((catIdx === 2 && valueIdx === 1) ||
                (catIdx === 4 && valueIdx === 4))),
        })),
      })),
    };
  }

  return {
    jeopardy: makeRound("Jeopardy", "JEOPARDY", [200, 400, 600, 800, 1000]),
    doubleJeopardy: makeRound("Double", "DOUBLE_JEOPARDY", [
      400,
      800,
      1200,
      1600,
      2000,
    ]),
    finalJeopardy: {
      id: nextId++,
      question: "Final board share clue",
      value: 0,
      round: "FINAL_JEOPARDY" as const,
      category: "Final Category",
      dailyDouble: false,
    },
  };
}

/**
 * Runs the describe "clues/submit + mark-correct/incorrect" test callback.
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
describe("clues/submit + mark-correct/incorrect", () => {
  /**
   * Runs the it "scores a correct answer with positive valueDelta" test callback.
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

  /**
   * Runs the it "scores an incorrect answer with negative valueDelta + enrolls in review" test callback.
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

  /**
   * Runs the it "mark-correct flips the score and removes the review schedule" test callback.
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

  /**
   * Runs the it "applies wager on a Daily Double" test callback.
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

  /**
   * Runs the it "allows wager in BOARD mode even on a non-DD clue (mixed-game DDs aren't in the DB)" test callback.
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

  /**
   * Runs the it "rejects wager on a non-DD clue in non-FINAL mode" test callback.
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

  /**
   * Runs the it "404s on missing clue" test callback.
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
  it("404s on missing clue", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    await agent
      .post("/api/clues/submit")
      .set(authHeader(token))
      .send({ clueId: 999999, answer: "x", responseTimeMs: 100, mode: "PRACTICE" })
      .expect(404);
  });

  /**
   * Runs the it "requires auth on submit" test callback.
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
  it("requires auth on submit", async () => {
    const agent = newAgent();
    const { clueId } = await seedClue({ answer: "Iowa" });
    await agent
      .post("/api/clues/submit")
      .send({ clueId, answer: "Iowa", responseTimeMs: 100, mode: "PRACTICE" })
      .expect(401);
  });
});

/**
 * Runs the describe "board share codes" test callback.
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
describe("board share codes", () => {
  /**
   * Runs the it "creates and resolves a shared board" test callback.
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
  it("creates and resolves a shared board", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    const episode = buildSharedEpisode();

    const created = await agent
      .post("/api/clues/board-share")
      .set(authHeader(token))
      .send({ episode })
      .expect(200);

    expect(created.body.code).toMatch(/^[A-Z2-9]{8}$/);

    const resolved = await agent
      .get(`/api/clues/board-share/${created.body.code}`)
      .expect(200);
    expect(resolved.body.episode).toEqual(episode);
  });

  /**
   * Runs the it "requires auth to create a shared board" test callback.
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
  it("requires auth to create a shared board", async () => {
    const agent = newAgent();
    await agent
      .post("/api/clues/board-share")
      .send({ episode: buildSharedEpisode() })
      .expect(401);
  });

  /**
   * Runs the it "404s on an unknown share code" test callback.
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
  it("404s on an unknown share code", async () => {
    const agent = newAgent();
    await agent.get("/api/clues/board-share/ABCD-EFGH").expect(404);
  });
});
