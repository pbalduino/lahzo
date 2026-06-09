# Lahzo SMS Assessment

## What this is

A small full-stack TypeScript app for a conversational SMS system:

- inbound Twilio webhook ingestion
- durable message and conversation storage
- async processing via a background worker
- outbound SMS replies through a mock or real Twilio gateway
- admin UI for browsing conversations and messages

Architecture in one line: layered TypeScript app, repository-backed durable Postgres queue, separate worker process, and SMS gateway adapter for mock or real Twilio delivery.

## Required tools

- Docker and Docker Compose: recommended way to run the full stack
- Node.js 24: required for local development outside Docker
- npm: required for local scripts and dependency installation
- ngrok: required only for local end-to-end Twilio webhook testing

## Run with Docker

Docker is the preferred way to run the project because it starts the web app, worker, and Postgres with the same topology used by the assessment.

```bash
docker compose up --build
```

This starts:

- `web` on port `3000`
- `worker` polling the same Postgres-backed queue
- `postgres` on port `5432`

Open:

```text
http://localhost:3000
```

## Run without Docker

Use this only if you already have Postgres running locally.

Create a local database:

```bash
createdb lahzo
```

Create a local `.env` file:

```bash
DATABASE_URL=postgres://YOUR_USER:YOUR_PASSWORD@localhost:5432/lahzo
SMS_GATEWAY=mock
```

If your local Postgres accepts socket or trust authentication, the URL may not need a password:

```bash
DATABASE_URL=postgres://YOUR_USER@localhost:5432/lahzo
```

```bash
npm install
npm run db:reset
npm run dev
```

`npm run dev` starts:

- `next dev` for the web app
- `tsx scripts/worker.ts` for the background worker

## Useful commands

```bash
npm run test
```

Runs the automated test suite against a real Postgres instance. Start Postgres first:

```bash
docker compose up -d postgres
```

```bash
npm run db:seed
```

Creates sample conversations and processes them through the worker flow. Useful for quickly populating the admin UI.

```bash
npm run db:reset
```

Clears conversations, messages, jobs, and worker heartbeats from Postgres. Useful before a clean manual test.

## Operational endpoints

- `GET /api/health` returns a readiness-style summary with database status, row counts, and timestamps
- `GET /api/metrics` returns a fuller JSON payload with queue and message lifecycle counters

The health check also reports whether the worker heartbeat is fresh enough to consider the async processor healthy. If no heartbeat exists yet, the worker is reported as unhealthy.

## Backend API coverage

- `POST /api/webhooks/twilio` receives incoming Twilio SMS webhook events
- inbound events are stored in Postgres as conversations and messages
- processing is handled asynchronously by `scripts/worker.ts`
- the worker simulates a 3-15 second processing delay by default
- outbound responses are sent through the configured SMS gateway
- message status is tracked through `received`, `processing`, `queued`, `sending`, `sent`, and `failed`

## Environment

- `DATABASE_URL` optional Postgres connection string
- `DATABASE_POOL_MAX` optional Postgres pool size
- `SMS_GATEWAY` optional outbound gateway, either `mock` or `twilio`
- `TWILIO_ACCOUNT_SID` required when `SMS_GATEWAY=twilio`
- `TWILIO_AUTH_TOKEN` enough for simple Twilio auth with `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY_SID` optional API key auth alternative
- `TWILIO_API_KEY_SECRET` optional API key auth alternative
- `TWILIO_MESSAGING_SERVICE_SID` optional sender override for Twilio Messaging Services
- `TWILIO_VALIDATE_SIGNATURE` optional webhook signature validation toggle. Defaults to enabled when `SMS_GATEWAY=twilio`
- `SIMULATED_DELAY_MIN_MS` optional minimum worker delay
- `SIMULATED_DELAY_MAX_MS` optional maximum worker delay
- `WORKER_ID` optional worker label
- `WORKER_CONCURRENCY` optional number of jobs a worker processes concurrently. Defaults to `5`

## Real Twilio outbound

The app uses the mock SMS gateway by default. To send real outbound SMS with account SID + auth token, set:

```bash
SMS_GATEWAY=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

`TWILIO_AUTH_TOKEN` is also used to validate inbound webhook signatures. Keep `TWILIO_VALIDATE_SIGNATURE` unset or set to `true` for real Twilio traffic. Set it to `false` only for unsigned local curl smoke tests.

API key auth is also supported:

```bash
SMS_GATEWAY=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=...
```

By default, replies are sent from the phone number that received the inbound SMS (`To` in the webhook). If you prefer a Twilio Messaging Service, set `TWILIO_MESSAGING_SERVICE_SID`.

For local end-to-end Twilio testing, expose the app with ngrok and configure the Twilio number's inbound SMS webhook. See [docs/twilio-setup.md](docs/twilio-setup.md).

## Admin UI

The admin interface is available at `/`. It lists conversations, shows operational metrics, and links to `/conversations/[conversationId]` for the full inbound/outbound message history and message statuses.

Authentication is intentionally omitted because the assessment states it is not required.

When `SMS_GATEWAY=mock`, the home page also shows a developer SMS simulator. When `SMS_GATEWAY=twilio`, that form is hidden so real Twilio testing happens through the actual SMS webhook flow: send an SMS from a phone to the Twilio number and let the worker reply.

Frontend coverage:

- view a list of conversations
- click into a conversation
- view all inbound and outbound messages
- see message status for each message

## Deployment notes

- run `web`, `worker`, and `postgres` as separate services
- set `DATABASE_URL` to the production Postgres connection string
- keep at least one worker replica running so queued SMS jobs are processed
- scale worker replicas horizontally or increase `WORKER_CONCURRENCY` when queue depth or job age increases
- expose `/api/webhooks/twilio` as the Twilio inbound SMS webhook URL
- use `/api/health` for readiness and `/api/metrics` for operational visibility
- store Twilio credentials as secrets, not committed env files
- set `SMS_GATEWAY=twilio` only when real outbound SMS should be sent

## Notes

The Twilio integration is mocked by default through a gateway abstraction. Set `SMS_GATEWAY=twilio` to use the real Twilio client for outbound SMS.

Structured JSON logs are emitted for webhook ingestion and worker activity so the processing path is observable even in the assessment environment.

For a quick manual check, open the home page and look at the operational metrics panel. Pending jobs should rise briefly after a demo SMS and fall back to zero once the worker processes it.

Claimed jobs use a lease. If the worker crashes mid-processing, an expired `running` job can be reclaimed and retried automatically instead of remaining stuck forever.

Outbound sends use a stable idempotency key derived from the generated reply message id. In the mock Twilio gateway, retries return the same provider message id instead of creating a duplicate send. In the real Twilio gateway, the same key is sent as `X-Twilio-Idempotency-Token`.

The worker writes a heartbeat into Postgres while it is running, so `/api/health` can tell the difference between a live system and a stalled processor.

## Assessment checklist

- inbound webhook returns quickly and only persists/enqueues work
- duplicate Twilio deliveries are deduplicated by `MessageSid`
- Twilio webhook signatures are validated when real Twilio mode is enabled
- jobs survive worker crashes through leases and retries
- outbound delivery retries are covered in tests
- admin UI shows conversations, message history, and statuses
- no authentication is implemented by design for this exercise
- health/metrics endpoints expose operational state and worker heartbeat
