import type { DbClient } from "@/lib/db";
import { query, withTransaction } from "@/lib/db";
import { createId } from "@/lib/ids";
import { nowIso } from "@/lib/time";
import type {
  ConversationDetails,
  ConversationSummary,
  JobStatus,
  MessageRecord,
  MessageStatus,
} from "@/lib/types";

export type InboundSms = {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  receivedAt?: string;
  source?: "twilio" | "mock";
};

export type IngestResult = {
  duplicate: boolean;
  conversationId: string;
  inboundMessage: MessageRecord;
};

export type ProcessJob = {
  id: string;
  type: string;
  status: JobStatus;
  payload: { messageId: string };
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
};

export type OperationalMetrics = {
  databaseOk: boolean;
  workerHealthy: boolean;
  workerHeartbeatAt: string | null;
  counts: {
    conversations: number;
    messages: number;
    inboundMessages: number;
    outboundMessages: number;
    pendingJobs: number;
    runningJobs: number;
    completedJobs: number;
    failedJobs: number;
  };
  messageStatuses: Record<MessageStatus, number>;
  lastMessageAt: string | null;
  lastJobAt: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  external_id: string;
  body: string;
  status: MessageStatus;
  error: string | null;
  related_inbound_message_id: string | null;
  provider_message_id: string | null;
  received_at: TimestampValue;
  processing_started_at: TimestampValue | null;
  processed_at: TimestampValue | null;
  sent_at: TimestampValue | null;
  failed_at: TimestampValue | null;
  created_at: TimestampValue;
  updated_at: TimestampValue;
};

type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  payload_json: { messageId: string } | string;
  attempts: number;
  max_attempts: number;
  available_at: TimestampValue;
  lease_expires_at: TimestampValue | null;
};

type TimestampValue = string | Date;

const JOB_LEASE_MS = 60_000;
const WORKER_HEARTBEAT_STALE_MS = 30_000;

