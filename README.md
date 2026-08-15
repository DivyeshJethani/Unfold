# AI Tutor Logic Module

This is the **AI tutor logic** slice of the platform: the part that turns raw
signals (exam marks, quiz results, video-watching behavior, teach-back
sessions) into per-topic mastery scores, personalized timetables, an
escalation path from AI-teachback to peer-teaching, and a credit economy.
It's built as a self-contained NestJS module (`AiTutorModule`) so it can be
dropped into the fuller backend once the school/board/curriculum data model
(a separate phase) exists.

## What's implemented, and why it's built this way

### 1. Weak-topic detection (`weak-topic-detection.service.ts`)
Every signal source — exam marks, quiz attempts, video-watching behavior,
revision tests, peer-teaching outcomes — reduces to a common `WeaknessSignal`
(`strengthDelta` in `-1..+1`, plus a `confidence`). These get fused into a
per-(student, topic) mastery score using an **EWMA (exponentially weighted
moving average)**, not a simple running average:
- recent evidence matters more than old evidence (a student who struggled
  last term but has aced the last 3 quizzes should update quickly)
- it's O(1) per update — no re-scanning history as data grows
- signal `confidence` modulates the effective learning rate, so a graded
  revision test moves the score more than an ambiguous rewind-density blip

Two consecutive revision-test/quiz failures on the same topic auto-escalate
from "teach it back to the AI" to "get a peer to re-teach you"
(`AI_TEACHBACK_ESCALATION_THRESHOLD`, tunable in `ai-tutor.constants.ts`).

### 2. Video-interaction analytics (`video-analytics.service.ts`)
Records raw pause/rewind/skip/speed-change/complete/drop-off events
(one row per event, not per lecture), then aggregates them into an
engagement summary and converts that into weakness signals:
- **rewind clustering** near the same timestamp → merged into "confused
  regions" (so the UI can point back at *where* in the video they got lost)
- **long pauses** (>15s before resuming) → possible confusion signal
- **skipping ahead** is treated as ambiguous: positive (confidence) if the
  lecture was still completed, negative (disengagement) if it wasn't
- **drop-off before 60% watched** → explicit penalty signal

### 3. Attention span & memory retention (`attention-span.service.ts`)
- **Attention span** is measured, not asked for: sessions are segmented by
  20-minute gaps, and within each session we find the point where
  engagement visibly degrades (a long pause, a drop-off, or a burst of 3+
  seeks within 30s). The median across recent sessions is the estimate.
- **Memory retention** approximates a forgetting curve by comparing
  revision-test scores on the same lecture/topic across repeated attempts
  spaced over time.
- Best focus window (hour-of-day) is inferred from historical completion
  rates.

### 4. Personalized timetable (`timetable.service.ts`)
Study blocks are sized to the student's *actual measured* attention span
(capped 10–45 min), not a generic 45-minute slot. Weakest topics are
front-loaded into the student's best-focus window; break length scales
inversely with memory retention (faster forgetting → shorter, more frequent
breaks). Remaining time is filled with spaced-review slots for topics that
are due for a refresh.

### 5. Revision tests (`revision-test.service.ts`)
Auto-generated after every lecture (`POST_LECTURE` trigger, fired by the
BullMQ processor on a `COMPLETE` event) and on-demand when a weak topic is
flagged. Supports MCQ + an optional free-text explanation, which Nemotron
grades and blends into the score (60% objective / 40% Nemotron quality).
Passing awards credits.

### 6. AI teach-back → peer escalation (`peer-teaching.service.ts`)
Implements the exact flow from the spec:
1. Student explains a weak topic to the AI (Feynman technique).
2. Nemotron judges the explanation (`evaluateExplanation`, structured JSON:
   quality score, concepts covered/missed, misconceptions, feedback).
3. If it passes → mastery improves, credits awarded.
4. If it fails **and** this is the 2nd+ consecutive failure on the topic →
   the service surfaces `shouldEscalateToPeer: true`, and
   `findPeerTutorCandidates` matches the student with a strong peer from
   their study group (load-balanced so the top student in the group isn't
   always the one tapped).
5. Peer sessions are resolved against a post-session check score; the tutor
   earns credits for teaching *and* a bonus only once the tutee's
   improvement is actually confirmed — this is the anti-gaming mechanism.

### 7. Credits (`credit.service.ts`)
Wallet + transaction ledger (`CreditWallet`, `CreditTransaction`), atomic
award/redeem via Prisma transactions, a reward catalog with stock tracking,
and a per-study-group leaderboard.

### 8. Study groups (`study-group.service.ts`)
Grouped by `(subject, standard, board)` — the granularity that actually
matters for peer teaching (a CBSE class-10 group shouldn't mix with an ICSE
class-12 group). Streams (PCM/PCB/Commerce/etc.) are implicit in subject
choice for 11th/12th.

### 9. NVIDIA Nemotron integration (`nemotron.service.ts`)
Thin wrapper around the OpenAI-compatible `/chat/completions` endpoint
(`build.nvidia.com` / NVIDIA NIM), forcing structured JSON output so no
caller ever has to regex-parse prose. Three prompt modes: teach-back
evaluation, revision-test grading, follow-up question generation.

### 10. Async processing (`processors/ai-evaluation.processor.ts`)
All heavy work (mastery recompute, Nemotron calls, revision-test
generation) happens off the request path via BullMQ, so the video player's
event-recording call returns fast.

## Honest gaps / what this does *not* do yet

- **No auth wiring.** `CurrentStudentId` is a stub reading
  `req.user.studentId` — swap in a real Clerk/JWT guard in the backend-core
  phase; no controller code needs to change.
- **No School/Board/Standard/Subject seed data** — those models are
  minimal stubs here (see `ai-tutor-models.prisma`); the full curriculum
  data model is a separate phase, as agreed.
- **`npx prisma generate` needs real internet access** to fetch the query
  engine binary — it's blocked in this sandboxed environment
  (`binaries.prisma.sh` isn't reachable here), so run it locally / in CI,
  not a code issue.
- **Nemotron calls are untested against the live API** (no API key in this
  environment) — the request/response shape follows NVIDIA's documented
  OpenAI-compatible schema; verify against your actual key before shipping.
- Co-curricular activity and exam-record ingestion have data models but no
  weighting into mastery yet beyond the direct exam-mark signal — that's a
  reasonable next slice (e.g., does strong debate/robotics performance
  correlate with faster topic pickup for that student?).

## Verified

`npm install && npx jest` was run in this environment: **16/16 tests pass**,
covering the EWMA mastery math (bounds, escalation thresholds, direction of
movement for good/bad signals) and the video-signal-to-weakness-signal
conversion logic (confusion detection, ambiguous-skip handling, drop-off
penalty), plus the credit wallet's award/redeem invariants.

## Running locally

```bash
cp .env.example .env        # fill in NEMOTRON_API_KEY at minimum
docker compose up -d postgres redis
npx prisma generate --schema=src/prisma/ai-tutor-models.prisma
npm run start:dev
# Swagger UI: http://localhost:3000/api/docs
```
