import crypto from "crypto";
import type { Server as HttpServer } from "http";
import { Prisma } from "@prisma/client";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  SharedCell,
  SharedEpisode,
  sharedEpisodeSchema,
  getEpisodeBoard,
  getMixedBoard,
} from "../lib/boardPayload";
import { submitClueAnswer } from "../lib/clueSubmit";
import { readAuthTokenFromHeaders, verifyAuthToken } from "../middleware/auth";

type RoundKind = "JEOPARDY" | "DOUBLE_JEOPARDY";
type PauseState = {
  reason: "HOST_DISCONNECTED";
  remainingMs: number | null;
} | null;

type RoomPhase =
  | { kind: "LOBBY" }
  | { kind: "BOARD"; round: RoundKind }
  | { kind: "READING"; round: RoundKind; clue: SharedCell; readEndsAt: string }
  | {
      kind: "BUZZ_OPEN";
      round: RoundKind;
      clue: SharedCell;
      buzzClosesAt: string;
    }
  | {
      kind: "DD_WAGER";
      round: RoundKind;
      clue: SharedCell;
      playerUserId: string;
      maxWager: number;
      wagerDeadlineAt: string;
    }
  | {
      kind: "ANSWERING";
      round: RoundKind;
      clue: SharedCell;
      answeringUserId: string;
      answerBeganAt: string;
      answerDeadlineAt: string;
      wager: number | null;
      dailyDouble: boolean;
    }
  | {
      kind: "RESULT";
      round: RoundKind;
      clue: SharedCell;
      result: {
        answeredByUserId: string | null;
        submittedAnswer: string;
        correct: boolean;
        canonicalAnswer: string;
        valueDelta: number;
        llmVerdict: boolean | null;
        timedOut: boolean;
        noBuzz: boolean;
      };
    }
  | {
      kind: "FINAL_WAGER";
      clue: SharedCell;
      eligibleUserIds: string[];
      wagers: Record<string, number>;
      startedAt: string;
      deadlineAt: string;
    }
  | {
      kind: "FINAL_ANSWER";
      clue: SharedCell;
      eligibleUserIds: string[];
      wagers: Record<string, number>;
      answers: Record<string, string>;
      startedAt: string;
      deadlineAt: string;
    }
  | {
      kind: "COMPLETE";
      finalResults: Array<{
        userId: string;
        submittedAnswer: string;
        correct: boolean;
        canonicalAnswer: string;
        valueDelta: number;
        wager: number;
        llmVerdict: boolean | null;
      }> | null;
      reason: string | null;
    }
  | { kind: "ABANDONED"; reason: string };

type RoomState = {
  version: 1;
  playedClueIds: number[];
  scores: Record<string, number>;
  selectorUserId: string | null;
  phase: RoomPhase;
  paused: PauseState;
  hostReconnectDeadlineAt: string | null;
};

type Action =
  | { type: "select-clue"; clueId: number }
  | { type: "buzz" }
  | { type: "submit-answer"; answer: string }
  | { type: "submit-wager"; wager: number }
  | { type: "advance" };

type Runtime = {
  clients: Map<string, Set<WebSocket>>;
  mainTimer: NodeJS.Timeout | null;
  hostGraceTimer: NodeJS.Timeout | null;
};

type RoomStatus = "LOBBY" | "LIVE" | "FINAL" | "COMPLETE" | "ABANDONED";

type RoomWithPlayers = {
  id: string;
  code: string;
  hostUserId: string;
  status: RoomStatus;
  boardPayload: Prisma.JsonValue;
  state: Prisma.JsonValue;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  players: Array<{
    id: string;
    roomId: string;
    userId: string;
    seat: number;
    joinedAt: Date;
    leftAt: Date | null;
    user: {
      id: string;
      displayName: string;
    };
  }>;
};

