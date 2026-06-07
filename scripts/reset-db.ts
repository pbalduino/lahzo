import { resetDatabase, closeDatabase } from "@/lib/db";

async function main() {
  await resetDatabase();
  await closeDatabase();
  console.log("Reset Postgres tables");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
