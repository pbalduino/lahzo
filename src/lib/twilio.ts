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
  private readonly config = getTwilioConfig();

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const body = new URLSearchParams({
      To: input.to,
      Body: input.body,
    });

    if (env.TWILIO_MESSAGING_SERVICE_SID) {
      body.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
    } else {
      body.set("From", input.from);
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.config.basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Idempotency-Token": input.idempotencyKey,
        },
        body,
      },
    );

    const payload = (await response.json()) as { sid?: string; message?: string };
    if (!response.ok || !payload.sid) {
      throw new Error(payload.message ?? `Twilio send failed with status ${response.status}`);
    }

    return { providerMessageId: payload.sid };
  }
}

function getTwilioConfig() {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new Error("TWILIO_ACCOUNT_SID is required when SMS_GATEWAY=twilio");
  }

  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return {
      accountSid: env.TWILIO_ACCOUNT_SID,
      basicAuth: Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64"),
    };
  }

  if (env.TWILIO_AUTH_TOKEN) {
    return {
      accountSid: env.TWILIO_ACCOUNT_SID,
      basicAuth: Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"),
    };
  }

  throw new Error(
    "TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN, are required when SMS_GATEWAY=twilio",
  );
}

export const smsGateway: SmsGateway =
  env.SMS_GATEWAY === "twilio" ? new TwilioSmsGateway() : new MockSmsGateway();
