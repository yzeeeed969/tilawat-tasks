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
      type text NOT NULL DEFAULT 'custom',
      weekdays text,
      time_of_day text,
      status text NOT NULL DEFAULT 'active',
      sent_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`ALTER TABLE personal_reminders ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'custom'`);
  await db.execute(sql`ALTER TABLE personal_reminders ADD COLUMN IF NOT EXISTS weekdays text`);
  await db.execute(sql`ALTER TABLE personal_reminders ADD COLUMN IF NOT EXISTS time_of_day text`);
  await db.execute(sql`UPDATE personal_reminders SET type = 'custom' WHERE type IS NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_personal_reminders_user_id ON personal_reminders(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_personal_reminders_active_due ON personal_reminders(status, remind_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_personal_reminders_type_status ON personal_reminders(type, status)`);
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
