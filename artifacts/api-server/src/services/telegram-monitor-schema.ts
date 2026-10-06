import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// جداول مراقبة قناة تلقرام — جديدة كليًا (إضافة فقط).
async function runTelegramMonitorSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_monitor_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      trial_mode boolean NOT NULL DEFAULT true,
      channel_chat_id text,
      channel_title text,
      channel_username text,
      telegram_platform_id integer REFERENCES platforms(id) ON DELETE SET NULL,
      app_platform_id integer REFERENCES platforms(id) ON DELETE SET NULL,
      monitoring_started_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_channel_posts (
      id serial PRIMARY KEY,
      chat_id text NOT NULL,
      message_id bigint NOT NULL,
      published_at timestamp NOT NULL,
      edited_at timestamp,
      caption text,
      hashtags jsonb,
      site_url text,
      post_url text,
      kind text NOT NULL DEFAULT 'pending',
      ignore_reason text,
      reciter_id integer REFERENCES reciters(id) ON DELETE SET NULL,
      mosque text,
      extracted_prayer text,
      hijri_day integer,
      hijri_month integer,
      hijri_year integer,
      parse_error text,
      edited_after_documented boolean NOT NULL DEFAULT false,
      telegram_status text NOT NULL DEFAULT 'pending',
      telegram_reason text,
      telegram_task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      telegram_proof_id integer REFERENCES task_proofs(id) ON DELETE SET NULL,
      app_status text NOT NULL DEFAULT 'pending',
      app_reason text,
      app_task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      app_proof_id integer REFERENCES task_proofs(id) ON DELETE SET NULL,
      processed_at timestamp,
      reviewed_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      reviewed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_channel_posts_message ON telegram_channel_posts(chat_id, message_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_published ON telegram_channel_posts(published_at)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_hashtag_aliases (
      id serial PRIMARY KEY,
      hashtag text NOT NULL,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_hashtag_aliases_hashtag ON telegram_hashtag_aliases(hashtag)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_seen_chats (
      chat_id text PRIMARY KEY,
      title text,
      username text,
      type text,
      bot_status text,
      first_seen_at timestamp NOT NULL DEFAULT now(),
      last_seen_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

export async function ensureTelegramMonitorSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTelegramMonitorSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
