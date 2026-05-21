# Game Modes

## Route Map

| Route | Auth | Purpose |
| --- | --- | --- |
| `/` | no | Home / feature entry point |
| `/login` | no | Email/password and Google sign-in |
| `/register` | no | Account creation |
| `/practice` | no | Single-clue training loop |
| `/daily` | no | Shared daily challenge |
| `/flashcards` | no | Curated decks and category decks |
| `/leaderboard` | no | Global rankings |
| `/buzzer` | yes | Buzzer-reflex training |
| `/review` | yes | Spaced review queue |
| `/board` | yes | Full Jeopardy board play |
| `/final` | yes | Standalone Final Jeopardy round |
| `/friends` | yes | Social graph management |
| `/dashboard` | yes | Personal performance metrics |
| `/settings` | yes | Profile, password, and account deletion |

## Shared Gameplay Rules

Most play modes follow the same judging pattern:

1. Show a clue.
2. Kick off hint generation in the background.
3. Let the user answer or time out.
4. Use `/api/clues/submit` when authenticated, otherwise `/api/clues/check`.
5. Show the canonical answer, correctness, wiki blurb, and hint text.

Shared result-panel behavior:

- Wikipedia blurbs come from `/api/clues/:id/wiki`
- hints come from `/api/clues/:id/hint`
- authenticated modes can manually flip a result with `/mark-correct` or `/mark-incorrect`

## Practice

Route: `/practice`

Purpose:

- fast, single-clue repetition
- good default mode for broad training

Behavior:

- 15-second answer timer
- optional weak-category mode for authenticated users
- optional meta-category filtering
- optional voice input using the browser speech-recognition API
- optional text-to-speech for clue reading

Primary backend endpoints:

- `GET /api/clues/random`
- `GET /api/clues/weak`
- `POST /api/clues/submit`
- `POST /api/clues/check`

Special notes:

- wrong authenticated answers enter the spaced-review queue
- category preference state is cached locally and synced to `/api/preferences` when logged in

## Daily

Route: `/daily`

Purpose:

- one shared challenge per UTC day
- comparable scores across all users

Behavior:

- deterministic 30-clue set keyed by the current UTC date
- guest progress is stored in `localStorage`
- authenticated progress and final score are reconstructed from saved responses
- authenticated users can resume unfinished runs and appear on the leaderboard

Primary backend endpoints:

- `GET /api/daily/today`
- `GET /api/daily/me`
- `POST /api/daily/finish`
- `GET /api/daily/leaderboard`

Special notes:

- the day resets at midnight UTC, not local midnight
- the server is authoritative for authenticated final scoring

## Buzzer

Route: `/buzzer`

Purpose:

- simulate buzzer timing rather than pure recall

Behavior:

- 10-clue rounds
- clue-reading phase before the "lights"
- early buzzes cause a lockout
- successful buzz opens a 5-second answer window
- empty timed-out answers are still submitted so the round score remains authoritative

Primary backend endpoints:

- `POST /api/buzzer/start`
- `POST /api/clues/submit`
- `POST /api/buzzer/finish`
- `GET /api/buzzer/history`

Scoring:

- finalized as Coryat on the backend from saved clue responses

Special notes:

- in-progress rounds are saved locally so the page can resume after refresh
- meta-category filtering also applies here

## Review

Route: `/review`

Purpose:

- revisit clues the user previously missed

Behavior:

- only available to authenticated users
- due clues are loaded from `ReviewSchedule`
- after each answer, the review interval is updated immediately

Primary backend endpoints:

- `GET /api/review/due`
- `GET /api/review/stats`
- `POST /api/clues/submit`
- `POST /api/review/result`

Scheduling model:

- wrong review result: back to 1 day
- right review result: interval grows by `2.5x`, capped at 90 days

## Board

Route: `/board`

Purpose:

- full Jeopardy game flow with wagering and Final Jeopardy

Two board sources:

- real aired episode via `GET /api/clues/episode`
- mixed board via `GET /api/clues/mixed-board`

Behavior:

- full Jeopardy and Double Jeopardy board selection
- Daily Double wagering
- Final Jeopardy wagering
- optional browser text-to-speech
- refresh-resume support through local storage

Primary backend endpoints:

- `GET /api/clues/episode`
- `GET /api/clues/mixed-board`
- `POST /api/clues/submit`
- `POST /api/clues/check`

Special notes:

- mixed boards randomize Daily Doubles because the database only knows real aired Daily Doubles
- if the player finishes Double Jeopardy below zero, Final Jeopardy is skipped

## Final Jeopardy

Route: `/final`

Purpose:

- standalone Final Jeopardy rehearsal

Behavior:

- pulls one `FINAL_JEOPARDY` clue
- accepts a wager
- optionally reads the category and clue aloud with browser TTS

Primary backend endpoints:

- `GET /api/clues/random?limit=1&round=FINAL_JEOPARDY`
- `POST /api/clues/submit`

## Flashcards

Route: `/flashcards`

Purpose:

- direct study mode, separate from clue-by-clue play

Two deck types:

- curated decks stored as real `Flashcard` records
- meta-category decks generated from clue corpus rows

Behavior:

- curated decks persist per-user review ratings when logged in
- meta-category decks are stateless random 30-card pulls

Primary backend endpoints:

- `GET /api/flashcards/decks`
- `GET /api/flashcards/decks/:id`
- `POST /api/flashcards/review`
- `GET /api/flashcards/meta-decks`
- `GET /api/flashcards/meta-decks/:name`

## Friends

Route: `/friends`

Purpose:

- manage accepted friendships and pending requests

Primary backend endpoints:

- `GET /api/friends`
- `GET /api/friends/pending`
- `POST /api/friends/request`
- `POST /api/friends/respond/:id`
- `DELETE /api/friends/:id`

## Leaderboard

Route: `/leaderboard`

Purpose:

- compare performance globally or against friends

Behavior:

- global leaderboard is visible publicly
- friends leaderboard requires auth
- ranking emphasizes best Coryat first, then accuracy, then volume

Primary backend endpoints:

- `GET /api/leaderboard/global`
- `GET /api/leaderboard/friends`

## Dashboard

Route: `/dashboard`

Purpose:

- show cumulative performance data for the current user

Metrics shown:

- total answered
- total correct
- overall accuracy
- best Coryat
- per-round breakdown
- top categories
- recent buzzer sessions

Primary backend endpoint:

- `GET /api/stats/me`

## Settings

Route: `/settings`

Purpose:

- manage account profile and credentials

Behavior:

- edit display name
- set or change password
- inspect whether the account has Google or password auth enabled
- permanently delete the account with a typed confirmation

Primary backend endpoints:

- `GET /api/auth/me`
- `PATCH /api/auth/me`
- `POST /api/auth/change-password`
- `DELETE /api/auth/me`

## Browser-Only Enhancements

These are client-side features and are not required for the app to function:

- text-to-speech via `window.speechSynthesis`
- voice input in Practice mode via `SpeechRecognition` / `webkitSpeechRecognition`
- in-progress resume state via `localStorage`
