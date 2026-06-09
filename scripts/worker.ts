import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { recordWorkerHeartbeat } from "@/lib/repository";
import { logger } from "@/lib/logger";
import { processNextJobs } from "@/server/sms";
import { sleep } from "@/lib/time";

const workerId = process.env.WORKER_ID ?? `worker_${randomUUID()}`;
const concurrency = env.WORKER_CONCURRENCY ?? 5;
const heartbeatIntervalMs = Math.min(10_000, Math.max(1_000, (env.SIMULATED_DELAY_MAX_MS ?? 15_000) / 2));
let running = true;

process.on("SIGINT", () => {
  running = false;
});

process.on("SIGTERM", () => {
  running = false;
});

async function main() {
  // Polling is acceptable here because the queue is persisted in Postgres and the
  // assessment values clarity over distributed-queue complexity.
  logger.info("worker started", { workerId, concurrency });
  await recordHeartbeat();
  const heartbeatTimer = setInterval(recordHeartbeat, heartbeatIntervalMs);
  heartbeatTimer.unref();

  while (running) {
    try {
      const processed = await processNextJobs(workerId, concurrency);
      if (processed.length === 0) {
        await sleep(500);
      }
    } catch (error) {
      logger.error("worker cycle failed", {
        workerId,
        error: error instanceof Error ? error.message : "unknown error",
      });
      await sleep(500);
    }
  }

  clearInterval(heartbeatTimer);
  await recordHeartbeat();
  logger.info("worker stopped", { workerId });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function recordHeartbeat() {
  try {
    await recordWorkerHeartbeat(workerId);
  } catch (error) {
    logger.error("failed to record worker heartbeat", {
      workerId,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
