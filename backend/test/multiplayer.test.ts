import { describe, expect, it } from "vitest";
import { Round } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
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
});
