# API Reference

Base path: `/api`

## Conventions

### Authentication

- The browser app authenticates with an `HttpOnly` same-site session cookie set by `/auth/register`, `/auth/login`, and `/auth/google`
- Protected endpoints also accept `Authorization: Bearer <jwt>` for internal tools and tests
- Some endpoints use optional auth and return richer data when a valid session is present

### Rate Limits

- auth endpoints: 10 requests/minute
- friend requests: 10 requests/minute
- clue submit/check endpoints: 120 requests/minute

### Error Shape

Most failures return JSON such as:

```json
{ "error": "message" }
```

Validation errors from `zod` return the flattened error object instead of a single string.

## Health

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | no | Liveness probe, returns `{ ok: true }` |

## Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | no | Create an email/password account |
| `POST` | `/auth/login` | no | Log in with email/password |
| `POST` | `/auth/google` | no | Log in with Google ID token |
| `POST` | `/auth/logout` | no | Clear the session cookie |
| `GET` | `/auth/config` | no | Returns Google client config for the frontend |
| `GET` | `/auth/me` | yes | Returns account profile and auth capabilities |
| `PATCH` | `/auth/me` | yes | Update display name |
| `POST` | `/auth/change-password` | yes | Set or change password |
| `DELETE` | `/auth/me` | yes | Delete the account |

### Auth Request Bodies

```json
POST /auth/register
{ "email": "user@example.com", "password": "password123", "displayName": "Player 1" }
```

```json
POST /auth/login
{ "email": "user@example.com", "password": "password123" }
```

```json
POST /auth/google
{ "credential": "<google-id-token>" }
```

```json
PATCH /auth/me
{ "displayName": "New Name" }
```

```json
POST /auth/change-password
{ "currentPassword": "old-password", "newPassword": "new-password-123" }
```

For Google-only accounts setting a password for the first time, `currentPassword` is optional.

```json
DELETE /auth/me
{ "confirm": "DELETE" }
```

### Auth Responses

- register/login/google return `{ user }` and set the session cookie
- `/auth/logout` returns `{ ok: true }` and clears the session cookie
- `/auth/me` returns `hasPassword` and `hasGoogle` booleans rather than raw credential data

## Clues

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/clues/random` | no | Random clue list, optionally filtered |
| `GET` | `/clues/weak` | yes | Random clues from the user's weakest categories |
| `GET` | `/clues/episode` | no | Full aired board for one episode |
| `GET` | `/clues/mixed-board` | no | Mixed-category board with random Final |
| `POST` | `/clues/board-share` | yes | Create a short share code for a board payload |
| `GET` | `/clues/board-share/:code` | no | Resolve a shared board code back into a board payload |
| `GET` | `/clues/categories` | no | All category names |
| `POST` | `/clues/submit` | yes | Judge and persist an answer |
| `POST` | `/clues/check` | no | Judge an answer without persistence |
| `POST` | `/clues/mark-correct/:responseId` | yes | Override a saved wrong answer to correct |
| `POST` | `/clues/mark-incorrect/:responseId` | yes | Override a saved correct answer to wrong |
| `GET` | `/clues/:id/wiki` | no | Fetch or return cached Wikipedia summary |
| `POST` | `/clues/:id/hint/prepare` | no | Kick off background hint generation |
| `GET` | `/clues/:id/hint` | no | Poll hint status |

## Multiplayer

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/multiplayer/rooms` | yes | Create a private multiplayer lobby |
| `POST` | `/multiplayer/join` | yes | Join a lobby by room code |
| `GET` | `/multiplayer/rooms/:code` | yes | Fetch room state for an existing participant |
| `POST` | `/multiplayer/rooms/:code/start` | yes | Host starts live play from the lobby |
| `POST` | `/multiplayer/rooms/:code/leave` | yes | Leave the lobby or forfeit/end a live room |

WebSocket:

- `GET ws /multiplayer/ws?code=ABC123`
- authenticated with the same browser session cookie as the REST API
- emits authoritative `room-state` snapshots and `error` messages

Room rules:

- room codes are 6 characters from `A-Z` and `2-9`
- maximum 3 total players per room, including the host
- joins are only allowed while the room is in `LOBBY`
- active gameplay actions are sent over the websocket: clue selection, buzzing, wagering, answering, and host advance

