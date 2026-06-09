import { afterEach, beforeEach, expect, test, vi } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://lahzo:lahzo@localhost:5432/lahzo";

let loadedDb: typeof import("../src/lib/db") | null = null;

async function loadModules() {
  vi.resetModules();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  loadedDb = await import("../src/lib/db");
  await loadedDb.resetDatabase();

  return {
    db: loadedDb,
    repository: await import("../src/lib/repository"),
    sms: await import("../src/server/sms"),
  };
}

beforeEach(() => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
});

afterEach(async () => {
  if (loadedDb) {
    await loadedDb.resetDatabase();
    await loadedDb.closeDatabase();
    loadedDb = null;
  }

  delete process.env.DATABASE_URL;
  delete process.env.SMS_GATEWAY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_VALIDATE_SIGNATURE;
  delete process.env.WORKER_CONCURRENCY;
  delete process.env.SIMULATED_DELAY_MIN_MS;
  delete process.env.SIMULATED_DELAY_MAX_MS;
  vi.restoreAllMocks();
});

test("ingestInboundSms is idempotent for duplicate webhook deliveries", async () => {
  const { repository } = await loadModules();

  const first = await repository.ingestInboundSms({
    messageSid: "SM123",
    from: "+15550001111",
    to: "+15550009999",
    body: "Hello",
  });
  const second = await repository.ingestInboundSms({
    messageSid: "SM123",
    from: "+15550001111",
    to: "+15550009999",
    body: "Hello",
  });

  expect(first.duplicate).toBe(false);
  expect(second.duplicate).toBe(true);
  expect(await repository.listConversations()).toHaveLength(1);
  expect(await repository.getMessageByExternalId("SM123")).not.toBeNull();
  expect(await repository.listPendingJobs(10)).toHaveLength(1);
});

test("worker health is false until a heartbeat is recorded", async () => {
  const { repository } = await loadModules();

  const metrics = await repository.getOperationalMetrics();
  expect(metrics.workerHealthy).toBe(false);
  expect(metrics.workerHeartbeatAt).toBeNull();
});

test("health route reports unhealthy worker before the heartbeat exists", async () => {
  await loadModules();
  const { GET } = await import("../app/api/health/route");

  const response = await GET();
  const payload = (await response.json()) as {
    ok: boolean;
    workerHealthy: boolean;
    workerHeartbeatAt: string | null;
  };

  expect(payload.ok).toBe(true);
  expect(payload.workerHealthy).toBe(false);
  expect(payload.workerHeartbeatAt).toBeNull();
});

test("parseWebhookRequest supports Twilio form payloads", async () => {
  const { sms } = await loadModules();

  const request = new Request("http://localhost/api/webhooks/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "MessageSid=SM999&From=%2B15550001111&To=%2B15550009999&Body=Need+help",
  });

  await expect(sms.parseWebhookRequest(request)).resolves.toEqual({
    messageSid: "SM999",
    from: "+15550001111",
    to: "+15550009999",
    body: "Need help",
  });
});

test("twilio webhook rejects unsigned requests when signature validation is enabled", async () => {
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_VALIDATE_SIGNATURE = "true";
  await loadModules();
  const { POST } = await import("../app/api/webhooks/twilio/route");

  const response = await POST(
    new Request("https://example.ngrok-free.app/api/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        MessageSid: "SMUNSIGNED",
        From: "+15550001111",
        To: "+15550009999",
        Body: "Unsigned",
      }),
    }),
  );

  expect(response.status).toBe(403);
});

