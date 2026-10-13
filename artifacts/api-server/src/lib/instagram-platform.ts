import { inArray } from "drizzle-orm";
import { db, platformsTable } from "@workspace/db";

// منصة إنستقرام تُعرف باسمها (كما تُعرف منصة يوتيوب في بقية النظام).
export const INSTAGRAM_PLATFORM_NAME = /إنستقرام|انستقرام|إنستغرام|انستغرام|انستجرام|إنستجرام|instagram/i;

// مهام «هدف أسبوعي بعدد مرات» على إنستقرام مصدرها الوحيد مراقبة إنستقرام — لا السلاسل المتكررة.
export const INSTAGRAM_QUOTA_BLOCKED_MESSAGE =
  "مهام إنستقرام الأسبوعية تُنشأ تلقائيًا من «مراقبة إنستقرام» (مهمة واحدة لكل قارئ في الأسبوع) — لا تُنشأ كسلسلة «هدف أسبوعي» يدوية.";

export async function anyInstagramPlatform(platformIds: Array<number | null | undefined>, client: any = db): Promise<boolean> {
  const ids = [...new Set(platformIds.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))];
  if (ids.length === 0) return false;
  const rows: Array<{ name: string }> = await client.select({ name: platformsTable.name }).from(platformsTable).where(inArray(platformsTable.id, ids));
  return rows.some((row) => INSTAGRAM_PLATFORM_NAME.test(row.name));
}
