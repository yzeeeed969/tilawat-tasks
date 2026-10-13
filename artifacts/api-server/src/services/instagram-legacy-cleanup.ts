import { sql } from "drizzle-orm";
import { db, activityLogTable } from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { riyadhWeekStart } from "./instagram-monitor";
import { addQuotaProof } from "./auto-documentation";
import { INSTAGRAM_PLATFORM_NAME } from "../lib/instagram-platform";
import { safeAnchorFromDateKey } from "../lib/hijri";

// تنظيف مهام إنستقرام الأسبوعية القديمة (النوع «ب»): مهام «هدف أسبوعي بعدد مرات» على منصة إنستقرام
// ولّدتها سلاسل يدوية متكررة (task-engine)، وتكرّر مهمة المراقبة. حذف ناعم قابل للاسترجاع (deleted_at).
//
// الأساس المشترك (كله معًا): منصة المهمة إنستقرام (بالاسم)، weekly_quota_required ليس فارغًا، غير محذوفة،
// ليست مهمة مراقبة (غير موجودة في instagram_weekly_tasks)، وأسبوعها الجاري أو لاحق (due_date ≥ أحد الأسبوع).
// ثم فئتان:
// 1) بلا عمل (بلا شاهد فعّال ولا رابط تسليم وغير مكتملة) ⇐ حذف ناعم مباشرة.
// 2) فيها شواهد ⇐ تُنقل روابطها (بلا تكرار) إلى مهمة المراقبة المقابلة (نفس الحساب ونفس الأسبوع) بنفس
//    منطق إضافة الشاهد (يرتفع X/N)، ثم حذف ناعم. لا مهمة مراقبة مقابلة ⇐ لا تُمس وتُذكر في التقرير.
// ويُوقَف (stopped) كل سلسلة متكررة نشطة تملك مهام «هدف أسبوعي» على إنستقرام، كي لا تُولّد مجددًا.

type Candidate = { id: number; title: string; dueDate: string; seriesId: number | null; weeklyQuotaRequired: number };
type Transfer = {
  legacyTaskId: number;
  title: string;
  dueDate: string;
  weekStart: string;
  links: string[];
  newLinks: string[];
  monitorTaskId: number;
  monitorTitle: string;
  monitorCountBefore: number;
  monitorRequired: number;
};
type Unmatched = { legacyTaskId: number; title: string; dueDate: string; reason: string };

async function instagramPlatformIds(): Promise<number[]> {
  const result: any = await db.execute(sql`SELECT id, name FROM platforms`);
  return (result.rows ?? result).filter((row: any) => INSTAGRAM_PLATFORM_NAME.test(String(row.name))).map((row: any) => Number(row.id));
}

const rowsOf = (result: any): any[] => result.rows ?? result;

const legacyBase = (platformIds: number[]) => sql`
  t.platform_id IN (${sql.join(platformIds.map((id) => sql`${id}`), sql`, `)})
  AND t.weekly_quota_required IS NOT NULL
  AND t.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)`;

// أحد الأسبوع لتاريخ حرفي (YYYY-MM-DD).
function sundayOf(dateKey: string) {
  const anchor = safeAnchorFromDateKey(dateKey);
  anchor.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
  return anchor.toISOString().slice(0, 10);
}

// الروابط الفعّالة لمهمة: شواهدها غير المحذوفة + رابط التسليم إن لم يكن ضمنها (بالترتيب، بلا تكرار).
async function activeLinks(taskId: number, submissionUrl: string | null): Promise<string[]> {
  const proofs = rowsOf(await db.execute(sql`SELECT url FROM task_proofs WHERE task_id = ${taskId} AND deleted_at IS NULL ORDER BY created_at, id`));
  const links = proofs.map((row) => String(row.url).trim()).filter(Boolean);
  if (submissionUrl?.trim()) links.push(submissionUrl.trim());
  return [...new Set(links)];
}

// مهمة المراقبة المقابلة: حساب الصفحة نفسها، وإلا حساب القارئ نفسه — ثم مهمة ذلك الأسبوع (غير محذوفة).
async function monitorTaskFor(pageId: number | null, reciterId: number | null, weekStart: string) {
  const accounts = rowsOf(await db.execute(sql`
    SELECT id FROM instagram_accounts
    WHERE (${pageId}::int IS NOT NULL AND page_id = ${pageId}) OR (${reciterId}::int IS NOT NULL AND reciter_id = ${reciterId})
    ORDER BY (page_id = ${pageId}) DESC NULLS LAST, id`));
  if (accounts.length === 0) return { accountFound: false as const, task: null };
  for (const account of accounts) {
    const [task] = rowsOf(await db.execute(sql`
      SELECT t.id, t.title, t.weekly_quota_required, t.submission_url FROM instagram_weekly_tasks w JOIN tasks t ON t.id = w.task_id
      WHERE w.account_id = ${Number(account.id)} AND w.week_start = ${weekStart} AND t.deleted_at IS NULL LIMIT 1`));
    if (task) return { accountFound: true as const, task: { id: Number(task.id), title: String(task.title), required: Number(task.weekly_quota_required ?? 1) } };
  }
  return { accountFound: true as const, task: null };
}