test("twilio webhook accepts signed form requests", async () => {
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_VALIDATE_SIGNATURE = "true";
  const { repository } = await loadModules();
  const { POST } = await import("../app/api/webhooks/twilio/route");
  const twilio = await import("twilio");
  const url = "https://example.ngrok-free.app/api/webhooks/twilio";
  const payload = {
    MessageSid: "SMSIGNED",
    From: "+15550001111",
    To: "+15550009999",
    Body: "Signed",
  };
  const signature = twilio.default.getExpectedTwilioSignature("test-token", url, payload);

  const response = await POST(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: new URLSearchParams(payload),
    }),
  );

  expect(response.status).toBe(202);
  expect(await repository.listPendingJobs(10)).toHaveLength(1);
  expect(await repository.getMessageByExternalId("SMSIGNED")).not.toBeNull();
});

test("database transaction rolls back persisted webhook work when a failure occurs", async () => {
  const { db, repository } = await loadModules();

  await expect(
    db.withTransaction(async (client) => {
      const timestamp = new Date().toISOString();
      await client.query(
        `
        INSERT INTO conversations (id, from_phone, to_phone, last_message_at, created_at, updated_at)
        VALUES ('conversation_rollback', '+15550001111', '+15550009999', $1, $1, $1)
      `,
        [timestamp],
      );
      await client.query(
        `
        INSERT INTO messages (
          id, conversation_id, direction, external_id, body, status, error,
          related_inbound_message_id, provider_message_id, received_at,
          processing_started_at, processed_at, sent_at, failed_at, created_at, updated_at
        ) VALUES (
          'message_rollback', 'conversation_rollback', 'inbound', 'SMROLLBACK',
          'rollback', 'received', NULL, NULL, NULL, $1, NULL, NULL, NULL, NULL, $1, $1
        )
      `,
        [timestamp],
      );

      throw new Error("simulated database failure");
    }),
  ).rejects.toThrow("simulated database failure");

  expect(await repository.listConversations()).toHaveLength(0);
  expect(await repository.getMessageByExternalId("SMROLLBACK")).toBeNull();
  expect(await repository.listPendingJobs(10)).toHaveLength(0);
});

