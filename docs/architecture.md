# Lahzo SMS Architecture

## System overview

This solution uses a single Next.js application for the admin UI and HTTP API, plus a separate TypeScript worker process.

The persistence layer is Postgres via `pg`. This keeps the assessment closer to a production shape while still keeping the queue and message lifecycle explicit in application code.

## Architecture patterns

The system uses a layered TypeScript architecture with a repository-backed durable queue, a separate worker process, and gateway adapters for external SMS delivery.

Patterns used:

- layered architecture: UI/API, processing logic, persistence, and integrations are separated
- repository pattern: database access is centralized in `src/lib/repository.ts`
- durable queue: Postgres `jobs` rows decouple webhook ingestion from slow processing
- worker pattern: `scripts/worker.ts` processes jobs outside the HTTP request path
- gateway/adapter pattern: `src/lib/twilio.ts` switches between mock and real Twilio delivery
- transactional ingest: inbound message and job are written in the same database transaction
- idempotent ingest: duplicate Twilio deliveries are deduplicated by `MessageSid`
- lease-based job claiming: workers can recover jobs after crashes without losing work

## Request flow

1. Twilio posts an inbound SMS webhook.
2. The webhook handler validates the payload and writes the message to the database in a transaction.
3. The handler enqueues a job row in the same transaction.
4. The handler returns `202 Accepted` immediately.
5. A background worker polls pending jobs, claims one atomically, simulates 3-15 seconds of processing, and sends the outbound reply through a gateway abstraction.
6. The outbound message and the inbound lifecycle state are updated in the database.

## Webhook timeout handling

Twilio has a 5-second timeout, while processing takes 3-15 seconds. The webhook path does not perform the slow work. It only validates, persists, and enqueues. That keeps the request short and safe within the timeout window.

## Decoupling message processing

Processing is decoupled through a durable `jobs` table. The worker claims one pending job at a time using an atomic `UPDATE ... RETURNING` guard so two workers do not process the same job concurrently.

For this assessment, Postgres is the queue boundary. That is a deliberate production-minded choice for an early system: it keeps the write path transactional, preserves message durability, supports multiple worker processes, and avoids introducing distributed queue infrastructure before the operational need is proven.

This gives the key behavior the assessment asks for:

- durable queue state
- retryability
- clear job ownership
- no dependence on request latency

The worker also writes a heartbeat row in the database. The health endpoint can therefore distinguish between "database reachable" and "worker stale, missing, or down".

## Idempotency and duplicate webhook deliveries

Twilio may deliver the same webhook more than once. The inbound `MessageSid` is stored with a unique constraint. If the same webhook arrives again, the system returns the existing record and does not enqueue another job.

This prevents duplicate processing without relying on memory or request-local state.

## Message ordering

Twilio does not guarantee delivery order, so the system does not assume that inbound messages arrive in conversation order. The admin UI renders the thread using the stored receipt timestamps (`received_at`) and creation timestamps as a tie-breaker, which keeps display stable without pretending we know the true causal order when the provider reorders messages.

## Message loss prevention

The ingest path writes both the inbound message and the processing job in one transaction. That means:

- if the request succeeds, the work is durably recorded
- if the request fails before commit, nothing is partially persisted
- if the worker crashes, the job remains in the queue and can be retried

The system also keeps outbound message rows even if send attempts fail, which means the conversation history remains intact and retry state is visible.

If the worker crashes after claiming a job, the job is not lost. Claimed jobs have a lease with an expiry timestamp, and expired `running` jobs become claimable again on the next worker pass. That avoids the "stuck running forever" failure mode.

Outbound sends are keyed by the outbound message id. In the mock gateway, the same idempotency key returns the same provider response, so a retry after a crash does not create a duplicate send in the assessment environment.

The real Twilio gateway can be enabled with `SMS_GATEWAY=twilio`. The simplest configuration is `TWILIO_ACCOUNT_SID` plus `TWILIO_AUTH_TOKEN`. API key credentials (`TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`) are also supported. When using the real provider, full exactly-once outbound delivery still depends on provider behavior or a stronger delivery ledger/outbox design.

## Admin interface and authentication

The admin UI is intentionally minimal and unauthenticated because the assessment explicitly says authentication is not required.

The home page lists conversations and operational metrics. The conversation detail page shows the full message history, including inbound/outbound direction, message body, timestamps, and status.

Frontend coverage:

- `/` shows the conversation list
- conversation rows link to `/conversations/[conversationId]`
- the detail page shows all inbound and outbound messages in timestamp order
- each message displays its current status
- no authentication flow is implemented by design

## Data model

Main tables:

- `conversations`: one row per phone pair
- `messages`: inbound and outbound SMS records, status, timestamps, error state, and linkage between inbound and outbound messages
- `jobs`: durable processing queue with attempt tracking and retry timing
- the outbound send key is stable per generated reply, which makes retry behavior deterministic

Why this shape:

- conversations let the admin view conversations directly
- messages preserve a full audit trail
- jobs isolate processing lifecycle from message lifecycle
- job leases let the worker recover from process crashes without manual intervention

## Message status lifecycle

The required statuses are represented directly:

