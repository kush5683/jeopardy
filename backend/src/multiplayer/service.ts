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
type PlayerRole = "PLAYER" | "AUDIENCE";

// Safe to broadcast before RESULT: this tracks who missed and how scoring moved,
// but never includes the canonical answer while the clue is still live.
type BuzzAttempt = {
  userId: string;
  submittedAnswer: string;
  correct: boolean;
  valueDelta: number;
  llmVerdict: boolean | null;
  timedOut: boolean;
};

type FinalResult = {
  userId: string;
  submittedAnswer: string;
  correct: boolean;
  canonicalAnswer: string;
  valueDelta: number;
  wager: number;
  llmVerdict: boolean | null;
  wagerRevealed?: boolean;
};

type RoomPhase =
  | { kind: "LOBBY" }
  | { kind: "BOARD"; round: RoundKind }
  | { kind: "READING"; round: RoundKind; clue: SharedCell; readEndsAt: string }
  | {
      kind: "BUZZ_OPEN";
      round: RoundKind;
      clue: SharedCell;
      buzzClosesAt: string;
      buzzedUserIds: string[];
      attempts: BuzzAttempt[];
    }
  | {
      kind: "DD_WAGER";
      round: RoundKind;
      clue: SharedCell;
      playerUserId: string;
      maxWager: number;
      wagerDeadlineAt: string;
      wagerDraft?: string;
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
      buzzedUserIds: string[];
      attempts: BuzzAttempt[];
      answerDraft?: string;
    }
  | {
      kind: "RESULT";
      round: RoundKind;
      clue: SharedCell;
      resultBeganAt?: string;
      advanceUnlocksAt?: string;
      result: {
        answeredByUserId: string | null;
        submittedAnswer: string;
        correct: boolean;
        canonicalAnswer: string;
        valueDelta: number;
        llmVerdict: boolean | null;
        timedOut: boolean;
        noBuzz: boolean;
        attempts: BuzzAttempt[];
      };
    }
  | {
      kind: "FINAL_WAGER";
      clue: SharedCell;
      eligibleUserIds: string[];
      wagers: Record<string, number>;
      startedAt: string;
      deadlineAt: string;
      submittedCount?: number;
    }
  | {
      kind: "FINAL_ANSWER";
      clue: SharedCell;
      eligibleUserIds: string[];
      wagers: Record<string, number>;
      answers: Record<string, string>;
      startedAt: string;
      deadlineAt: string;
      submittedCount?: number;
    }
  | {
      kind: "FINAL_REVEAL";
      clue: SharedCell;
      eligibleUserIds: string[];
      results: FinalResult[];
      revealIndex: number;
      revealStep: "ANSWER" | "WAGER";
    }
  | {
      kind: "COMPLETE";
      finalResults: FinalResult[] | null;
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
  | { type: "update-draft"; value: string }
  | { type: "advance" };

type LiveDraft = {
  kind: "dd-wager" | "answer";
  phaseKey: string;
  userId: string;
  value: string;
};

type Runtime = {
  clients: Map<string, Set<WebSocket>>;
  mainTimer: NodeJS.Timeout | null;
  hostGraceTimer: NodeJS.Timeout | null;
  draft: LiveDraft | null;
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
  serverNow: string;
  board: SharedEpisode;
  state: RoomState;
  players: Array<{
    userId: string;
    displayName: string;
    seat: number;
    isHost: boolean;
    role: PlayerRole;
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
const RESULT_ADVANCE_DELAY_MS = 3000;

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
  z.object({
    type: z.literal("update-draft"),
    value: z.string().max(400),
  }),
  z.object({ type: z.literal("advance") }),
]);

/**
 * Normalizes room code input.
 *
 * Parameters:
 * - `raw` (`string`): Untrusted or loosely typed input normalized before the rest of the function uses it.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 */
function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Generates room code data.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function newRoomCode(): string {
  const bytes = crypto.randomBytes(ROOM_CODE_LEN);
  let out = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Builds initial state data.
 *
 * Parameters:
 * - `playerIds` (`string[]`): Identifier value used to look up, compare, or persist related records.
 * - `selectorUserId` (`string | null`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `RoomState`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 */
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

/**
 * Implements the player role from seat function.
 *
 * Parameters:
 * - `seat` (`number`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `PlayerRole`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function playerRoleFromSeat(seat: number): PlayerRole {
  return seat <= MAX_PLAYERS ? "PLAYER" : "AUDIENCE";
}

/**
 * Checks the contestant condition.
 *
 * Parameters:
 * - `player` (`Pick<RoomWithPlayers["players"][number], "seat" | "leftAt">`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function isContestant(player: Pick<RoomWithPlayers["players"][number], "seat" | "leftAt">) {
  return !player.leftAt && playerRoleFromSeat(player.seat) === "PLAYER";
}

/**
 * Implements the active players function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `{ id: string; roomId: string; userId: string; seat: number; joinedAt: Date; leftAt: Date; user: { id: string; displayName: string; }; }[]`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function activePlayers(room: RoomWithPlayers) {
  return room.players
    .filter(isContestant)
    .sort((a, b) => a.seat - b.seat);
}

/**
 * Implements the active player user ids function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string[]`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function activePlayerUserIds(room: RoomWithPlayers): string[] {
  return activePlayers(room).map((player) => player.userId);
}

/**
 * Implements the unique user ids function.
 *
 * Parameters:
 * - `userIds` (`string[]`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `string[]`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 */
function uniqueUserIds(userIds: string[]): string[] {
  return [...new Set(userIds)];
}

/**
 * Implements the phase buzzed user ids function.
 *
 * Parameters:
 * - `phase` (`Extract<RoomPhase, { kind: "BUZZ_OPEN" | "ANSWERING" }>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string[]`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function phaseBuzzedUserIds(
  phase: Extract<RoomPhase, { kind: "BUZZ_OPEN" | "ANSWERING" }>,
): string[] {
  return Array.isArray(phase.buzzedUserIds) ? phase.buzzedUserIds : [];
}

/**
 * Implements the phase buzz attempts function.
 *
 * Parameters:
 * - `phase` (`Extract<RoomPhase, { kind: "BUZZ_OPEN" | "ANSWERING" }>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `BuzzAttempt[]`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function phaseBuzzAttempts(
  phase: Extract<RoomPhase, { kind: "BUZZ_OPEN" | "ANSWERING" }>,
): BuzzAttempt[] {
  return Array.isArray(phase.attempts) ? phase.attempts : [];
}

/**
 * Implements the all active players attempted function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 * - `buzzedUserIds` (`string[]`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 */
function allActivePlayersAttempted(
  room: RoomWithPlayers,
  buzzedUserIds: string[],
): boolean {
  const buzzed = new Set(buzzedUserIds);
  return activePlayerUserIds(room).every((playerId) => buzzed.has(playerId));
}

/**
 * Implements the next open seat function.
 *
 * Parameters:
 * - `players` (`RoomWithPlayers["players"]`): Caller-provided value consumed by the function body.
 * - `minSeat` (`number`): Caller-provided value consumed by the function body.
 * - `maxSeat` (`number | null`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `number | null`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 */
function nextOpenSeat(
  players: RoomWithPlayers["players"],
  minSeat: number,
  maxSeat: number | null = null,
): number | null {
  const occupied = new Set(
    players
      .filter((player) => !player.leftAt)
      .map((player) => player.seat),
  );
  for (let seat = minSeat; maxSeat == null || seat <= maxSeat; seat++) {
    if (!occupied.has(seat)) return seat;
  }
  return null;
}

/**
 * Implements the dd wager draft key function.
 *
 * Parameters:
 * - `phase` (`Extract<RoomPhase, { kind: "DD_WAGER" }>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function ddWagerDraftKey(phase: Extract<RoomPhase, { kind: "DD_WAGER" }>) {
  return `dd-wager:${phase.clue.id}:${phase.playerUserId}`;
}

/**
 * Implements the answer draft key function.
 *
 * Parameters:
 * - `phase` (`Extract<RoomPhase, { kind: "ANSWERING" }>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function answerDraftKey(phase: Extract<RoomPhase, { kind: "ANSWERING" }>) {
  return `answer:${phase.clue.id}:${phase.answeringUserId}:${phase.answerBeganAt}`;
}

/**
 * Implements the phase deadline at function.
 *
 * Parameters:
 * - `phase` (`RoomPhase`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
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

/**
 * Implements the with phase deadline function.
 *
 * Parameters:
 * - `phase` (`RoomPhase`): Caller-provided value consumed by the function body.
 * - `deadlineAt` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `RoomPhase`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
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

/**
 * Implements the get room state function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `RoomState`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
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

/**
 * Implements the get board payload function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `SharedEpisode`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function getBoardPayload(room: RoomWithPlayers): SharedEpisode {
  const parsed = sharedEpisodeSchema.safeParse(room.boardPayload);
  if (!parsed.success) {
    throw new Error("room board payload invalid");
  }
  return parsed.data;
}

/**
 * Implements the board for round function.
 *
 * Parameters:
 * - `board` (`SharedEpisode`): Caller-provided value consumed by the function body.
 * - `round` (`RoundKind`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `{ values?: number[]; categories?: { name?: string; cells?: { value?: number; id?: number; question?: string; round?: "JEOPARDY" | "DOUBLE_JEOPARDY" | "FINAL_...`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function boardForRound(board: SharedEpisode, round: RoundKind) {
  return round === "JEOPARDY" ? board.jeopardy : board.doubleJeopardy;
}

/**
 * Implements the find board cell function.
 *
 * Parameters:
 * - `board` (`SharedEpisode`): Caller-provided value consumed by the function body.
 * - `clueId` (`number`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `{ round: RoundKind; clue: SharedCell; } | null`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
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

/**
 * Implements the round has unplayed function.
 *
 * Parameters:
 * - `board` (`SharedEpisode`): Caller-provided value consumed by the function body.
 * - `round` (`RoundKind`): Caller-provided value consumed by the function body.
 * - `playedClueIds` (`number[]`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 */
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

/**
 * Implements the next selector user id function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 * - `selectorUserId` (`string | null`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
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

/**
 * Implements the read duration ms function.
 *
 * Parameters:
 * - `question` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `number`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function readDurationMs(question: string): number {
  const wordCount = question.split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_READING_MS, wordCount * READING_RATE_MS_PER_WORD);
}

/**
 * Builds result timing data.
 *
 * Parameters:
 * - `now` (`Date`): Date-like value converted into the canonical date or timestamp representation.
 *
 * Output:
 * - `{ resultBeganAt: string; advanceUnlocksAt: string; }`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
function buildResultTiming(now = new Date()) {
  return {
    resultBeganAt: now.toISOString(),
    advanceUnlocksAt: new Date(
      now.getTime() + RESULT_ADVANCE_DELAY_MS,
    ).toISOString(),
  };
}

/**
 * Implements the result advance unlock ms function.
 *
 * Parameters:
 * - `phase` (`Extract<RoomPhase, { kind: "RESULT" }>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `number`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
function resultAdvanceUnlockMs(
  phase: Extract<RoomPhase, { kind: "RESULT" }>,
): number {
  const explicitUnlock = phase.advanceUnlocksAt
    ? new Date(phase.advanceUnlocksAt).getTime()
    : NaN;
  if (Number.isFinite(explicitUnlock)) return explicitUnlock;
  const beganAt = phase.resultBeganAt
    ? new Date(phase.resultBeganAt).getTime()
    : NaN;
  return Number.isFinite(beganAt) ? beganAt + RESULT_ADVANCE_DELAY_MS : 0;
}

/**
 * Implements the max daily double wager function.
 *
 * Parameters:
 * - `round` (`RoundKind`): Caller-provided value consumed by the function body.
 * - `score` (`number`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `number`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function maxDailyDoubleWager(round: RoundKind, score: number): number {
  return Math.max(score, round === "JEOPARDY" ? 1000 : 2000);
}

/**
 * Normalizes origin host input.
 *
 * Parameters:
 * - `origin` (`string | undefined`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function parseOriginHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Implements the serialize room function.
 *
 * Parameters:
 * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
 * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
 * - `board` (`SharedEpisode`): Caller-provided value consumed by the function body.
 * - `runtime` (`Runtime | undefined`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `PublicRoomState`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
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
    serverNow: new Date().toISOString(),
    board,
    state,
    players: room.players
      .sort((a, b) => a.seat - b.seat)
      .map((player) => ({
        userId: player.userId,
        displayName: player.user.displayName,
        seat: player.seat,
        isHost: player.userId === room.hostUserId,
        role: playerRoleFromSeat(player.seat),
        connected: Boolean(runtime?.clients.get(player.userId)?.size),
        left: Boolean(player.leftAt),
        score: state.scores[player.userId] ?? 0,
      })),
    createdAt: room.createdAt.toISOString(),
    startedAt: room.startedAt?.toISOString() ?? null,
    completedAt: room.completedAt?.toISOString() ?? null,
  };
}

/**
 * Implements the personalize room function.
 *
 * Parameters:
 * - `snapshot` (`PublicRoomState`): Caller-provided value consumed by the function body.
 * - `viewerUserId` (`string`): Identifier value used to look up, compare, or persist related records.
 * - `runtime` (`Runtime | undefined`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `PublicRoomState`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function personalizeRoom(
  snapshot: PublicRoomState,
  viewerUserId: string,
  runtime: Runtime | undefined,
): PublicRoomState {
  const viewer = snapshot.players.find((player) => player.userId === viewerUserId);
  const isAudience = viewer?.role === "AUDIENCE" && !viewer.left;
  const phase = snapshot.state.phase;
  let personalizedPhase: RoomPhase = phase;

  if (phase.kind === "DD_WAGER") {
    const draft = runtime?.draft;
    personalizedPhase = {
      ...phase,
      wagerDraft:
        draft?.kind === "dd-wager" &&
        draft.phaseKey === ddWagerDraftKey(phase) &&
        draft.userId === phase.playerUserId
          ? draft.value
          : "",
    };
  } else if (phase.kind === "ANSWERING") {
    const draft = runtime?.draft;
    personalizedPhase = {
      ...phase,
      answerDraft:
        isAudience &&
        !phase.dailyDouble &&
        draft?.kind === "answer" &&
        draft.phaseKey === answerDraftKey(phase) &&
        draft.userId === phase.answeringUserId
          ? draft.value
          : "",
    };
  } else if (phase.kind === "FINAL_WAGER") {
    const ownWagers =
      viewer?.role === "PLAYER" && viewerUserId in phase.wagers
        ? { [viewerUserId]: phase.wagers[viewerUserId] }
        : {};
    personalizedPhase = {
      ...phase,
      wagers: ownWagers,
      submittedCount: Object.keys(phase.wagers).length,
    };
  } else if (phase.kind === "FINAL_ANSWER") {
    const ownWagers =
      viewer?.role === "PLAYER" && viewerUserId in phase.wagers
        ? { [viewerUserId]: phase.wagers[viewerUserId] }
        : {};
    const ownAnswers =
      viewer?.role === "PLAYER" && viewerUserId in phase.answers
        ? { [viewerUserId]: phase.answers[viewerUserId] }
        : {};
    personalizedPhase = {
      ...phase,
      wagers: ownWagers,
      answers: ownAnswers,
      submittedCount: Object.keys(phase.answers).length,
    };
  } else if (phase.kind === "FINAL_REVEAL") {
    const visibleCount = Math.min(phase.revealIndex + 1, phase.results.length);
    const visibleResults = phase.results.slice(0, visibleCount).map((result, idx) => {
      const wagerRevealed =
        idx < phase.revealIndex || phase.revealStep === "WAGER";
      return wagerRevealed
        ? { ...result, wagerRevealed: true }
        : {
            ...result,
            valueDelta: 0,
            wager: 0,
            wagerRevealed: false,
          };
    });
    personalizedPhase = {
      ...phase,
      results: visibleResults,
    };
  }

  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      scores: { ...snapshot.state.scores },
      phase: personalizedPhase,
    },
    players: snapshot.players.map((player) => ({ ...player })),
  };
}

export class MultiplayerService {
  private runtimes = new Map<string, Runtime>();
  private roomLocks = new Map<string, Promise<unknown>>();
  private wss: WebSocketServer | null = null;

  /**
   * Builds room data.
   *
   * Parameters:
   * - `params` (`{ hostUserId: string; source: "episode" | "mixed"; date?: string; }`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
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
    const runtime = this.runtimes.get(room.id);
    const snapshot = serializeRoom(room, state, board, runtime);
    return personalizeRoom(snapshot, params.hostUserId, runtime);
  }

  /**
   * Implements the join room method.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   */
  async joinRoom(codeRaw: string, userId: string): Promise<PublicRoomState> {
    const code = normalizeRoomCode(codeRaw);
    const room = await this.loadRoomByCode(code);
    return this.withRoomLock(room.id, async () => {
      const current = await this.loadRoomByCode(code);
      const existing = current.players.find((player) => player.userId === userId);
      const state = getRoomState(current);
      const board = getBoardPayload(current);

      if (existing) {
        if (existing.leftAt) {
          throw this.httpError(409, "room seat is no longer available");
        }
        const runtime = this.runtimes.get(current.id);
        const snapshot = serializeRoom(current, state, board, runtime);
        return personalizeRoom(snapshot, userId, runtime);
      }

      if (current.status === "COMPLETE" || current.status === "ABANDONED") {
        throw this.httpError(409, "room has ended");
      }

      const playerSeat =
        current.status === "LOBBY"
          ? nextOpenSeat(current.players, 1, MAX_PLAYERS)
          : null;
      const seat = playerSeat ?? nextOpenSeat(current.players, MAX_PLAYERS + 1);
      if (!seat) {
        throw this.httpError(409, "audience is full");
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
      await this.ensureRoomRuntime(updated);
      const snapshot = serializeRoom(
        updated,
        nextState,
        board,
        this.runtimes.get(updated.id),
      );
      this.broadcastSnapshot(updated.id, snapshot);
      return personalizeRoom(snapshot, userId, this.runtimes.get(updated.id));
    });
  }

  /**
   * Implements the get room method.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
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
    const runtime = this.runtimes.get(hydrated.id);
    const snapshot = serializeRoom(
      hydrated,
      getRoomState(hydrated),
      getBoardPayload(hydrated),
      runtime,
    );
    return personalizeRoom(snapshot, userId, runtime);
  }

  /**
   * Implements the start room method.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
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
      return personalizeRoom(snapshot, userId, this.runtimes.get(updated.id));
    });
  }

  /**
   * Implements the leave room method.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
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
          const snapshot = await this.abandonRoom(
            current,
            state,
            "Host closed the room.",
          );
          return personalizeRoom(snapshot, userId, this.runtimes.get(current.id));
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
          const snapshot = await this.abandonRoom(
            current,
            state,
            "Host left the game.",
          );
          return personalizeRoom(snapshot, userId, this.runtimes.get(current.id));
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
      return personalizeRoom(snapshot, userId, this.runtimes.get(updated.id));
    });
  }

  /**
   * Implements the connect socket method.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `socket` (`WebSocket`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
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
    this.sendJson(socket, {
      type: "room-state",
      room: personalizeRoom(snapshot, userId, this.runtimes.get(hydrated.id)),
    });
    this.broadcastSnapshot(hydrated.id, snapshot);
  }

  /**
   * Implements the disconnect socket method.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `socket` (`WebSocket`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
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

  /**
   * Handles the action workflow.
   *
   * Parameters:
   * - `codeRaw` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `action` (`Action`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
  async handleAction(codeRaw: string, userId: string, action: Action) {
    const code = normalizeRoomCode(codeRaw);
    if (action.type === "update-draft") {
      return this.handleDraftUpdate(code, userId, action.value);
    }
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
      if (!isContestant(player)) {
        throw this.httpError(403, "audience members cannot play clues");
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
      return personalizeRoom(snapshot, userId, this.runtimes.get(updatedRoom.id));
    });
  }

  /**
   * Implements the attach method.
   *
   * Parameters:
   * - `server` (`HttpServer`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
   * - Tokenizes or pattern-matches strings to derive comparable values.
   * - Transforms credentials or session data into hashes, tokens, or cookies.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  attach(server: HttpServer) {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    /**
     * Handles the upgrade event callback registered on server.
     *
     * Parameters:
     * - `req` (`IncomingMessage`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
     * - `socket` (`Duplex`): Caller-provided value consumed by the function body.
     * - `head` (`NonSharedBuffer`): Caller-provided value consumed by the function body.
     *
     * Output:
     * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
     *
     * Data transformations:
     * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
     * - Tokenizes or pattern-matches strings to derive comparable values.
     * - Transforms credentials or session data into hashes, tokens, or cookies.
     * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
     */
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

    /**
     * Handles the connection event callback registered on wss.
     *
     * Parameters:
     * - `socket` (`WebSocket`): Caller-provided value consumed by the function body.
     * - `code` (`string`): Code string normalized or validated before lookup.
     * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
     */
    wss.on("connection", (socket: WebSocket, code: string, userId: string) => {
      void this.connectSocket(code, userId, socket).catch((err) => {
        this.sendJson(socket, {
          type: "error",
          message: err instanceof Error ? err.message : "connection failed",
        });
        socket.close(1008, "unauthorized");
      });
      /**
       * Handles the message event callback registered on socket.
       *
       * Parameters:
       * - `raw` (`RawData`): Untrusted or loosely typed input normalized before the rest of the function uses it.
       *
       * Output:
       * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
       *
       * Data transformations:
       * - Performs control-flow checks and returns or mutates values without additional structural transformation.
       */
      socket.on("message", (raw: RawData) => {
        void this.handleSocketMessage(socket, code, userId, raw);
      });
      /**
       * Handles the close event callback registered on socket.
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
      socket.on("close", () => {
        void this.disconnectSocket(code, userId, socket);
      });
    });
  }

  /**
   * Handles the socket message workflow.
   *
   * Parameters:
   * - `socket` (`WebSocket`): Caller-provided value consumed by the function body.
   * - `code` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `raw` (`RawData`): Untrusted or loosely typed input normalized before the rest of the function uses it.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Validates unknown input with schema/runtime checks before using narrowed values.
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
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

  /**
   * Handles the draft update workflow.
   *
   * Parameters:
   * - `code` (`string`): Code string normalized or validated before lookup.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `valueRaw` (`string`): Untrusted or loosely typed input normalized before the rest of the function uses it.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
  private async handleDraftUpdate(
    code: string,
    userId: string,
    valueRaw: string,
  ): Promise<PublicRoomState> {
    const room = await this.loadRoomByCode(code);
    const member = room.players.find(
      (entry) => entry.userId === userId && !entry.leftAt,
    );
    if (!member) {
      throw this.httpError(403, "not a member of this room");
    }
    if (!isContestant(member)) {
      throw this.httpError(403, "audience members cannot submit live input");
    }
    const state = getRoomState(room);
    if (state.paused) {
      throw this.httpError(409, "room is paused while the host reconnects");
    }

    const runtime = this.getRuntime(room.id);
    const value = valueRaw.slice(0, 400);
    if (state.phase.kind === "DD_WAGER" && state.phase.playerUserId === userId) {
      runtime.draft = {
        kind: "dd-wager",
        phaseKey: ddWagerDraftKey(state.phase),
        userId,
        value: value.replace(/[^\d]/g, "").slice(0, 6),
      };
    } else if (
      state.phase.kind === "ANSWERING" &&
      state.phase.answeringUserId === userId &&
      !state.phase.dailyDouble
    ) {
      runtime.draft = {
        kind: "answer",
        phaseKey: answerDraftKey(state.phase),
        userId,
        value,
      };
    } else {
      throw this.httpError(409, "the room is not accepting live input");
    }

    const snapshot = serializeRoom(room, state, getBoardPayload(room), runtime);
    this.broadcastSnapshot(room.id, snapshot);
    return personalizeRoom(snapshot, userId, runtime);
  }

  /**
   * Implements the get runtime method.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Runtime`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
   */
  private getRuntime(roomId: string): Runtime {
    const existing = this.runtimes.get(roomId);
    if (existing) return existing;
    const runtime: Runtime = {
      clients: new Map(),
      mainTimer: null,
      hostGraceTimer: null,
      draft: null,
    };
    this.runtimes.set(roomId, runtime);
    return runtime;
  }

  /**
   * Builds room record data.
   *
   * Parameters:
   * - `hostUserId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `board` (`SharedEpisode`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<RoomWithPlayers>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
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

  /**
   * Loads room by code data.
   *
   * Parameters:
   * - `code` (`string`): Code string normalized or validated before lookup.
   *
   * Output:
   * - `Promise<RoomWithPlayers>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   */
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

  /**
   * Implements the ensure room runtime method.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<RoomWithPlayers>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  private async ensureRoomRuntime(room: RoomWithPlayers): Promise<RoomWithPlayers> {
    const state = getRoomState(room);
    this.scheduleRoom(room, state);
    if (state.hostReconnectDeadlineAt) {
      this.scheduleHostGrace(room.id, room.code, state);
    }
    return room;
  }

  /**
   * Implements the schedule room method.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
  private scheduleRoom(room: RoomWithPlayers, state: RoomState) {
    this.clearMainTimer(room.id);
    if (state.paused) return;
    const deadlineAt = phaseDeadlineAt(state.phase);
    if (!deadlineAt) return;
    const delay = Math.max(0, new Date(deadlineAt).getTime() - Date.now());
    const runtime = this.getRuntime(room.id);
    /**
     * Runs the delayed setTimeout timer callback.
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
    runtime.mainTimer = setTimeout(() => {
      void this.handleTimer(room.code, room.id);
    }, delay);
  }

  /**
   * Implements the schedule host grace method.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `code` (`string`): Code string normalized or validated before lookup.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
  private scheduleHostGrace(roomId: string, code: string, state: RoomState) {
    this.clearHostGraceTimer(roomId);
    if (!state.hostReconnectDeadlineAt) return;
    const delay = Math.max(
      0,
      new Date(state.hostReconnectDeadlineAt).getTime() - Date.now(),
    );
    const runtime = this.getRuntime(roomId);
    /**
     * Runs the delayed setTimeout timer callback.
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
    runtime.hostGraceTimer = setTimeout(() => {
      void this.handleHostGraceExpiry(roomId, code);
    }, delay);
  }

  /**
   * Clears main timer state or resources.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  private clearMainTimer(roomId: string) {
    const runtime = this.runtimes.get(roomId);
    if (!runtime?.mainTimer) return;
    clearTimeout(runtime.mainTimer);
    runtime.mainTimer = null;
  }

  /**
   * Clears host grace timer state or resources.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  private clearHostGraceTimer(roomId: string) {
    const runtime = this.runtimes.get(roomId);
    if (!runtime?.hostGraceTimer) return;
    clearTimeout(runtime.hostGraceTimer);
    runtime.hostGraceTimer = null;
  }

  /**
   * Handles the timer workflow.
   *
   * Parameters:
   * - `code` (`string`): Code string normalized or validated before lookup.
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
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
              buzzedUserIds: [],
              attempts: [],
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

  /**
   * Handles the host grace expiry workflow.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `code` (`string`): Code string normalized or validated before lookup.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
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

  /**
   * Handles the select clue workflow.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `clueId` (`number`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `{ state: RoomState; status: RoomStatus }`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
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

  /**
   * Handles the buzz workflow.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `{ state: RoomState; status: RoomStatus }`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
  private handleBuzz(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
  ): { state: RoomState; status: RoomStatus } {
    if (room.status !== "LIVE" || state.phase.kind !== "BUZZ_OPEN") {
      throw this.httpError(409, "buzzing is not open");
    }
    const buzzedUserIds = phaseBuzzedUserIds(state.phase);
    if (buzzedUserIds.includes(userId)) {
      throw this.httpError(409, "you already buzzed on this clue");
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
          buzzedUserIds,
          attempts: phaseBuzzAttempts(state.phase),
        },
      },
    };
  }

  /**
   * Handles the submit wager workflow.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `wager` (`number`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<{ state: RoomState; status: RoomStatus }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
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
            buzzedUserIds: [],
            attempts: [],
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

  /**
   * Handles the submit answer workflow.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `answer` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<{ state: RoomState; status: RoomStatus }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
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
    const scores = {
      ...state.scores,
      [userId]: (state.scores[userId] ?? 0) + verdict.valueDelta,
    };
    const attempt: BuzzAttempt = {
      userId,
      submittedAnswer: answer.trim(),
      correct: verdict.correct,
      valueDelta: verdict.valueDelta,
      llmVerdict: verdict.llmVerdict,
      timedOut: answer.trim().length === 0,
    };
    const attempts = [...phaseBuzzAttempts(state.phase), attempt];

    if (!state.phase.dailyDouble && !verdict.correct) {
      const buzzedUserIds = uniqueUserIds([
        ...phaseBuzzedUserIds(state.phase),
        userId,
      ]);
      // Wrong regular-clue attempts keep the clue live for everyone who has
      // not tried yet. Returning BUZZ_OPEN here also withholds canonicalAnswer.
      if (!allActivePlayersAttempted(room, buzzedUserIds)) {
        return {
          status: "LIVE",
          state: {
            ...state,
            scores,
            phase: {
              kind: "BUZZ_OPEN",
              round: state.phase.round,
              clue: state.phase.clue,
              buzzClosesAt: new Date(
                Date.now() + BUZZ_WINDOW_MS,
              ).toISOString(),
              buzzedUserIds,
              attempts,
            },
          },
        };
      }
    }

    const playedClueIds = state.playedClueIds.includes(state.phase.clue.id)
      ? state.playedClueIds
      : [...state.playedClueIds, state.phase.clue.id];
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
          ...buildResultTiming(),
          result: {
            answeredByUserId: userId,
            submittedAnswer: answer.trim(),
            correct: verdict.correct,
            canonicalAnswer: verdict.canonicalAnswer,
            valueDelta: verdict.valueDelta,
            llmVerdict: verdict.llmVerdict,
            timedOut: answer.trim().length === 0,
            noBuzz: false,
            attempts,
          },
        },
      },
    };
  }

  /**
   * Handles the advance workflow.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `{ state: RoomState; status: RoomStatus }`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
  private handleAdvance(
    room: RoomWithPlayers,
    state: RoomState,
    userId: string,
  ): { state: RoomState; status: RoomStatus } {
    if (state.phase.kind === "FINAL_REVEAL") {
      if (room.hostUserId !== userId) {
        throw this.httpError(403, "only the host can advance Final Jeopardy");
      }
      return this.advanceFinalReveal(state);
    }
    if (state.phase.kind !== "RESULT") {
      throw this.httpError(409, "there is no result screen to advance");
    }
    const answeredByUserId = state.phase.result.answeredByUserId;
    const answeredByActive = answeredByUserId
      ? activePlayerUserIds(room).includes(answeredByUserId)
      : false;
    const advanceUserId = answeredByActive ? answeredByUserId : room.hostUserId;
    if (advanceUserId !== userId) {
      throw this.httpError(
        403,
        answeredByActive
          ? "only the player who answered can advance this clue"
          : "only the host can advance this clue",
      );
    }
    if (Date.now() < resultAdvanceUnlockMs(state.phase)) {
      throw this.httpError(409, "the answer reveal is still in its read delay");
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

  /**
   * Implements the advance final reveal method.
   *
   * Parameters:
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   *
   * Output:
   * - `{ state: RoomState; status: RoomStatus }`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  private advanceFinalReveal(
    state: RoomState,
  ): { state: RoomState; status: RoomStatus } {
    if (state.phase.kind !== "FINAL_REVEAL") {
      return { state, status: "FINAL" };
    }
    const phase = state.phase;
    const current = phase.results[phase.revealIndex];
    if (!current) {
      return {
        status: "COMPLETE",
        state: {
          ...state,
          phase: {
            kind: "COMPLETE",
            finalResults: phase.results,
            reason: null,
          },
        },
      };
    }

    if (phase.revealStep === "ANSWER") {
      return {
        status: "FINAL",
        state: {
          ...state,
          scores: {
            ...state.scores,
            [current.userId]: (state.scores[current.userId] ?? 0) + current.valueDelta,
          },
          phase: {
            ...phase,
            revealStep: "WAGER",
          },
        },
      };
    }

    const nextIndex = phase.revealIndex + 1;
    if (nextIndex < phase.results.length) {
      return {
        status: "FINAL",
        state: {
          ...state,
          phase: {
            ...phase,
            revealIndex: nextIndex,
            revealStep: "ANSWER",
          },
        },
      };
    }

    return {
      status: "COMPLETE",
      state: {
        ...state,
        phase: {
          kind: "COMPLETE",
          finalResults: phase.results,
          reason: null,
        },
      },
    };
  }

  /**
   * Implements the pass clue on no buzz method.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   *
   * Output:
   * - `Promise<RoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   */
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
      ...buildResultTiming(),
      result: {
        answeredByUserId: null,
        submittedAnswer: "",
        correct: false,
        canonicalAnswer: clue?.answer ?? "(unavailable)",
        valueDelta: 0,
        llmVerdict: null,
        timedOut: false,
        noBuzz: true,
        attempts: phaseBuzzAttempts(state.phase),
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

  /**
   * Implements the timeout final wagers method.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   *
   * Output:
   * - `Promise<{ state: RoomState; status: RoomStatus }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
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

  /**
   * Implements the resolve final answers method.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   *
   * Output:
   * - `Promise<{ state: RoomState; status: RoomStatus }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   */
  private async resolveFinalAnswers(
    room: RoomWithPlayers,
    state: RoomState,
  ): Promise<{ state: RoomState; status: RoomStatus }> {
    if (state.phase.kind !== "FINAL_ANSWER") {
      return { state, status: room.status };
    }
    const finalResults: FinalResult[] = [];
    const responseTimeMs = Math.min(
      FINAL_ANSWER_WINDOW_MS,
      Math.max(0, Date.now() - new Date(state.phase.startedAt).getTime()),
    );
    const seatByUserId = new Map(
      room.players.map((player) => [player.userId, player.seat]),
    );
    const revealUserIds = [...state.phase.eligibleUserIds].sort(
      (a, b) =>
        (state.scores[a] ?? 0) - (state.scores[b] ?? 0) ||
        (seatByUserId.get(a) ?? 0) - (seatByUserId.get(b) ?? 0),
    );
    for (const userId of revealUserIds) {
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
      status: "FINAL",
      state: {
        ...state,
        phase: {
          kind: "FINAL_REVEAL",
          clue: state.phase.clue,
          eligibleUserIds: state.phase.eligibleUserIds,
          results: finalResults,
          revealIndex: 0,
          revealStep: "ANSWER",
        },
      },
    };
  }

  /**
   * Implements the abandon room method.
   *
   * Parameters:
   * - `room` (`RoomWithPlayers`): Caller-provided value consumed by the function body.
   * - `state` (`RoomState`): State object copied or narrowed before a new state value is produced.
   * - `reason` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<PublicRoomState>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Reads from or writes to Prisma models and reshapes database rows into application data.
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
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

  /**
   * Implements the broadcast snapshot method.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `snapshot` (`PublicRoomState`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   */
  private broadcastSnapshot(roomId: string, snapshot: PublicRoomState) {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    for (const [userId, sockets] of runtime.clients.entries()) {
      const payload = JSON.stringify({
        type: "room-state",
        room: personalizeRoom(snapshot, userId, runtime),
      });
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      }
    }
  }

  /**
   * Implements the close user sockets method.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  private closeUserSockets(roomId: string, userId: string) {
    const runtime = this.runtimes.get(roomId);
    const sockets = runtime?.clients.get(userId);
    if (!sockets) return;
    for (const socket of sockets) {
      socket.close(1000, "left room");
    }
    runtime?.clients.delete(userId);
  }

  /**
   * Implements the send json method.
   *
   * Parameters:
   * - `socket` (`WebSocket`): Caller-provided value consumed by the function body.
   * - `payload` (`unknown`): Structured payload validated and projected into the required output shape.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   */
  private sendJson(socket: WebSocket, payload: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  /**
   * Implements the http error method.
   *
   * Parameters:
   * - `status` (`number`): Caller-provided value consumed by the function body.
   * - `message` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Error & { status?: number; }`: Numeric value calculated from inputs, state, or persisted data.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  private httpError(status: number, message: string) {
    const err = new Error(message) as Error & { status?: number };
    err.status = status;
    return err;
  }

  /**
   * Implements the with room lock method.
   *
   * Parameters:
   * - `roomId` (`string`): Identifier value used to look up, compare, or persist related records.
   * - `work` (`() => Promise<T>`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<T>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  private async withRoomLock<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    /**
     * Implements the release function.
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