export async function ingestInboundSms(input: InboundSms): Promise<IngestResult> {
  const timestamp = input.receivedAt ?? nowIso();

  return withTransaction(async (client) => {
    const existing = await getMessageByExternalIdFromDb(client, input.messageSid);
    if (existing) {
      return {
        duplicate: true,
        conversationId: existing.conversation_id,
        inboundMessage: mapMessageRow(existing),
      };
    }

    const createdAt = nowIso();
    const conversationId = createId("conversation");
    const conversation = await client.query<{ id: string }>(
      `
      INSERT INTO conversations (id, from_phone, to_phone, last_message_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(from_phone, to_phone) DO UPDATE SET
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at
      RETURNING id
    `,
      [conversationId, input.from, input.to, timestamp, createdAt, createdAt],
    );

    const messageId = createId("message");
    await client.query(
      `
      INSERT INTO messages (
        id,
        conversation_id,
        direction,
        external_id,
        body,
        status,
        error,
        related_inbound_message_id,
        provider_message_id,
        received_at,
        processing_started_at,
        processed_at,
        sent_at,
        failed_at,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, 'inbound', $3, $4, 'received', NULL, NULL, NULL,
        $5, NULL, NULL, NULL, NULL, $6, $7
      )
    `,
      [messageId, conversation.rows[0].id, input.messageSid, input.body, timestamp, createdAt, createdAt],
    );

    await client.query(
      `
      UPDATE conversations
      SET last_message_at = $1, updated_at = $2
      WHERE id = $3
    `,
      [timestamp, createdAt, conversation.rows[0].id],
    );

    await client.query(
      `
      INSERT INTO jobs (
        id, type, status, payload_json, available_at, locked_at, locked_by,
        attempts, max_attempts, last_error, created_at, updated_at
      ) VALUES (
        $1, $2, 'pending', $3, $4, NULL, NULL, 0, 5, NULL, $5, $6
      )
    `,
      [
        createId("job"),
        "process-inbound-message",
        JSON.stringify({ messageId }),
        createdAt,
        createdAt,
        createdAt,
      ],
    );

    const inboundMessage = await getMessageByIdFromDb(client, messageId);
    if (!inboundMessage) {
      throw new Error(`Inbound message not found after insert: ${messageId}`);
    }

    return {
      duplicate: false,
      conversationId: conversation.rows[0].id,
      inboundMessage: mapMessageRow(inboundMessage),
    };
  });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const rows = await query<{
    id: string;
    from_phone: string;
    to_phone: string;
    last_message_at: TimestampValue;
    created_at: TimestampValue;
    updated_at: TimestampValue;
    message_count: string;
    last_message_body: string | null;
    last_message_status: MessageStatus | null;
  }>(`
    SELECT
      c.id,
      c.from_phone,
      c.to_phone,
      c.last_message_at,
      c.created_at,
      c.updated_at,
      COUNT(m.id) AS message_count,
      (
        SELECT m2.body
        FROM messages m2
        WHERE m2.conversation_id = c.id
        ORDER BY m2.received_at DESC, m2.created_at DESC
        LIMIT 1
      ) AS last_message_body,
      (
        SELECT m2.status
        FROM messages m2
        WHERE m2.conversation_id = c.id
        ORDER BY m2.received_at DESC, m2.created_at DESC
        LIMIT 1
      ) AS last_message_status
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.last_message_at DESC
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    fromPhone: row.from_phone,
    toPhone: row.to_phone,
    lastMessageAt: toIso(row.last_message_at),
    lastMessageBody: row.last_message_body,
    lastMessageStatus: row.last_message_status,
    messageCount: Number(row.message_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

export async function getOperationalMetrics(): Promise<OperationalMetrics> {
  const [
    conversations,
    messages,
    inboundMessages,
    outboundMessages,
    pendingJobs,
    runningJobs,
    completedJobs,
    failedJobs,
    received,
    processing,
    sent,
    failed,
    queued,
    sending,
    lastMessageAt,
    lastJobAt,
    workerHeartbeat,
  ] = await Promise.all([
    countByQuery("SELECT COUNT(*) AS count FROM conversations"),
    countByQuery("SELECT COUNT(*) AS count FROM messages"),
    countByQuery("SELECT COUNT(*) AS count FROM messages WHERE direction = 'inbound'"),
    countByQuery("SELECT COUNT(*) AS count FROM messages WHERE direction = 'outbound'"),
    countByQuery("SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'"),
    countByQuery("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'"),
    countByQuery("SELECT COUNT(*) AS count FROM jobs WHERE status = 'completed'"),
    countByQuery("SELECT COUNT(*) AS count FROM jobs WHERE status = 'failed'"),
    countMessageStatus("received"),
    countMessageStatus("processing"),
    countMessageStatus("sent"),
    countMessageStatus("failed"),
    countMessageStatus("queued"),
    countMessageStatus("sending"),
    query<{ value: TimestampValue | null }>("SELECT MAX(created_at) AS value FROM messages"),
    query<{ value: TimestampValue | null }>("SELECT MAX(created_at) AS value FROM jobs"),
    getLatestWorkerHeartbeat(),
  ]);

  const workerHeartbeatAt = toIso(workerHeartbeat?.last_seen_at ?? null);
  const workerHealthy =
    workerHeartbeatAt !== null &&
    Date.now() - new Date(workerHeartbeatAt).getTime() <= WORKER_HEARTBEAT_STALE_MS;

  return {
    databaseOk: true,
    workerHealthy,
    workerHeartbeatAt,
    counts: {
      conversations,
      messages,
      inboundMessages,
      outboundMessages,
      pendingJobs,
      runningJobs,
      completedJobs,
      failedJobs,
    },
    messageStatuses: {
      received,
      processing,
      sent,
      failed,
      queued,
      sending,
    },
    lastMessageAt: toIso(lastMessageAt.rows[0]?.value ?? null),
    lastJobAt: toIso(lastJobAt.rows[0]?.value ?? null),
  };
}

export async function getConversationById(
  conversationId: string,
): Promise<ConversationDetails | null> {
  const conversation = await query<{
    id: string;
    from_phone: string;
    to_phone: string;
    created_at: TimestampValue;
    updated_at: TimestampValue;
  }>(
    `
    SELECT id, from_phone, to_phone, created_at, updated_at
    FROM conversations
    WHERE id = $1
  `,
    [conversationId],
  );

  if (!conversation.rows[0]) {
    return null;
  }

  const messages = await query<MessageRow>(
    `
    SELECT *
    FROM messages
    WHERE conversation_id = $1
    ORDER BY received_at ASC, created_at ASC
  `,
    [conversationId],
  );

  return {
    id: conversation.rows[0].id,
    fromPhone: conversation.rows[0].from_phone,
    toPhone: conversation.rows[0].to_phone,
    createdAt: toIso(conversation.rows[0].created_at),
    updatedAt: toIso(conversation.rows[0].updated_at),
    messages: messages.rows.map(mapMessageRow),
  };
}

export async function getMessageById(messageId: string) {
  const row = await getMessageByIdFromDb(null, messageId);
  return row ? mapMessageRow(row) : null;
}

export async function createMockInboundSms(input: { from: string; to: string; body: string }) {
  return ingestInboundSms({
    messageSid: createId("sms"),
    from: input.from,
    to: input.to,
    body: input.body,
    source: "mock",
  });
}

export async function listPendingJobs(limit = 1): Promise<ProcessJob[]> {
  const timestamp = nowIso();
  const rows = await query<JobRow>(
    `
    SELECT id, type, status, payload_json, attempts, max_attempts, available_at, lease_expires_at
    FROM jobs
    WHERE (status = 'pending' AND available_at <= $1)
       OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2)
    ORDER BY available_at ASC, created_at ASC
    LIMIT $3
  `,
    [timestamp, timestamp, limit],
  );

  return rows.rows.map(mapJobRow);
}

export async function claimJob(jobId: string, workerId: string) {
  const timestamp = nowIso();
  const result = await query<JobRow>(
    `
    UPDATE jobs
    SET status = 'running',
        locked_at = $1,
        locked_by = $2,
        lease_expires_at = $3,
        attempts = attempts + 1,
        updated_at = $4
    WHERE id = $5
      AND (
        status = 'pending'
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $6)
      )
    RETURNING id, type, status, payload_json, attempts, max_attempts, available_at, lease_expires_at
  `,
    [
      timestamp,
      workerId,
      new Date(Date.now() + JOB_LEASE_MS).toISOString(),
      timestamp,
      jobId,
      timestamp,
    ],
  );

  return result.rows[0] ? mapJobRow(result.rows[0]) : null;
}

export async function completeJob(jobId: string) {
  await query(
    `
    UPDATE jobs
    SET status = 'completed',
        lease_expires_at = NULL,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = $1
    WHERE id = $2
  `,
    [nowIso(), jobId],
  );
}

export async function failJob(jobId: string, message: string, retryAt?: string) {
  await query(
    `
    UPDATE jobs
    SET status = $1,
        last_error = $2,
        available_at = COALESCE($3, available_at),
        lease_expires_at = NULL,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = $4
    WHERE id = $5
  `,
    [retryAt ? "pending" : "failed", message, retryAt ?? null, nowIso(), jobId],
  );
}

export async function updateMessageStatus(
  messageId: string,
  status: MessageStatus,
  patch?: {
    providerMessageId?: string | null;
    error?: string | null;
    processingStartedAt?: string | null;
    processedAt?: string | null;
    sentAt?: string | null;
    failedAt?: string | null;
  },
) {
  const updated = await query<MessageRow>(
    `
    UPDATE messages
    SET status = $1,
        provider_message_id = COALESCE($2, provider_message_id),
        error = $3,
        processing_started_at = COALESCE($4, processing_started_at),
        processed_at = COALESCE($5, processed_at),
        sent_at = COALESCE($6, sent_at),
        failed_at = COALESCE($7, failed_at),
        updated_at = $8
    WHERE id = $9
    RETURNING *
  `,
    [
      status,
      patch?.providerMessageId ?? null,
      patch?.error ?? null,
      patch?.processingStartedAt ?? null,
      patch?.processedAt ?? null,
      patch?.sentAt ?? null,
      patch?.failedAt ?? null,
      nowIso(),
      messageId,
    ],
  );

  return updated.rows[0] ?? null;
}

export async function getMessageByExternalId(externalId: string) {
  const row = await getMessageByExternalIdFromDb(null, externalId);
  return row ? mapMessageRow(row) : null;
}

export async function ensureOutboundResponseForInbound(messageId: string) {
  const inboundRow = await getMessageByIdFromDb(null, messageId);
  if (!inboundRow) {
    throw new Error(`Inbound message not found: ${messageId}`);
  }

  const inbound = mapMessageRow(inboundRow);
  const existing = await query<MessageRow>(
    `SELECT * FROM messages WHERE related_inbound_message_id = $1`,
    [messageId],
  );

  if (existing.rows[0]) {
    return mapMessageRow(existing.rows[0]);
  }

  const timestamp = nowIso();
  const outboundId = createId("message");
  const body = buildResponseBody(inbound.body);
  await query(
    `
    INSERT INTO messages (
      id,
      conversation_id,
      direction,
      external_id,
      body,
      status,
      error,
      related_inbound_message_id,
      provider_message_id,
      received_at,
      processing_started_at,
      processed_at,
      sent_at,
      failed_at,
      created_at,
      updated_at
    ) VALUES (
      $1, $2, 'outbound', $3, $4, 'queued', NULL, $5, NULL,
      $6, NULL, NULL, NULL, NULL, $7, $8
    )
  `,
    [
      outboundId,
      inbound.conversationId,
      `outbound-${outboundId}`,
      body,
      messageId,
      timestamp,
      timestamp,
      timestamp,
    ],
  );

  const outbound = await getMessageByIdFromDb(null, outboundId);
  if (!outbound) {
    throw new Error(`Outbound message not found after insert: ${outboundId}`);
  }

  return mapMessageRow(outbound);
}

export function buildResponseBody(body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return "Received your message. Reply with more details if you want us to continue.";
  }

  return `Received: "${trimmed}". Your request is being processed.`;
}

export function markInboundAsProcessing(messageId: string) {
  return updateMessageStatus(messageId, "processing", {
    processingStartedAt: nowIso(),
  });
}

export function markInboundAsSent(messageId: string) {
  return updateMessageStatus(messageId, "sent", {
    processedAt: nowIso(),
  });
}

export function markInboundAsFailed(messageId: string, error: string) {
  return updateMessageStatus(messageId, "failed", {
    error,
    failedAt: nowIso(),
  });
}

export function markOutboundAsSending(messageId: string) {
  return updateMessageStatus(messageId, "sending", {
    processingStartedAt: nowIso(),
  });
}

export function markOutboundAsSent(messageId: string, providerMessageId: string) {
  return updateMessageStatus(messageId, "sent", {
    providerMessageId,
    sentAt: nowIso(),
  });
}

export function markOutboundAsFailed(messageId: string, error: string) {
  return updateMessageStatus(messageId, "failed", {
    error,
    failedAt: nowIso(),
  });
}

export async function recordWorkerHeartbeat(workerId: string) {
  const timestamp = nowIso();
  await query(
    `
    INSERT INTO worker_heartbeats (worker_id, last_seen_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(worker_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `,
    [workerId, timestamp, timestamp, timestamp],
  );
}

async function getMessageByIdFromDb(client: DbClient | null, messageId: string) {
  const result = client
    ? await client.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [messageId])
    : await query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [messageId]);

  return result.rows[0];
}

async function getMessageByExternalIdFromDb(client: DbClient | null, externalId: string) {
  const result = client
    ? await client.query<MessageRow>(`SELECT * FROM messages WHERE external_id = $1`, [externalId])
    : await query<MessageRow>(`SELECT * FROM messages WHERE external_id = $1`, [externalId]);

  return result.rows[0];
}

async function countByQuery(sql: string) {
  const result = await query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

async function countMessageStatus(status: MessageStatus) {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM messages WHERE status = $1",
    [status],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function getLatestWorkerHeartbeat() {
  const result = await query<{ worker_id: string; last_seen_at: TimestampValue }>(`
    SELECT worker_id, last_seen_at
    FROM worker_heartbeats
    ORDER BY last_seen_at DESC
    LIMIT 1
  `);

  return result.rows[0];
}

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    externalId: row.external_id,
    body: row.body,
    status: row.status,
    error: row.error,
    relatedInboundMessageId: row.related_inbound_message_id,
    providerMessageId: row.provider_message_id,
    receivedAt: toIso(row.received_at),
    processingStartedAt: toIso(row.processing_started_at),
    processedAt: toIso(row.processed_at),
    sentAt: toIso(row.sent_at),
    failedAt: toIso(row.failed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapJobRow(row: JobRow): ProcessJob {
  const payload =
    typeof row.payload_json === "string"
      ? (JSON.parse(row.payload_json) as { messageId: string })
      : row.payload_json;

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: toIso(row.available_at),
    leaseExpiresAt: toIso(row.lease_expires_at),
  };
}

function toIso(value: TimestampValue): string;
function toIso(value: TimestampValue | null | undefined): string | null;
function toIso(value: TimestampValue | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}
