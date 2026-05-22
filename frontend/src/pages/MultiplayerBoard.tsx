import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { TimerBar } from "../components/TimerBar";
import { RetryPanel } from "../components/RetryPanel";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type RoundKind = "JEOPARDY" | "DOUBLE_JEOPARDY";
type RoomStatus = "LOBBY" | "LIVE" | "FINAL" | "COMPLETE" | "ABANDONED";
type PlayerRole = "PLAYER" | "AUDIENCE";

type Cell = {
  id: number;
  question: string;
  value: number;
  round: "JEOPARDY" | "DOUBLE_JEOPARDY" | "FINAL_JEOPARDY";
  category: string;
  dailyDouble: boolean;
};

type RoundBoard = {
  values: number[];
  categories: { name: string; cells: Array<Cell | null> }[];
};

type Episode = {
  date?: string;
  jeopardy: RoundBoard;
  doubleJeopardy: RoundBoard;
  finalJeopardy: Cell | null;
};

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
  | { kind: "READING"; round: RoundKind; clue: Cell; readEndsAt: string }
  | {
      kind: "BUZZ_OPEN";
      round: RoundKind;
      clue: Cell;
      buzzClosesAt: string;
      buzzedUserIds: string[];
      attempts: BuzzAttempt[];
    }
  | {
      kind: "DD_WAGER";
      round: RoundKind;
      clue: Cell;
      playerUserId: string;
      maxWager: number;
      wagerDeadlineAt: string;
      wagerDraft?: string;
    }
  | {
      kind: "ANSWERING";
      round: RoundKind;
      clue: Cell;
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
      clue: Cell;
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
      clue: Cell;
      eligibleUserIds: string[];
      wagers: Record<string, number>;
      startedAt: string;
      deadlineAt: string;
      submittedCount?: number;
    }
  | {
      kind: "FINAL_ANSWER";
      clue: Cell;
      eligibleUserIds: string[];
      wagers: Record<string, number>;
      answers: Record<string, string>;
      startedAt: string;
      deadlineAt: string;
      submittedCount?: number;
    }
  | {
      kind: "FINAL_REVEAL";
      clue: Cell;
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

type Room = {
  code: string;
  status: RoomStatus;
  hostUserId: string;
  serverNow: string;
  board: Episode;
  state: {
    version: 1;
    playedClueIds: number[];
    scores: Record<string, number>;
    selectorUserId: string | null;
    phase: RoomPhase;
    paused: { reason: "HOST_DISCONNECTED"; remainingMs: number | null } | null;
    hostReconnectDeadlineAt: string | null;
  };
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

type SocketMessage =
  | { type: "room-state"; room: Room }
  | { type: "error"; message: string };

const RESULT_ADVANCE_DELAY_MS = 1500;
const RESULT_ADVANCE_TICK_MS = 50;
const BUZZ_WINDOW_MS = 5000;
const ANSWER_WINDOW_MS = 5000;
const DD_WAGER_WINDOW_MS = 15000;
const DD_ANSWER_WINDOW_MS = 15000;
const FINAL_WAGER_WINDOW_MS = 30000;
const FINAL_ANSWER_WINDOW_MS = 30000;
const MIN_DD_WAGER = 5;

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
 * Implements the format room code function.
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
function formatRoomCode(raw: string): string {
  return normalizeRoomCode(raw).replace(/(.{3})(?=.)/g, "$1-");
}

/**
 * Implements the ws url function.
 *
 * Parameters:
 * - `code` (`string`): Code string normalized or validated before lookup.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function wsUrl(code: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/multiplayer/ws?code=${encodeURIComponent(code)}`;
}

/**
 * Implements the remaining ms function.
 *
 * Parameters:
 * - `deadlineAt` (`string`): Caller-provided value consumed by the function body.
 * - `serverClockOffsetMs` (`number`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `number`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function remainingMs(deadlineAt: string, serverClockOffsetMs = 0): number {
  const deadlineMs = parseTimeMs(deadlineAt);
  if (deadlineMs == null) return 0;
  return Math.max(0, deadlineMs - (Date.now() + serverClockOffsetMs));
}

/**
 * Implements the timer time left ms function.
 *
 * Parameters:
 * - `deadlineAt` (`string`): Caller-provided value consumed by the function body.
 * - `serverClockOffsetMs` (`number`): Caller-provided value consumed by the function body.
 * - `maxMs` (`number` optional): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `number`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function timerTimeLeftMs(
  deadlineAt: string,
  serverClockOffsetMs: number,
  maxMs?: number,
): number {
  const timeLeftMs = remainingMs(deadlineAt, serverClockOffsetMs);
  return maxMs == null ? timeLeftMs : Math.min(maxMs, timeLeftMs);
}

/**
 * Implements the player name function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 * - `userId` (`string | null`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function playerName(room: Room, userId: string | null): string {
  if (!userId) return "Nobody";
  return room.players.find((player) => player.userId === userId)?.displayName ?? "Unknown";
}

/**
 * Implements the current round function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `RoundKind | null`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function currentRound(room: Room): RoundKind | null {
  switch (room.state.phase.kind) {
    case "BOARD":
    case "READING":
    case "BUZZ_OPEN":
    case "DD_WAGER":
    case "ANSWERING":
    case "RESULT":
      return room.state.phase.round;
    default:
      return null;
  }
}

/**
 * Implements the current board function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `RoundBoard | null`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function currentBoard(room: Room): RoundBoard | null {
  const round = currentRound(room);
  if (!round) return null;
  return round === "JEOPARDY" ? room.board.jeopardy : room.board.doubleJeopardy;
}

/**
 * Implements the standings function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `{ userId: string; displayName: string; seat: number; isHost: boolean; role: PlayerRole; connected: boolean; left: boolean; score: number; }[]`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function standings(room: Room) {
  return contestants(room).sort((a, b) => b.score - a.score || a.seat - b.seat);
}

/**
 * Implements the contestants function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `{ userId: string; displayName: string; seat: number; isHost: boolean; role: PlayerRole; connected: boolean; left: boolean; score: number; }[]`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function contestants(room: Room) {
  return room.players.filter((player) => player.role === "PLAYER");
}

/**
 * Implements the audience members function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `{ userId: string; displayName: string; seat: number; isHost: boolean; role: PlayerRole; connected: boolean; left: boolean; score: number; }[]`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function audienceMembers(room: Room) {
  return room.players.filter((player) => player.role === "AUDIENCE");
}

/**
 * Checks the own condition.
 *
 * Parameters:
 * - `record` (`T`): Caller-provided value consumed by the function body.
 * - `key` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `key is keyof T & string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function hasOwn<T extends object>(record: T, key: string): key is keyof T & string {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Implements the display draft wager function.
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
function displayDraftWager(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "$";
  return `$${Number(digits).toLocaleString()}`;
}

/**
 * Normalizes time ms input.
 *
 * Parameters:
 * - `raw` (`string` optional): Untrusted or loosely typed input normalized before the rest of the function uses it.
 *
 * Output:
 * - `number | null`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
function parseTimeMs(raw?: string): number | null {
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Implements the result advance actor user id function.
 *
 * Parameters:
 * - `room` (`Room`): Caller-provided value consumed by the function body.
 * - `phase` (`Extract<RoomPhase, { kind: "RESULT" }>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function resultAdvanceActorUserId(
  room: Room,
  phase: Extract<RoomPhase, { kind: "RESULT" }>,
): string {
  const answeredByUserId = phase.result.answeredByUserId;
  const answeredByActive = Boolean(
    answeredByUserId &&
      contestants(room).some(
        (player) => player.userId === answeredByUserId && !player.left,
      ),
  );
  return answeredByActive && answeredByUserId ? answeredByUserId : room.hostUserId;
}

/**
 * Renders the MultiplayerBoard React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 */
export function MultiplayerBoard() {
  useDocumentTitle("Online Multiplayer");
  const { user } = useAuth();
  const nav = useNavigate();
  const { code: codeParam } = useParams();
  const code = normalizeRoomCode(codeParam ?? "");
  const [room, setRoom] = useState<Room | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [createBusy, setCreateBusy] = useState<"episode" | "mixed" | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [socketState, setSocketState] = useState<
    "idle" | "connecting" | "reconnecting" | "open" | "closed"
  >(code ? "connecting" : "idle");
  const [answerInput, setAnswerInput] = useState("");
  const [wagerInput, setWagerInput] = useState("");
  const socketRef = useRef<WebSocket | null>(null);

  /**
   * Implements the my player function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `{ userId: string; displayName: string; seat: number; isHost: boolean; role: PlayerRole; connected: boolean; left: boolean; score: number; }`: Boolean decision value derived from validation, comparison, or state checks.
   *
   * Data transformations:
   * - Transforms collections with map/filter/reduce/sort/search operations.
   */
  const myPlayer = useMemo(
    () => room?.players.find((player) => player.userId === user?.id) ?? null,
    [room, user?.id],
  );
  const iAmHost = room?.hostUserId === user?.id;
  const iAmContestant = myPlayer?.role === "PLAYER" && !myPlayer.left;
  const iAmAudience = myPlayer?.role === "AUDIENCE" && !myPlayer.left;
  const hasBoardControl = iAmContestant && room?.state.selectorUserId === user?.id;
  /**
   * Implements the server clock offset ms function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `number`: Numeric value calculated from inputs, state, or persisted data.
   *
   * Data transformations:
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
  const serverClockOffsetMs = useMemo(() => {
    const serverNowMs = parseTimeMs(room?.serverNow);
    return serverNowMs == null ? 0 : serverNowMs - Date.now();
  }, [room?.serverNow]);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  useEffect(() => {
    setActionError(null);
    setAnswerInput("");
    setWagerInput("");
  }, [room?.state.phase.kind]);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `() => void`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    if (!code) {
      setRoom(null);
      setLoadError(null);
      setSocketState("idle");
      return;
    }
    let cancelled = false;
    setLoadError(null);
    api
      .get(`/multiplayer/rooms/${code}`)
      .then((res) => {
        if (cancelled) return;
        setRoom(res.data.room);
      })
      .catch((err: any) => {
        if (cancelled) return;
        const raw = err?.response?.data?.error;
        setLoadError(typeof raw === "string" ? raw : "Couldn't load that room.");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `() => void`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Validates unknown input with schema/runtime checks before using narrowed values.
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Computes numeric bounds, random values, or cryptographic tokens.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  useEffect(() => {
    if (!code || loadError) return;
    let stopped = false;
    let reconnectAttempts = 0;
    let reconnectTimer: number | null = null;

    /**
     * Implements the connect function.
     *
     * Parameters:
     * - None.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Validates unknown input with schema/runtime checks before using narrowed values.
     * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
     * - Updates application/browser state, cookies, or persistent browser storage from computed values.
     * - Computes numeric bounds, random values, or cryptographic tokens.
     * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
     */
    function connect() {
      if (stopped) return;
      const ws = new WebSocket(wsUrl(code));
      socketRef.current = ws;
      setSocketState(reconnectAttempts === 0 ? "connecting" : "reconnecting");

      ws.onopen = () => {
        if (stopped || socketRef.current !== ws) return;
        reconnectAttempts = 0;
        setSocketState("open");
        setActionError(null);
      };
      ws.onmessage = (event) => {
        if (socketRef.current !== ws) return;
        try {
          const message = JSON.parse(event.data) as SocketMessage;
          if (message.type === "room-state") {
            setRoom(message.room);
            setLoadError(null);
          } else if (message.type === "error") {
            setActionError(message.message);
          }
        } catch {
          setActionError("Received an unreadable room update.");
        }
      };
      ws.onclose = (event) => {
        if (socketRef.current !== ws) return;
        socketRef.current = null;
        if (stopped) return;
        if (event.code === 1002 || event.code === 1003 || event.code === 1008) {
          setSocketState("closed");
          setActionError(
            (current) =>
              current ?? (event.reason || "Live room connection was rejected."),
          );
          return;
        }

        reconnectAttempts += 1;
        setSocketState("reconnecting");
        const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts - 1, 4), 10000);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
      }
      const ws = socketRef.current;
      if (ws) {
        socketRef.current = null;
        ws.close(1000, "leaving room");
      }
    };
  }, [code, loadError]);

  const buzzOpenPhase = room?.state.phase.kind === "BUZZ_OPEN" ? room.state.phase : null;
  const iBuzzedThisClue = Boolean(
    user?.id && buzzOpenPhase?.buzzedUserIds?.includes(user.id),
  );
  const canBuzz = Boolean(
    buzzOpenPhase && !room?.state.paused && iAmContestant && !iBuzzedThisClue,
  );

  /**
   * Implements the send action function.
   *
   * Parameters:
   * - `payload` (`object`): Structured payload validated and projected into the required output shape.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  const sendAction = useCallback((payload: object) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setActionError("Live room connection is down. Waiting to reconnect.");
      return;
    }
    socketRef.current.send(JSON.stringify(payload));
  }, []);

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `() => void`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  useEffect(() => {
    if (!canBuzz) return;

    // Spacebar acts like the physical buzzer, but should not steal keyboard
    // behavior from form fields, buttons, or links that currently have focus.
    /**
     * Handles the key down event.
     *
     * Parameters:
     * - `event` (`KeyboardEvent`): Browser or React event object read for form, keyboard, or pointer state.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Performs control-flow checks and returns or mutates values without additional structural transformation.
     */
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || (event.code !== "Space" && event.key !== " ")) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (
        target?.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT" ||
        tagName === "BUTTON" ||
        tagName === "A"
      ) {
        return;
      }
      event.preventDefault();
      sendAction({ type: "buzz" });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canBuzz, buzzOpenPhase?.buzzClosesAt, sendAction]);

  /**
   * Builds room data.
   *
   * Parameters:
   * - `source` (`"episode" | "mixed"`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function createRoom(source: "episode" | "mixed") {
    setCreateBusy(source);
    setActionError(null);
    try {
      const { data } = await api.post("/multiplayer/rooms", { source });
      nav(`/board/multiplayer/${data.room.code}`, { replace: true });
    } catch (err: any) {
      const raw = err?.response?.data?.error;
      setActionError(typeof raw === "string" ? raw : "Couldn't create a room.");
    } finally {
      setCreateBusy(null);
    }
  }

  /**
   * Implements the join room function.
   *
   * Parameters:
   * - `e` (`FormEvent`): Browser or React event object read for form, keyboard, or pointer state.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function joinRoom(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeRoomCode(joinCode);
    if (!normalized || joinBusy) return;
    setJoinBusy(true);
    setActionError(null);
    try {
      const { data } = await api.post("/multiplayer/join", { code: normalized });
      nav(`/board/multiplayer/${data.room.code}`, { replace: true });
    } catch (err: any) {
      const raw = err?.response?.data?.error;
      setActionError(typeof raw === "string" ? raw : "Couldn't join that room.");
    } finally {
      setJoinBusy(false);
    }
  }

  /**
   * Implements the start room function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function startRoom() {
    if (!room || startBusy) return;
    setStartBusy(true);
    setActionError(null);
    try {
      const { data } = await api.post(`/multiplayer/rooms/${room.code}/start`);
      setRoom(data.room);
    } catch (err: any) {
      const raw = err?.response?.data?.error;
      setActionError(typeof raw === "string" ? raw : "Couldn't start the room.");
    } finally {
      setStartBusy(false);
      setLeaveBusy(false);
    }
  }

  /**
   * Implements the leave room function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
   *
   * Data transformations:
   * - Fetches remote/API data and projects the response into local state or return values.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  async function leaveRoom() {
    if (!room || leaveBusy) return;
    setLeaveBusy(true);
    setActionError(null);
    try {
      await api.post(`/multiplayer/rooms/${room.code}/leave`);
      nav("/board/multiplayer", { replace: true });
    } catch (err: any) {
      const raw = err?.response?.data?.error;
      setActionError(typeof raw === "string" ? raw : "Couldn't leave the room.");
    } finally {
      setLeaveBusy(false);
    }
  }

  /**
   * Implements the submit answer function.
   *
   * Parameters:
   * - `e` (`FormEvent`): Browser or React event object read for form, keyboard, or pointer state.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function submitAnswer(e: FormEvent) {
    e.preventDefault();
    sendAction({ type: "submit-answer", answer: answerInput });
    setAnswerInput("");
  }

  /**
   * Implements the submit wager function.
   *
   * Parameters:
   * - `e` (`FormEvent`): Browser or React event object read for form, keyboard, or pointer state.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function submitWager(e: FormEvent) {
    e.preventDefault();
    const wager = parseInt(wagerInput, 10);
    if (!Number.isFinite(wager)) {
      setActionError("Enter a whole-number wager.");
      return;
    }
    sendAction({ type: "submit-wager", wager });
    setWagerInput("");
  }

  /**
   * Implements the update wager input function.
   *
   * Parameters:
   * - `value` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function updateWagerInput(value: string) {
    setWagerInput(value);
    if (!user) return;
    const currentPhase = room?.state.phase;
    if (currentPhase?.kind === "DD_WAGER" && currentPhase.playerUserId === user.id) {
      sendAction({ type: "update-draft", value });
    }
  }

  /**
   * Implements the update answer input function.
   *
   * Parameters:
   * - `value` (`string`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  function updateAnswerInput(value: string) {
    setAnswerInput(value);
    if (!user) return;
    const currentPhase = room?.state.phase;
    if (
      currentPhase?.kind === "ANSWERING" &&
      currentPhase.answeringUserId === user.id &&
      !currentPhase.dailyDouble
    ) {
      sendAction({ type: "update-draft", value });
    }
  }

  if (!user) {
    return null;
  }

  if (!code) {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-3">
          <h1 className="font-category text-5xl text-jeopardy-gold">Online Multiplayer</h1>
          <p className="text-white/75 max-w-2xl mx-auto">
            Private live rooms for 3 players plus audience. Create a room,
            share the code, and play the same full board in real time.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <button
            onClick={() => void createRoom("episode")}
            disabled={createBusy !== null}
            className="clue-tile p-6 rounded text-left hover:scale-[1.02] transition disabled:opacity-60 disabled:cursor-wait"
          >
            <h2 className="font-category text-2xl text-jeopardy-gold">Host real episode</h2>
            <p className="mt-2 text-sm text-white/80">
              Random aired board, private room code, live buzz-in play.
            </p>
            <p className="mt-4 text-xs text-white/50">
              {createBusy === "episode" ? "Creating room…" : "Host room"}
            </p>
          </button>
          <button
            onClick={() => void createRoom("mixed")}
            disabled={createBusy !== null}
            className="clue-tile p-6 rounded text-left hover:scale-[1.02] transition disabled:opacity-60 disabled:cursor-wait"
          >
            <h2 className="font-category text-2xl text-jeopardy-gold">Host mixed board</h2>
            <p className="mt-2 text-sm text-white/80">
              Random categories, live room, same invite-only flow.
            </p>
            <p className="mt-4 text-xs text-white/50">
              {createBusy === "mixed" ? "Creating room…" : "Host room"}
            </p>
          </button>
        </div>

        <div className="max-w-md mx-auto bg-white/5 rounded p-4 space-y-3">
          <h2 className="font-category text-2xl text-jeopardy-gold text-center">
            Join with code
          </h2>
          <form onSubmit={joinRoom} className="flex gap-2">
            <input
              aria-label="Room code"
              autoComplete="off"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ABC-123"
              className="flex-1 px-3 py-3 rounded bg-white/10 uppercase tracking-[0.2em] text-center"
            />
            <button
              type="submit"
              disabled={joinBusy || normalizeRoomCode(joinCode).length !== 6}
              className="px-4 py-2 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
            >
              {joinBusy ? "…" : "Join"}
            </button>
          </form>
          {actionError && (
            <p className="text-sm text-red-300 text-center" role="alert">
              {actionError}
            </p>
          )}
          <p className="text-xs text-white/50 text-center">
            Already in a room? Enter the code exactly as the host sent it.
          </p>
        </div>

        <div className="text-center">
          <Link to="/board" className="text-sm text-white/60 underline">
            Back to single-player board
          </Link>
        </div>
      </div>
    );
  }

  if (loadError && !room) {
    return (
      <RetryPanel
        onRetry={() => nav(0)}
        message={loadError}
      />
    );
  }

  if (!room) {
    return <p className="text-center text-white/60 py-12">Loading room…</p>;
  }

  const phase = room.state.phase;
  const board = currentBoard(room);
  const played = new Set(room.state.playedClueIds);
  const roomCode = formatRoomCode(room.code);
  const selector = playerName(room, room.state.selectorUserId);
  const sortedStandings = standings(room);
  const paused = room.state.paused;
  const resultPhase = phase.kind === "RESULT" ? phase : null;
  const advanceResultUserId = resultPhase
    ? resultAdvanceActorUserId(room, resultPhase)
    : null;
  const iCanAdvanceResult = advanceResultUserId === user.id;

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-category text-4xl text-jeopardy-gold">Online Multiplayer</h1>
          <p className="text-sm text-white/60">
            Room code <span className="font-mono tracking-[0.2em]">{roomCode}</span>
          </p>
          <p className="text-xs text-white/45">
            {room.board.date ? `Episode aired ${room.board.date}` : "Mixed board"}
          </p>
          {iAmAudience && (
            <p className="text-xs text-jeopardy-gold/80">Audience view</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-xs px-2 py-1 rounded border ${
              socketState === "open"
                ? "border-green-400/40 text-green-200"
                : socketState === "closed"
                  ? "border-red-400/40 text-red-200"
                : "border-yellow-500/40 text-yellow-200"
            }`}
          >
            {socketState === "open"
              ? "Live connected"
              : socketState === "closed"
                ? "Connection lost"
                : socketState === "reconnecting"
                  ? "Reconnecting"
                  : "Connecting"}
          </span>
          <button
            onClick={() => void leaveRoom()}
            disabled={leaveBusy}
            className="px-3 py-2 rounded border border-white/30 hover:bg-white/10 text-sm disabled:opacity-60 disabled:cursor-wait"
          >
            {leaveBusy
              ? "Leaving…"
              : iAmHost && room.status !== "LOBBY"
                ? "End room"
                : room.status === "LOBBY"
                  ? "Leave lobby"
                  : "Forfeit seat"}
          </button>
        </div>
      </div>

      {actionError && (
        <p className="text-sm text-red-300" role="alert">
          {actionError}
        </p>
      )}
      {paused && (
        <div className="rounded border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
          The host disconnected. Room actions are paused while they reconnect.
        </div>
      )}

      <ScoreStrip room={room} meUserId={user.id} />

      {room.status === "LOBBY" && (
        <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-4">
          <section className="clue-tile rounded p-6 space-y-4">
            <h2 className="font-category text-3xl text-jeopardy-gold">Lobby</h2>
            <p className="text-white/75">
              Share <span className="font-mono tracking-[0.2em]">{roomCode}</span> with up to{" "}
              {Math.max(0, 3 - contestants(room).filter((player) => !player.left).length)} more player
              {contestants(room).filter((player) => !player.left).length === 2 ? "" : "s"}.
            </p>
            <p className="text-sm text-white/60">
              Extra joins enter the audience and follow the same room view without playing clues.
            </p>
            {iAmHost ? (
              <button
                onClick={() => void startRoom()}
                disabled={startBusy}
                className="px-6 py-3 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60 disabled:cursor-wait"
              >
                {startBusy ? "Starting…" : "Start game"}
              </button>
            ) : (
              <p className="text-sm text-white/70">
                Waiting for <span className="font-semibold">{playerName(room, room.hostUserId)}</span> to start the game.
              </p>
            )}
          </section>
          <PlayerRoster room={room} />
        </div>
      )}

      {(room.status === "LIVE" || room.status === "FINAL") && phase.kind === "BOARD" && board && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="font-category text-3xl text-jeopardy-gold">
                {phase.round === "DOUBLE_JEOPARDY" ? "Double Jeopardy!" : "Jeopardy!"}
              </h2>
              <p className="text-sm text-white/60">
                Board control: <span className="font-semibold">{selector}</span>
              </p>
            </div>
            <div className="text-sm text-white/70">
              {hasBoardControl ? "Pick the next clue." : `Waiting for ${selector} to choose.`}
            </div>
          </div>
          <BoardGrid
            board={board}
            played={played}
            selectable={hasBoardControl && !paused}
            onSelect={(clueId) => sendAction({ type: "select-clue", clueId })}
          />
        </div>
      )}

      {(phase.kind === "READING" ||
        phase.kind === "BUZZ_OPEN" ||
        phase.kind === "DD_WAGER" ||
        phase.kind === "ANSWERING" ||
        phase.kind === "RESULT" ||
        phase.kind === "FINAL_WAGER" ||
        phase.kind === "FINAL_ANSWER" ||
        phase.kind === "FINAL_REVEAL" ||
        phase.kind === "COMPLETE" ||
        phase.kind === "ABANDONED") && (
        <div className="grid lg:grid-cols-[1.25fr_0.75fr] gap-4">
          <section className="space-y-4">
            {phase.kind === "READING" && (
              <ClueStage
                heading="Clue revealed"
                clue={phase.clue}
                subtext={`Board control: ${selector}`}
              >
                <TimerBar
                  totalMs={Math.max(
                    1,
                    remainingMs(phase.readEndsAt, serverClockOffsetMs),
                  )}
                  resetKey={phase.readEndsAt}
                  paused={Boolean(paused)}
                  onExpire={() => {}}
                />
                <p className="text-sm text-white/70 text-center">
                  Buzz opens when the read timer ends.
                </p>
              </ClueStage>
            )}

            {phase.kind === "BUZZ_OPEN" && (
              <ClueStage
                heading="Buzz window"
                clue={phase.clue}
                subtext={`Board control: ${selector}`}
              >
                <TimerBar
                  totalMs={BUZZ_WINDOW_MS}
                  initialTimeLeftMs={timerTimeLeftMs(
                    phase.buzzClosesAt,
                    serverClockOffsetMs,
                    BUZZ_WINDOW_MS,
                  )}
                  resetKey={phase.buzzClosesAt}
                  paused={Boolean(paused)}
                  onExpire={() => {}}
                />
                {(phase.attempts?.length ?? 0) > 0 && (
                  <p className="text-sm text-white/70 text-center">
                    {phase.attempts.length} incorrect buzz
                    {phase.attempts.length === 1 ? "" : "es"} so far.
                  </p>
                )}
                <div className="flex justify-center">
                  <button
                    onClick={() => sendAction({ type: "buzz" })}
                    disabled={!canBuzz}
                    title="Buzz"
                    className="px-8 py-4 bg-jeopardy-gold text-black font-bold text-2xl rounded disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {iBuzzedThisClue ? "Out for clue" : "Buzz"}
                  </button>
                </div>
              </ClueStage>
            )}

            {phase.kind === "DD_WAGER" && (
              <ClueStage
                heading="Daily Double!"
                clue={phase.clue}
                subtext={`${playerName(room, phase.playerUserId)} controls this clue.`}
              >
                <TimerBar
                  totalMs={DD_WAGER_WINDOW_MS}
                  initialTimeLeftMs={timerTimeLeftMs(
                    phase.wagerDeadlineAt,
                    serverClockOffsetMs,
                    DD_WAGER_WINDOW_MS,
                  )}
                  resetKey={phase.wagerDeadlineAt}
                  paused={Boolean(paused)}
                  onExpire={() => {}}
                />
                <div className="max-w-md mx-auto rounded bg-black/30 border border-jeopardy-gold/30 px-4 py-5 text-center">
                  <div className="text-xs uppercase text-white/45">Live wager</div>
                  <div className="dollar text-4xl text-jeopardy-gold mt-1">
                    {displayDraftWager(
                      phase.playerUserId === user.id ? wagerInput : phase.wagerDraft ?? "",
                    )}
                  </div>
                  <div className="text-xs text-white/45 mt-2">
                    Maximum <span className="dollar">${phase.maxWager.toLocaleString()}</span>
                  </div>
                </div>
                {phase.playerUserId === user.id ? (
                  <form onSubmit={submitWager} className="flex gap-2 max-w-md mx-auto">
                    <input
                      autoFocus
                      aria-label="Daily Double wager"
                      type="number"
                      min={MIN_DD_WAGER}
                      max={phase.maxWager}
                      value={wagerInput}
                      onChange={(e) => updateWagerInput(e.target.value)}
                      placeholder={`$${MIN_DD_WAGER} to $${phase.maxWager}`}
                      className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
                    />
                    <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
                      Lock in
                    </button>
                  </form>
                ) : (
                  <p className="text-center text-sm text-white/70">
                    Waiting for {playerName(room, phase.playerUserId)} to lock in a wager.
                  </p>
                )}
              </ClueStage>
            )}

            {phase.kind === "ANSWERING" && (
              <ClueStage
                heading={phase.dailyDouble ? "Daily Double answer" : "Answer in"}
                clue={phase.clue}
                subtext={`Answering: ${playerName(room, phase.answeringUserId)}`}
              >
                <TimerBar
                  totalMs={phase.dailyDouble ? DD_ANSWER_WINDOW_MS : ANSWER_WINDOW_MS}
                  initialTimeLeftMs={timerTimeLeftMs(
                    phase.answerDeadlineAt,
                    serverClockOffsetMs,
                    phase.dailyDouble ? DD_ANSWER_WINDOW_MS : ANSWER_WINDOW_MS,
                  )}
                  resetKey={phase.answerDeadlineAt}
                  paused={Boolean(paused)}
                  onExpire={() => {}}
                />
                {phase.answeringUserId === user.id ? (
                  <form onSubmit={submitAnswer} className="flex gap-2">
                    <input
                      autoFocus
                      aria-label="Your answer"
                      autoComplete="off"
                      value={answerInput}
                      onChange={(e) => updateAnswerInput(e.target.value)}
                      placeholder="What is..."
                      className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
                    />
                    <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
                      Submit
                    </button>
                  </form>
                ) : iAmAudience && !phase.dailyDouble ? (
                  <div className="rounded bg-black/30 border border-white/10 px-4 py-4">
                    <div className="text-xs uppercase text-white/45">
                      {playerName(room, phase.answeringUserId)} is typing
                    </div>
                    <div className="mt-2 min-h-[2.5rem] text-2xl text-white break-words">
                      {phase.answerDraft || ""}
                    </div>
                  </div>
                ) : (
                  <p className="text-center text-sm text-white/70">
                    Waiting for {playerName(room, phase.answeringUserId)} to answer.
                  </p>
                )}
              </ClueStage>
            )}

            {phase.kind === "RESULT" && (
              <div
                className={`rounded p-6 text-center ${
                  phase.result.correct ? "bg-green-700/40" : "bg-red-700/40"
                }`}
              >
                <h2 className="font-category text-3xl text-jeopardy-gold mb-3">
                  {phase.result.noBuzz
                    ? "No buzz"
                    : phase.result.correct
                      ? "Correct"
                      : "Incorrect"}
                </h2>
                <p className="text-white/70">{phase.clue.question}</p>
                <p className="mt-3 text-white/90">
                  Answer: <span className="font-bold">{phase.result.canonicalAnswer}</span>
                </p>
                {phase.result.answeredByUserId && (
                  <p className="mt-2 text-sm text-white/65">
                    {playerName(room, phase.result.answeredByUserId)} submitted{" "}
                    <span className="italic">
                      {phase.result.submittedAnswer || "(blank)"}
                    </span>
                  </p>
                )}
                {((phase.result.attempts?.length ?? 0) > 1 ||
                  (phase.result.noBuzz && (phase.result.attempts?.length ?? 0) > 0)) && (
                  <div className="mt-4 max-w-md mx-auto space-y-1 text-left text-sm text-white/70">
                    {phase.result.attempts.map((attempt) => (
                      <div
                        key={`${attempt.userId}-${attempt.submittedAnswer}-${attempt.valueDelta}`}
                        className="flex items-center justify-between gap-3 rounded bg-white/5 px-3 py-2"
                      >
                        <span className="truncate">
                          {playerName(room, attempt.userId)}:{" "}
                          <span className="italic">
                            {attempt.submittedAnswer || "(blank)"}
                          </span>
                        </span>
                        <span className={attempt.correct ? "text-green-200" : "text-red-200"}>
                          {attempt.correct ? "+" : "−"}
                          <span className="dollar">
                            ${Math.abs(attempt.valueDelta).toLocaleString()}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-xl">
                  {phase.result.valueDelta >= 0 ? "+" : "−"}
                  <span className="dollar">
                    ${Math.abs(phase.result.valueDelta).toLocaleString()}
                  </span>
                </p>
                {phase.result.llmVerdict != null && (
                  <p className="mt-2 text-[10px] text-white/40">
                    LLM invoked: {phase.result.llmVerdict ? "YES" : "NO"}
                  </p>
                )}
                {iCanAdvanceResult ? (
                  <ResultAdvanceButton
                    phase={phase}
                    paused={Boolean(paused)}
                    serverClockOffsetMs={serverClockOffsetMs}
                    onAdvance={() => sendAction({ type: "advance" })}
                  />
                ) : (
                  <p className="mt-4 text-sm text-white/60">
                    Waiting for {playerName(room, advanceResultUserId)} to advance.
                  </p>
                )}
              </div>
            )}

            {phase.kind === "FINAL_WAGER" && (
              <div className="space-y-4">
                <div className="category-banner text-center py-3 text-2xl">
                  {phase.clue.category}
                </div>
                <TimerBar
                  totalMs={FINAL_WAGER_WINDOW_MS}
                  initialTimeLeftMs={timerTimeLeftMs(
                    phase.deadlineAt,
                    serverClockOffsetMs,
                    FINAL_WAGER_WINDOW_MS,
                  )}
                  resetKey={phase.deadlineAt}
                  paused={Boolean(paused)}
                  onExpire={() => {}}
                />
                {iAmContestant &&
                phase.eligibleUserIds.includes(user.id) &&
                hasOwn(phase.wagers, user.id) ? (
                  <div className="max-w-md mx-auto rounded bg-white/5 px-4 py-3 text-center">
                    <div className="text-sm text-white/60">Your wager is locked.</div>
                    <div className="dollar text-3xl text-jeopardy-gold">
                      ${phase.wagers[user.id].toLocaleString()}
                    </div>
                  </div>
                ) : iAmContestant && phase.eligibleUserIds.includes(user.id) ? (
                  <form onSubmit={submitWager} className="flex gap-2 max-w-md mx-auto">
                    <input
                      autoFocus
                      aria-label="Final Jeopardy wager"
                      type="number"
                      min={0}
                      max={Math.max(0, myPlayer?.score ?? 0)}
                      value={wagerInput}
                      onChange={(e) => updateWagerInput(e.target.value)}
                      placeholder={`0 to ${Math.max(0, myPlayer?.score ?? 0)}`}
                      className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
                    />
                    <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
                      Wager
                    </button>
                  </form>
                ) : iAmAudience ? (
                  <p className="text-center text-sm text-white/65">
                    Final wagers are hidden until the reveal.
                  </p>
                ) : (
                  <p className="text-center text-sm text-white/65">
                    You did not qualify for Final Jeopardy.
                  </p>
                )}
                <p className="text-center text-sm text-white/60">
                  {phase.submittedCount ?? Object.keys(phase.wagers).length} of{" "}
                  {phase.eligibleUserIds.length} eligible players locked in.
                </p>
              </div>
            )}

            {phase.kind === "FINAL_ANSWER" && (
              <div className="space-y-4">
                <div className="category-banner text-center py-3 text-2xl">
                  {phase.clue.category}
                </div>
                <div className="clue-tile p-5 sm:p-10 text-center min-h-[40vh] flex items-center justify-center rounded">
                  <p className="text-3xl sm:text-4xl md:text-6xl leading-tight font-category break-words">
                    {phase.clue.question}
                  </p>
                </div>
                <TimerBar
                  totalMs={FINAL_ANSWER_WINDOW_MS}
                  initialTimeLeftMs={timerTimeLeftMs(
                    phase.deadlineAt,
                    serverClockOffsetMs,
                    FINAL_ANSWER_WINDOW_MS,
                  )}
                  resetKey={phase.deadlineAt}
                  paused={Boolean(paused)}
                  onExpire={() => {}}
                />
                {iAmContestant &&
                phase.eligibleUserIds.includes(user.id) &&
                hasOwn(phase.answers, user.id) ? (
                  <div className="max-w-2xl mx-auto rounded bg-white/5 px-4 py-3 text-center">
                    {hasOwn(phase.wagers, user.id) && (
                      <div className="text-sm text-white/60">
                        Your wager:{" "}
                        <span className="dollar">
                          ${phase.wagers[user.id].toLocaleString()}
                        </span>
                      </div>
                    )}
                    <div className="mt-2 text-sm text-white/60">Your answer is locked.</div>
                    <div className="text-xl text-white break-words">
                      {phase.answers[user.id] || "(blank)"}
                    </div>
                  </div>
                ) : iAmContestant && phase.eligibleUserIds.includes(user.id) ? (
                  <form onSubmit={submitAnswer} className="flex gap-2">
                    <input
                      autoFocus
                      aria-label="Final answer"
                      autoComplete="off"
                      value={answerInput}
                      onChange={(e) => updateAnswerInput(e.target.value)}
                      placeholder="What is..."
                      className="flex-1 px-3 py-3 rounded bg-white/10 text-xl"
                    />
                    <button className="px-6 py-2 bg-jeopardy-gold text-black font-semibold rounded">
                      Submit
                    </button>
                  </form>
                ) : iAmAudience ? (
                  <p className="text-center text-sm text-white/60">
                    Final answers are hidden until the reveal.
                  </p>
                ) : (
                  <p className="text-center text-sm text-white/60">
                    Waiting for the finalists to answer.
                  </p>
                )}
                <p className="text-center text-sm text-white/60">
                  {phase.submittedCount ?? Object.keys(phase.answers).length} of{" "}
                  {phase.eligibleUserIds.length} eligible players locked in.
                </p>
              </div>
            )}

            {phase.kind === "FINAL_REVEAL" && (
              <div className="space-y-4">
                <div className="category-banner text-center py-3 text-2xl">
                  {phase.clue.category}
                </div>
                <div className="clue-tile p-5 sm:p-10 text-center min-h-[30vh] flex items-center justify-center rounded">
                  <p className="text-3xl sm:text-4xl md:text-5xl leading-tight font-category break-words">
                    {phase.clue.question}
                  </p>
                </div>
                <div className="rounded bg-white/5 p-5 space-y-4">
                  <div className="text-sm text-white/60 text-center">
                    Final response{" "}
                    {Math.min(phase.revealIndex + 1, phase.eligibleUserIds.length)} of{" "}
                    {phase.eligibleUserIds.length}
                  </div>
                  {phase.results.length > 0 && (
                    <FinalRevealCard
                      room={room}
                      result={phase.results[phase.results.length - 1]}
                    />
                  )}
                  {phase.results.length > 1 && (
                    <div className="space-y-2">
                      <h3 className="font-category text-2xl text-jeopardy-gold">
                        Revealed
                      </h3>
                      {phase.results.slice(0, -1).map((result) => (
                        <FinalRevealSummary
                          key={result.userId}
                          room={room}
                          result={result}
                        />
                      ))}
                    </div>
                  )}
                  {iAmHost ? (
                    <button
                      onClick={() => sendAction({ type: "advance" })}
                      disabled={Boolean(paused)}
                      className="w-full px-6 py-3 bg-jeopardy-gold text-black font-semibold rounded disabled:opacity-60"
                    >
                      {phase.revealStep === "ANSWER"
                        ? "Reveal wager"
                        : phase.revealIndex + 1 >= phase.eligibleUserIds.length
                          ? "Finish game"
                          : "Next response"}
                    </button>
                  ) : (
                    <p className="text-center text-sm text-white/60">
                      Waiting for the host to reveal the next step.
                    </p>
                  )}
                </div>
              </div>
            )}

            {phase.kind === "COMPLETE" && (
              <div className="rounded p-6 bg-white/8 space-y-5">
                <h2 className="font-category text-4xl text-jeopardy-gold text-center">
                  Game complete
                </h2>
                {phase.reason && (
                  <p className="text-center text-white/70">{phase.reason}</p>
                )}
                <div className="space-y-2">
                  {sortedStandings.map((player, idx) => (
                    <div
                      key={player.userId}
                      className="flex items-center justify-between rounded bg-white/5 px-4 py-3"
                    >
                      <div>
                        <div className="font-semibold">
                          {idx + 1}. {player.displayName}
                        </div>
                        {player.left && (
                          <div className="text-xs text-white/45">Left room</div>
                        )}
                      </div>
                      <div className="dollar text-xl">
                        ${player.score.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
                {phase.finalResults && (
                  <div className="space-y-2">
                    <h3 className="font-category text-2xl text-jeopardy-gold">
                      Final Jeopardy recap
                    </h3>
                    {phase.finalResults.map((result) => (
                      <div key={result.userId} className="rounded bg-white/5 px-4 py-3">
                        <div className="font-semibold">{playerName(room, result.userId)}</div>
                        <div className="text-sm text-white/70">
                          Wagered <span className="dollar">${result.wager.toLocaleString()}</span>
                          {" · "}
                          {result.submittedAnswer || "(blank)"}
                        </div>
                        <div className="text-sm text-white/70">
                          Answer: <span className="font-semibold">{result.canonicalAnswer}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-center">
                  <Link
                    to="/board/multiplayer"
                    className="px-6 py-3 inline-block bg-jeopardy-gold text-black font-semibold rounded"
                  >
                    New room
                  </Link>
                </div>
              </div>
            )}

            {phase.kind === "ABANDONED" && (
              <div className="rounded p-6 bg-red-900/30 border border-red-500/30 text-center space-y-3">
                <h2 className="font-category text-4xl text-jeopardy-gold">Room closed</h2>
                <p className="text-white/75">{phase.reason}</p>
                <Link
                  to="/board/multiplayer"
                  className="px-6 py-3 inline-block bg-jeopardy-gold text-black font-semibold rounded"
                >
                  Back to multiplayer
                </Link>
              </div>
            )}
          </section>

          <div className="space-y-4">
            <PlayerRoster room={room} />
            {phase.kind === "RESULT" && (
              <div className="rounded bg-white/5 px-4 py-3 text-sm text-white/70">
                {hasBoardControl
                  ? "You control the board."
                  : `${selector} controls the board.`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the ResultAdvanceButton React component.
 *
 * Parameters:
 * - `{ phase, paused, serverClockOffsetMs, onAdvance }` (`{ phase: Extract<RoomPhase, { kind: "RESULT" }>; paused: boolean; serverClockOffsetMs: number; onAdvance: () => void; }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function ResultAdvanceButton({
  phase,
  paused,
  serverClockOffsetMs,
  onAdvance,
}: {
  phase: Extract<RoomPhase, { kind: "RESULT" }>;
  paused: boolean;
  serverClockOffsetMs: number;
  onAdvance: () => void;
}) {
  /**
   * Implements the now ms function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `number`: Numeric value calculated from inputs, state, or persisted data.
   *
   * Data transformations:
   * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
   */
  const nowMs = useCallback(() => Date.now() + serverClockOffsetMs, [
    serverClockOffsetMs,
  ]);
  const fallbackStartedAt = useRef(nowMs());
  const startedAt =
    parseTimeMs(phase.resultBeganAt) ?? fallbackStartedAt.current;
  const unlocksAt =
    parseTimeMs(phase.advanceUnlocksAt) ?? startedAt + RESULT_ADVANCE_DELAY_MS;
  const totalMs = Math.max(1, unlocksAt - startedAt);
  const [now, setNow] = useState(nowMs());

  /**
   * Runs the useEffect callback for the surrounding component lifecycle.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `() => void`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  useEffect(() => {
    setNow(nowMs());
    /**
     * Runs the delayed setInterval timer callback.
     *
     * Parameters:
     * - None.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Updates application/browser state, cookies, or persistent browser storage from computed values.
     */
    const id = window.setInterval(() => {
      const current = nowMs();
      setNow(current);
      if (current >= unlocksAt) {
        window.clearInterval(id);
      }
    }, RESULT_ADVANCE_TICK_MS);
    return () => window.clearInterval(id);
  }, [nowMs, startedAt, unlocksAt]);

  const progress = Math.min(1, Math.max(0, (now - startedAt) / totalMs));
  const locked = paused || progress < 1;
  const fillPercent = Math.round(progress * 1000) / 10;

  return (
    <button
      onClick={onAdvance}
      disabled={locked}
      aria-label={
        locked ? "Advance available after answer read timer" : "Advance to board"
      }
      className={`mt-5 overflow-hidden rounded border border-yellow-300/70 px-6 py-2 font-semibold text-black shadow-sm transition ${
        locked ? "cursor-not-allowed" : "hover:brightness-110"
      }`}
      style={{
        background: `linear-gradient(to right, #D69F4C ${fillPercent}%, #d4b484 ${fillPercent}%)`,
      }}
    >
      Advance
    </button>
  );
}

