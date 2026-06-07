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
