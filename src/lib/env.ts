import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().optional(),
  SMS_GATEWAY: z.enum(["mock", "twilio"]).default("mock"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  WORKER_ID: z.string().optional(),
  SIMULATED_DELAY_MIN_MS: z.coerce.number().int().positive().optional(),
  SIMULATED_DELAY_MAX_MS: z.coerce.number().int().positive().optional(),
});

export const env = envSchema.parse(process.env);
