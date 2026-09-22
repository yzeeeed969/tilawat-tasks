import { asc, eq } from "drizzle-orm";
import { db, youtubeSettingsTable, type YoutubeSettings } from "@workspace/db";
import { ensureYoutubeMonitorSchema } from "./youtube-monitor-schema";

// صف إعدادات واحد (get-or-create)، بنفس نمط getTelegramSettings. وضع التجربة مفعَّل افتراضيًا
// عند أول إنشاء للصف — لا توثيق تلقائي فعلي قبل أن يُطفئه المدير عمدًا من صفحة الإدارة.
export async function getYoutubeSettings(): Promise<YoutubeSettings> {
  await ensureYoutubeMonitorSchema();
  const [existing] = await db
    .select()
    .from(youtubeSettingsTable)
    .orderBy(asc(youtubeSettingsTable.id))
    .limit(1);

  if (existing) return existing;

  const [created] = await db.insert(youtubeSettingsTable).values({}).returning();
  return created;
}

export async function updateYoutubeSettings(input: Partial<{ enabled: boolean; trialMode: boolean }>): Promise<YoutubeSettings> {
  const current = await getYoutubeSettings();
  const update: Partial<typeof youtubeSettingsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof input.enabled === "boolean") update.enabled = input.enabled;
  if (typeof input.trialMode === "boolean") update.trialMode = input.trialMode;

  const [updated] = await db
    .update(youtubeSettingsTable)
    .set(update)
    .where(eq(youtubeSettingsTable.id, current.id))
    .returning();
  return updated;
}
