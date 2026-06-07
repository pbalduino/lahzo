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

    const outboundFrom = payload.from?.trim();
    const outboundTo = payload.to?.trim();

    if (!outboundFrom || !outboundTo) {
      return NextResponse.json({ error: "from and to are required" }, { status: 400 });
    }

    const result = await createMockInboundMessage({
      // The admin form is written as an outbound test send: From is the Twilio
      // number and To is the user. Twilio inbound webhooks arrive inverted.
      from: outboundTo,
      to: outboundFrom,
      body: payload.body ?? "",
    });

    logger.info("mock sms created", {
      duplicate: result.duplicate,
      conversationId: result.conversationId,
      inboundMessageId: result.inboundMessage.id,
      outboundFrom,
      outboundTo,
    });

    return NextResponse.json(
      {
        duplicate: result.duplicate,
        conversationId: result.conversationId,
        inboundMessageId: result.inboundMessage.id,
        outboundFrom,
        outboundTo,
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
