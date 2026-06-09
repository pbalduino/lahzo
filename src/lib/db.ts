import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "@/lib/env";

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

const DEFAULT_DATABASE_URL = "postgres://lahzo:lahzo@localhost:5432/lahzo";

export type DbClient = Pick<PoolClient, "query">;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      max: env.DATABASE_POOL_MAX ?? 10,
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
) {
  await initializeDatabase();
  return getPool().query<T>(sql, values);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  await initializeDatabase();
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase() {
  if (!initialized) {
    initialized = initializeSchema();
  }

  return initialized;
}

export async function resetDatabase() {
  await initializeDatabase();
  await getPool().query(`
    TRUNCATE worker_heartbeats, jobs, messages, conversations RESTART IDENTITY CASCADE
  `);
}

export async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    initialized = null;
  }
}

async function initializeSchema() {
  const database = getPool();

  await database.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      from_phone TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      last_message_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(from_phone, to_phone)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      external_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      related_inbound_message_id TEXT UNIQUE,
      provider_message_id TEXT,
      received_at TIMESTAMPTZ NOT NULL,
      processing_started_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
      ON messages(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_messages_status
      ON messages(status);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      payload_json JSONB NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      lease_expires_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status_available_at
      ON jobs(status, available_at, created_at);

    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      worker_id TEXT PRIMARY KEY,
      last_seen_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  await database.query(`
    ALTER TABLE conversations
      ALTER COLUMN last_message_at TYPE TIMESTAMPTZ USING last_message_at::timestamptz,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

    ALTER TABLE messages
      ALTER COLUMN received_at TYPE TIMESTAMPTZ USING received_at::timestamptz,
      ALTER COLUMN processing_started_at TYPE TIMESTAMPTZ USING processing_started_at::timestamptz,
      ALTER COLUMN processed_at TYPE TIMESTAMPTZ USING processed_at::timestamptz,
      ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING sent_at::timestamptz,
      ALTER COLUMN failed_at TYPE TIMESTAMPTZ USING failed_at::timestamptz,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

    ALTER TABLE jobs
      ALTER COLUMN available_at TYPE TIMESTAMPTZ USING available_at::timestamptz,
      ALTER COLUMN locked_at TYPE TIMESTAMPTZ USING locked_at::timestamptz,
      ALTER COLUMN lease_expires_at TYPE TIMESTAMPTZ USING lease_expires_at::timestamptz,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

    ALTER TABLE worker_heartbeats
      ALTER COLUMN last_seen_at TYPE TIMESTAMPTZ USING last_seen_at::timestamptz,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;
  `);
}
