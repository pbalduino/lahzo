import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { createMockInboundMessage } from "@/server/sms";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      from?: string;
      to?: string;
      body?: string;
    };

    if (!payload.from || !payload.to) {
      return NextResponse.json({ error: "from and to are required" }, { status: 400 });
    }

    const result = await createMockInboundMessage({
      from: payload.from,
      to: payload.to,
      body: payload.body ?? "",
    });

    logger.info("mock sms created", {
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
    const message = error instanceof Error ? error.message : "Invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
