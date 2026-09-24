import { sql } from "drizzle-orm";
import { db, platformsTable, recitersTable, youtubeChannelsTable } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runYoutubeMonitorSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS youtube_channels (
      id serial PRIMARY KEY,
      handle text NOT NULL,
      display_name text NOT NULL,
      reciter_name_constant text NOT NULL,
      platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT true,
      channel_id text,
      uploads_playlist_id text,
      last_checked_at timestamp,
      monitoring_started_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_youtube_channels_handle ON youtube_channels(handle)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS youtube_videos (
      id serial PRIMARY KEY,
      channel_row_id integer NOT NULL REFERENCES youtube_channels(id) ON DELETE CASCADE,
      video_id text NOT NULL,
      title text NOT NULL,
      description text,
      published_at timestamp NOT NULL,
      url text NOT NULL,
      has_marker boolean NOT NULL DEFAULT false,
      extracted_prayer text,
      extracted_hijri_day integer,
      extracted_hijri_month integer,
      matched_task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      created_proof_id integer REFERENCES task_proofs(id) ON DELETE SET NULL,
      status text NOT NULL,
      decision_reason text,
      processed_at timestamp NOT NULL DEFAULT now(),
      reviewed_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      reviewed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_youtube_videos_video_id ON youtube_videos(video_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel_row_id ON youtube_videos(channel_row_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_youtube_videos_status ON youtube_videos(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_youtube_videos_matched_task_id ON youtube_videos(matched_task_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS youtube_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      trial_mode boolean NOT NULL DEFAULT true,
      check_interval_minutes integer NOT NULL DEFAULT 10,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE youtube_settings ADD COLUMN IF NOT EXISTS short_duration_marker_backfill_done boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE youtube_settings ADD COLUMN IF NOT EXISTS due_date_timezone_backfill_done boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE youtube_settings ADD COLUMN IF NOT EXISTS hashtag_name_backfill_done boolean NOT NULL DEFAULT false`);

  await seedBandarBalilahChannel();
}

// محاولة تفعيل صف قناة الشيخ بندر بليلة تلقائيًا (قناة التجربة) بربطها بمنصة يوتيوب وقارئه في النظام.
// لا نُدخل تخمينًا: إن لم نجد منصة "يوتيوب" واحدة بوضوح، أو قارئًا اسمه "بندر بليلة" واحدًا بوضوح،
// نتوقف ونسجّل تحذيرًا فقط — المدير يستطيع إنشاء الصف يدويًا من صفحة إدارة يوتيوب.
async function seedBandarBalilahChannel() {
  const handle = "@Bandarbalilaah";
  const [existing] = await db
    .select({ id: youtubeChannelsTable.id })
    .from(youtubeChannelsTable)
    .where(sql`${youtubeChannelsTable.handle} = ${handle}`)
    .limit(1);
  if (existing) return;

  const platformMatches = await db
    .select({ id: platformsTable.id, name: platformsTable.name })
    .from(platformsTable)
    .where(sql`lower(${platformsTable.name}) LIKE '%يوتيوب%' OR lower(${platformsTable.name}) LIKE '%youtube%'`);

  const reciterMatches = await db
    .select({ id: recitersTable.id, name: recitersTable.name })
    .from(recitersTable)
    .where(sql`${recitersTable.name} LIKE '%بندر%' AND ${recitersTable.name} LIKE '%بليلة%'`);

  if (platformMatches.length !== 1 || reciterMatches.length !== 1) {
    console.warn(
      "[youtube-monitor] تعذّر تفعيل قناة بندر بليلة تلقائيًا " +
      `(منصات يوتيوب مطابقة: ${platformMatches.length}, قراء مطابقون: ${reciterMatches.length}). ` +
      "أنشئ الصف يدويًا من صفحة إدارة يوتيوب.",
    );
    return;
  }

  await db.insert(youtubeChannelsTable).values({
    handle,
    displayName: "قناة تلاوات الشيخ بندر بليلة",
    reciterNameConstant: "بندر بليلة",
    platformId: platformMatches[0].id,
    reciterId: reciterMatches[0].id,
    enabled: true,
  }).onConflictDoNothing();
}

export async function ensureYoutubeMonitorSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runYoutubeMonitorSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
