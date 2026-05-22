import { describe, expect, it } from "vitest";
import { Prisma, Round } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { multiplayerService } from "../src/multiplayer/service";
import { newAgent, registerUser, authHeader } from "./helpers";

/**
 * Implements the seed episode board function.
 *
 * Parameters:
 * - `date` (`Date`): Date-like value converted into the canonical date or timestamp representation.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
async function seedEpisodeBoard(date = new Date("2024-01-01T00:00:00.000Z")) {
  const jeopardyValues = [200, 400, 600, 800, 1000];
  const doubleValues = [400, 800, 1200, 1600, 2000];

  for (let categoryIdx = 0; categoryIdx < 6; categoryIdx++) {
    const category = await prisma.category.create({
      data: { name: `Episode Category ${categoryIdx + 1}` },
    });
    for (const value of jeopardyValues) {
      await prisma.clue.create({
        data: {
          categoryId: category.id,
          round: Round.JEOPARDY,
          value,
          question: `J clue ${categoryIdx + 1}-${value}`,
          answer: `Answer ${categoryIdx + 1}-${value}`,
          airDate: date,
          dailyDouble: categoryIdx === 1 && value === 800,
        },
      });
    }
    for (const value of doubleValues) {
      await prisma.clue.create({
        data: {
          categoryId: category.id,
          round: Round.DOUBLE_JEOPARDY,
          value,
          question: `DJ clue ${categoryIdx + 1}-${value}`,
          answer: `Double ${categoryIdx + 1}-${value}`,
          airDate: date,
          dailyDouble:
            (categoryIdx === 2 && value === 800) ||
            (categoryIdx === 4 && value === 2000),
        },
      });
    }
  }

  const finalCategory = await prisma.category.create({
    data: { name: "Final Test Category" },
  });
  await prisma.clue.create({
    data: {
      categoryId: finalCategory.id,
      round: Round.FINAL_JEOPARDY,
      value: 0,
      question: "Final clue",
      answer: "Final answer",
      airDate: date,
    },
  });
}

/**
 * Builds started room data.
 *
 * Parameters:
 * - `playerCount` (`number`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<{ agents: TestAgent<Test>[]; users: { token: string; userId: string; email: string; cookies: string[]; }[]; room: any; }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
async function createStartedRoom(playerCount: number) {
  const agents = Array.from({ length: playerCount }, () => newAgent());
  const users = await Promise.all(
    agents.map((agent, idx) =>
      registerUser(agent, { displayName: `Player ${idx + 1}` }),
    ),
  );
  const created = await agents[0]
    .post("/api/multiplayer/rooms")
    .set(authHeader(users[0].token))
    .send({ source: "episode", date: "2024-01-01" })
    .expect(200);

  for (let idx = 1; idx < playerCount; idx++) {
    await agents[idx]
      .post("/api/multiplayer/join")
      .set(authHeader(users[idx].token))
      .send({ code: created.body.room.code })
      .expect(200);
  }

  const started = await agents[0]
    .post(`/api/multiplayer/rooms/${created.body.room.code}/start`)
    .set(authHeader(users[0].token))
    .expect(200);

  return { agents, users, room: started.body.room };
}

/**
 * Implements the force buzz open function.
 *
 * Parameters:
 * - `room` (`any`): Caller-provided value consumed by the function body.
 * - `clue` (`any`): Clue data read from API or database rows and reshaped for gameplay.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
async function forceBuzzOpen(room: any, clue: any) {
  const state = {
    ...room.state,
    phase: {
      kind: "BUZZ_OPEN",
      round: "JEOPARDY",
      clue,
      buzzClosesAt: new Date(Date.now() + 5000).toISOString(),
      buzzedUserIds: [],
      attempts: [],
    },
  };
  await prisma.multiplayerRoom.update({
    where: { code: room.code },
    data: { state: state as Prisma.InputJsonValue },
  });
}

/**
 * Implements the force final wager function.
 *
 * Parameters:
 * - `room` (`any`): Caller-provided value consumed by the function body.
 * - `userIds` (`string[]`): Identifier value used to look up, compare, or persist related records.
 * - `scores` (`Record<string, number>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
async function forceFinalWager(room: any, userIds: string[], scores: Record<string, number>) {
  const state = {
    ...room.state,
    scores,
    phase: {
      kind: "FINAL_WAGER",
      clue: room.board.finalJeopardy,
      eligibleUserIds: userIds,
      wagers: {},
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
    },
  };
  await prisma.multiplayerRoom.update({
    where: { code: room.code },
    data: {
      status: "FINAL",
      state: state as Prisma.InputJsonValue,
    },
  });
}

/**
 * Implements the force daily double wager function.
 *
 * Parameters:
 * - `room` (`any`): Caller-provided value consumed by the function body.
 * - `clue` (`any`): Clue data read from API or database rows and reshaped for gameplay.
 * - `playerUserId` (`string`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
async function forceDailyDoubleWager(room: any, clue: any, playerUserId: string) {
  const state = {
    ...room.state,
    phase: {
      kind: "DD_WAGER",
      round: "JEOPARDY",
      clue,
      playerUserId,
      maxWager: 1000,
      wagerDeadlineAt: new Date(Date.now() + 15000).toISOString(),
    },
  };
  await prisma.multiplayerRoom.update({
    where: { code: room.code },
    data: { state: state as Prisma.InputJsonValue },
  });
}

/**
 * Runs the describe "multiplayer rooms" test callback.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
describe("multiplayer rooms", () => {
  /**
   * Runs the it "creates a lobby and joins by code" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
  it("creates a lobby and joins by code", async () => {
    await seedEpisodeBoard();
    const hostAgent = newAgent();
    const guestAgent = newAgent();
    const { token: hostToken, userId: hostUserId } = await registerUser(hostAgent, {
      displayName: "Host",
    });
    const { token: guestToken, userId: guestUserId } = await registerUser(guestAgent, {
      displayName: "Guest",
    });

    const created = await hostAgent
      .post("/api/multiplayer/rooms")
      .set(authHeader(hostToken))
      .send({ source: "episode", date: "2024-01-01" })
      .expect(200);

    expect(created.body.room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(created.body.room.status).toBe("LOBBY");
    expect(created.body.room.players).toHaveLength(1);
    expect(created.body.room.hostUserId).toBe(hostUserId);

    const joined = await guestAgent
      .post("/api/multiplayer/join")
      .set(authHeader(guestToken))
      .send({ code: created.body.room.code })
      .expect(200);

    expect(joined.body.room.players).toHaveLength(2);
    expect(
      joined.body.room.players.some((player: { userId: string }) => player.userId === guestUserId),
    ).toBe(true);
  });

  /**
   * Runs the it "puts joins after the first 3 seats in the audience" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
  it("puts joins after the first 3 seats in the audience", async () => {
    await seedEpisodeBoard();
    const agents = [newAgent(), newAgent(), newAgent(), newAgent()];
    const users = await Promise.all(agents.map((agent, idx) => registerUser(agent, {
      displayName: `User ${idx + 1}`,
    })));

    const created = await agents[0]
      .post("/api/multiplayer/rooms")
      .set(authHeader(users[0].token))
      .send({ source: "episode", date: "2024-01-01" })
      .expect(200);

    await agents[1]
      .post("/api/multiplayer/join")
      .set(authHeader(users[1].token))
      .send({ code: created.body.room.code })
      .expect(200);
    await agents[2]
      .post("/api/multiplayer/join")
      .set(authHeader(users[2].token))
      .send({ code: created.body.room.code })
      .expect(200);

    const audience = await agents[3]
      .post("/api/multiplayer/join")
      .set(authHeader(users[3].token))
      .send({ code: created.body.room.code })
      .expect(200);

    const joinedAudience = audience.body.room.players.find(
      (player: { userId: string }) => player.userId === users[3].userId,
    );
    expect(joinedAudience.role).toBe("AUDIENCE");
    expect(joinedAudience.seat).toBeGreaterThan(3);
  });

  /**
   * Runs the it "only lets the host start, and puts late joins after start in the audience" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
  it("only lets the host start, and puts late joins after start in the audience", async () => {
    await seedEpisodeBoard();
    const hostAgent = newAgent();
    const guestAgent = newAgent();
    const lateAgent = newAgent();
    const { token: hostToken } = await registerUser(hostAgent, {
      displayName: "Host",
    });
    const { token: guestToken } = await registerUser(guestAgent, {
      displayName: "Guest",
    });
    const { token: lateToken } = await registerUser(lateAgent, {
      displayName: "Late",
    });

    const created = await hostAgent
      .post("/api/multiplayer/rooms")
      .set(authHeader(hostToken))
      .send({ source: "episode", date: "2024-01-01" })
      .expect(200);

    await guestAgent
      .post("/api/multiplayer/join")
      .set(authHeader(guestToken))
      .send({ code: created.body.room.code })
      .expect(200);

    await guestAgent
      .post(`/api/multiplayer/rooms/${created.body.room.code}/start`)
      .set(authHeader(guestToken))
      .expect(403);

    const started = await hostAgent
      .post(`/api/multiplayer/rooms/${created.body.room.code}/start`)
      .set(authHeader(hostToken))
      .expect(200);

    expect(started.body.room.status).toBe("LIVE");
    expect(started.body.room.state.phase.kind).toBe("BOARD");
    expect(started.body.room.state.phase.round).toBe("JEOPARDY");

    const lateJoin = await lateAgent
      .post("/api/multiplayer/join")
      .set(authHeader(lateToken))
      .send({ code: created.body.room.code })
      .expect(200);

    const lateMember = lateJoin.body.room.players.find(
      (player: { displayName: string }) => player.displayName === "Late",
    );
    expect(lateMember.role).toBe("AUDIENCE");
  });

  /**
   * Runs the it "reopens buzzing after wrong answers and reveals the answer only after everyone misses" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  it("reopens buzzing after wrong answers and reveals the answer only after everyone misses", async () => {
    await seedEpisodeBoard();
    const { users, room } = await createStartedRoom(3);
    const clue = room.board.jeopardy.categories[0].cells[0];
    await forceBuzzOpen(room, clue);

    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "buzz",
    });
    const afterFirstWrong = await multiplayerService.handleAction(
      room.code,
      users[0].userId,
      { type: "submit-answer", answer: "wrong" },
    );

    expect(afterFirstWrong.state.phase.kind).toBe("BUZZ_OPEN");
    if (afterFirstWrong.state.phase.kind !== "BUZZ_OPEN") {
      throw new Error("expected buzz to reopen");
    }
    expect(afterFirstWrong.state.phase.buzzedUserIds).toEqual([
      users[0].userId,
    ]);
    expect(afterFirstWrong.state.phase.attempts).toHaveLength(1);
    expect(JSON.stringify(afterFirstWrong.state.phase)).not.toContain(
      "Answer 1-200",
    );

    await expect(
      multiplayerService.handleAction(room.code, users[0].userId, {
        type: "buzz",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await multiplayerService.handleAction(room.code, users[1].userId, {
      type: "buzz",
    });
    const afterSecondWrong = await multiplayerService.handleAction(
      room.code,
      users[1].userId,
      { type: "submit-answer", answer: "also wrong" },
    );

    expect(afterSecondWrong.state.phase.kind).toBe("BUZZ_OPEN");
    if (afterSecondWrong.state.phase.kind !== "BUZZ_OPEN") {
      throw new Error("expected second wrong answer to reopen buzz");
    }
    expect(afterSecondWrong.state.phase.buzzedUserIds).toEqual([
      users[0].userId,
      users[1].userId,
    ]);
    expect(JSON.stringify(afterSecondWrong.state.phase)).not.toContain(
      "Answer 1-200",
    );

    await multiplayerService.handleAction(room.code, users[2].userId, {
      type: "buzz",
    });
    const finalResult = await multiplayerService.handleAction(
      room.code,
      users[2].userId,
      { type: "submit-answer", answer: "still wrong" },
    );

    expect(finalResult.state.phase.kind).toBe("RESULT");
    if (finalResult.state.phase.kind !== "RESULT") {
      throw new Error("expected clue to end after every player missed");
    }
    expect(finalResult.state.phase.result.correct).toBe(false);
    expect(finalResult.state.phase.result.canonicalAnswer).toBe("Answer 1-200");
    expect(finalResult.state.phase.result.attempts).toHaveLength(3);
    expect(finalResult.state.playedClueIds).toContain(clue.id);
    expect(finalResult.state.scores[users[0].userId]).toBe(-200);
    expect(finalResult.state.scores[users[1].userId]).toBe(-200);
    expect(finalResult.state.scores[users[2].userId]).toBe(-200);
  });

  /**
   * Runs the it "passes a clue when a reopened buzz timer expires" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  it("passes a clue when a reopened buzz timer expires", async () => {
    await seedEpisodeBoard();
    const { users, room } = await createStartedRoom(2);
    const clue = room.board.jeopardy.categories[0].cells[0];
    await forceBuzzOpen(room, clue);

    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "buzz",
    });
    const afterWrong = await multiplayerService.handleAction(
      room.code,
      users[0].userId,
      { type: "submit-answer", answer: "wrong" },
    );
    expect(afterWrong.state.phase.kind).toBe("BUZZ_OPEN");
    if (afterWrong.state.phase.kind !== "BUZZ_OPEN") {
      throw new Error("expected buzz to reopen");
    }

    const expiredState = {
      ...afterWrong.state,
      phase: {
        ...afterWrong.state.phase,
        buzzClosesAt: new Date(Date.now() - 1).toISOString(),
      },
    };
    const roomRecord = await prisma.multiplayerRoom.update({
      where: { code: room.code },
      data: { state: expiredState as Prisma.InputJsonValue },
      select: { id: true },
    });

    await (multiplayerService as any).handleTimer(room.code, roomRecord.id);
    const snapshot = await multiplayerService.getRoom(room.code, users[0].userId);

    expect(snapshot.state.phase.kind).toBe("RESULT");
    if (snapshot.state.phase.kind !== "RESULT") {
      throw new Error("expected clue to pass after buzz timer expiry");
    }
    expect(snapshot.state.phase.result.noBuzz).toBe(true);
    expect(snapshot.state.phase.result.canonicalAnswer).toBe("Answer 1-200");
    expect(snapshot.state.phase.result.attempts).toHaveLength(1);
    expect(snapshot.state.playedClueIds).toContain(clue.id);
  });

  /**
   * Runs the it "lets the buzzed player advance a revealed result after the read delay" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  it("lets the buzzed player advance a revealed result after the read delay", async () => {
    await seedEpisodeBoard();
    const { users, room } = await createStartedRoom(2);
    const clue = room.board.jeopardy.categories[0].cells[0];
    await forceBuzzOpen(room, clue);

    await multiplayerService.handleAction(room.code, users[1].userId, {
      type: "buzz",
    });
    const result = await multiplayerService.handleAction(
      room.code,
      users[1].userId,
      { type: "submit-answer", answer: "Answer 1-200" },
    );

    expect(result.state.phase.kind).toBe("RESULT");
    if (result.state.phase.kind !== "RESULT") {
      throw new Error("expected clue result");
    }
    expect(result.state.phase.result.correct).toBe(true);
    expect(result.state.phase.result.answeredByUserId).toBe(users[1].userId);
    expect(result.state.phase.resultBeganAt).toEqual(expect.any(String));
    expect(result.state.phase.advanceUnlocksAt).toEqual(expect.any(String));

    await expect(
      multiplayerService.handleAction(room.code, users[1].userId, {
        type: "advance",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      multiplayerService.handleAction(room.code, users[0].userId, {
        type: "advance",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const unlockedState = {
      ...result.state,
      phase: {
        ...result.state.phase,
        advanceUnlocksAt: new Date(Date.now() - 1).toISOString(),
      },
    };
    await prisma.multiplayerRoom.update({
      where: { code: room.code },
      data: { state: unlockedState as Prisma.InputJsonValue },
    });

    const advanced = await multiplayerService.handleAction(
      room.code,
      users[1].userId,
      { type: "advance" },
    );
    expect(advanced.state.phase.kind).toBe("BOARD");
    if (advanced.state.phase.kind !== "BOARD") {
      throw new Error("expected board after result advance");
    }
    expect(advanced.state.selectorUserId).toBe(users[1].userId);
  });

  /**
   * Runs the it "shows regular answer drafts only to the audience" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  it("shows regular answer drafts only to the audience", async () => {
    await seedEpisodeBoard();
    const { users, room } = await createStartedRoom(3);
    const audienceAgent = newAgent();
    const audience = await registerUser(audienceAgent, { displayName: "Audience" });
    await audienceAgent
      .post("/api/multiplayer/join")
      .set(authHeader(audience.token))
      .send({ code: room.code })
      .expect(200);

    const clue = room.board.jeopardy.categories[0].cells[0];
    await forceBuzzOpen(room, clue);
    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "buzz",
    });
    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "update-draft",
      value: "typing live",
    });

    const playerView = await multiplayerService.getRoom(room.code, users[1].userId);
    const audienceView = await multiplayerService.getRoom(room.code, audience.userId);
    expect(playerView.state.phase.kind).toBe("ANSWERING");
    expect(audienceView.state.phase.kind).toBe("ANSWERING");
    if (
      playerView.state.phase.kind !== "ANSWERING" ||
      audienceView.state.phase.kind !== "ANSWERING"
    ) {
      throw new Error("expected answering phase");
    }
    expect(playerView.state.phase.answerDraft).toBe("");
    expect(audienceView.state.phase.answerDraft).toBe("typing live");

    await expect(
      multiplayerService.handleAction(room.code, audience.userId, { type: "buzz" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  /**
   * Runs the it "shows Daily Double wager drafts to players and audience" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  it("shows Daily Double wager drafts to players and audience", async () => {
    await seedEpisodeBoard();
    const { users, room } = await createStartedRoom(3);
    const audienceAgent = newAgent();
    const audience = await registerUser(audienceAgent, { displayName: "Audience" });
    await audienceAgent
      .post("/api/multiplayer/join")
      .set(authHeader(audience.token))
      .send({ code: room.code })
      .expect(200);

    const dailyDouble = room.board.jeopardy.categories[1].cells[3];
    await forceDailyDoubleWager(room, dailyDouble, users[0].userId);
    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "update-draft",
      value: "1234",
    });

    const otherPlayerView = await multiplayerService.getRoom(room.code, users[1].userId);
    const audienceView = await multiplayerService.getRoom(room.code, audience.userId);
    expect(otherPlayerView.state.phase.kind).toBe("DD_WAGER");
    expect(audienceView.state.phase.kind).toBe("DD_WAGER");
    if (
      otherPlayerView.state.phase.kind !== "DD_WAGER" ||
      audienceView.state.phase.kind !== "DD_WAGER"
    ) {
      throw new Error("expected Daily Double wager phase");
    }
    expect(otherPlayerView.state.phase.wagerDraft).toBe("1234");
    expect(audienceView.state.phase.wagerDraft).toBe("1234");
  });

  /**
   * Runs the it "keeps Final wagers and answers private until the reveal" test callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  it("keeps Final wagers and answers private until the reveal", async () => {
    await seedEpisodeBoard();
    const { users, room } = await createStartedRoom(3);
    const audienceAgent = newAgent();
    const audience = await registerUser(audienceAgent, { displayName: "Audience" });
    await audienceAgent
      .post("/api/multiplayer/join")
      .set(authHeader(audience.token))
      .send({ code: room.code })
      .expect(200);

    const scores = {
      [users[0].userId]: 1000,
      [users[1].userId]: 2000,
      [users[2].userId]: 3000,
    };
    await forceFinalWager(
      room,
      users.map((user) => user.userId),
      scores,
    );

    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "submit-wager",
      wager: 100,
    });
    const firstPlayerWagerView = await multiplayerService.getRoom(
      room.code,
      users[0].userId,
    );
    const secondPlayerWagerView = await multiplayerService.getRoom(
      room.code,
      users[1].userId,
    );
    const audienceWagerView = await multiplayerService.getRoom(room.code, audience.userId);
    if (
      firstPlayerWagerView.state.phase.kind !== "FINAL_WAGER" ||
      secondPlayerWagerView.state.phase.kind !== "FINAL_WAGER" ||
      audienceWagerView.state.phase.kind !== "FINAL_WAGER"
    ) {
      throw new Error("expected final wager phase");
    }
    expect(firstPlayerWagerView.state.phase.wagers).toEqual({
      [users[0].userId]: 100,
    });
    expect(secondPlayerWagerView.state.phase.wagers).toEqual({});
    expect(audienceWagerView.state.phase.wagers).toEqual({});
    expect(audienceWagerView.state.phase.submittedCount).toBe(1);

    await multiplayerService.handleAction(room.code, users[1].userId, {
      type: "submit-wager",
      wager: 200,
    });
    await multiplayerService.handleAction(room.code, users[2].userId, {
      type: "submit-wager",
      wager: 300,
    });
    await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "submit-answer",
      answer: "Final answer",
    });

    const firstPlayerAnswerView = await multiplayerService.getRoom(
      room.code,
      users[0].userId,
    );
    const secondPlayerAnswerView = await multiplayerService.getRoom(
      room.code,
      users[1].userId,
    );
    const audienceAnswerView = await multiplayerService.getRoom(room.code, audience.userId);
    if (
      firstPlayerAnswerView.state.phase.kind !== "FINAL_ANSWER" ||
      secondPlayerAnswerView.state.phase.kind !== "FINAL_ANSWER" ||
      audienceAnswerView.state.phase.kind !== "FINAL_ANSWER"
    ) {
      throw new Error("expected final answer phase");
    }
    expect(firstPlayerAnswerView.state.phase.answers).toEqual({
      [users[0].userId]: "Final answer",
    });
    expect(secondPlayerAnswerView.state.phase.answers).toEqual({});
    expect(audienceAnswerView.state.phase.answers).toEqual({});
    expect(secondPlayerAnswerView.state.phase.wagers).toEqual({
      [users[1].userId]: 200,
    });

    await multiplayerService.handleAction(room.code, users[1].userId, {
      type: "submit-answer",
      answer: "wrong",
    });
    const revealStart = await multiplayerService.handleAction(room.code, users[2].userId, {
      type: "submit-answer",
      answer: "wrong",
    });
    expect(revealStart.state.phase.kind).toBe("FINAL_REVEAL");
    if (revealStart.state.phase.kind !== "FINAL_REVEAL") {
      throw new Error("expected final reveal phase");
    }
    expect(revealStart.state.scores[users[0].userId]).toBe(1000);
    expect(revealStart.state.phase.results).toHaveLength(1);
    expect(revealStart.state.phase.results[0].userId).toBe(users[0].userId);
    expect(revealStart.state.phase.results[0].submittedAnswer).toBe("Final answer");
    expect(revealStart.state.phase.results[0].wager).toBe(0);
    expect(revealStart.state.phase.results[0].wagerRevealed).toBe(false);

    const wagerReveal = await multiplayerService.handleAction(room.code, users[0].userId, {
      type: "advance",
    });
    expect(wagerReveal.state.phase.kind).toBe("FINAL_REVEAL");
    if (wagerReveal.state.phase.kind !== "FINAL_REVEAL") {
      throw new Error("expected final reveal wager step");
    }
    expect(wagerReveal.state.scores[users[0].userId]).toBe(1100);
    expect(wagerReveal.state.phase.results[0].wager).toBe(100);
    expect(wagerReveal.state.phase.results[0].wagerRevealed).toBe(true);
  });
});
