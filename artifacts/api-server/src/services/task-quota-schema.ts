import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTaskQuotaSchemaEnsure() {
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS weekly_quota_required integer`);
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS weekly_quota_period_start timestamp`);
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS weekly_quota_period_end timestamp`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS task_proofs (
      id serial PRIMARY KEY,
      task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      url text NOT NULL,
      note text,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      deleted_at timestamp
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_proofs_task_id ON task_proofs(task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_proofs_created_by_user_id ON task_proofs(created_by_user_id)`);
}

export async function ensureTaskQuotaSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTaskQuotaSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