Client action messages:

```json
{ "type": "select-clue", "clueId": 123 }
```

```json
{ "type": "buzz" }
```

```json
{ "type": "submit-answer", "answer": "What is Paris?" }
```

```json
{ "type": "submit-wager", "wager": 1200 }
```

```json
{ "type": "advance" }
```

Multiplayer phase notes:

- `READING`, `BUZZ_OPEN`, `DD_WAGER`, `ANSWERING`, `FINAL_WAGER`, and `FINAL_ANSWER` carry server deadlines; clients render timers from those deadlines but the server is authoritative.
- `BUZZ_OPEN.buzzedUserIds` lists players who are out for the current clue after a wrong or timed-out answer.
- `BUZZ_OPEN.attempts` carries prior missed attempts for the current clue but does not include the canonical answer.
- `RESULT.result.canonicalAnswer` is the first regular-clue phase where the correct answer is sent to clients.
- On non-Daily Double clues, an incorrect or blank answer returns the room to `BUZZ_OPEN` with a fresh `buzzClosesAt` unless every active player has already attempted the clue.

### `GET /clues/random`

Query parameters:

- `limit`: default `5`, max `50`
- `round`: one of `JEOPARDY`, `DOUBLE_JEOPARDY`, `FINAL_JEOPARDY`
- `categoryId`
- `metaCategories`: comma-separated subset of known meta categories

Response:

```json
{
  "clues": [
    {
      "id": 1,
      "question": "Clue text",
      "value": 400,
      "round": "JEOPARDY",
      "dailyDouble": false,
      "airDate": null,
      "category": "HISTORY"
    }
  ]
}
```

### `GET /clues/weak`

Query parameters:

- `limit`: default `5`, max `50`

Response includes both clue rows and `weakCategories`, each with `accuracy` and `attempts`.

### `GET /clues/episode`

Query parameters:

- `date`: optional `YYYY-MM-DD`

If omitted, the server picks a random date that has a complete Jeopardy, Double Jeopardy, and Final Jeopardy set.

Response includes:

- `date`
- `jeopardy`
- `doubleJeopardy`
- `finalJeopardy`

### `GET /clues/mixed-board`

Builds a synthetic full board:

- 6 random categories for Jeopardy
- 6 random categories for Double Jeopardy
- 1 random Final Jeopardy clue
- Daily Doubles sprinkled randomly

### Board Share Codes

`POST /clues/board-share`

- authenticated users can persist the current board payload and receive a short code
- request body: `{ "episode": { ...board payload... } }`
- response: `{ "code": "ABCDWXYZ" }`

`GET /clues/board-share/:code`

- resolves a previously shared code
- accepts codes with or without separators such as `ABCD-EFGH`
- response: `{ "episode": { ...board payload... } }`

### `POST /clues/submit`

Request body:

```json
{
  "clueId": 123,
  "answer": "what is paris",
  "responseTimeMs": 4200,
  "mode": "PRACTICE",
  "wager": null,
  "buzzerSessionId": null
}
```

Notes:

- `mode` must be one of `PRACTICE`, `BUZZER`, `DAILY`, `REVIEW`, `BOARD`, `FINAL`
- `wager` is only allowed for Daily Doubles, `FINAL`, and `BOARD`
- `buzzerSessionId` is only stored for `BUZZER` submissions

Response:

```json
{
  "responseId": "cuid",
  "correct": true,
  "canonicalAnswer": "Paris",
  "valueDelta": 400,
  "llmVerdict": null
}
```

`llmVerdict` meanings:

- `null`: deterministic matcher decided the result
- `true` or `false`: the LLM was consulted and returned that verdict

### `POST /clues/check`

Anonymous version of `/clues/submit`.

Request body:

```json
{ "clueId": 123, "answer": "paris" }
```

Response:

```json
{
  "correct": true,
  "canonicalAnswer": "Paris",
  "value": 400,
  "llmVerdict": null
}
```

### Manual Overrides

`POST /clues/mark-correct/:responseId`

- flips an existing saved response to correct
- removes any review schedule entry for that clue
- returns `{ valueDelta }`

