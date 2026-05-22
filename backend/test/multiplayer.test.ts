import { describe, expect, it } from "vitest";
import { Prisma, Round } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { multiplayerService } from "../src/multiplayer/service";
import { newAgent, registerUser, authHeader } from "./helpers";

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

describe("multiplayer rooms", () => {
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

  it("enforces the 3-player cap", async () => {
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

    await agents[3]
      .post("/api/multiplayer/join")
      .set(authHeader(users[3].token))
      .send({ code: created.body.room.code })
      .expect(409);
  });

  it("only lets the host start, and rejects late joins after start", async () => {
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

    await lateAgent
      .post("/api/multiplayer/join")
      .set(authHeader(lateToken))
      .send({ code: created.body.room.code })
      .expect(409);
  });

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
});