/**
 * Renders the FinalRevealCard React component.
 *
 * Parameters:
 * - `{ room, result }` (`{ room: Room; result: FinalResult }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function FinalRevealCard({ room, result }: { room: Room; result: FinalResult }) {
  return (
    <div
      className={`rounded p-5 text-center ${
        result.correct ? "bg-green-700/35" : "bg-red-700/35"
      }`}
    >
      <div className="text-sm text-white/60">{playerName(room, result.userId)}</div>
      <div className="mt-2 text-2xl text-white break-words">
        {result.submittedAnswer || "(blank)"}
      </div>
      <div className={result.correct ? "mt-3 text-green-100" : "mt-3 text-red-100"}>
        {result.correct ? "Correct" : "Incorrect"}
      </div>
      <div className="mt-2 text-sm text-white/70">
        Correct response: <span className="font-semibold">{result.canonicalAnswer}</span>
      </div>
      {result.wagerRevealed ? (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="text-sm text-white/60">Wager</div>
          <div className="dollar text-3xl text-jeopardy-gold">
            ${result.wager.toLocaleString()}
          </div>
          <div className={result.valueDelta >= 0 ? "text-green-100" : "text-red-100"}>
            {result.valueDelta >= 0 ? "+" : "-"}
            <span className="dollar">
              ${Math.abs(result.valueDelta).toLocaleString()}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-4 text-sm text-white/55">Wager hidden</div>
      )}
    </div>
  );
}

/**
 * Renders the FinalRevealSummary React component.
 *
 * Parameters:
 * - `{ room, result }` (`{ room: Room; result: FinalResult }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function FinalRevealSummary({ room, result }: { room: Room; result: FinalResult }) {
  return (
    <div className="rounded bg-white/5 px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-semibold truncate">{playerName(room, result.userId)}</div>
        <div className="text-sm text-white/60 truncate">
          {result.submittedAnswer || "(blank)"}
        </div>
      </div>
      <div className={result.valueDelta >= 0 ? "text-green-100" : "text-red-100"}>
        {result.valueDelta >= 0 ? "+" : "-"}
        <span className="dollar">${Math.abs(result.valueDelta).toLocaleString()}</span>
      </div>
    </div>
  );
}

/**
 * Renders the ScoreStrip React component.
 *
 * Parameters:
 * - `{ room, meUserId }` (`{ room: Room; meUserId: string }`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function ScoreStrip({ room, meUserId }: { room: Room; meUserId: string }) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {contestants(room).map((player) => (
        <div
          key={player.userId}
          className={`rounded px-4 py-3 border ${
            player.userId === meUserId
              ? "border-jeopardy-gold/60 bg-jeopardy-gold/10"
              : "border-white/10 bg-white/5"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {player.displayName}
                {player.isHost ? " · Host" : ""}
              </div>
              <div className="text-xs text-white/45">
                {player.left ? "Left room" : player.connected ? "Connected" : "Offline"}
              </div>
            </div>
            <div className="dollar text-2xl">${player.score.toLocaleString()}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the PlayerRoster React component.
 *
 * Parameters:
 * - `{ room }` (`{ room: Room }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function PlayerRoster({ room }: { room: Room }) {
  const playerRows = contestants(room).slice().sort((a, b) => a.seat - b.seat);
  const audienceRows = audienceMembers(room).slice().sort((a, b) => a.seat - b.seat);

  return (
    <section className="rounded bg-white/5 p-4 space-y-3">
      <h2 className="font-category text-2xl text-jeopardy-gold">Players</h2>
      <div className="space-y-2">
        {playerRows.map((player) => (
          <div
            key={player.userId}
            className="flex items-center justify-between gap-3 rounded bg-white/5 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="font-semibold truncate">
                Seat {player.seat}: {player.displayName}
              </div>
              <div className="text-xs text-white/45">
                {player.isHost ? "Host | " : ""}
                {player.left ? "Left room" : player.connected ? "Connected" : "Offline"}
              </div>
            </div>
            <div className="dollar text-lg">${player.score.toLocaleString()}</div>
          </div>
        ))}
      </div>
      {audienceRows.length > 0 && (
        <div className="pt-2 border-t border-white/10 space-y-2">
          <h3 className="font-category text-xl text-jeopardy-gold">Audience</h3>
          {audienceRows.map((player) => (
            <div
              key={player.userId}
              className="flex items-center justify-between gap-3 rounded bg-white/5 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="font-semibold truncate">{player.displayName}</div>
                <div className="text-xs text-white/45">
                  {player.left ? "Left room" : player.connected ? "Connected" : "Offline"}
                </div>
              </div>
              <div className="text-xs text-white/50">Watching</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Renders the BoardGrid React component.
 *
 * Parameters:
 * - `{ board, played, selectable, onSelect }` (`{ board: RoundBoard; played: Set<number>; selectable: boolean; onSelect: (clueId: number) => void; }`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 */
