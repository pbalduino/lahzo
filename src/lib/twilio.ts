import twilio from "twilio";
import { env } from "@/lib/env";
import { createId } from "@/lib/ids";

export type SendSmsInput = {
  to: string;
  from: string;
  body: string;
  idempotencyKey: string;
};

export type SendSmsResult = {
  providerMessageId: string;
};

export interface SmsGateway {
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
}

class MockSmsGateway implements SmsGateway {
  private readonly sent = new Map<string, SendSmsResult>();

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const existing = this.sent.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const result = { providerMessageId: createId("mock_twilio") };
    this.sent.set(input.idempotencyKey, result);
    return result;
  }
}

class TwilioSmsGateway implements SmsGateway {
  private readonly client = createTwilioClient();

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const message = await this.client.messages.create({
      to: input.to,
      body: input.body,
      ...(env.TWILIO_MESSAGING_SERVICE_SID
        ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
        : { from: input.from }),
    });

    return { providerMessageId: message.sid };
  }
}

function createTwilioClient() {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new Error("TWILIO_ACCOUNT_SID is required when SMS_GATEWAY=twilio");
  }

  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
      accountSid: env.TWILIO_ACCOUNT_SID,
    });
  }

  if (env.TWILIO_AUTH_TOKEN) {
    return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }

  throw new Error(
    "TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN, are required when SMS_GATEWAY=twilio",
  );
}

export const smsGateway: SmsGateway =
  env.SMS_GATEWAY === "twilio" ? new TwilioSmsGateway() : new MockSmsGateway();
