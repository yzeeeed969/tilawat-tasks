import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTaskDependenciesSchemaEnsure() {
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'admin_created'`);
  await db.execute(sql`UPDATE tasks SET source = 'admin_created' WHERE source IS NULL`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id serial PRIMARY KEY,
      prerequisite_task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dependent_task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_task_dependencies_pair
    ON task_dependencies(prerequisite_task_id, dependent_task_id)
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_dependencies_prerequisite ON task_dependencies(prerequisite_task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_dependencies_dependent ON task_dependencies(dependent_task_id)`);
}

export async function ensureTaskDependenciesSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTaskDependenciesSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
