import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// إضافة فقط: عمود يقبل الفراغ على tasks، وجداول جديدة كليًا. لا يُعاد كتابة أي صف قائم.
async function runWeeklyScheduleSchemaEnsure() {
  // نوع التصوير لمهام يوتيوب/فيسبوك (affairs / tv). NULL لكل المهام القائمة ولبقية المنصات.
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS filming_type text`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reciter_publishing_templates (
      id serial PRIMARY KEY,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
      platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
      filming_type text,
      member_id integer NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      page_id integer REFERENCES platform_pages(id) ON DELETE SET NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_reciter_publishing_templates_reciter ON reciter_publishing_templates(reciter_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_reciter_publishing_templates_row
    ON reciter_publishing_templates (reciter_id, platform_id, coalesce(filming_type, ''))
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS weekly_schedule_batches (
      id serial PRIMARY KEY,
      week_start text NOT NULL,
      week_end text NOT NULL,
      assignments jsonb NOT NULL,
      created_tasks integer NOT NULL DEFAULT 0,
      skipped_duplicates integer NOT NULL DEFAULT 0,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_weekly_schedule_batches_week ON weekly_schedule_batches(week_start)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS weekly_schedule_settings (
      id serial PRIMARY KEY,
      preview_enabled boolean NOT NULL DEFAULT true,
      template_imported_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

export async function ensureWeeklyScheduleSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runWeeklyScheduleSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
