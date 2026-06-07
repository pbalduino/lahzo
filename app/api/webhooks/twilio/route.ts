import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { ingestWebhookRequest } from "@/server/sms";

export async function POST(request: Request) {
  try {
    const result = await ingestWebhookRequest(request);
    logger.info("webhook accepted", {
      duplicate: result.duplicate,
      conversationId: result.conversationId,
      inboundMessageId: result.inboundMessage.id,
    });

    return NextResponse.json(
      {
        duplicate: result.duplicate,
        conversationId: result.conversationId,
        inboundMessageId: result.inboundMessage.id,
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid webhook payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
