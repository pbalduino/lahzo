import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  claimJob,
  completeJob,
  createMockInboundSms,
  ensureOutboundResponseForInbound,
  failJob,
  getConversationById,
  getMessageById,
  ingestInboundSms,
  listPendingJobs,
  markInboundAsFailed,
  markInboundAsProcessing,
  markInboundAsSent,
  markOutboundAsFailed,
  markOutboundAsSending,
  markOutboundAsSent,
} from "@/lib/repository";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { randomBetween, sleep } from "@/lib/time";
import { smsGateway } from "@/lib/twilio";

const twilioPayloadSchema = z.object({
  MessageSid: z.string().min(1).optional(),
  messageSid: z.string().min(1).optional(),
  From: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  To: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  Body: z.string().optional(),
  body: z.string().optional(),
});

export async function ingestWebhookRequest(request: Request) {
  const payload = await parseWebhookRequest(request);
  logger.info("ingest inbound sms", { messageSid: payload.messageSid, from: payload.from, to: payload.to });
  return ingestInboundSms(payload);
}

export async function parseWebhookRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  let raw: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    raw = (await request.json()) as Record<string, string>;
  } else {
    const text = await request.text();
    raw = Object.fromEntries(new URLSearchParams(text));
  }

  const parsed = twilioPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid Twilio payload");
  }

  const messageSid = parsed.data.MessageSid ?? parsed.data.messageSid ?? `sms_${randomUUID()}`;
  const from = parsed.data.From ?? parsed.data.from;
  const to = parsed.data.To ?? parsed.data.to;
  const body = parsed.data.Body ?? parsed.data.body ?? "";

  if (!from || !to) {
    throw new Error("Twilio payload is missing From or To");
  }

  return {
    messageSid,
    from,
    to,
    body,
  };
}

export async function createMockInboundMessage(input: { from: string; to: string; body: string }) {
  return createMockInboundSms(input);
}

export async function processNextJob(workerId: string) {
  const [job] = await listPendingJobs(1);
  if (!job) {
    return null;
  }

  const claimedJob = await claimJob(job.id, workerId);
  if (!claimedJob) {
    return null;
  }

  logger.info("claimed job", { workerId, jobId: claimedJob.id, messageId: claimedJob.payload.messageId });

  const inboundMessage = await getMessageById(claimedJob.payload.messageId);
  if (!inboundMessage) {
    await failJob(claimedJob.id, `Inbound message not found for job ${claimedJob.id}`);
    return claimedJob;
  }

  const conversation = await getConversationById(inboundMessage.conversationId);
  if (!conversation) {
    await failJob(claimedJob.id, `Conversation not found for message ${inboundMessage.id}`);
    return claimedJob;
  }

  let outboundMessage = null as Awaited<ReturnType<typeof ensureOutboundResponseForInbound>> | null;

  try {
    outboundMessage = await ensureOutboundResponseForInbound(inboundMessage.id);
    await markInboundAsProcessing(inboundMessage.id);
    await markOutboundAsSending(outboundMessage.id);

    const minDelay = env.SIMULATED_DELAY_MIN_MS ?? 3000;
    const maxDelay = env.SIMULATED_DELAY_MAX_MS ?? 15000;
    const delay = randomBetween(minDelay, maxDelay);
    await sleep(delay);

    const providerResponse = await smsGateway.sendSms({
      to: conversation.fromPhone,
      from: conversation.toPhone,
      body: outboundMessage.body,
      idempotencyKey: outboundMessage.id,
    });

    await markOutboundAsSent(outboundMessage.id, providerResponse.providerMessageId);
    await markInboundAsSent(inboundMessage.id);
    await completeJob(claimedJob.id);

    logger.info("sent outbound sms", {
      workerId,
      jobId: claimedJob.id,
      inboundMessageId: inboundMessage.id,
      outboundMessageId: outboundMessage.id,
      providerMessageId: providerResponse.providerMessageId,
      from: conversation.toPhone,
      to: conversation.fromPhone,
    });

    return claimedJob;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";
    logger.error("job failed", {
      workerId,
      jobId: claimedJob.id,
      messageId: inboundMessage.id,
      error: message,
    });

    if (outboundMessage) {
      await markOutboundAsFailed(outboundMessage.id, message);
    }

    await markInboundAsFailed(inboundMessage.id, message);

    if (claimedJob.attempts < claimedJob.maxAttempts) {
      await failJob(claimedJob.id, message, new Date(Date.now() + 15000).toISOString());
    } else {
      await failJob(claimedJob.id, message);
    }

    return claimedJob;
  }
}

export async function processJobsUntilIdle(workerId: string) {
  while (true) {
    const processed = await processNextJob(workerId);
    if (!processed) {
      break;
    }
  }
}