export async function previewInstagramLegacyCleanup(now = new Date()) {
  await ensureInstagramSchema();
  const weekStart = riyadhWeekStart(now);
  const platformIds = await instagramPlatformIds();
  if (platformIds.length === 0) return { weekStart, candidates: [] as Candidate[], transfers: [] as Transfer[], unmatched: [] as Unmatched[], protectedCount: 0, seriesToStop: [] as number[] };

  // 1) بلا عمل.
  const candidates: Candidate[] = rowsOf(await db.execute(sql`
    SELECT t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.series_id, t.weekly_quota_required
    FROM tasks t
    WHERE ${legacyBase(platformIds)}
      AND to_char(t.due_date, 'YYYY-MM-DD') >= ${weekStart}
      AND t.status <> 'completed'
      AND t.submission_url IS NULL
      AND NOT EXISTS (SELECT 1 FROM task_proofs p WHERE p.task_id = t.id AND p.deleted_at IS NULL)
    ORDER BY t.due_date, t.id`)).map((row) => ({
    id: Number(row.id), title: String(row.title), dueDate: String(row.due_date), seriesId: row.series_id == null ? null : Number(row.series_id), weeklyQuotaRequired: Number(row.weekly_quota_required),
  }));

  // 2) فيها عمل (شاهد/رابط تسليم/مكتملة).
  const withWork = rowsOf(await db.execute(sql`
    SELECT t.id, t.title, t.page_id, t.reciter_id, t.submission_url,
      to_char(t.due_date, 'YYYY-MM-DD') AS due_date, to_char(t.weekly_quota_period_start, 'YYYY-MM-DD') AS period_start
    FROM tasks t
    WHERE ${legacyBase(platformIds)}
      AND to_char(t.due_date, 'YYYY-MM-DD') >= ${weekStart}
      AND (t.status = 'completed' OR t.submission_url IS NOT NULL OR EXISTS (SELECT 1 FROM task_proofs p WHERE p.task_id = t.id AND p.deleted_at IS NULL))
    ORDER BY t.due_date, t.id`));
  const transfers: Transfer[] = [];
  const unmatched: Unmatched[] = [];
  for (const row of withWork) {
    const legacyTaskId = Number(row.id);
    const dueDate = String(row.due_date);
    const taskWeek = sundayOf(row.period_start ? String(row.period_start) : dueDate);
    const links = await activeLinks(legacyTaskId, row.submission_url ? String(row.submission_url) : null);
    const base = { legacyTaskId, title: String(row.title), dueDate };
    if (links.length === 0) {
      unmatched.push({ ...base, reason: "مكتملة بلا أي شاهد أو رابط — لا شيء يُنقل، فلم تُمس" });
      continue;
    }
    const monitor = await monitorTaskFor(row.page_id == null ? null : Number(row.page_id), row.reciter_id == null ? null : Number(row.reciter_id), taskWeek);
    if (!monitor.task) {
      unmatched.push({ ...base, reason: monitor.accountFound ? `لا توجد مهمة مراقبة لأسبوع ${taskWeek} بعد — لم تُمس` : "لا يوجد حساب مراقبة إنستقرام لهذا القارئ/الصفحة — لم تُمس" });
      continue;
    }
    const existing = new Set(await activeLinks(monitor.task.id, null));
    transfers.push({
      ...base,
      weekStart: taskWeek,
      links,
      newLinks: links.filter((url) => !existing.has(url)),
      monitorTaskId: monitor.task.id,
      monitorTitle: monitor.task.title,
      monitorCountBefore: existing.size,
      monitorRequired: monitor.task.required,
    });
  }

  const seriesToStop: number[] = rowsOf(await db.execute(sql`
    SELECT DISTINCT s.id FROM task_series s
    JOIN tasks t ON t.series_id = s.id
    WHERE s.status = 'active'
      AND t.platform_id IN (${sql.join(platformIds.map((id) => sql`${id}`), sql`, `)})
      AND t.weekly_quota_required IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)
    ORDER BY s.id`)).map((row) => Number(row.id));

  return { weekStart, candidates, transfers, unmatched, protectedCount: unmatched.length, seriesToStop };
}

