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
  // شاهد فيسبوك التكميلي على مهمة يوتيوب المطابقة (الخيار «ب»: لا مهام فيسبوك مستقلة).
  await db.execute(sql`ALTER TABLE yt_fb_uploads ADD COLUMN IF NOT EXISTS proof_task_id integer`);
  await db.execute(sql`ALTER TABLE yt_fb_uploads ADD COLUMN IF NOT EXISTS proof_id integer`);
  await db.execute(sql`ALTER TABLE yt_fb_uploads ADD COLUMN IF NOT EXISTS proof_attached_at timestamp`);
  // ربط يدوي قناة ← صفحة (الإصدار 64): لقنوات عامة لا قارئ لها (مثل @Haramayn ← «تطبيق تلاوات الحرمين»).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS yt_fb_manual_links (
      channel_id text PRIMARY KEY,
      channel_title text NOT NULL,
      channel_handle text,
      fb_page_id text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS app_one_time_migrations (name text PRIMARY KEY, ran_at timestamp NOT NULL DEFAULT now(), details jsonb)`);
  // أول ربط بطلب المدير، لمرة واحدة فقط (إن حذفه لاحقًا لا يعود).
  const seeded = await db.execute(sql`INSERT INTO app_one_time_migrations (name) VALUES ('yt_fb_manual_link_haramayn_v64') ON CONFLICT (name) DO NOTHING RETURNING name`);
  if (((seeded as any)?.rows ?? seeded ?? []).length > 0) {
    await db.execute(sql`
      INSERT INTO yt_fb_manual_links (channel_id, channel_title, channel_handle, fb_page_id)
      VALUES ('UCBc5f-MDWCEzjYD_w4F9CVw', 'الحرمين', '@Haramayn', '112084043986952')
      ON CONFLICT (channel_id) DO NOTHING`);
  }
}

export async function ensureCrosspostSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runEnsure().then(() => { ensured = true; }).finally(() => { ensurePromise = null; });
  }
  await ensurePromise;
}