export type PublicRoomState = {
  code: string;
  status: RoomStatus;
  hostUserId: string;
  board: SharedEpisode;
  state: RoomState;
  players: Array<{
    userId: string;
    displayName: string;
    seat: number;
    isHost: boolean;
    connected: boolean;
    left: boolean;
    score: number;
  }>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

const roomInclude = {
  players: {
    include: {
      user: { select: { id: true, displayName: true } },
    },
  },
} satisfies Prisma.MultiplayerRoomInclude;

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LEN = 6;
const MAX_PLAYERS = 3;
const MIN_DD_WAGER = 5;
const READING_RATE_MS_PER_WORD = 280;
const MIN_READING_MS = 1500;
const BUZZ_WINDOW_MS = 5000;
const ANSWER_WINDOW_MS = 5000;
const DD_WAGER_WINDOW_MS = 15000;
const DD_ANSWER_WINDOW_MS = 15000;
const FINAL_WAGER_WINDOW_MS = 30000;
const FINAL_ANSWER_WINDOW_MS = 30000;
const HOST_RECONNECT_GRACE_MS = 120000;

export const createRoomSchema = z.object({
  source: z.enum(["episode", "mixed"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const joinRoomSchema = z.object({
  code: z.string().min(1).max(32),
});

export const multiplayerActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select-clue"),
    clueId: z.number().int().positive(),
  }),
  z.object({ type: z.literal("buzz") }),
  z.object({ type: z.literal("submit-answer"), answer: z.string().max(400) }),
  z.object({
    type: z.literal("submit-wager"),
    wager: z.number().int().min(0).max(50000),
  }),
  z.object({ type: z.literal("advance") }),
]);

function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newRoomCode(): string {
  const bytes = crypto.randomBytes(ROOM_CODE_LEN);
  let out = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

function buildInitialState(
  playerIds: string[],
  selectorUserId: string | null = null,
): RoomState {
  return {
    version: 1,
    playedClueIds: [],
    scores: Object.fromEntries(playerIds.map((id) => [id, 0])),
    selectorUserId,
    phase: { kind: "LOBBY" },
    paused: null,
    hostReconnectDeadlineAt: null,
  };
}

function activePlayers(room: RoomWithPlayers) {
  return room.players
    .filter((player) => !player.leftAt)
    .sort((a, b) => a.seat - b.seat);
}

function phaseDeadlineAt(phase: RoomPhase): string | null {
  switch (phase.kind) {
    case "READING":
      return phase.readEndsAt;
    case "BUZZ_OPEN":
      return phase.buzzClosesAt;
    case "DD_WAGER":
      return phase.wagerDeadlineAt;
    case "ANSWERING":
      return phase.answerDeadlineAt;
    case "FINAL_WAGER":
    case "FINAL_ANSWER":
      return phase.deadlineAt;
    default:
      return null;
  }
}

function withPhaseDeadline(phase: RoomPhase, deadlineAt: string): RoomPhase {
  switch (phase.kind) {
    case "READING":
      return { ...phase, readEndsAt: deadlineAt };
    case "BUZZ_OPEN":
      return { ...phase, buzzClosesAt: deadlineAt };
    case "DD_WAGER":
      return { ...phase, wagerDeadlineAt: deadlineAt };
    case "ANSWERING":
      return { ...phase, answerDeadlineAt: deadlineAt };
    case "FINAL_WAGER":
      return { ...phase, deadlineAt };
    case "FINAL_ANSWER":
      return { ...phase, deadlineAt };
    default:
      return phase;
  }
}

function getRoomState(room: RoomWithPlayers): RoomState {
  const raw = room.state;
  const fallback = buildInitialState(
    activePlayers(room).map((player) => player.userId),
    room.hostUserId,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }
  const state = raw as RoomState;
  if (state.version !== 1 || !state.phase) {
    return fallback;
  }
  const next = {
    ...state,
    scores: { ...(state.scores ?? {}) },
  };
  for (const player of room.players) {
    if (!(player.userId in next.scores)) {
      next.scores[player.userId] = 0;
    }
  }
  return next;
}

function getBoardPayload(room: RoomWithPlayers): SharedEpisode {
  const parsed = sharedEpisodeSchema.safeParse(room.boardPayload);
  if (!parsed.success) {
    throw new Error("room board payload invalid");
  }
  return parsed.data;
}

function boardForRound(board: SharedEpisode, round: RoundKind) {
  return round === "JEOPARDY" ? board.jeopardy : board.doubleJeopardy;
}

function findBoardCell(board: SharedEpisode, clueId: number): {
  round: RoundKind;
  clue: SharedCell;
} | null {
  for (const round of ["JEOPARDY", "DOUBLE_JEOPARDY"] as const) {
    for (const category of boardForRound(board, round).categories) {
      for (const cell of category.cells) {
        if (cell?.id === clueId) {
          return { round, clue: cell };
        }
      }
    }
  }
  return null;
}

function roundHasUnplayed(
  board: SharedEpisode,
  round: RoundKind,
  playedClueIds: number[],
): boolean {
  const played = new Set(playedClueIds);
  for (const category of boardForRound(board, round).categories) {
    for (const cell of category.cells) {
      if (cell && !played.has(cell.id)) return true;
    }
  }
  return false;
}

function nextSelectorUserId(
  room: RoomWithPlayers,
  selectorUserId: string | null,
): string | null {
  const active = activePlayers(room);
  if (selectorUserId && active.some((player) => player.userId === selectorUserId)) {
    return selectorUserId;
  }
  const host = active.find((player) => player.userId === room.hostUserId);
  return host?.userId ?? active[0]?.userId ?? null;
}

function readDurationMs(question: string): number {
  const wordCount = question.split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_READING_MS, wordCount * READING_RATE_MS_PER_WORD);
}

function maxDailyDoubleWager(round: RoundKind, score: number): number {
  return Math.max(score, round === "JEOPARDY" ? 1000 : 2000);
}

function parseOriginHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function serializeRoom(
  room: RoomWithPlayers,
  state: RoomState,
  board: SharedEpisode,
  runtime: Runtime | undefined,
): PublicRoomState {
  return {
    code: room.code,
    status: room.status,
    hostUserId: room.hostUserId,
    board,
    state,
    players: room.players
      .sort((a, b) => a.seat - b.seat)
      .map((player) => ({
        userId: player.userId,
        displayName: player.user.displayName,
        seat: player.seat,
        isHost: player.userId === room.hostUserId,
        connected: Boolean(runtime?.clients.get(player.userId)?.size),
        left: Boolean(player.leftAt),
        score: state.scores[player.userId] ?? 0,
      })),
    createdAt: room.createdAt.toISOString(),
    startedAt: room.startedAt?.toISOString() ?? null,
    completedAt: room.completedAt?.toISOString() ?? null,
  };
}

export class MultiplayerService {
  private runtimes = new Map<string, Runtime>();
  private roomLocks = new Map<string, Promise<unknown>>();
  private wss: WebSocketServer | null = null;

  async createRoom(params: {
    hostUserId: string;
    source: "episode" | "mixed";
    date?: string;
  }): Promise<PublicRoomState> {
    const board =
      params.source === "episode"
        ? await getEpisodeBoard(params.date)
        : await getMixedBoard();
    const room = await this.createRoomRecord(params.hostUserId, board);
    const state = getRoomState(room);
    return serializeRoom(room, state, board, this.runtimes.get(room.id));
  }

  async joinRoom(codeRaw: string, userId: string): Promise<PublicRoomState> {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    return this.withRoomLock(room.id, async () => {
      const current = await this.loadRoomByCode(code);
      const existing = current.players.find((player) => player.userId === userId);
      const state = getRoomState(current);
      const board = getBoardPayload(current);

      if (current.status !== "LOBBY") {
        if (!existing || existing.leftAt) {
          throw this.httpError(409, "room already started");
        }
        return serializeRoom(
          current,
          state,
          board,
          this.runtimes.get(current.id),
        );
      }

      if (existing) {
        if (existing.leftAt) {
          throw this.httpError(409, "room seat is no longer available");
        }
        return serializeRoom(
          current,
          state,
          board,
          this.runtimes.get(current.id),
        );
      }

      const joined = activePlayers(current);
      if (joined.length >= MAX_PLAYERS) {
        throw this.httpError(409, "room is full");
      }
      const seat = [1, 2, 3].find(
        (value) => !joined.some((player) => player.seat === value),
      );
      if (!seat) {
        throw this.httpError(409, "room is full");
      }

      const nextState: RoomState = {
        ...state,
        scores: {
          ...state.scores,
          [userId]: 0,
        },
      };
      await prisma.$transaction([
        prisma.multiplayerPlayer.create({
          data: {
            roomId: current.id,
            userId,
            seat,
          },
        }),
        prisma.multiplayerRoom.update({
          where: { id: current.id },
          data: { state: nextState as Prisma.InputJsonValue },
        }),
      ]);

      const updated = await this.loadRoomByCode(code);
      const snapshot = serializeRoom(
        updated,
        nextState,
        board,
        this.runtimes.get(updated.id),
      );
      this.broadcastSnapshot(updated.id, snapshot);
      return snapshot;
    });
  }

  async getRoom(codeRaw: string, userId: string): Promise<PublicRoomState> {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    const member = room.players.find(
      (player) => player.userId === userId && !player.leftAt,
    );
    if (!member) {
      throw this.httpError(403, "not a member of this room");
    }
    const hydrated = await this.ensureRoomRuntime(room);
    return serializeRoom(
      hydrated,
      getRoomState(hydrated),
      getBoardPayload(hydrated),
      this.runtimes.get(hydrated.id),
    );
  }

  async startRoom(codeRaw: string, userId: string): Promise<PublicRoomState> {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    return this.withRoomLock(room.id, async () => {
      const current = await this.loadRoomByCode(code);
      if (current.hostUserId !== userId) {
        throw this.httpError(403, "only the host can start the room");
      }
      if (current.status !== "LOBBY") {
        throw this.httpError(409, "room already started");
      }
      const state = getRoomState(current);
      const players = activePlayers(current);
      if (players.length === 0) {
        throw this.httpError(400, "room has no players");
      }
      const nextState: RoomState = {
        ...state,
        selectorUserId: current.hostUserId,
        phase: { kind: "BOARD", round: "JEOPARDY" },
      };
      const updated = await prisma.multiplayerRoom.update({
        where: { id: current.id },
        data: {
          status: "LIVE",
          startedAt: new Date(),
          state: nextState as Prisma.InputJsonValue,
        },
        include: roomInclude,
      });
      await this.ensureRoomRuntime(updated);
      const snapshot = serializeRoom(
        updated,
        nextState,
        getBoardPayload(updated),
        this.runtimes.get(updated.id),
      );
      this.broadcastSnapshot(updated.id, snapshot);
      return snapshot;
    });
  }

  async leaveRoom(codeRaw: string, userId: string): Promise<PublicRoomState> {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    return this.withRoomLock(room.id, async () => {
      const current = await this.loadRoomByCode(code);
      const player = current.players.find(
        (entry) => entry.userId === userId && !entry.leftAt,
      );
      if (!player) {
        throw this.httpError(404, "room membership not found");
      }
      const state = getRoomState(current);
      if (current.status === "LOBBY") {
        if (userId === current.hostUserId) {
          return this.abandonRoom(current, state, "Host closed the room.");
        }
        const nextScores = { ...state.scores };
        delete nextScores[userId];
        await prisma.$transaction([
          prisma.multiplayerPlayer.delete({ where: { id: player.id } }),
          prisma.multiplayerRoom.update({
            where: { id: current.id },
            data: {
              state: {
                ...state,
                scores: nextScores,
              } as Prisma.InputJsonValue,
            },
          }),
        ]);
      } else {
        if (userId === current.hostUserId) {
          return this.abandonRoom(current, state, "Host left the game.");
        }
        state.selectorUserId =
          state.selectorUserId === userId
            ? nextSelectorUserId(current, null)
            : state.selectorUserId;
        await prisma.$transaction([
          prisma.multiplayerPlayer.update({
            where: { id: player.id },
            data: { leftAt: new Date() },
          }),
          prisma.multiplayerRoom.update({
            where: { id: current.id },
            data: { state: state as Prisma.InputJsonValue },
          }),
        ]);
      }

      this.closeUserSockets(current.id, userId);
      const updated = await this.loadRoomByCode(code);
      await this.ensureRoomRuntime(updated);
      const snapshot = serializeRoom(
        updated,
        getRoomState(updated),
        getBoardPayload(updated),
        this.runtimes.get(updated.id),
      );
      this.broadcastSnapshot(updated.id, snapshot);
      return snapshot;
    });
  }

  async connectSocket(
    codeRaw: string,
    userId: string,
    socket: WebSocket,
  ): Promise<void> {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    const player = room.players.find(
      (entry) => entry.userId === userId && !entry.leftAt,
    );
    if (!player) {
      throw this.httpError(403, "not a member of this room");
    }
    const runtime = this.getRuntime(room.id);
    const existing = runtime.clients.get(userId) ?? new Set<WebSocket>();
    existing.add(socket);
    runtime.clients.set(userId, existing);

    const hydrated = await this.ensureRoomRuntime(room);
    const state = getRoomState(hydrated);
    if (userId === hydrated.hostUserId && state.paused) {
      await this.withRoomLock(hydrated.id, async () => {
        const latest = await this.loadRoomByCode(code);
        const latestState = getRoomState(latest);
        if (!latestState.paused) return;
        const paused = latestState.paused;
        latestState.paused = null;
        latestState.hostReconnectDeadlineAt = null;
        const deadlineAt = phaseDeadlineAt(latestState.phase);
        if (deadlineAt) {
          const remainingMs = paused?.remainingMs ?? null;
          if (remainingMs != null) {
            latestState.phase = withPhaseDeadline(
              latestState.phase,
              new Date(Date.now() + remainingMs).toISOString(),
            );
          }
        }
        const updated = await prisma.multiplayerRoom.update({
          where: { id: latest.id },
          data: {
            state: latestState as Prisma.InputJsonValue,
          },
          include: roomInclude,
        });
        this.clearHostGraceTimer(updated.id);
        await this.ensureRoomRuntime(updated);
        this.scheduleRoom(updated, latestState);
        const snapshot = serializeRoom(
          updated,
          latestState,
          getBoardPayload(updated),
          this.runtimes.get(updated.id),
        );
        this.broadcastSnapshot(updated.id, snapshot);
      });
      return;
    }

    const snapshot = serializeRoom(
      hydrated,
      state,
      getBoardPayload(hydrated),
      this.runtimes.get(hydrated.id),
    );
    this.sendJson(socket, { type: "room-state", room: snapshot });
    this.broadcastSnapshot(hydrated.id, snapshot);
  }

  async disconnectSocket(codeRaw: string, userId: string, socket: WebSocket) {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code).catch(() => null);
    if (!room) return;
    const runtime = this.getRuntime(room.id);
    const sockets = runtime.clients.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      runtime.clients.delete(userId);
    }

    if (userId !== room.hostUserId || runtime.clients.get(userId)?.size) {
      const snapshot = serializeRoom(
        room,
        getRoomState(room),
        getBoardPayload(room),
        runtime,
      );
      this.broadcastSnapshot(room.id, snapshot);
      return;
    }

    const state = getRoomState(room);
    if (
      room.status === "LIVE" ||
      room.status === "FINAL"
    ) {
      await this.withRoomLock(room.id, async () => {
        const latest = await this.loadRoomByCode(code);
        const latestState = getRoomState(latest);
        if (latestState.paused || latest.status === "COMPLETE") return;
        const deadlineAt = phaseDeadlineAt(latestState.phase);
        latestState.paused = {
          reason: "HOST_DISCONNECTED",
          remainingMs: deadlineAt
            ? Math.max(0, new Date(deadlineAt).getTime() - Date.now())
            : null,
        };
        latestState.hostReconnectDeadlineAt = new Date(
          Date.now() + HOST_RECONNECT_GRACE_MS,
        ).toISOString();
        const updated = await prisma.multiplayerRoom.update({
          where: { id: latest.id },
          data: { state: latestState as Prisma.InputJsonValue },
          include: roomInclude,
        });
        this.clearMainTimer(updated.id);
        this.scheduleHostGrace(updated.id, code, latestState);
        const snapshot = serializeRoom(
          updated,
          latestState,
          getBoardPayload(updated),
          this.runtimes.get(updated.id),
        );
        this.broadcastSnapshot(updated.id, snapshot);
      });
      return;
    }

    const snapshot = serializeRoom(room, state, getBoardPayload(room), runtime);
    this.broadcastSnapshot(room.id, snapshot);
  }

  async handleAction(codeRaw: string, userId: string, action: Action) {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    return this.withRoomLock(room.id, async () => {
      const current = await this.loadRoomByCode(code);
      const state = getRoomState(current);
      if (state.paused) {
        throw this.httpError(409, "room is paused while the host reconnects");
      }
      const player = current.players.find(
        (entry) => entry.userId === userId && !entry.leftAt,
      );
      if (!player) {
        throw this.httpError(403, "not a member of this room");
      }
      let updatedRoom = current;
      let nextState = state;
      let nextStatus = current.status;
      switch (action.type) {
        case "select-clue":
          ({ state: nextState, status: nextStatus } = this.handleSelectClue(
            current,
            state,
            userId,
            action.clueId,
          ));
          break;
        case "buzz":
          ({ state: nextState, status: nextStatus } = this.handleBuzz(
            current,
            state,
            userId,
          ));
          break;
        case "submit-answer":
          ({ state: nextState, status: nextStatus } = await this.handleSubmitAnswer(
            current,
            state,
            userId,
            action.answer,
          ));
          break;
        case "submit-wager":
          ({ state: nextState, status: nextStatus } = await this.handleSubmitWager(
            current,
            state,
            userId,
            action.wager,
          ));
          break;
        case "advance":
          ({ state: nextState, status: nextStatus } = this.handleAdvance(
            current,
            state,
            userId,
          ));
          break;
      }
      updatedRoom = await prisma.multiplayerRoom.update({
        where: { id: current.id },
        data: {
          status: nextStatus,
          completedAt:
            nextStatus === "COMPLETE" || nextStatus === "ABANDONED"
              ? new Date()
              : current.completedAt,
          state: nextState as Prisma.InputJsonValue,
        },
        include: roomInclude,
      });
      await this.ensureRoomRuntime(updatedRoom);
      this.scheduleRoom(updatedRoom, nextState);
      const snapshot = serializeRoom(
        updatedRoom,
        nextState,
        getBoardPayload(updatedRoom),
        this.runtimes.get(updatedRoom.id),
      );
      this.broadcastSnapshot(updatedRoom.id, snapshot);
      return snapshot;
    });
  }

  attach(server: HttpServer) {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on("upgrade", async (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/multiplayer/ws") {
        return;
      }
      const host = (req.headers.host ?? "").toLowerCase();
      const originHost = parseOriginHost(
        typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      );
      if (originHost && originHost !== host) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = readAuthTokenFromHeaders(req.headers);
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      let userId: string;
      try {
        userId = verifyAuthToken(token);
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const code = normalizeRoomCode(url.searchParams.get("code") ?? "");
      if (!new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LEN}}$`).test(code)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit("connection", ws, code, userId);
      });
    });

    wss.on("connection", (socket: WebSocket, code: string, userId: string) => {
      void this.connectSocket(code, userId, socket).catch((err) => {
        this.sendJson(socket, {
          type: "error",
          message: err instanceof Error ? err.message : "connection failed",
        });
        socket.close(1008, "unauthorized");
      });
      socket.on("message", (raw: RawData) => {
        void this.handleSocketMessage(socket, code, userId, raw);
      });
      socket.on("close", () => {
        void this.disconnectSocket(code, userId, socket);
      });
    });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    code: string,
    userId: string,
    raw: RawData,
  ) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      this.sendJson(socket, { type: "error", message: "bad message payload" });
      return;
    }
    const parsed = multiplayerActionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.sendJson(socket, { type: "error", message: "invalid action" });
      return;
    }
    try {
      await this.handleAction(code, userId, parsed.data);
    } catch (err) {
      this.sendJson(socket, {
        type: "error",
        message: err instanceof Error ? err.message : "action failed",
      });
    }
  }

  private getRuntime(roomId: string): Runtime {
    const existing = this.runtimes.get(roomId);
    if (existing) return existing;
    const runtime: Runtime = {
      clients: new Map(),
      mainTimer: null,
      hostGraceTimer: null,
    };
    this.runtimes.set(roomId, runtime);
    return runtime;
  }

  private async createRoomRecord(
    hostUserId: string,
    board: SharedEpisode,
  ): Promise<RoomWithPlayers> {
    for (let i = 0; i < 5; i++) {
      const code = newRoomCode();
      try {
        return await prisma.multiplayerRoom.create({
          data: {
            code,
            hostUserId,
            status: "LOBBY",
            boardPayload: board,
            state: buildInitialState([hostUserId], hostUserId) as Prisma.InputJsonValue,
            players: {
              create: {
                userId: hostUserId,
                seat: 1,
              },
            },
          },
          include: roomInclude,
        });
      } catch (err: any) {
        if (err?.code === "P2002") continue;
        throw err;
      }
    }
    throw new Error("failed to allocate room code");
  }

  private async loadRoomByCode(code: string): Promise<RoomWithPlayers> {
    const room = await prisma.multiplayerRoom.findUnique({
      where: { code },
      include: roomInclude,
    });
    if (!room) {
      throw this.httpError(404, "room not found");
    }
    return room;
  }

  private async ensureRoomRuntime(room: RoomWithPlayers): Promise<RoomWithPlayers> {
    const state = getRoomState(room);
    this.scheduleRoom(room, state);
    if (state.hostReconnectDeadlineAt) {
      this.scheduleHostGrace(room.id, room.code, state);
    }
    return room;
  }

  private scheduleRoom(room: RoomWithPlayers, state: RoomState) {
    this.clearMainTimer(room.id);
    if (state.paused) return;
    const deadlineAt = phaseDeadlineAt(state.phase);
    if (!deadlineAt) return;
    const delay = Math.max(0, new Date(deadlineAt).getTime() - Date.now());
    const runtime = this.getRuntime(room.id);
    runtime.mainTimer = setTimeout(() => {
      void this.handleTimer(room.code, room.id);
    }, delay);
  }

  private scheduleHostGrace(roomId: string, code: string, state: RoomState) {
    this.clearHostGraceTimer(roomId);
    if (!state.hostReconnectDeadlineAt) return;
    const delay = Math.max(
      0,
      new Date(state.hostReconnectDeadlineAt).getTime() - Date.now(),
    );
    const runtime = this.getRuntime(roomId);
    runtime.hostGraceTimer = setTimeout(() => {
      void this.handleHostGraceExpiry(roomId, code);
    }, delay);
  }

  private clearMainTimer(roomId: string) {
    const runtime = this.runtimes.get(roomId);
    if (!runtime?.mainTimer) return;
    clearTimeout(runtime.mainTimer);
    runtime.mainTimer = null;
  }

  private clearHostGraceTimer(roomId: string) {
    const runtime = this.runtimes.get(roomId);
    if (!runtime?.hostGraceTimer) return;
    clearTimeout(runtime.hostGraceTimer);
    runtime.hostGraceTimer = null;
  }

  private async handleTimer(code: string, roomId: string) {
    await this.withRoomLock(roomId, async () => {
      const room = await this.loadRoomByCode(code).catch(() => null);
      if (!room) return;
      const state = getRoomState(room);
      if (state.paused) return;
      const deadlineAt = phaseDeadlineAt(state.phase);
      if (!deadlineAt || new Date(deadlineAt).getTime() > Date.now()) {
        this.scheduleRoom(room, state);
        return;
      }
      let nextState = state;
      let nextStatus = room.status;
      switch (state.phase.kind) {
        case "READING":
          nextState = {
            ...state,
            phase: {
              kind: "BUZZ_OPEN",
              round: state.phase.round,
              clue: state.phase.clue,
              buzzClosesAt: new Date(Date.now() + BUZZ_WINDOW_MS).toISOString(),
            },
          };
          break;
        case "BUZZ_OPEN":
          nextState = await this.passClueOnNoBuzz(room, state);
          break;
        case "DD_WAGER":
          ({ state: nextState } = await this.handleSubmitWager(
            room,
            state,
            state.phase.playerUserId,
            Math.min(state.phase.maxWager, MIN_DD_WAGER),
          ));
          break;
        case "ANSWERING":
          ({ state: nextState } = await this.handleSubmitAnswer(
            room,
            state,
            state.phase.answeringUserId,
            "",
          ));
          break;
        case "FINAL_WAGER":
          ({ state: nextState, status: nextStatus } =
            await this.timeoutFinalWagers(room, state));
          break;
        case "FINAL_ANSWER":
          ({ state: nextState, status: nextStatus } = await this.resolveFinalAnswers(
            room,
            state,
          ));
          break;
        default:
          return;
      }
      const updated = await prisma.multiplayerRoom.update({
        where: { id: room.id },
        data: {
          status: nextStatus,
          completedAt:
            nextStatus === "COMPLETE" || nextStatus === "ABANDONED"
              ? new Date()
              : room.completedAt,
          state: nextState as Prisma.InputJsonValue,
        },
        include: roomInclude,
      });
      this.scheduleRoom(updated, nextState);
      const snapshot = serializeRoom(
        updated,
        nextState,
        getBoardPayload(updated),
        this.runtimes.get(updated.id),
      );
      this.broadcastSnapshot(updated.id, snapshot);
    });
  }

  private async handleHostGraceExpiry(roomId: string, code: string) {
    await this.withRoomLock(roomId, async () => {
      const room = await this.loadRoomByCode(code).catch(() => null);
      if (!room) return;
      const runtime = this.getRuntime(room.id);
      if (runtime.clients.get(room.hostUserId)?.size) return;
      const state = getRoomState(room);
      if (!state.hostReconnectDeadlineAt) return;
      const snapshot = await this.abandonRoom(
        room,
        state,
        "Host did not reconnect in time.",
      );
      this.broadcastSnapshot(room.id, snapshot);
    });
  }

  private handleSelectClue(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
    clueId: number,
  ): { state: RoomState; status: RoomStatus } {
    if (room.status !== "LIVE") {
      throw this.httpError(409, "room is not in live board play");
    }
    if (state.phase.kind !== "BOARD") {
      throw this.httpError(409, "room is not ready for clue selection");
    }
    if (state.selectorUserId !== userId) {
      throw this.httpError(403, "it is not your board control");
    }
    const board = getBoardPayload(room);
    const found = findBoardCell(board, clueId);
    if (!found || found.round !== state.phase.round) {
      throw this.httpError(404, "clue not available in this round");
    }
    if (state.playedClueIds.includes(clueId)) {
      throw this.httpError(409, "clue already played");
    }
    if (found.clue.dailyDouble) {
      const score = state.scores[userId] ?? 0;
      return {
        status: "LIVE",
        state: {
          ...state,
          phase: {
            kind: "DD_WAGER",
            round: found.round,
            clue: found.clue,
            playerUserId: userId,
            maxWager: maxDailyDoubleWager(found.round, score),
            wagerDeadlineAt: new Date(
              Date.now() + DD_WAGER_WINDOW_MS,
            ).toISOString(),
          },
        },
      };
    }
    return {
      status: "LIVE",
      state: {
        ...state,
        phase: {
          kind: "READING",
          round: found.round,
          clue: found.clue,
          readEndsAt: new Date(
            Date.now() + readDurationMs(found.clue.question),
          ).toISOString(),
        },
      },
    };
  }

  private handleBuzz(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
  ): { state: RoomState; status: RoomStatus } {
    if (room.status !== "LIVE" || state.phase.kind !== "BUZZ_OPEN") {
      throw this.httpError(409, "buzzing is not open");
    }
    return {
      status: "LIVE",
      state: {
        ...state,
        phase: {
          kind: "ANSWERING",
          round: state.phase.round,
          clue: state.phase.clue,
          answeringUserId: userId,
          answerBeganAt: new Date().toISOString(),
          answerDeadlineAt: new Date(
            Date.now() + ANSWER_WINDOW_MS,
          ).toISOString(),
          wager: null,
          dailyDouble: false,
        },
      },
    };
  }

  private async handleSubmitWager(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
    wager: number,
  ): Promise<{ state: RoomState; status: RoomStatus }> {
    if (state.phase.kind === "DD_WAGER") {
      if (state.phase.playerUserId !== userId) {
        throw this.httpError(403, "only the Daily Double player can wager");
      }
      if (wager < MIN_DD_WAGER || wager > state.phase.maxWager) {
        throw this.httpError(
          400,
          `wager must be between $${MIN_DD_WAGER} and $${state.phase.maxWager}`,
        );
      }
      return {
        status: "LIVE",
        state: {
          ...state,
          phase: {
            kind: "ANSWERING",
            round: state.phase.round,
            clue: state.phase.clue,
            answeringUserId: userId,
            answerBeganAt: new Date().toISOString(),
            answerDeadlineAt: new Date(
              Date.now() + DD_ANSWER_WINDOW_MS,
            ).toISOString(),
            wager,
            dailyDouble: true,
          },
        },
      };
    }

    if (state.phase.kind !== "FINAL_WAGER") {
      throw this.httpError(409, "the room is not accepting wagers");
    }
    if (!state.phase.eligibleUserIds.includes(userId)) {
      throw this.httpError(403, "you are not eligible for Final Jeopardy");
    }
    const max = Math.max(0, state.scores[userId] ?? 0);
    if (wager < 0 || wager > max) {
      throw this.httpError(400, `wager must be between $0 and $${max}`);
    }
    const wagers = { ...state.phase.wagers, [userId]: wager };
    const allSubmitted = state.phase.eligibleUserIds.every(
      (id) => id in wagers,
    );
    if (!allSubmitted) {
      return {
        status: "FINAL",
        state: {
          ...state,
          phase: {
            ...state.phase,
            wagers,
          },
        },
      };
    }
    return {
      status: "FINAL",
      state: {
        ...state,
        phase: {
          kind: "FINAL_ANSWER",
          clue: state.phase.clue,
          eligibleUserIds: state.phase.eligibleUserIds,
          wagers,
          answers: {},
          startedAt: new Date().toISOString(),
          deadlineAt: new Date(
            Date.now() + FINAL_ANSWER_WINDOW_MS,
          ).toISOString(),
        },
      },
    };
  }

  private async handleSubmitAnswer(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
    answer: string,
  ): Promise<{ state: RoomState; status: RoomStatus }> {
    if (state.phase.kind === "FINAL_ANSWER") {
      if (!state.phase.eligibleUserIds.includes(userId)) {
        throw this.httpError(403, "you are not eligible for Final Jeopardy");
      }
      const answers = { ...state.phase.answers, [userId]: answer.trim() };
      const nextState: RoomState = {
        ...state,
        phase: {
          ...state.phase,
          answers,
        },
      };
      const allSubmitted = state.phase.eligibleUserIds.every((id) => id in answers);
      if (!allSubmitted) {
        return { state: nextState, status: "FINAL" };
      }
      return this.resolveFinalAnswers(room, nextState);
    }

    if (state.phase.kind !== "ANSWERING") {
      throw this.httpError(409, "the room is not accepting answers");
    }
    if (state.phase.answeringUserId !== userId) {
      throw this.httpError(403, "it is not your turn to answer");
    }
    const totalMs = state.phase.dailyDouble
      ? DD_ANSWER_WINDOW_MS
      : ANSWER_WINDOW_MS;
    const responseTimeMs = Math.min(
      totalMs,
      Math.max(
        0,
        Date.now() - new Date(state.phase.answerBeganAt).getTime(),
      ),
    );
    const verdict = await submitClueAnswer({
      userId,
      clueId: state.phase.clue.id,
      answer: answer.trim(),
      responseTimeMs,
      mode: "BOARD",
      wager: state.phase.wager,
    });
    const playedClueIds = state.playedClueIds.includes(state.phase.clue.id)
      ? state.playedClueIds
      : [...state.playedClueIds, state.phase.clue.id];
    const scores = {
      ...state.scores,
      [userId]: (state.scores[userId] ?? 0) + verdict.valueDelta,
    };
    return {
      status: "LIVE",
      state: {
        ...state,
        playedClueIds,
        scores,
        selectorUserId: verdict.correct ? userId : state.selectorUserId,
        phase: {
          kind: "RESULT",
          round: state.phase.round,
          clue: state.phase.clue,
          result: {
            answeredByUserId: userId,
            submittedAnswer: answer.trim(),
            correct: verdict.correct,
            canonicalAnswer: verdict.canonicalAnswer,
            valueDelta: verdict.valueDelta,
            llmVerdict: verdict.llmVerdict,
            timedOut: answer.trim().length === 0,
            noBuzz: false,
          },
        },
      },
    };
  }

  private handleAdvance(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
  ): { state: RoomState; status: RoomStatus } {
    if (room.hostUserId !== userId) {
      throw this.httpError(403, "only the host can advance the room");
    }
    if (state.phase.kind !== "RESULT") {
      throw this.httpError(409, "there is no result screen to advance");
    }
    const board = getBoardPayload(room);
    const currentRound = state.phase.round;
    const selectorUserId = nextSelectorUserId(room, state.selectorUserId);
    if (roundHasUnplayed(board, currentRound, state.playedClueIds)) {
      return {
        status: "LIVE",
        state: {
          ...state,
          selectorUserId,
          phase: { kind: "BOARD", round: currentRound },
        },
      };
    }
    if (
      currentRound === "JEOPARDY" &&
      roundHasUnplayed(board, "DOUBLE_JEOPARDY", state.playedClueIds)
    ) {
      return {
        status: "LIVE",
        state: {
          ...state,
          selectorUserId,
          phase: { kind: "BOARD", round: "DOUBLE_JEOPARDY" },
        },
      };
    }
    if (!board.finalJeopardy) {
      return {
        status: "COMPLETE",
        state: {
          ...state,
          phase: {
            kind: "COMPLETE",
            finalResults: null,
            reason: "Board complete.",
          },
        },
      };
    }
    const eligibleUserIds = activePlayers(room)
      .map((player) => player.userId)
      .filter((playerId) => (state.scores[playerId] ?? 0) >= 0);
    if (eligibleUserIds.length === 0) {
      return {
        status: "COMPLETE",
        state: {
          ...state,
          phase: {
            kind: "COMPLETE",
            finalResults: null,
            reason: "No players qualified for Final Jeopardy.",
          },
        },
      };
    }
    return {
      status: "FINAL",
      state: {
        ...state,
        phase: {
          kind: "FINAL_WAGER",
          clue: board.finalJeopardy,
          eligibleUserIds,
          wagers: {},
          startedAt: new Date().toISOString(),
          deadlineAt: new Date(
            Date.now() + FINAL_WAGER_WINDOW_MS,
          ).toISOString(),
        },
      },
    };
  }

  private async passClueOnNoBuzz(
    room: RoomWithPlayers,
    state: RoomState,
  ): Promise<RoomState> {
    if (state.phase.kind !== "BUZZ_OPEN") return state;
    const clue = await prisma.clue.findUnique({
      where: { id: state.phase.clue.id },
      select: { answer: true },
    });
    const phase: RoomPhase = {
      kind: "RESULT",
      round: state.phase.round,
      clue: state.phase.clue,
      result: {
        answeredByUserId: null,
        submittedAnswer: "",
        correct: false,
        canonicalAnswer: clue?.answer ?? "(unavailable)",
        valueDelta: 0,
        llmVerdict: null,
        timedOut: false,
        noBuzz: true,
      },
    };
    return {
      ...state,
      playedClueIds: state.playedClueIds.includes(state.phase.clue.id)
        ? state.playedClueIds
        : [...state.playedClueIds, state.phase.clue.id],
      phase,
    };
  }

  private async timeoutFinalWagers(
    room: RoomWithPlayers,
    state: RoomState,
  ): Promise<{ state: RoomState; status: RoomStatus }> {
    if (state.phase.kind !== "FINAL_WAGER") {
      return { state, status: room.status };
    }
    const wagers = { ...state.phase.wagers };
    for (const userId of state.phase.eligibleUserIds) {
      if (!(userId in wagers)) wagers[userId] = 0;
    }
    return {
      status: "FINAL",
      state: {
        ...state,
        phase: {
          kind: "FINAL_ANSWER",
          clue: state.phase.clue,
          eligibleUserIds: state.phase.eligibleUserIds,
          wagers,
          answers: {},
          startedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + FINAL_ANSWER_WINDOW_MS).toISOString(),
        },
      },
    };
  }

  private async resolveFinalAnswers(
    room: RoomWithPlayers,
    state: RoomState,
  ): Promise<{ state: RoomState; status: RoomStatus }> {
    if (state.phase.kind !== "FINAL_ANSWER") {
      return { state, status: room.status };
    }
    const scores = { ...state.scores };
    const finalResults: Array<{
      userId: string;
      submittedAnswer: string;
      correct: boolean;
      canonicalAnswer: string;
      valueDelta: number;
      wager: number;
      llmVerdict: boolean | null;
    }> = [];
    const responseTimeMs = Math.min(
      FINAL_ANSWER_WINDOW_MS,
      Math.max(0, Date.now() - new Date(state.phase.startedAt).getTime()),
    );
    for (const userId of state.phase.eligibleUserIds) {
      const submittedAnswer = state.phase.answers[userId] ?? "";
      const wager = state.phase.wagers[userId] ?? 0;
      const verdict = await submitClueAnswer({
        userId,
        clueId: state.phase.clue.id,
        answer: submittedAnswer,
        responseTimeMs,
        mode: "FINAL",
        wager,
      });
      scores[userId] = (scores[userId] ?? 0) + verdict.valueDelta;
      finalResults.push({
        userId,
        submittedAnswer,
        correct: verdict.correct,
        canonicalAnswer: verdict.canonicalAnswer,
        valueDelta: verdict.valueDelta,
        wager,
        llmVerdict: verdict.llmVerdict,
      });
    }
    return {
      status: "COMPLETE",
      state: {
        ...state,
        scores,
        phase: {
          kind: "COMPLETE",
          finalResults,
          reason: null,
        },
      },
    };
  }

  private async abandonRoom(
    room: RoomWithPlayers,
    state: RoomState,
    reason: string,
  ): Promise<PublicRoomState> {
    this.clearMainTimer(room.id);
    this.clearHostGraceTimer(room.id);
    const nextState: RoomState = {
      ...state,
      paused: null,
      hostReconnectDeadlineAt: null,
      phase: { kind: "ABANDONED", reason },
    };
    const updated = await prisma.multiplayerRoom.update({
      where: { id: room.id },
      data: {
        status: "ABANDONED",
        completedAt: new Date(),
        state: nextState as Prisma.InputJsonValue,
      },
      include: roomInclude,
    });
    return serializeRoom(
      updated,
      nextState,
      getBoardPayload(updated),
      this.runtimes.get(updated.id),
    );
  }

  private broadcastSnapshot(roomId: string, snapshot: PublicRoomState) {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    const payload = JSON.stringify({ type: "room-state", room: snapshot });
    for (const sockets of runtime.clients.values()) {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      }
    }
  }

  private closeUserSockets(roomId: string, userId: string) {
    const runtime = this.runtimes.get(roomId);
    const sockets = runtime?.clients.get(userId);
    if (!sockets) return;
    for (const socket of sockets) {
      socket.close(1000, "left room");
    }
    runtime?.clients.delete(userId);
  }

  private sendJson(socket: WebSocket, payload: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private httpError(status: number, message: string) {
    const err = new Error(message) as Error & { status?: number };
    err.status = status;
    return err;
  }

  private async withRoomLock<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(
      () => barrier,
      () => barrier,
    );
    this.roomLocks.set(roomId, chain);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.roomLocks.get(roomId) === chain) {
        this.roomLocks.delete(roomId);
      }
    }
  }
}

export const multiplayerService = new MultiplayerService();
