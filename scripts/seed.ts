import { createMockInboundMessage } from "@/server/sms";
import { processJobsUntilIdle } from "@/server/sms";
import { closeDatabase } from "@/lib/db";

async function main() {
  await createMockInboundMessage({
    from: "+15550001111",
    to: "+15550009999",
    body: "Need order status for #1001.",
  });

  await createMockInboundMessage({
    from: "+15550002222",
    to: "+15550009999",
    body: "Cancel my subscription.",
  });

  await processJobsUntilIdle("seed-worker");
  await closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
