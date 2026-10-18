import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// الرفع التلقائي يوتيوب ← فيسبوك (ناتيف). جداول إضافة فقط:
// - yt_fb_settings: مفتاح التشغيل (معطّل افتراضيًا)، ووقت آخر تفعيل، وآخر استعلام من جهاز التنزيل.
// - yt_fb_channels: لكل قناة يوتيوب مراقَبة: صفحة فيسبوك المقابلة (أو سبب التعطيل)، و«خط الأساس».
// - yt_fb_uploads: ذاكرة منع التكرار — صف لكل videoId (فريد)، وحالته (uploading | uploaded | failed).
let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS yt_fb_settings (
      id integer PRIMARY KEY DEFAULT 1,
      enabled boolean NOT NULL DEFAULT false,
      enabled_at timestamp,
      last_machine_poll_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT yt_fb_settings_single CHECK (id = 1)
    )`);
  await db.execute(sql`INSERT INTO yt_fb_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS yt_fb_channels (
      channel_id text PRIMARY KEY,
      youtube_channel_row_id integer,
      display_name text NOT NULL,
      reciter_id integer,
      reciter_name text,
      fb_page_id text,
      fb_page_name text,
      status text NOT NULL DEFAULT 'disabled',
      reason text,
      baseline_video_id text,
      baseline_published_at timestamp,
      baseline_set_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS yt_fb_uploads (
      id serial PRIMARY KEY,
      video_id text NOT NULL,
      channel_id text NOT NULL,
      fb_page_id text NOT NULL,
      title text NOT NULL,
      status text NOT NULL,
      fb_video_id text,
      error text,
      attempts integer NOT NULL DEFAULT 1,
      file_size bigint,
      started_at timestamp NOT NULL DEFAULT now(),
      uploaded_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_fb_uploads_video ON yt_fb_uploads(video_id)`);
}

export async function ensureCrosspostSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runEnsure().then(() => { ensured = true; }).finally(() => { ensurePromise = null; });
  }
  await ensurePromise;
}
