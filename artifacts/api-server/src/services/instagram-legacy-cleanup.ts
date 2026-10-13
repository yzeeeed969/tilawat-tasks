import { sql } from "drizzle-orm";
import { db, activityLogTable } from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { riyadhWeekStart } from "./instagram-monitor";
import { INSTAGRAM_PLATFORM_NAME } from "../lib/instagram-platform";

// تنظيف مهام إنستقرام الأسبوعية القديمة (النوع «ب»): مهام «هدف أسبوعي بعدد مرات» على منصة إنستقرام
// ولّدتها سلاسل يدوية متكررة (task-engine)، وتكرّر مهمة المراقبة. حذف ناعم قابل للاسترجاع (deleted_at).
//
// المعايير (كلها معًا):
// - منصة المهمة إنستقرام (بالاسم)، و weekly_quota_required ليس فارغًا، وغير محذوفة.
// - ليست مهمة مراقبة: معرّفها غير موجود في instagram_weekly_tasks.
// - بلا أي شاهد فعّال، وبلا رابط تسليم، وغير مكتملة — فلا يُمس أي عمل موثَّق.
// - أسبوعها الجاري أو لاحق: due_date ≥ أحد الأسبوع الجاري (الرياض).
// ويُوقَف (stopped) كل سلسلة متكررة نشطة تملك مهام «هدف أسبوعي» على إنستقرام، كي لا تُولّد مجددًا.

type Candidate = { id: number; title: string; dueDate: string; seriesId: number | null; weeklyQuotaRequired: number };

async function instagramPlatformIds(): Promise<number[]> {
  const result: any = await db.execute(sql`SELECT id, name FROM platforms`);
  return (result.rows ?? result).filter((row: any) => INSTAGRAM_PLATFORM_NAME.test(String(row.name))).map((row: any) => Number(row.id));
}

const legacyBase = (platformIds: number[]) => sql`
  t.platform_id IN (${sql.join(platformIds.map((id) => sql`${id}`), sql`, `)})
  AND t.weekly_quota_required IS NOT NULL
  AND t.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)`;

export async function previewInstagramLegacyCleanup(now = new Date()) {
  await ensureInstagramSchema();
  const weekStart = riyadhWeekStart(now);
  const platformIds = await instagramPlatformIds();
  if (platformIds.length === 0) return { weekStart, candidates: [] as Candidate[], protectedCount: 0, seriesToStop: [] as number[] };

  const candidatesResult: any = await db.execute(sql`
    SELECT t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.series_id, t.weekly_quota_required
    FROM tasks t
    WHERE ${legacyBase(platformIds)}
      AND to_char(t.due_date, 'YYYY-MM-DD') >= ${weekStart}
      AND t.status <> 'completed'
      AND t.submission_url IS NULL
      AND NOT EXISTS (SELECT 1 FROM task_proofs p WHERE p.task_id = t.id AND p.deleted_at IS NULL)
    ORDER BY t.due_date, t.id`);
  const candidates: Candidate[] = (candidatesResult.rows ?? candidatesResult).map((row: any) => ({
    id: Number(row.id), title: String(row.title), dueDate: String(row.due_date), seriesId: row.series_id == null ? null : Number(row.series_id), weeklyQuotaRequired: Number(row.weekly_quota_required),
  }));

  // مهام قديمة من النوع نفسه لكن فيها عمل (شاهد/مكتملة) — لا تُمس، ونعرض عددها للشفافية.
  const protectedResult: any = await db.execute(sql`
    SELECT count(*)::int AS c FROM tasks t
    WHERE ${legacyBase(platformIds)}
      AND to_char(t.due_date, 'YYYY-MM-DD') >= ${weekStart}
      AND (t.status = 'completed' OR t.submission_url IS NOT NULL OR EXISTS (SELECT 1 FROM task_proofs p WHERE p.task_id = t.id AND p.deleted_at IS NULL))`);
  const protectedCount = Number((protectedResult.rows ?? protectedResult)[0]?.c ?? 0);

  const seriesResult: any = await db.execute(sql`
    SELECT DISTINCT s.id FROM task_series s
    JOIN tasks t ON t.series_id = s.id
    WHERE s.status = 'active'
      AND t.platform_id IN (${sql.join(platformIds.map((id) => sql`${id}`), sql`, `)})
      AND t.weekly_quota_required IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)
    ORDER BY s.id`);
  const seriesToStop: number[] = (seriesResult.rows ?? seriesResult).map((row: any) => Number(row.id));

  return { weekStart, candidates, protectedCount, seriesToStop };
}

// التطبيق: نفس المعايير تُعاد داخل المعاملة (لا نثق بمعاينة قديمة)، ثم سجل نشاط بالمعرّفات للتراجع.
export async function applyInstagramLegacyCleanup(userId: number | null, now = new Date()) {
  const preview = await previewInstagramLegacyCleanup(now);
  const taskIds = preview.candidates.map((c) => c.id);
  const deletedAt = new Date();
  await db.transaction(async (tx: any) => {
    if (taskIds.length > 0) {
      await tx.execute(sql`
        UPDATE tasks t SET deleted_at = ${deletedAt}
        WHERE t.id IN (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)})
          AND t.deleted_at IS NULL AND t.status <> 'completed' AND t.submission_url IS NULL
          AND NOT EXISTS (SELECT 1 FROM task_proofs p WHERE p.task_id = t.id AND p.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)`);
    }
    if (preview.seriesToStop.length > 0) {
      await tx.execute(sql`
        UPDATE task_series SET status = 'stopped', updated_at = now()
        WHERE status = 'active' AND id IN (${sql.join(preview.seriesToStop.map((id) => sql`${id}`), sql`, `)})`);
    }
  });
  await db.insert(activityLogTable).values({
    userId,
    userName: "تنظيف مهام إنستقرام القديمة",
    action: "instagram_legacy_cleanup",
    entityType: "task",
    entityId: null,
    entityName: `حذف ناعم لـ ${taskIds.length} مهمة وإيقاف ${preview.seriesToStop.length} سلسلة`,
    meta: { taskIds, seriesIds: preview.seriesToStop, deletedAt: deletedAt.toISOString(), weekStart: preview.weekStart },
  });
  return { deletedTasks: taskIds.length, stoppedSeries: preview.seriesToStop.length, protectedCount: preview.protectedCount, taskIds, seriesIds: preview.seriesToStop };
}