function BoardGrid({
  board,
  played,
  selectable,
  onSelect,
}: {
  board: RoundBoard;
  played: Set<number>;
  selectable: boolean;
  onSelect: (clueId: number) => void;
}) {
  return (
    <div className="grid grid-cols-6 gap-1 max-w-7xl mx-auto">
      {board.categories.map((cat, ci) => (
        <div
          key={ci}
          className="category-banner py-2 md:py-3 text-center text-[10px] sm:text-sm md:text-base h-full flex items-center justify-center min-h-[60px] sm:min-h-[80px] px-0.5 sm:px-1"
        >
          {cat.name}
        </div>
      ))}
      {board.values.map((value, valueIdx) =>
        board.categories.map((cat, catIdx) => {
          const cell = cat.cells[valueIdx];
          if (!cell) {
            return (
              <div
                key={`${valueIdx}-${catIdx}-empty`}
                className="min-h-[60px] sm:min-h-[80px] rounded bg-white/5 text-center flex items-center justify-center text-white/30 text-xs"
              >
                —
              </div>
            );
          }
          const isPlayed = played.has(cell.id);
          return (
            <button
              key={`${valueIdx}-${catIdx}-${cell.id}`}
              onClick={() => onSelect(cell.id)}
              disabled={isPlayed || !selectable}
              className={`clue-tile min-h-[60px] sm:min-h-[80px] text-center rounded transition ${
                isPlayed
                  ? "opacity-20 cursor-default"
                  : selectable
                    ? "hover:scale-105"
                    : "opacity-70 cursor-not-allowed"
              }`}
            >
              <span className="dollar text-lg sm:text-2xl md:text-3xl">
                {isPlayed ? "" : `$${value}`}
              </span>
            </button>
          );
        }),
      )}
    </div>
  );
}

/**
 * Renders the ClueStage React component.
 *
 * Parameters:
 * - `{ heading, clue, subtext, children }` (`{ heading: string; clue: Cell; subtext: string; children: ReactNode; }`): Clue data read from API or database rows and reshaped for gameplay.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function ClueStage({
  heading,
  clue,
  subtext,
  children,
}: {
  heading: string;
  clue: Cell;
  subtext: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-category text-3xl text-jeopardy-gold">{heading}</h2>
          <p className="text-sm text-white/60">{subtext}</p>
        </div>
        <div className="text-sm text-white/70">
          {clue.category} · <span className="dollar">${clue.value}</span>
        </div>
      </div>
      <div className="clue-tile p-5 sm:p-10 text-center min-h-[40vh] flex items-center justify-center rounded">
        <p className="text-3xl sm:text-4xl md:text-6xl leading-tight font-category break-words">
          {clue.question}
        </p>
      </div>
      {children}
    </div>
  );
}
