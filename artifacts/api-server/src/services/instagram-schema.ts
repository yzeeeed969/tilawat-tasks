import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// جداول مراقبة إنستقرام — جديدة كليًا (إضافة فقط، آمنة للتكرار).
async function runInstagramSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      trial_mode boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_accounts (
      id serial PRIMARY KEY,
      page_id integer NOT NULL REFERENCES platform_pages(id) ON DELETE CASCADE,
      platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
      member_id integer NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT true,
      ig_user_id text,
      username text,
      access_token_encrypted text,
      token_expires_at timestamp,
      token_refreshed_at timestamp,
      status text NOT NULL DEFAULT 'not_connected',
      last_error text,
      reconnect_alert_sent_at timestamp,
      connected_at timestamp,
      monitoring_started_at timestamp,
      last_checked_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS weekly_goal integer NOT NULL DEFAULT 2`);
  await db.execute(sql`ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS fb_page_id text`);
  await db.execute(sql`ALTER TABLE instagram_settings ADD COLUMN IF NOT EXISTS fb_trial_mode boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE instagram_settings ADD COLUMN IF NOT EXISTS fb_match_window_hours integer NOT NULL DEFAULT 6`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_accounts_page ON instagram_accounts(page_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_instagram_accounts_reciter ON instagram_accounts(reciter_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_oauth_states (
      state text PRIMARY KEY,
      account_id integer NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_media (
      id serial PRIMARY KEY,
      account_id integer NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      ig_media_id text NOT NULL,
      permalink text,
      caption text,
      media_type text,
      media_product_type text,
      published_at timestamp NOT NULL,
      week_start text NOT NULL,
      status text NOT NULL,
      reason text,
      task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      proof_id integer REFERENCES task_proofs(id) ON DELETE SET NULL,
      processed_at timestamp NOT NULL DEFAULT now(),
      reviewed_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      reviewed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_media_account_media ON instagram_media(account_id, ig_media_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_instagram_media_week ON instagram_media(account_id, week_start)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_weekly_tasks (
      id serial PRIMARY KEY,
      account_id integer NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      week_start text NOT NULL,
      task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_weekly_tasks_week ON instagram_weekly_tasks(account_id, week_start)`);
  // فيسبوك (نسخة منشور إنستقرام).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS facebook_connection (
      id serial PRIMARY KEY,
      user_token_encrypted text,
      token_expires_at timestamp,
      fb_user_id text,
      fb_user_name text,
      status text NOT NULL DEFAULT 'not_connected',
      last_error text,
      reconnect_alert_sent_at timestamp,
      connected_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS facebook_pages (
      id serial PRIMARY KEY,
      fb_page_id text NOT NULL,
      name text NOT NULL,
      access_token_encrypted text,
      status text NOT NULL DEFAULT 'connected',
      last_error text,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_pages_page ON facebook_pages(fb_page_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS facebook_oauth_states (
      state text PRIMARY KEY,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_facebook_links (
      id serial PRIMARY KEY,
      media_id integer NOT NULL REFERENCES instagram_media(id) ON DELETE CASCADE,
      account_id integer NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
      fb_page_id text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      fb_post_id text,
      fb_url text,
      task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      proof_id integer REFERENCES task_proofs(id) ON DELETE SET NULL,
      candidates jsonb,
      reason text,
      attempts integer NOT NULL DEFAULT 0,
      last_attempt_at timestamp,
      reviewed_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      reviewed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_facebook_links_media ON instagram_facebook_links(media_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_instagram_facebook_links_status ON instagram_facebook_links(status)`);
  // منشور فيسبوك واحد لا يُربط بمنشورَي إنستقرام (للروابط الفعّالة فقط).
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_facebook_links_fb_post ON instagram_facebook_links(fb_post_id) WHERE fb_post_id IS NOT NULL AND status IN ('linked', 'manual')`);
}

export async function ensureInstagramSchema(): Promise<void> {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runInstagramSchemaEnsure()
      .then(() => { ensured = true; })
      .finally(() => { ensurePromise = null; });
  }
  await ensurePromise;
}
