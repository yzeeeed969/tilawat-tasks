import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runPersonalRemindersSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS personal_reminders (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      message text NOT NULL,
      remind_at timestamp NOT NULL,
      timezone text NOT NULL DEFAULT 'Asia/Riyadh',
      status text NOT NULL DEFAULT 'active',
      sent_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_personal_reminders_user_id ON personal_reminders(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_personal_reminders_active_due ON personal_reminders(status, remind_at)`);
}

export async function ensurePersonalRemindersSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runPersonalRemindersSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
