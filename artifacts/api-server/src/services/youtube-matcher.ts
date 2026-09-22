import { and, eq, isNull } from "drizzle-orm";
import { db, tasksTable } from "@workspace/db";
import { type PrayerCode } from "../lib/prayer";
import { arabicWeekdayOf, hijriPartsOf, isPublishedWithinTaskWindow } from "../lib/hijri";

export type MatchInput = {
  platformId: number;
  reciterId: number;
  prayer: PrayerCode;
  hijriDay: number;
  hijriMonth: number;
  dayNameInTitle: string | null;
  publishedAt: Date;
};

export type MatchResult =
  | { kind: "match"; taskId: number; reason: string }
  | { kind: "review"; candidateTaskIds: number[]; reason: string }
  | { kind: "no_task"; reason: string };

// يطابق مقطعًا (بعد استخراج ثوابته من العنوان) بمهمة معلّقة واحدة. لا تخمين أبدًا:
// صفر مهام مطابقة أو أكثر من مهمة واحدة → مراجعة/بلا مهمة، لا يُختار أي منها تلقائيًا.
export async function matchVideoToTask(input: MatchInput): Promise<MatchResult> {
  const candidates = await db
    .select({
      id: tasksTable.id,
      dueDate: tasksTable.dueDate,
      weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
    })
    .from(tasksTable)
    .where(and(
      eq(tasksTable.platformId, input.platformId),
      eq(tasksTable.reciterId, input.reciterId),
      eq(tasksTable.prayer, input.prayer),
      eq(tasksTable.status, "pending"),
      isNull(tasksTable.deletedAt),
    ));

  if (candidates.length === 0) {
    return { kind: "no_task", reason: "لا توجد أي مهمة يوتيوب معلّقة لهذا القارئ بهذه الصلاة." };
  }

  // مهام الحصة الأسبوعية لا تكتمل بمقطع واحد — تُستبعد من التوثيق التلقائي دائمًا وتذهب للمراجعة
  // إن كانت هي المرشّح الوحيد المطابق للتاريخ.
  const eligible = candidates.filter((task) => task.weeklyQuotaRequired == null && task.dueDate);

  const matches: typeof eligible = [];
  const quotaMatchesByDate: typeof candidates = [];

  for (const task of eligible) {
    const dueDate = task.dueDate as Date;
    const hijri = hijriPartsOf(dueDate);
    if (hijri.day !== input.hijriDay || hijri.month !== input.hijriMonth) continue;
    if (input.dayNameInTitle && arabicWeekdayOf(dueDate) !== input.dayNameInTitle) continue;
    if (!isPublishedWithinTaskWindow(input.publishedAt, dueDate)) continue;
    matches.push(task);
  }

  for (const task of candidates) {
    if (task.weeklyQuotaRequired == null || !task.dueDate) continue;
    const hijri = hijriPartsOf(task.dueDate);
    if (hijri.day === input.hijriDay && hijri.month === input.hijriMonth) quotaMatchesByDate.push(task);
  }

  if (matches.length === 1) {
    return {
      kind: "match",
      taskId: matches[0].id,
      reason: "تطابق واضح: نفس المنصة والقارئ والصلاة والتاريخ الهجري، ونشر ضمن اليوم المسموح.",
    };
  }
  if (matches.length > 1) {
    return {
      kind: "review",
      candidateTaskIds: matches.map((m) => m.id),
      reason: `أكثر من مهمة معلّقة تطابق نفس الصلاة والتاريخ (${matches.length} مهام) — بحاجة اختيار يدوي.`,
    };
  }
  if (quotaMatchesByDate.length > 0) {
    return {
      kind: "review",
      candidateTaskIds: quotaMatchesByDate.map((m) => m.id),
      reason: "المهمة المطابقة للتاريخ ذات حصة أسبوعية — لا تُوثَّق تلقائيًا بمقطع واحد.",
    };
  }
  return {
    kind: "review",
    candidateTaskIds: [],
    reason: "لم تُطابق أي مهمة معلّقة التاريخ الهجري، أو اسم اليوم في العنوان يخالف تاريخ المهمة، أو وقت النشر خارج النافذة المسموحة.",
  };
}