test("expired running jobs are claimable again after a worker crash", async () => {
  const { db, repository } = await loadModules();

  await repository.ingestInboundSms({
    messageSid: "SMCRASH",
    from: "+15550001111",
    to: "+15550009999",
    body: "Please recover me",
  });

  const job = (await repository.listPendingJobs(1))[0];
  expect(job).toBeDefined();

  await db.query(
    `
    UPDATE jobs
    SET status = 'running',
        locked_at = $1,
        locked_by = 'stale-worker',
        lease_expires_at = $2
    WHERE id = $3
  `,
    [
      new Date(Date.now() - 120_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
      job.id,
    ],
  );

  const claimable = await repository.listPendingJobs(10);
  expect(claimable).toHaveLength(1);
  expect(claimable[0].id).toBe(job.id);
  expect(claimable[0].status).toBe("running");
});

test("mock gateway is idempotent for the same delivery key", async () => {
  const { smsGateway } = await import("../src/lib/twilio");
  const first = await smsGateway.sendSms({
    to: "+15550001111",
    from: "+15550009999",
    body: "Reply",
    idempotencyKey: "message-123",
  });

  const second = await smsGateway.sendSms({
    to: "+15550001111",
    from: "+15550009999",
    body: "Reply",
    idempotencyKey: "message-123",
  });

  expect(second.providerMessageId).toBe(first.providerMessageId);
});

test("full inbound-to-outbound flow completes through the worker", async () => {
  process.env.SIMULATED_DELAY_MIN_MS = "1";
  process.env.SIMULATED_DELAY_MAX_MS = "2";

  const { repository, sms } = await loadModules();

  const ingested = await repository.ingestInboundSms({
    messageSid: "SMFULLFLOW",
    from: "+15550001111",
    to: "+15550009999",
    body: "Need help with my order",
  });

  const processed = await sms.processNextJob("test-worker");
  expect(processed).not.toBeNull();

  const conversation = await repository.getConversationById(ingested.conversationId);
  expect(conversation).not.toBeNull();
  expect(conversation?.messages).toHaveLength(2);

  const [inbound, outbound] = conversation!.messages;
  expect(inbound.direction).toBe("inbound");
  expect(inbound.status).toBe("sent");
  expect(outbound.direction).toBe("outbound");
  expect(outbound.status).toBe("sent");
  expect(outbound.relatedInboundMessageId).toBe(inbound.id);
  expect(outbound.providerMessageId).toMatch(/^mock_twilio_/);
});

test("processNextJobs processes multiple jobs concurrently", async () => {
  process.env.SIMULATED_DELAY_MIN_MS = "1";
  process.env.SIMULATED_DELAY_MAX_MS = "1";

  const { repository, sms } = await loadModules();

  await Promise.all([
    repository.ingestInboundSms({
      messageSid: "SMCONCURRENT1",
      from: "+15550001111",
      to: "+15550009999",
      body: "First",
    }),
    repository.ingestInboundSms({
      messageSid: "SMCONCURRENT2",
      from: "+15550002222",
      to: "+15550009999",
      body: "Second",
    }),
  ]);

  const processed = await sms.processNextJobs("test-worker", 2);

  expect(processed).toHaveLength(2);
  expect(await repository.listPendingJobs(10)).toHaveLength(0);
});

test("dev inbound route respects UI outbound From and To fields", async () => {
  process.env.SIMULATED_DELAY_MIN_MS = "1";
  process.env.SIMULATED_DELAY_MAX_MS = "1";

  const { repository, sms } = await loadModules();
  const { POST } = await import("../app/api/dev/inbound/route");
  const { smsGateway } = await import("../src/lib/twilio");
  const sendSpy = vi.spyOn(smsGateway, "sendSms");

  const response = await POST(
    new Request("http://localhost/api/dev/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "+15013659142",
        to: "+5511975185804",
        body: "Real phone test",
      }),
    }),
  );

  const payload = (await response.json()) as { conversationId: string };
  await sms.processNextJob("test-worker");

  const conversation = await repository.getConversationById(payload.conversationId);
  expect(conversation?.fromPhone).toBe("+5511975185804");
  expect(conversation?.toPhone).toBe("+15013659142");
  expect(sendSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      from: "+15013659142",
      to: "+5511975185804",
    }),
  );
});

test("failed outbound delivery is retried without creating a duplicate outbound message", async () => {
  process.env.SIMULATED_DELAY_MIN_MS = "1";
  process.env.SIMULATED_DELAY_MAX_MS = "1";

  const { db, repository, sms } = await loadModules();
  const { smsGateway } = await import("../src/lib/twilio");
  const sendSpy = vi.spyOn(smsGateway, "sendSms");
  sendSpy.mockRejectedValueOnce(new Error("temporary provider failure"));

  const ingested = await repository.ingestInboundSms({
    messageSid: "SMRETRY",
    from: "+15550001111",
    to: "+15550009999",
    body: "Please retry",
  });

  const firstAttempt = await sms.processNextJob("test-worker");
  expect(firstAttempt).not.toBeNull();

  const failedOutbound = (await repository.getConversationById(ingested.conversationId))?.messages.find(
    (message) => message.direction === "outbound",
  );

  expect(failedOutbound?.status).toBe("failed");

  await db.query(
    `
    UPDATE jobs
    SET available_at = $1
    WHERE status = 'pending'
  `,
    [new Date(Date.now() - 60_000).toISOString()],
  );

  expect(await repository.listPendingJobs(10)).toHaveLength(1);

  const secondAttempt = await sms.processNextJob("test-worker");
  expect(secondAttempt).not.toBeNull();

  const conversation = await repository.getConversationById(ingested.conversationId);
  expect(conversation?.messages.filter((message) => message.direction === "outbound")).toHaveLength(1);
  expect(conversation?.messages[1].status).toBe("sent");
  expect(conversation?.messages[1].providerMessageId).toMatch(/^mock_twilio_/);
});
