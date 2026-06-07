# Lahzo SMS Assessment

## What this is

A small full-stack TypeScript app for a conversational SMS system:

- inbound Twilio webhook ingestion
- durable message and conversation storage
- async processing via a background worker
- outbound SMS replies through a mock or real Twilio gateway
- admin UI for browsing conversations and messages

Architecture in one line: layered TypeScript app, repository-backed durable Postgres queue, separate worker process, and SMS gateway adapter for mock or real Twilio delivery.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts:

- `next dev` for the web app
- `tsx scripts/worker.ts` for the background worker

## Run with Docker

```bash
docker compose up --build
```

This starts:

- `web` on port `3000`
- `worker` polling the same Postgres-backed queue
- `postgres` on port `5432`

## Useful commands

```bash
npm run test
npm run db:seed
npm run db:reset
```

Tests run against a real Postgres instance, not an in-memory database. Start it with `docker compose up -d postgres` before running `npm test`.

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
- `TWILIO_API_KEY_SID` required for Twilio API key auth
- `TWILIO_API_KEY_SECRET` required for Twilio API key auth
- `TWILIO_AUTH_TOKEN` optional fallback if not using API key auth
- `TWILIO_MESSAGING_SERVICE_SID` optional sender override for Twilio Messaging Services
- `SIMULATED_DELAY_MIN_MS` optional minimum worker delay
- `SIMULATED_DELAY_MAX_MS` optional maximum worker delay
- `WORKER_ID` optional worker label

## Real Twilio outbound

The app uses the mock SMS gateway by default. To send real outbound SMS, set:

```bash
SMS_GATEWAY=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=...
```

By default, replies are sent from the phone number that received the inbound SMS (`To` in the webhook). If you prefer a Twilio Messaging Service, set `TWILIO_MESSAGING_SERVICE_SID`.

## Admin UI

The admin interface is available at `/`. It lists conversations, shows operational metrics, and links to `/conversations/[conversationId]` for the full inbound/outbound message history and message statuses.

Authentication is intentionally omitted because the assessment states it is not required.

Frontend coverage:

- view a list of conversations
- click into a conversation
- view all inbound and outbound messages
- see message status for each message

## Deployment notes

- run `web`, `worker`, and `postgres` as separate services
- set `DATABASE_URL` to the production Postgres connection string
- keep at least one worker replica running so queued SMS jobs are processed
- scale worker replicas horizontally when queue depth or job age increases
- expose `/api/webhooks/twilio` as the Twilio inbound SMS webhook URL
- use `/api/health` for readiness and `/api/metrics` for operational visibility
- store Twilio credentials as secrets, not committed env files
- set `SMS_GATEWAY=twilio` only when real outbound SMS should be sent

## Notes

The Twilio integration is mocked by default through a gateway abstraction. Set `SMS_GATEWAY=twilio` to use the real Twilio client for outbound SMS.

Structured JSON logs are emitted for webhook ingestion and worker activity so the processing path is observable even in the assessment environment.

For a quick manual check, open the home page and look at the operational metrics panel. Pending jobs should rise briefly after a demo SMS and fall back to zero once the worker processes it.

Claimed jobs use a lease. If the worker crashes mid-processing, an expired `running` job can be reclaimed and retried automatically instead of remaining stuck forever.

Outbound sends use a stable idempotency key derived from the generated reply message id. In the mock Twilio gateway, retries return the same provider message id instead of creating a duplicate send.

The worker writes a heartbeat into Postgres while it is running, so `/api/health` can tell the difference between a live system and a stalled processor.

## Assessment checklist

- inbound webhook returns quickly and only persists/enqueues work
- duplicate Twilio deliveries are deduplicated by `MessageSid`
- jobs survive worker crashes through leases and retries
- outbound delivery retries are covered in tests
- admin UI shows conversations, message history, and statuses
- no authentication is implemented by design for this exercise
- health/metrics endpoints expose operational state and worker heartbeat
