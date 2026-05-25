import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTelegramSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT false,
      daily_reminder_time text NOT NULL DEFAULT '09:00',
      daily_summary_time text NOT NULL DEFAULT '21:00',
      overdue_after_time text NOT NULL DEFAULT '23:59',
      timezone text NOT NULL DEFAULT 'Asia/Riyadh',
      notify_daily_reminder boolean NOT NULL DEFAULT true,
      notify_member_overdue boolean NOT NULL DEFAULT true,
      notify_admin_overdue boolean NOT NULL DEFAULT true,
      notify_admin_completed boolean NOT NULL DEFAULT true,
      notify_admin_daily_summary boolean NOT NULL DEFAULT true,
      suppress_repeat_hours integer NOT NULL DEFAULT 24,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_recipients (
      id serial PRIMARY KEY,
      user_id integer REFERENCES app_users(id) ON DELETE CASCADE,
      member_id integer REFERENCES members(id) ON DELETE CASCADE,
      chat_id text NOT NULL,
      telegram_username text,
      is_enabled boolean NOT NULL DEFAULT true,
      linked_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_link_tokens (
      id serial PRIMARY KEY,
      token_hash text NOT NULL,
      user_id integer REFERENCES app_users(id) ON DELETE CASCADE,
      member_id integer REFERENCES members(id) ON DELETE CASCADE,
      expires_at timestamp NOT NULL,
      used_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id serial PRIMARY KEY,
      channel text NOT NULL DEFAULT 'telegram',
      type text NOT NULL,
      recipient_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      recipient_member_id integer REFERENCES members(id) ON DELETE SET NULL,
      task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      dedupe_key text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      failure_reason text,
      sent_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_recipients_chat_id ON telegram_recipients(chat_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_telegram_recipients_user_id ON telegram_recipients(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_telegram_recipients_member_id ON telegram_recipients(member_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_link_tokens_hash ON telegram_link_tokens(token_hash)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_user_id ON telegram_link_tokens(user_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_logs_dedupe_key ON notification_logs(dedupe_key)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_notification_logs_type ON notification_logs(type)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_notification_logs_task_id ON notification_logs(task_id)`);
}

export async function ensureTelegramSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTelegramSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