// التطبيق: المعايير تُعاد الآن (لا نثق بمعاينة قديمة). النقل بنفس منطق إضافة الشاهد (addQuotaProof)، ثم
// حذف ناعم للقديمة فقط إن نُقلت كل روابطها. سجل نشاط بالمعرّفات (المحذوفة والشواهد المنقولة) للتراجع.
export async function applyInstagramLegacyCleanup(userId: number | null, now = new Date()) {
  const preview = await previewInstagramLegacyCleanup(now);
  const deletedAt = new Date();
  const softDelete = async (ids: number[]) => {
    if (ids.length === 0) return;
    await db.execute(sql`UPDATE tasks t SET deleted_at = ${deletedAt}
      WHERE t.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)`);
  };

  // 1) بلا عمل: نفس الشروط تُعاد في جملة الحذف.
  const emptyIds = preview.candidates.map((c) => c.id);
  if (emptyIds.length > 0) {
    await db.execute(sql`UPDATE tasks t SET deleted_at = ${deletedAt}
      WHERE t.id IN (${sql.join(emptyIds.map((id) => sql`${id}`), sql`, `)})
        AND t.deleted_at IS NULL AND t.status <> 'completed' AND t.submission_url IS NULL
        AND NOT EXISTS (SELECT 1 FROM task_proofs p WHERE p.task_id = t.id AND p.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM instagram_weekly_tasks w WHERE w.task_id = t.id)`);
  }

  // 2) نقل الشواهد ثم الحذف.
  const moved: Array<{ legacyTaskId: number; monitorTaskId: number; links: string[]; createdProofIds: number[] }> = [];
  const failed: Unmatched[] = [];
  for (const transfer of preview.transfers) {
    const createdProofIds: number[] = [];
    let ok = true;
    for (const url of transfer.newLinks) {
      const added = await addQuotaProof({
        taskId: transfer.monitorTaskId,
        proofUrl: url,
        note: `منقول من مهمة إنستقرام الأسبوعية القديمة #${transfer.legacyTaskId} عند التنظيف`,
        activityUserName: "تنظيف مهام إنستقرام القديمة",
        activityAction: "instagram_legacy_proof_moved",
        meta: { legacyTaskId: transfer.legacyTaskId },
      });
      if (!added.added || !added.createdProofId) { ok = false; break; }
      createdProofIds.push(added.createdProofId);
    }
    if (!ok) {
      failed.push({ legacyTaskId: transfer.legacyTaskId, title: transfer.title, dueDate: transfer.dueDate, reason: "تعذّر نقل شاهد — لم تُحذف" });
      continue;
    }
    await softDelete([transfer.legacyTaskId]);
    moved.push({ legacyTaskId: transfer.legacyTaskId, monitorTaskId: transfer.monitorTaskId, links: transfer.newLinks, createdProofIds });
  }

  if (preview.seriesToStop.length > 0) {
    await db.execute(sql`UPDATE task_series SET status = 'stopped', updated_at = now()
      WHERE status = 'active' AND id IN (${sql.join(preview.seriesToStop.map((id) => sql`${id}`), sql`, `)})`);
  }

  const deletedTaskIds = [...emptyIds, ...moved.map((m) => m.legacyTaskId)];
  const movedProofs = moved.reduce((sum, m) => sum + m.createdProofIds.length, 0);
  await db.insert(activityLogTable).values({
    userId,
    userName: "تنظيف مهام إنستقرام القديمة",
    action: "instagram_legacy_cleanup",
    entityType: "task",
    entityId: null,
    entityName: `حذف ناعم لـ ${deletedTaskIds.length} مهمة، نقل ${movedProofs} شاهد، وإيقاف ${preview.seriesToStop.length} سلسلة`,
    meta: { taskIds: deletedTaskIds, emptyTaskIds: emptyIds, moved, seriesIds: preview.seriesToStop, unmatched: [...preview.unmatched, ...failed], deletedAt: deletedAt.toISOString(), weekStart: preview.weekStart },
  });
  return {
    deletedTasks: deletedTaskIds.length,
    movedProofs,
    mergedTasks: moved.length,
    stoppedSeries: preview.seriesToStop.length,
    protectedCount: preview.unmatched.length + failed.length,
    unmatched: [...preview.unmatched, ...failed],
    taskIds: deletedTaskIds,
    seriesIds: preview.seriesToStop,
  };
}
