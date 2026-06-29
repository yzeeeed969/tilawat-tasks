import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTaskGenerationSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS task_generation_batches (
      id serial PRIMARY KEY,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      title text NOT NULL,
      source_platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE RESTRICT,
      start_date timestamp NOT NULL,
      end_date timestamp NOT NULL,
      note text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS generation_batch_id integer REFERENCES task_generation_batches(id) ON DELETE SET NULL
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_generation_batches_created_by ON task_generation_batches(created_by_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_generation_batches_reciter ON task_generation_batches(reciter_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tasks_generation_batch_id ON tasks(generation_batch_id)`);
}

export async function ensureTaskGenerationSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTaskGenerationSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