`POST /clues/mark-incorrect/:responseId`

- flips an existing saved response to wrong
- re-enrolls the clue in the review queue
- returns `{ valueDelta }`

### Wiki and Hint Endpoints

`GET /clues/:id/wiki` response:

```json
{
  "title": "Article title",
  "extract": "Lead summary",
  "url": "https://en.wikipedia.org/...",
  "thumb": "https://...",
  "cached": true
}
```

`GET /clues/:id/hint` response:

```json
{ "status": "ready", "hint": "Short explanation" }
```

Possible `status` values:

- `ready`
- `pending`
- `not_started`

## Daily

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/daily/today` | no | Returns today's deterministic 30-clue set |
| `POST` | `/daily/finish` | yes | Recomputes and saves the authenticated user's score |
| `GET` | `/daily/leaderboard` | no | Top 50 results for a given day |
| `GET` | `/daily/me` | yes | Returns saved attempt or resumable progress |

### Notes

- The daily set is keyed by UTC date.
- `POST /daily/finish` ignores the client body and recomputes from saved `ClueResponse` rows.
- `GET /daily/me` returns either `{ attempt, progress: null }` or `{ attempt: null, progress }`.

## Buzzer

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/buzzer/start` | yes | Issues a fresh client session ID |
| `POST` | `/buzzer/finish` | yes | Finalizes the session from saved responses |
| `GET` | `/buzzer/history` | yes | Returns the latest 30 finished sessions |

### `POST /buzzer/finish`

Request body:

```json
{ "sessionId": "hex-string" }
```

The backend deduplicates multiple answers to the same clue and calculates:

- `totalClues`
- `correctCount`
- `avgResponseMs`
- `coryatScore`

## Flashcards

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/flashcards/decks` | no | List curated decks |
| `GET` | `/flashcards/decks/:id` | optional | Load one curated deck, optionally with user progress |
| `POST` | `/flashcards/review` | yes | Save progress for a curated flashcard |
| `GET` | `/flashcards/meta-decks` | no | List corpus-derived meta-category decks |
| `GET` | `/flashcards/meta-decks/:name` | no | Load a random clue deck for a meta category |

### `POST /flashcards/review`

Request body:

```json
{ "flashcardId": 123, "knownLevel": 3 }
```

`knownLevel` must be an integer from `0` to `5`.

## Friends

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/friends` | yes | List accepted friends |
| `GET` | `/friends/pending` | yes | List incoming and outgoing pending requests |
| `POST` | `/friends/request` | yes | Send a friend request by email |
| `POST` | `/friends/respond/:id` | yes | Accept or reject a pending request |
| `DELETE` | `/friends/:id` | yes | Remove a friendship or cancel a request |

### Notes

- `/friends/request` always returns the same success shape to avoid email enumeration.
- `/friends/respond/:id` treats `{ "accept": true }` as accept; any other value rejects/deletes the request.

## Leaderboards

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/leaderboard/global` | optional | Global ranking |
| `GET` | `/leaderboard/friends` | yes | Friends-only ranking |

### Global Leaderboard Behavior

- Returns the top 100 visible users
- Excludes `isTestAccount` users
- If the caller is authenticated but outside the top 100, the response includes a `me` block with their own rank and row

## Review

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/review/due` | yes | Fetch due review clues |
| `GET` | `/review/stats` | yes | Queue statistics |
| `POST` | `/review/result` | yes | Update spaced-review interval after a review attempt |

### `POST /review/result`

Request body:

```json
{ "clueId": 123, "correct": true }
```

The scheduler:

- resets wrong answers to a 1-day interval
- grows correct answers by a factor of `2.5`
- caps intervals at `90` days

## Stats

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/stats/me` | yes | Dashboard metrics for the current user |

Returns:

- overall answer counts and accuracy
- per-round aggregates
- top categories
- recent buzzer sessions
- best Coryat score

## Preferences

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/preferences` | yes | Fetch saved disabled meta categories |
| `PUT` | `/preferences` | yes | Update disabled meta categories |

### `PUT /preferences`

Request body:

```json
{ "disabledMetaCategories": ["Sports", "Math"] }
```

Unknown category names are dropped before persistence.
