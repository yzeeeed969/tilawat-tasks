import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTaskCreationGroupsSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS task_creation_groups (
      id serial PRIMARY KEY,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      title text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS creation_group_id integer REFERENCES task_creation_groups(id) ON DELETE SET NULL
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_creation_groups_created_by ON task_creation_groups(created_by_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tasks_creation_group_id ON tasks(creation_group_id)`);
}

export async function ensureTaskCreationGroupsSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTaskCreationGroupsSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
