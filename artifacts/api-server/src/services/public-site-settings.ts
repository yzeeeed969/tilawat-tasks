import { asc, eq, sql } from "drizzle-orm";
import { db, publicSiteSettingsTable } from "@workspace/db";

const SETTINGS_ID = 1;

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runPublicSiteSettingsSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public_site_settings (
      id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      youtube_total_views bigint,
      youtube_views_updated_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`ALTER TABLE public_site_settings ADD COLUMN IF NOT EXISTS youtube_total_views bigint`);
  await db.execute(sql`ALTER TABLE public_site_settings ADD COLUMN IF NOT EXISTS youtube_views_updated_at timestamp`);
  await db.execute(sql`ALTER TABLE public_site_settings ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE public_site_settings ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()`);
}

export async function ensurePublicSiteSettingsSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runPublicSiteSettingsSchemaEnsure()
      .then(() => {
        ensured = true;
      })
      .finally(() => {
        ensurePromise = null;
      });
  }
  await ensurePromise;
}

async function ensureSettingsRow() {
  await ensurePublicSiteSettingsSchema();
  await db
    .insert(publicSiteSettingsTable)
    .values({ id: SETTINGS_ID })
    .onConflictDoNothing();
}

export async function getPublicSiteSettings() {
  await ensureSettingsRow();
  const [settings] = await db
    .select()
    .from(publicSiteSettingsTable)
    .orderBy(asc(publicSiteSettingsTable.id))
    .limit(1);
  return settings;
}

export async function updatePublicSiteSettings(input: { youtubeTotalViews?: unknown }) {
  await ensureSettingsRow();

  const rawViews = input.youtubeTotalViews;
  const youtubeTotalViews = rawViews === null || rawViews === ""
    ? null
    : Number(rawViews);

  if (
    youtubeTotalViews !== null &&
    (!Number.isSafeInteger(youtubeTotalViews) || youtubeTotalViews < 0)
  ) {
    throw new Error("رقم مشاهدات يوتيوب يجب أن يكون رقمًا صحيحًا موجبًا");
  }

  const now = new Date();
  const [settings] = await db
    .update(publicSiteSettingsTable)
    .set({
      youtubeTotalViews,
      youtubeViewsUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(publicSiteSettingsTable.id, SETTINGS_ID))
    .returning();

  return settings;
}
