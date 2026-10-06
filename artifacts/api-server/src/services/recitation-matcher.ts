import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, tasksTable } from "@workspace/db";
import { type PrayerCode } from "../lib/prayer";
import { arabicWeekdayOf, hijriPartsOf, isPublishedWithinTaskWindow, safeAnchorFromDateKey } from "../lib/hijri";

// مطابِق عام لتوثيق التلاوات تلقائيًا، تستخدمه يوتيوب وتلقرام. لا تخمين أبدًا:
// مهمة واحدة مطابقة ⇐ توثيق، أكثر من واحدة ⇐ مراجعة، لا شيء ⇐ بلا مهمة/مراجعة (حسب المصدر).
//
// وضعا الهدف:
// - «بقارئ»   (يوتيوب، والتطبيق): المنصة + القارئ + الصلاة + التاريخ.
// - «بمسجد»   (تلقرام العامة):    المنصة + مهمة بلا قارئ + المسجد + الصلاة + التاريخ.

export type MatchTarget =
  | { kind: "reciter"; reciterId: number }
  | { kind: "mosque"; mosque: "haram" | "nabawi" };

export type MatchWindow = "same_or_next_day" | { hours: number };

export type RecitationMatchInput = {
  platformId: number;
  target: MatchTarget;
  prayer: PrayerCode;
  hijriDay: number;
  hijriMonth: number;
  // السنة الهجرية من النص (إن وُجدت) تُقارن بسنة تاريخ المهمة كذلك.
  hijriYear?: number | null;
  dayNameInTitle: string | null;
  publishedAt: Date;
  window: MatchWindow;
  // يوتيوب فقط: نوع التصوير من علامة الوصف. غيابه ⇐ لا تصفية بنوع التصوير.
  filmingMarker?: "affairs" | "tv";
  // ما يُرجَع حين توجد مهام للمنصة والهدف والصلاة لكن لا يطابق أيٌّ منها التاريخ/النافذة.
  // يوتيوب: "review" (سلوكه القائم). تلقرام: "no_task".
  noDateMatchAs?: "review" | "no_task";
  noTaskReason?: string;
};

export type MatchResult =
  | { kind: "match"; taskId: number; reason: string }
  | { kind: "review"; candidateTaskIds: number[]; reason: string }
  | { kind: "no_task"; reason: string };

// نافذة الساعات تبدأ من منتصف ليل يوم المهمة بتوقيت الرياض (+03:00).
function isWithinHours(publishedAt: Date, dueDateKey: string, hours: number) {
  const start = new Date(`${dueDateKey}T00:00:00+03:00`).getTime();
  const at = publishedAt.getTime();
  return at >= start && at < start + hours * 60 * 60 * 1000;
}

export async function matchRecitationToTask(input: RecitationMatchInput): Promise<MatchResult> {
  const conditions = [
    eq(tasksTable.platformId, input.platformId),
    eq(tasksTable.prayer, input.prayer),
    eq(tasksTable.status, "pending"),
    isNull(tasksTable.deletedAt),
  ];
  if (input.target.kind === "reciter") {
    conditions.push(eq(tasksTable.reciterId, input.target.reciterId));
  } else {
    // المهام العامة فقط: بلا قارئ، وبالمسجد المستنتج — فلا تُمس مهام القرّاء على نفس المنصة.
    conditions.push(isNull(tasksTable.reciterId));
    conditions.push(eq(tasksTable.mosque, input.target.mosque));
  }
  if (input.filmingMarker === "tv") {
    conditions.push(eq(tasksTable.filmingType, "tv"));
  } else if (input.filmingMarker === "affairs") {
    conditions.push(or(isNull(tasksTable.filmingType), eq(tasksTable.filmingType, "affairs"))!);
  }

  const candidates = await db
    .select({
      id: tasksTable.id,
      // اليوم الميلادي الحرفي من PostgreSQL (to_char) — بلا أي تفسير توقيت من جانب Node.
      dueDateKey: sql<string | null>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')`,
      weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
    })
    .from(tasksTable)
    .where(and(...conditions));

  if (candidates.length === 0) {
    return { kind: "no_task", reason: input.noTaskReason ?? "لا توجد مهمة معلّقة مطابقة لهذه المنصة والصلاة." };
  }

  // مهام الحصة الأسبوعية لا تكتمل بمنشور واحد — تُستبعد من التوثيق التلقائي دائمًا.
  const eligible = candidates.filter((task) => task.weeklyQuotaRequired == null && task.dueDateKey);
  const matches: typeof eligible = [];
  const quotaMatchesByDate: typeof candidates = [];

  const dateMatches = (dueDateKey: string) => {
    const hijri = hijriPartsOf(safeAnchorFromDateKey(dueDateKey));
    if (hijri.day !== input.hijriDay || hijri.month !== input.hijriMonth) return false;
    if (input.hijriYear && hijri.year !== input.hijriYear) return false;
    return true;
  };

  for (const task of eligible) {
    const key = task.dueDateKey as string;
    const dueDate = safeAnchorFromDateKey(key);
    if (!dateMatches(key)) continue;
    if (input.dayNameInTitle && arabicWeekdayOf(dueDate) !== input.dayNameInTitle) continue;
    const inWindow = input.window === "same_or_next_day"
      ? isPublishedWithinTaskWindow(input.publishedAt, dueDate)
      : isWithinHours(input.publishedAt, key, input.window.hours);
    if (!inWindow) continue;
    matches.push(task);
  }

  for (const task of candidates) {
    if (task.weeklyQuotaRequired == null || !task.dueDateKey) continue;
    if (dateMatches(task.dueDateKey)) quotaMatchesByDate.push(task);
  }

  if (matches.length === 1) {
    return {
      kind: "match",
      taskId: matches[0].id,
      reason: input.target.kind === "mosque"
        ? "تطابق واضح: نفس المنصة والمسجد والصلاة والتاريخ الهجري، ونشر ضمن النافذة المسموحة."
        : "تطابق واضح: نفس المنصة والقارئ والصلاة والتاريخ الهجري، ونشر ضمن اليوم المسموح.",
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
      reason: "المهمة المطابقة للتاريخ ذات حصة أسبوعية — لا تُوثَّق تلقائيًا بمنشور واحد.",
    };
  }
  const noDateReason = "لم تُطابق أي مهمة معلّقة التاريخ الهجري، أو اسم اليوم في النص يخالف تاريخ المهمة، أو وقت النشر خارج النافذة المسموحة.";
  return input.noDateMatchAs === "no_task"
    ? { kind: "no_task", reason: noDateReason }
    : { kind: "review", candidateTaskIds: [], reason: noDateReason };
}
