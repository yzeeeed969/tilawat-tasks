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

// قنوات متعددة (الإصدار 20) + نقل إعدادات قناة التلاوات لمرة واحدة كما هي تمامًا.
async function runTelegramChannelsEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_channels (
      id serial PRIMARY KEY,
      kind text NOT NULL,
      chat_id text NOT NULL,
      title text,
      username text,
      enabled boolean NOT NULL DEFAULT true,
      trial_mode boolean NOT NULL DEFAULT true,
      telegram_platform_id integer REFERENCES platforms(id) ON DELETE SET NULL,
      app_platform_id integer REFERENCES platforms(id) ON DELETE SET NULL,
      page_id integer REFERENCES platform_pages(id) ON DELETE SET NULL,
      monitoring_started_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_channels_chat ON telegram_channels(chat_id)`);
  await db.execute(sql`ALTER TABLE telegram_channel_posts ADD COLUMN IF NOT EXISTS channel_id integer`);
  await db.execute(sql`ALTER TABLE telegram_channel_posts ADD COLUMN IF NOT EXISTS has_video boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE telegram_channel_posts ADD COLUMN IF NOT EXISTS day_of_week integer`);
  await db.execute(sql`ALTER TABLE telegram_channel_posts ADD COLUMN IF NOT EXISTS extra_index integer`);

  // نقل لمرة واحدة: صف إعدادات قناة التلاوات (إن كانت مسجّلة) ← صف قناة من نوع recitations بنفس القيم
  // حرفيًا (الحالة، وضع التجربة، المنصتان، بداية المراقبة). الجدول القديم لا يُحذف ولا يُعدَّل.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS app_one_time_migrations (
      name text PRIMARY KEY,
      ran_at timestamp NOT NULL DEFAULT now(),
      details jsonb
    )
  `);
  await db.transaction(async (tx: any) => {
    const marker = await tx.execute(sql`
      INSERT INTO app_one_time_migrations (name) VALUES ('telegram_channels_from_settings_v20')
      ON CONFLICT (name) DO NOTHING RETURNING name
    `);
    const inserted = (Array.isArray(marker) ? marker : marker?.rows ?? []) as unknown[];
    if (inserted.length === 0) return;
    await tx.execute(sql`
      INSERT INTO telegram_channels (kind, chat_id, title, username, enabled, trial_mode, telegram_platform_id, app_platform_id, monitoring_started_at)
      SELECT 'recitations', s.channel_chat_id, s.channel_title, s.channel_username, s.enabled, s.trial_mode,
             s.telegram_platform_id, s.app_platform_id, s.monitoring_started_at
      FROM telegram_monitor_settings s
      WHERE s.channel_chat_id IS NOT NULL
      ORDER BY s.id
      LIMIT 1
      ON CONFLICT (chat_id) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE telegram_channel_posts p SET channel_id = c.id
      FROM telegram_channels c
      WHERE p.channel_id IS NULL AND p.chat_id = c.chat_id
    `);
  });
}

export async function ensureTelegramMonitorSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTelegramMonitorSchemaEnsure().then(() => runTelegramChannelsEnsure()).then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