- `received`: inbound SMS persisted by the webhook
- `processing`: worker claimed the inbound message and is performing the simulated work
- `sent`: inbound processing completed and outbound SMS was accepted by the SMS gateway
- `failed`: processing or outbound delivery failed

The implementation also tracks two outbound-specific intermediate states:

- `queued`: outbound response row has been created but sending has not started
- `sending`: worker is attempting delivery through the SMS gateway

## Tradeoffs

What I chose:

- Postgres as the durable system of record and initial job queue
- a separate worker process so webhook latency is independent from message processing time
- atomic job claiming and leases so multiple workers can run without double-processing the same job
- mock Twilio gateway by default to avoid external setup during review, with a real Twilio gateway available by configuration

### Postgres queue vs RabbitMQ

I intentionally kept the initial queue in Postgres instead of adding RabbitMQ.

Postgres queue advantages for this implementation:

- the inbound message and job are committed in the same transaction
- there is no gap where the message is stored but the job publish fails
- fewer services make the assessment easier to run and review
- the current claim/lease design still supports multiple worker replicas
- all conversation, message, job, retry, and health state is inspectable in one place

RabbitMQ advantages if the system grows:

- stronger queue-native semantics such as ack/nack, routing, dead-letter queues, and backpressure
- workers can scale with less database contention
- high-throughput background processing is easier to tune independently from the relational database
- multiple processing pipelines can be routed cleanly by message type

RabbitMQ tradeoffs:

- it adds another production service to deploy, monitor, and debug
- the system then needs an outbox publisher to avoid losing jobs between the Postgres commit and RabbitMQ publish
- retry and dead-letter policies need careful design to avoid duplicates or infinite retry loops
- for the current problem size, it adds operational complexity before the need is proven

The production path I would take is incremental: keep Postgres as the durable source of truth and initial queue, measure queue depth and job age, then introduce RabbitMQ or another broker behind the same worker boundary if throughput or latency requires it. At that point I would add an outbox table so publishing to RabbitMQ is driven from committed database state.

What I accepted:

- Postgres-backed queues are a good fit for this scale and exercise, but they require careful indexing, bounded polling, and operational visibility
- a broker is not required to prove the architecture, because the code already isolates the queue behind repository functions and a worker boundary
- the polling interval is intentionally small and simple for review; production tuning would depend on measured traffic and latency targets

## What I would change for production scale

- horizontally scale worker replicas with the existing claim/lease mechanism
- add indexes and dashboards around queue depth, job age, attempts, and failed jobs
- move from polling to `LISTEN/NOTIFY` or a broker such as SQS/RabbitMQ if queue depth or latency metrics justify it
- add a proper outbox/inbox pattern with a delivery ledger
- make per-worker concurrency configurable
- add tracing and dead-letter handling
- add authentication and authorization to the admin UI
- add retention and archival policies for conversation history

## Deployment notes

The deployable units are intentionally separated:

- `web`: Next.js admin UI and API routes
- `worker`: background SMS processor
- `postgres`: durable system of record and initial queue

Operational requirements:

- configure `DATABASE_URL` for both web and worker
- keep the worker process deployed independently from the web process
- configure Twilio inbound SMS to call `POST /api/webhooks/twilio`
- use `SMS_GATEWAY=mock` for local review and `SMS_GATEWAY=twilio` for real outbound SMS
- store Twilio credentials in secret management rather than committed files
- monitor `/api/health`, `/api/metrics`, structured logs, worker heartbeat freshness, queue depth, and failed jobs

## Testing strategy

The test suite runs against a real Postgres instance instead of an in-memory fake or repository stub.

I made that choice because the highest-risk behavior in this system depends on database semantics:

- transactionality between inbound message insert and job enqueue
- unique constraints for webhook idempotency
- atomic job claiming with `UPDATE ... RETURNING`
- lease expiry and retry behavior
- persisted status transitions across worker attempts

Mocking the database would make the tests faster, but it would also avoid the exact behavior the system relies on for correctness. The external SMS provider remains behind a gateway abstraction, so tests can keep Twilio mocked while still exercising the real persistence and queue behavior.

Coverage includes:

- webhook parsing
- duplicate webhook ingestion / idempotency
- full inbound webhook -> worker -> outbound flow
- worker crash recovery for expired jobs
- outbound retry after a temporary send failure
- health reporting before the worker heartbeat exists

## Spec checklist

- 5-second webhook timeout: addressed by persisting and enqueuing before returning `202`
- duplicate webhook deliveries: addressed by unique `MessageSid`
- out-of-order delivery: addressed by stable timestamp ordering in the admin UI
- message loss: addressed by durable writes, job leasing, and retryable failed jobs
- message status tracking: addressed by `received`, `processing`, `queued`, `sending`, `sent`, and `failed`
- admin conversation history: addressed by the conversation list/detail UI
- authentication: intentionally omitted because it is out of scope for the exercise
- operational visibility: addressed by `/api/health`, `/api/metrics`, logs, and worker heartbeat

Residual production risk:

- a real external SMS provider may still require a stronger delivery ledger or provider-level idempotency to fully eliminate duplicate outbound sends during crash windows
