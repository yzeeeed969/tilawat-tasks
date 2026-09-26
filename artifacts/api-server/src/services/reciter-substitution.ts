// نظام النيابة: قارئ (النائب) ينوب عن قارئ في نطاق من الفروض.
//
// المفاهيم:
// - «الفرض» (slot) = (تاريخ + صلاة + القارئ الأصلي). مهام الفرض = كل مهمة غير محذوفة للقارئ الأصلي
//   في نفس اليوم ونفس الصلاة، بغضّ النظر عن مجموعة إنشائها. للمهام القديمة بلا صلاة: نفس المجموعة + نفس اليوم.
// - النطاق: فرض واحد / أيام محددة / من هذا اليوم لآخر الأسبوع (الأحد → السبت) — لنفس الصلاة فقط.
// - توفّر النائب على منصة: المنصة «تشمل كل القرّاء» ⇐ متاح دائمًا؛ غير ذلك ⇐ متاح فقط إن وُجدت له صفحة عليها.
//
// الضمانات:
// - المعاينة (preview) قراءة فقط، وتُرجع بصمة الخطة (planToken).
// - التطبيق (apply) يعيد حساب الخطة على الخادم ولا يثق بالواجهة؛ إن تغيّرت البصمة ⇐ 409 بلا أي تغيير.
// - كل التطبيق في معاملة واحدة، وكل تحديث مشروط بأن المهمة ما زالت غير مكتملة وبلا شاهد وغير محذوفة
//   وللقارئ الأصلي؛ إن لم يطابق صف واحد تُلغى المعاملة كلها.
// - الحذف ناعم فقط (deleted_at)، ولكل تغيير لقطة «قبل» كاملة تتيح التراجع عن العملية كلها.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  tasksTable,
  taskMembersTable,
  taskProofsTable,
  platformsTable,
  platformPagesTable,
  pageMembersTable,
  membersTable,
  recitersTable,
  reciterSubstitutionsTable,
  reciterSubstitutionItemsTable,
} from "@workspace/db";
import { safeAnchorFromDateKey } from "../lib/hijri";

export type SubstitutionScopeKind = "single" | "dates" | "rest_of_week";

export type SlotKey = { date: string | null; prayer: string | null; creationGroupId: number | null };

export type MemberOption = { id: number; name: string };
export type PageOption = { id: number; name: string; members: MemberOption[] };

export type RowKind =
  | "auto_assign"
  | "choose_member"
  | "choose_any_member"
  | "choose_page"
  | "delete_unavailable"
  | "protected_completed"
  | "protected_proof"
  | "excluded_quota";

export type PlanRow = {
  taskId: number;
  slot: SlotKey;
  platformId: number;
  platformName: string;
  coversAllReciters: boolean;
  kind: RowKind;
  currentMemberIds: number[];
  currentMemberNames: string[];
  currentTitle: string;
  newTitle: string;
  titleWillChange: boolean;
  pageId: number | null;
  pageOptions: PageOption[];
  candidateMembers: MemberOption[];
  autoMemberId: number | null;
  warnings: string[];
};

export type ExtraPlatformRow = {
  key: string; // `${date}|${platformId}`
  slot: SlotKey;
  platformId: number;
  platformName: string;
  pageOptions: PageOption[];
  pageId: number | null;
  candidateMembers: MemberOption[];
  autoMemberId: number | null;
  newTitle: string;
};

export type SubstitutionPlan = {
  baseTaskId: number;
  fromReciter: { id: number; name: string };
  toReciter: { id: number; name: string };
  scopeKind: SubstitutionScopeKind;
  slots: SlotKey[];
  rows: PlanRow[];
  extras: ExtraPlatformRow[];
  warnings: string[];
  planToken: string;
};

export type SlotOption = {
  date: string;
  prayer: string | null;
  isBase: boolean;
  isPast: boolean;
  taskCount: number;
  actionableCount: number;
};

export class SubstitutionError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = "SubstitutionError";
  }
}

// ── أدوات التاريخ (مستقلة عن توقيت الخادم: مفاتيح YYYY-MM-DD حرفية من PostgreSQL) ──────────────

const taskDateKeySql = sql<string | null>`to_char(coalesce(${tasksTable.dueDate}, ${tasksTable.startDate}), 'YYYY-MM-DD')`;

function addDaysToKey(dateKey: string, days: number) {
  const anchor = safeAnchorFromDateKey(dateKey);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

// الأسبوع يبدأ الأحد (0) وينتهي السبت (6) — الجدول الرسمي ينزل السبت ويُرتَّب من الأحد إلى السبت الذي يليه.
export function weekRangeOfKey(dateKey: string) {
  const dow = safeAnchorFromDateKey(dateKey).getUTCDay();
  const start = addDaysToKey(dateKey, -dow);
  return { start, end: addDaysToKey(start, 6) };
}

function riyadhTodayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ── المهمة الأساسية ──────────────────────────────────────────────────────────────────────────

type BaseTask = {
  id: number;
  reciterId: number;
  reciterName: string;
  prayer: string | null;
  creationGroupId: number | null;
  dateKey: string | null;
  weeklyQuotaRequired: number | null;
};

async function loadBaseTask(taskId: number): Promise<BaseTask> {
  const [row] = await db
    .select({
      id: tasksTable.id,
      reciterId: tasksTable.reciterId,
      reciterName: recitersTable.name,
      prayer: tasksTable.prayer,
      creationGroupId: tasksTable.creationGroupId,
      dateKey: taskDateKeySql,
      weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
      deletedAt: tasksTable.deletedAt,
    })
    .from(tasksTable)
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  if (!row || row.deletedAt) throw new SubstitutionError(404, "task_not_found", "المهمة غير موجودة");
  if (!row.reciterId || !row.reciterName) {
    throw new SubstitutionError(400, "task_without_reciter", "لا يمكن النيابة في مهمة بلا قارئ — حدّد القارئ من نافذة التعديل");
  }
  if (row.weeklyQuotaRequired != null) {
    throw new SubstitutionError(400, "weekly_quota_excluded", "مهام الحصة الأسبوعية مستثناة من النيابة لأنها تغطي أسبوعًا كاملًا لا فرضًا واحدًا");
  }
  return {
    id: row.id,
    reciterId: row.reciterId,
    reciterName: row.reciterName,
    prayer: row.prayer ?? null,
    creationGroupId: row.creationGroupId ?? null,
    dateKey: row.dateKey ?? null,
    weeklyQuotaRequired: row.weeklyQuotaRequired ?? null,
  };
}

// شرط «مهام الفرض» لقارئ معيّن (القارئ الأصلي عادةً، أو النائب لكشف التعارض).
function slotTaskCondition(base: BaseTask, dateKey: string, reciterId: number) {
  const conditions = [
    isNull(tasksTable.deletedAt),
    eq(tasksTable.reciterId, reciterId),
    sql`${taskDateKeySql} = ${dateKey}`,
  ];
  if (base.prayer) {
    conditions.push(eq(tasksTable.prayer, base.prayer));
  } else {
    // مهام قديمة بلا صلاة: نحصر الفرض في نفس مجموعة الإنشاء.
    conditions.push(isNull(tasksTable.prayer));
    conditions.push(eq(tasksTable.creationGroupId, base.creationGroupId as number));
  }
  return and(...conditions);
}

// ── قائمة الفروض المتاحة للاختيار (نفس الصلاة، نفس الأسبوع) ─────────────────────────────────────

export async function listSubstitutionSlots(taskId: number): Promise<{
  base: { id: number; reciterId: number; reciterName: string; prayer: string | null; dateKey: string | null };
  week: { start: string; end: string } | null;
  slots: SlotOption[];
  canUseMultiDay: boolean;
}> {
  const base = await loadBaseTask(taskId);
  const baseInfo = { id: base.id, reciterId: base.reciterId, reciterName: base.reciterName, prayer: base.prayer, dateKey: base.dateKey };
  const canUseMultiDay = Boolean(base.dateKey && (base.prayer || base.creationGroupId));
  if (!base.dateKey || !canUseMultiDay) {
    return { base: baseInfo, week: null, slots: [], canUseMultiDay: false };
  }

  const week = weekRangeOfKey(base.dateKey);
  const today = riyadhTodayKey();
  const slots: SlotOption[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const dateKey = addDaysToKey(week.start, offset);
    const tasks = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(slotTaskCondition(base, dateKey, base.reciterId));
    if (tasks.length === 0) continue;
    const protectedIds = await protectedTaskIds(tasks.map((t) => t.id));
    slots.push({
      date: dateKey,
      prayer: base.prayer,
      isBase: dateKey === base.dateKey,
      isPast: dateKey < today,
      taskCount: tasks.length,
      actionableCount: tasks.filter((t) => !protectedIds.has(t.id)).length,
    });
  }
  return { base: baseInfo, week, slots, canUseMultiDay };
}

// المهام المحمية: مكتملة، أو لها شاهد (رابط تسليم أو دليل غير محذوف)، أو حصة أسبوعية.
async function protectedTaskIds(taskIds: number[]) {
  const result = new Set<number>();
  if (taskIds.length === 0) return result;
  const rows = await db
    .select({
      id: tasksTable.id,
      status: tasksTable.status,
      completedAt: tasksTable.completedAt,
      submissionUrl: tasksTable.submissionUrl,
      weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
    })
    .from(tasksTable)
    .where(inArray(tasksTable.id, taskIds));
  const proofRows = await db
    .select({ taskId: taskProofsTable.taskId })
    .from(taskProofsTable)
    .where(and(inArray(taskProofsTable.taskId, taskIds), isNull(taskProofsTable.deletedAt)));
  const withProof = new Set(proofRows.map((r) => r.taskId));
  for (const row of rows) {
    if (
      row.status === "completed" ||
      row.completedAt ||
      (row.submissionUrl ?? "").trim() !== "" ||
      withProof.has(row.id) ||
      row.weeklyQuotaRequired != null
    ) {
      result.add(row.id);
    }
  }
  return result;
}

// ── توفّر النائب على المنصات ────────────────────────────────────────────────────────────────

type PlatformInfo = { id: number; name: string; coversAllReciters: boolean };
type ReciterAvailability = {
  platforms: Map<number, PlatformInfo>;
  pagesByPlatform: Map<number, PageOption[]>; // صفحات النائب على كل منصة (مع أعضائها النشطين)
  activeMembers: MemberOption[];
  youtubeChannelPlatformIds: Set<number>;
};

export async function resolveReciterAvailability(reciterId: number): Promise<ReciterAvailability> {
  const platformRows = await db
    .select({ id: platformsTable.id, name: platformsTable.name, coversAllReciters: platformsTable.coversAllReciters })
    .from(platformsTable);
  const platforms = new Map(platformRows.map((p) => [p.id, { ...p, coversAllReciters: Boolean(p.coversAllReciters) }]));

  const pageRows = await db
    .select({ id: platformPagesTable.id, name: platformPagesTable.name, platformId: platformPagesTable.platformId })
    .from(platformPagesTable)
    .where(eq(platformPagesTable.reciterId, reciterId))
    .orderBy(platformPagesTable.id);
  const pageIds = pageRows.map((p) => p.id);
  const memberRows = pageIds.length > 0
    ? await db
      .select({ pageId: pageMembersTable.pageId, id: membersTable.id, name: membersTable.name })
      .from(pageMembersTable)
      .innerJoin(membersTable, eq(pageMembersTable.memberId, membersTable.id))
      .where(and(inArray(pageMembersTable.pageId, pageIds), eq(membersTable.isActive, true)))
      .orderBy(membersTable.id)
    : [];
  const membersByPage = new Map<number, MemberOption[]>();
  for (const row of memberRows) {
    if (!membersByPage.has(row.pageId)) membersByPage.set(row.pageId, []);
    membersByPage.get(row.pageId)!.push({ id: row.id, name: row.name });
  }
  const pagesByPlatform = new Map<number, PageOption[]>();
  for (const page of pageRows) {
    if (!pagesByPlatform.has(page.platformId)) pagesByPlatform.set(page.platformId, []);
    pagesByPlatform.get(page.platformId)!.push({ id: page.id, name: page.name, members: membersByPage.get(page.id) ?? [] });
  }

  const activeMembers = await db
    .select({ id: membersTable.id, name: membersTable.name })
    .from(membersTable)
    .where(eq(membersTable.isActive, true))
    .orderBy(membersTable.id);

  // قنوات يوتيوب المراقَبة للنائب (للتنبيه فقط: صفحة بلا قناة مراقَبة ⇐ التوثيق يدوي).
  let youtubeChannelPlatformIds = new Set<number>();
  try {
    const result: any = await db.execute(sql`SELECT platform_id FROM youtube_channels WHERE reciter_id = ${reciterId} AND enabled = true`);
    const rows = (Array.isArray(result) ? result : result?.rows ?? []) as Array<{ platform_id: number }>;
    youtubeChannelPlatformIds = new Set(rows.map((r) => Number(r.platform_id)));
  } catch {
    // جدول القنوات غير موجود بعد — لا تنبيه.
  }

  return { platforms, pagesByPlatform, activeMembers, youtubeChannelPlatformIds };
}

function isYoutubePlatformName(name: string) {
  return /youtube|يوتيوب/i.test(name);
}

// ── العنوان ─────────────────────────────────────────────────────────────────────────────────

function replaceReciterName(title: string, oldName: string, newName: string) {
  if (!oldName || !title.includes(oldName)) return title;
  return title.split(oldName).join(newName);
}

function buildExtraTitle(templateTitle: string, templatePlatformName: string, targetPlatformName: string, oldName: string, newName: string) {
  const withName = replaceReciterName(templateTitle, oldName, newName);
  if (templatePlatformName && withName.includes(templatePlatformName)) {
    return withName.split(templatePlatformName).join(targetPlatformName);
  }
  return [newName, targetPlatformName].filter(Boolean).join(" — ");
}

// ── بناء الخطة ──────────────────────────────────────────────────────────────────────────────

type SlotTask = {
  id: number;
  title: string;
  platformId: number;
  memberId: number;
  pageId: number | null;
  status: string;
  completedAt: Date | null;
  submissionUrl: string | null;
  deletedAt: Date | null;
  reciterId: number | null;
  substitutionId: number | null;
  originalReciterId: number | null;
  weeklyQuotaRequired: number | null;
  creationGroupId: number | null;
  description: string | null;
  priority: string;
  startDate: Date | null;
  endDate: Date | null;
  dueDate: Date | null;
  prayer: string | null;
};

async function loadSlotTasks(base: BaseTask, slot: SlotKey, reciterId: number): Promise<SlotTask[]> {
  const columns = {
    id: tasksTable.id,
    title: tasksTable.title,
    platformId: tasksTable.platformId,
    memberId: tasksTable.memberId,
    pageId: tasksTable.pageId,
    status: tasksTable.status,
    completedAt: tasksTable.completedAt,
    submissionUrl: tasksTable.submissionUrl,
    deletedAt: tasksTable.deletedAt,
    reciterId: tasksTable.reciterId,
    substitutionId: tasksTable.substitutionId,
    originalReciterId: tasksTable.originalReciterId,
    weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
    creationGroupId: tasksTable.creationGroupId,
    description: tasksTable.description,
    priority: tasksTable.priority,
    startDate: tasksTable.startDate,
    endDate: tasksTable.endDate,
    dueDate: tasksTable.dueDate,
    prayer: tasksTable.prayer,
  };
  if (!slot.date) {
    // مهمة بلا تاريخ: الفرض هو المهمة الأساسية وحدها.
    if (reciterId !== base.reciterId) return [];
    return db.select(columns).from(tasksTable).where(and(eq(tasksTable.id, base.id), isNull(tasksTable.deletedAt))).orderBy(tasksTable.id);
  }
  if (!base.prayer && !base.creationGroupId) {
    if (reciterId !== base.reciterId) return [];
    return db.select(columns).from(tasksTable).where(and(eq(tasksTable.id, base.id), isNull(tasksTable.deletedAt))).orderBy(tasksTable.id);
  }
  return db.select(columns).from(tasksTable).where(slotTaskCondition(base, slot.date, reciterId)).orderBy(tasksTable.id);
}

async function resolveScopeSlots(base: BaseTask, scopeKind: SubstitutionScopeKind, requestedDates: unknown): Promise<SlotKey[]> {
  const baseSlot: SlotKey = { date: base.dateKey, prayer: base.prayer, creationGroupId: base.prayer ? null : base.creationGroupId };
  if (scopeKind === "single") return [baseSlot];

  const listing = await listSubstitutionSlots(base.id);
  if (!listing.canUseMultiDay) {
    throw new SubstitutionError(400, "multi_day_unavailable", "هذه المهمة قديمة (بلا صلاة/مجموعة/تاريخ) — النيابة متاحة لها كفرض واحد فقط");
  }
  if (scopeKind === "rest_of_week") {
    return listing.slots
      .filter((slot) => base.dateKey && slot.date >= base.dateKey)
      .map((slot) => ({ date: slot.date, prayer: base.prayer, creationGroupId: base.prayer ? null : base.creationGroupId }));
  }

  const dates = Array.isArray(requestedDates) ? [...new Set(requestedDates.map(String))] : [];
  if (dates.length === 0) throw new SubstitutionError(400, "dates_required", "اختر يومًا واحدًا على الأقل");
  const allowed = new Set(listing.slots.map((slot) => slot.date));
  const invalid = dates.filter((date) => !allowed.has(date));
  if (invalid.length > 0) {
    throw new SubstitutionError(400, "invalid_dates", "بعض الأيام المختارة ليست من فروض هذا القارئ في هذا الأسبوع", { invalid });
  }
  return dates.sort().map((date) => ({ date, prayer: base.prayer, creationGroupId: base.prayer ? null : base.creationGroupId }));
}

export async function buildSubstitutionPlan(input: {
  taskId: number;
  newReciterId: number;
  scopeKind: SubstitutionScopeKind;
  dates?: unknown;
}): Promise<SubstitutionPlan & { internal: { base: BaseTask; slotTasks: Map<string, SlotTask[]>; availability: ReciterAvailability } }> {
  const base = await loadBaseTask(input.taskId);
  if (input.newReciterId === base.reciterId) {
    throw new SubstitutionError(400, "same_reciter", "النائب هو نفس القارئ الحالي");
  }
  const [toReciter] = await db
    .select({ id: recitersTable.id, name: recitersTable.name })
    .from(recitersTable)
    .where(eq(recitersTable.id, input.newReciterId))
    .limit(1);
  if (!toReciter) throw new SubstitutionError(404, "reciter_not_found", "القارئ النائب غير موجود");

  const slots = await resolveScopeSlots(base, input.scopeKind, input.dates);
  const availability = await resolveReciterAvailability(toReciter.id);

  const rows: PlanRow[] = [];
  const extras: ExtraPlatformRow[] = [];
  const warnings: string[] = [];
  const slotTasks = new Map<string, SlotTask[]>();
  const tokenParts: unknown[] = [];

  const allTaskIds: number[] = [];
  const perSlot: Array<{ slot: SlotKey; tasks: SlotTask[]; substituteTasks: SlotTask[] }> = [];
  for (const slot of slots) {
    const tasks = await loadSlotTasks(base, slot, base.reciterId);
    const substituteTasks = await loadSlotTasks(base, slot, toReciter.id);
    slotTasks.set(slot.date ?? "", tasks);
    allTaskIds.push(...tasks.map((t) => t.id));
    perSlot.push({ slot, tasks, substituteTasks });
  }
  if (allTaskIds.length === 0) {
    throw new SubstitutionError(409, "nothing_in_scope", "لا توجد مهام للقارئ الأصلي في النطاق المختار");
  }

  const protectedIds = await protectedTaskIds(allTaskIds);
  const memberRows = await db
    .select({ taskId: taskMembersTable.taskId, memberId: taskMembersTable.memberId, name: membersTable.name })
    .from(taskMembersTable)
    .innerJoin(membersTable, eq(taskMembersTable.memberId, membersTable.id))
    .where(inArray(taskMembersTable.taskId, allTaskIds));
  const membersByTask = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of memberRows) {
    if (!membersByTask.has(row.taskId)) membersByTask.set(row.taskId, []);
    membersByTask.get(row.taskId)!.push({ id: row.memberId, name: row.name });
  }
  const memberNameById = new Map(availability.activeMembers.map((m) => [m.id, m.name]));
  const extraMemberIds = [...new Set(allTaskIds.length ? (await db.select({ memberId: tasksTable.memberId }).from(tasksTable).where(inArray(tasksTable.id, allTaskIds))).map((r) => r.memberId) : [])]
    .filter((id) => !memberNameById.has(id));
  if (extraMemberIds.length > 0) {
    const extraMembers = await db.select({ id: membersTable.id, name: membersTable.name }).from(membersTable).where(inArray(membersTable.id, extraMemberIds));
    for (const m of extraMembers) memberNameById.set(m.id, m.name);
  }

  const warnedNoYoutubeChannel = new Set<number>();

  for (const { slot, tasks, substituteTasks } of perSlot) {
    const platformsInSlot = new Set(tasks.map((t) => t.platformId));
    const substitutePlatformsInSlot = new Set(substituteTasks.map((t) => t.platformId));

    for (const task of tasks) {
      const platform = availability.platforms.get(task.platformId) ?? { id: task.platformId, name: "منصة", coversAllReciters: false };
      const currentMembers = membersByTask.get(task.id) ?? [{ id: task.memberId, name: memberNameById.get(task.memberId) ?? "" }];
      const newTitle = replaceReciterName(task.title, base.reciterName, toReciter.name);
      const row: PlanRow = {
        taskId: task.id,
        slot,
        platformId: task.platformId,
        platformName: platform.name,
        coversAllReciters: platform.coversAllReciters,
        kind: "auto_assign",
        currentMemberIds: currentMembers.map((m) => m.id),
        currentMemberNames: currentMembers.map((m) => m.name),
        currentTitle: task.title,
        newTitle,
        titleWillChange: newTitle !== task.title,
        pageId: null,
        pageOptions: [],
        candidateMembers: [],
        autoMemberId: null,
        warnings: [],
      };

      if (task.weeklyQuotaRequired != null) row.kind = "excluded_quota";
      else if (task.status === "completed" || task.completedAt) row.kind = "protected_completed";
      else if (protectedIds.has(task.id)) row.kind = "protected_proof";
      else {
        const pages = availability.pagesByPlatform.get(task.platformId) ?? [];
        if (pages.length === 0 && !platform.coversAllReciters) {
          row.kind = "delete_unavailable";
        } else if (pages.length > 1) {
          row.kind = "choose_page";
          row.pageOptions = pages;
          row.candidateMembers = availability.activeMembers;
          row.warnings.push(`للنائب أكثر من صفحة على ${platform.name} — اختر الصفحة الصحيحة`);
        } else {
          const page = pages[0] ?? null;
          row.pageId = page?.id ?? null;
          if (page) row.pageOptions = [page];
          const linked = page?.members ?? [];
          if (linked.length === 1) {
            row.kind = "auto_assign";
            row.autoMemberId = linked[0].id;
            row.candidateMembers = linked;
          } else if (linked.length > 1) {
            row.kind = "choose_member";
            row.candidateMembers = linked;
          } else {
            row.kind = "choose_any_member";
            row.candidateMembers = availability.activeMembers;
          }
        }
        if (!row.titleWillChange) row.warnings.push("العنوان لا يحتوي اسم القارئ الأصلي — لن يتغيّر العنوان");
        if (substitutePlatformsInSlot.has(task.platformId)) {
          row.warnings.push("للنائب مهمة أخرى على نفس المنصة في نفس الفرض — تحقّق من عدم التكرار");
        }
        if (
          row.kind !== "delete_unavailable" &&
          isYoutubePlatformName(platform.name) &&
          !availability.youtubeChannelPlatformIds.has(task.platformId) &&
          !warnedNoYoutubeChannel.has(task.platformId)
        ) {
          warnedNoYoutubeChannel.add(task.platformId);
          warnings.push(`للنائب صفحة على ${platform.name} لكن لا توجد له قناة مراقَبة — التوثيق هناك سيكون يدويًا`);
        }
        if (slot.date && slot.date < riyadhTodayKey()) row.warnings.push("تاريخ هذا الفرض مضى");
      }
      rows.push(row);
      tokenParts.push([
        task.id, task.status, task.completedAt ? 1 : 0, (task.submissionUrl ?? "").trim() ? 1 : 0, protectedIds.has(task.id) ? 1 : 0,
        task.reciterId, task.memberId, task.pageId, task.title, task.deletedAt ? 1 : 0, task.weeklyQuotaRequired,
        row.currentMemberIds.slice().sort(),
      ]);
    }

    // المنصات الزائدة: للنائب صفحة عليها، وليست ضمن مهام هذا الفرض، ولا مهمة للنائب عليها في الفرض نفسه.
    const template = tasks[0];
    if (template) {
      const templatePlatform = availability.platforms.get(template.platformId);
      for (const [platformId, pages] of availability.pagesByPlatform) {
        if (platformsInSlot.has(platformId) || substitutePlatformsInSlot.has(platformId)) continue;
        const platform = availability.platforms.get(platformId);
        if (!platform) continue;
        const page = pages.length === 1 ? pages[0] : null;
        const linked = page?.members ?? [];
        extras.push({
          key: `${slot.date ?? ""}|${platformId}`,
          slot,
          platformId,
          platformName: platform.name,
          pageOptions: pages,
          pageId: page?.id ?? null,
          candidateMembers: linked.length > 0 ? linked : availability.activeMembers,
          autoMemberId: linked.length === 1 ? linked[0].id : null,
          newTitle: buildExtraTitle(template.title, templatePlatform?.name ?? "", platform.name, base.reciterName, toReciter.name),
        });
      }
    }
  }

  if (!rows.some((row) => !["protected_completed", "protected_proof", "excluded_quota"].includes(row.kind))) {
    warnings.push("كل مهام النطاق محمية (مكتملة أو لها شاهد) — لا يوجد ما يُغيَّر");
  }

  // بصمة الخطة: حالة كل مهمة في النطاق + إعداد صفحات النائب وأعضائها + الأعضاء النشطين.
  const availabilitySnapshot = [...availability.pagesByPlatform.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([platformId, pages]) => [platformId, pages.map((p) => [p.id, p.members.map((m) => m.id)])]);
  const coverSnapshot = [...availability.platforms.values()].filter((p) => p.coversAllReciters).map((p) => p.id).sort();
  const planToken = createHash("sha256")
    .update(JSON.stringify({
      base: base.id,
      from: base.reciterId,
      to: toReciter.id,
      slots: slots.map((s) => [s.date, s.prayer, s.creationGroupId]),
      tasks: tokenParts,
      availability: availabilitySnapshot,
      coverSnapshot,
      activeMembers: availability.activeMembers.map((m) => m.id),
    }))
    .digest("hex");

  return {
    baseTaskId: base.id,
    fromReciter: { id: base.reciterId, name: base.reciterName },
    toReciter,
    scopeKind: input.scopeKind,
    slots,
    rows,
    extras,
    warnings,
    planToken,
    internal: { base, slotTasks, availability },
  };
}

export function publicPlan(plan: Awaited<ReturnType<typeof buildSubstitutionPlan>>): SubstitutionPlan {
  const { internal: _internal, ...rest } = plan;
  return rest;
}

// ── التطبيق ─────────────────────────────────────────────────────────────────────────────────

export type RowDecision = { taskId: number; memberId?: number; pageId?: number };
export type ExtraDecision = { key: string; create: boolean; memberId?: number; pageId?: number };

export type SubstitutionNotification = {
  memberId: number;
  kind: "assigned" | "reciter_changed" | "cancelled" | "moved_away";
  taskId: number;
  title: string;
  platformName: string;
  dateKey: string | null;
  prayer: string | null;
};

export type SubstitutionTaskChange = {
  taskId: number;
  action: "reassigned" | "deleted" | "created";
  platformName: string;
  previousTitle: string | null;
  newTitle: string;
  fromMemberIds: number[];
  toMemberId: number | null;
};

export type ApplyResult = {
  substitutionId: number;
  reassigned: number;
  deleted: number;
  created: number;
  protected: number;
  notifications: SubstitutionNotification[];
  taskChanges: SubstitutionTaskChange[];
  fromReciterName: string;
  toReciterName: string;
};

class StaleRowError extends Error {}

const NOT_PROTECTED_SQL = sql`
  ${tasksTable.deletedAt} IS NULL
  AND ${tasksTable.status} <> 'completed'
  AND ${tasksTable.completedAt} IS NULL
  AND ${tasksTable.weeklyQuotaRequired} IS NULL
  AND coalesce(btrim(${tasksTable.submissionUrl}), '') = ''
  AND NOT EXISTS (SELECT 1 FROM task_proofs tp WHERE tp.task_id = ${tasksTable.id} AND tp.deleted_at IS NULL)
`;

async function taskMemberIdsUsing(client: any, taskId: number, fallbackMemberId: number) {
  const rows = await client.select({ memberId: taskMembersTable.memberId }).from(taskMembersTable).where(eq(taskMembersTable.taskId, taskId));
  return rows.length > 0 ? rows.map((r: { memberId: number }) => r.memberId) : [fallbackMemberId];
}

async function syncTaskMembersUsing(client: any, taskId: number, memberIds: number[]) {
  await client.delete(taskMembersTable).where(eq(taskMembersTable.taskId, taskId));
  if (memberIds.length > 0) {
    await client.insert(taskMembersTable).values(memberIds.map((memberId) => ({ taskId, memberId })));
  }
}

function snapshotOf(task: { reciterId: number | null; memberId: number; pageId: number | null; title: string; deletedAt: Date | null; substitutionId: number | null; originalReciterId: number | null }, memberIds: number[]) {
  return {
    reciterId: task.reciterId,
    memberId: task.memberId,
    memberIds,
    pageId: task.pageId,
    title: task.title,
    deletedAt: task.deletedAt ? task.deletedAt.toISOString() : null,
    substitutionId: task.substitutionId,
    originalReciterId: task.originalReciterId,
  };
}

export async function applySubstitution(input: {
  taskId: number;
  newReciterId: number;
  scopeKind: SubstitutionScopeKind;
  dates?: unknown;
  planToken: string;
  decisions: RowDecision[];
  extras: ExtraDecision[];
  userId: number | null;
}): Promise<ApplyResult> {
  const plan = await buildSubstitutionPlan(input);
  if (!input.planToken || plan.planToken !== input.planToken) {
    throw new SubstitutionError(409, "plan_stale", "تغيّرت البيانات منذ المعاينة — راجع الشاشة من جديد", { plan: publicPlan(plan) });
  }

  const decisionsByTask = new Map<number, RowDecision>();
  for (const decision of input.decisions ?? []) {
    const taskId = Number(decision?.taskId);
    if (!Number.isInteger(taskId)) throw new SubstitutionError(400, "invalid_decision", "قرار غير صالح");
    decisionsByTask.set(taskId, decision);
  }
  const rowsByTask = new Map(plan.rows.map((row) => [row.taskId, row]));
  for (const taskId of decisionsByTask.keys()) {
    const row = rowsByTask.get(taskId);
    if (!row) throw new SubstitutionError(400, "decision_outside_scope", "قرار لمهمة خارج نطاق النيابة");
    if (["protected_completed", "protected_proof", "excluded_quota", "delete_unavailable"].includes(row.kind)) {
      throw new SubstitutionError(400, "decision_on_locked_row", "لا يمكن اتخاذ قرار لمهمة محمية أو محذوفة تلقائيًا");
    }
  }

  const activeMemberIds = new Set(plan.internal.availability.activeMembers.map((m) => m.id));
  type Op =
    | { type: "reassign"; row: PlanRow; memberId: number; pageId: number | null }
    | { type: "delete"; row: PlanRow }
    | { type: "create"; extra: ExtraPlatformRow; memberId: number; pageId: number | null };
  const ops: Op[] = [];
  let protectedCount = 0;

  for (const row of plan.rows) {
    if (row.kind === "protected_completed" || row.kind === "protected_proof" || row.kind === "excluded_quota") {
      protectedCount += 1;
      continue;
    }
    if (row.kind === "delete_unavailable") {
      ops.push({ type: "delete", row });
      continue;
    }
    const decision = decisionsByTask.get(row.taskId);
    let pageId = row.pageId;
    let allowedMembers = row.candidateMembers;
    if (row.kind === "choose_page") {
      const page = row.pageOptions.find((p) => p.id === Number(decision?.pageId));
      if (!page) throw new SubstitutionError(400, "page_required", `اختر صفحة النائب على ${row.platformName}`);
      pageId = page.id;
      allowedMembers = page.members.length > 0 ? page.members : plan.internal.availability.activeMembers;
    }
    let memberId: number | null = row.kind === "auto_assign" ? row.autoMemberId : null;
    if (decision?.memberId !== undefined && decision?.memberId !== null) memberId = Number(decision.memberId);
    if (!memberId || !allowedMembers.some((m) => m.id === memberId) || !activeMemberIds.has(memberId)) {
      throw new SubstitutionError(400, "member_required", `اختر العضو المسؤول لمهمة ${row.platformName} (${row.slot.date ?? ""})`);
    }
    ops.push({ type: "reassign", row, memberId, pageId });
  }

  const extrasByKey = new Map(plan.extras.map((extra) => [extra.key, extra]));
  for (const decision of input.extras ?? []) {
    if (!decision?.create) continue;
    const extra = extrasByKey.get(String(decision.key));
    if (!extra) throw new SubstitutionError(400, "invalid_extra", "منصة إضافية غير صالحة");
    let pageId = extra.pageId;
    let allowedMembers = extra.candidateMembers;
    if (extra.pageOptions.length > 1) {
      const page = extra.pageOptions.find((p) => p.id === Number(decision.pageId));
      if (!page) throw new SubstitutionError(400, "page_required", `اختر صفحة النائب على ${extra.platformName}`);
      pageId = page.id;
      allowedMembers = page.members.length > 0 ? page.members : plan.internal.availability.activeMembers;
    }
    const memberId = Number(decision.memberId ?? extra.autoMemberId);
    if (!memberId || !allowedMembers.some((m) => m.id === memberId) || !activeMemberIds.has(memberId)) {
      throw new SubstitutionError(400, "member_required", `اختر العضو المسؤول للمهمة الجديدة على ${extra.platformName}`);
    }
    ops.push({ type: "create", extra, memberId, pageId });
  }

  if (ops.length === 0) {
    throw new SubstitutionError(400, "nothing_to_apply", "لا يوجد ما يُطبَّق — كل مهام النطاق محمية");
  }

  const { base } = plan.internal;
  const fromReciterId = base.reciterId;
  const toReciterId = plan.toReciter.id;
  const notifications: SubstitutionNotification[] = [];
  const taskChanges: SubstitutionTaskChange[] = [];
  let reassigned = 0;
  let deleted = 0;
  let created = 0;

  let substitutionId: number;
  try {
    substitutionId = await db.transaction(async (tx: any) => {
      const [substitution] = await tx.insert(reciterSubstitutionsTable).values({
        baseTaskId: base.id,
        fromReciterId,
        toReciterId,
        scopeKind: input.scopeKind,
        slots: plan.slots,
        status: "applied",
        createdByUserId: input.userId,
      }).returning();

      for (const op of ops) {
        if (op.type === "reassign" || op.type === "delete") {
          const [task] = await tx.select().from(tasksTable).where(eq(tasksTable.id, op.row.taskId)).for("update");
          if (!task) throw new StaleRowError();
          const beforeMemberIds = await taskMemberIdsUsing(tx, task.id, task.memberId);
          const before = snapshotOf(task, beforeMemberIds);
          // original_reciter_id: القارئ المجدول أصلًا — يبقى الأول إن كانت المهمة نيابة سابقة.
          const originalReciterId = task.originalReciterId ?? fromReciterId;

          if (op.type === "delete") {
            const updated = await tx.update(tasksTable)
              .set({ deletedAt: new Date(), substitutionId: substitution.id, originalReciterId })
              .where(and(eq(tasksTable.id, task.id), eq(tasksTable.reciterId, fromReciterId), NOT_PROTECTED_SQL))
              .returning({ id: tasksTable.id });
            if (updated.length !== 1) throw new StaleRowError();
            await tx.insert(reciterSubstitutionItemsTable).values({
              substitutionId: substitution.id,
              taskId: task.id,
              action: "deleted",
              before,
              after: { ...before, deletedAt: new Date().toISOString(), substitutionId: substitution.id, originalReciterId },
            });
            deleted += 1;
            taskChanges.push({ taskId: task.id, action: "deleted", platformName: op.row.platformName, previousTitle: task.title, newTitle: task.title, fromMemberIds: beforeMemberIds, toMemberId: null });
            for (const memberId of beforeMemberIds) {
              notifications.push({ memberId, kind: "cancelled", taskId: task.id, title: task.title, platformName: op.row.platformName, dateKey: op.row.slot.date, prayer: op.row.slot.prayer });
            }
            continue;
          }

          const newTitle = op.row.newTitle;
          const updated = await tx.update(tasksTable)
            .set({
              reciterId: toReciterId,
              memberId: op.memberId,
              pageId: op.pageId,
              title: newTitle,
              substitutionId: substitution.id,
              originalReciterId,
            })
            .where(and(eq(tasksTable.id, task.id), eq(tasksTable.reciterId, fromReciterId), NOT_PROTECTED_SQL))
            .returning({ id: tasksTable.id });
          if (updated.length !== 1) throw new StaleRowError();
          await syncTaskMembersUsing(tx, task.id, [op.memberId]);
          await tx.insert(reciterSubstitutionItemsTable).values({
            substitutionId: substitution.id,
            taskId: task.id,
            action: "reassigned",
            before,
            after: {
              reciterId: toReciterId,
              memberId: op.memberId,
              memberIds: [op.memberId],
              pageId: op.pageId,
              title: newTitle,
              deletedAt: null,
              substitutionId: substitution.id,
              originalReciterId,
            },
          });
          reassigned += 1;
          taskChanges.push({ taskId: task.id, action: "reassigned", platformName: op.row.platformName, previousTitle: task.title, newTitle, fromMemberIds: beforeMemberIds, toMemberId: op.memberId });
          const common = { taskId: task.id, title: newTitle, platformName: op.row.platformName, dateKey: op.row.slot.date, prayer: op.row.slot.prayer };
          if (beforeMemberIds.includes(op.memberId)) {
            notifications.push({ memberId: op.memberId, kind: "reciter_changed", ...common });
          } else {
            notifications.push({ memberId: op.memberId, kind: "assigned", ...common });
          }
          for (const memberId of beforeMemberIds) {
            if (memberId !== op.memberId) notifications.push({ memberId, kind: "moved_away", ...common });
          }
          continue;
        }

        // إنشاء مهمة لمنصة زائدة عند النائب — بنفس تاريخ/صلاة/أولوية مهمة من الفرض، بلا سلسلة.
        const template = (plan.internal.slotTasks.get(op.extra.slot.date ?? "") ?? [])[0];
        if (!template) throw new StaleRowError();
        const [newTask] = await tx.insert(tasksTable).values({
          creationGroupId: template.creationGroupId,
          seriesId: null,
          source: "admin_created",
          title: op.extra.newTitle,
          description: template.description,
          platformId: op.extra.platformId,
          memberId: op.memberId,
          reciterId: toReciterId,
          status: "pending",
          priority: template.priority as "urgent" | "normal" | "low",
          progress: 0,
          startDate: template.startDate,
          endDate: template.endDate,
          dueDate: template.dueDate,
          recurrence: "none",
          pageId: op.pageId,
          prayer: template.prayer,
          substitutionId: substitution.id,
          originalReciterId: fromReciterId,
        }).returning();
        await syncTaskMembersUsing(tx, newTask.id, [op.memberId]);
        await tx.insert(reciterSubstitutionItemsTable).values({
          substitutionId: substitution.id,
          taskId: newTask.id,
          action: "created",
          before: null,
          after: { reciterId: toReciterId, memberId: op.memberId, memberIds: [op.memberId], pageId: op.pageId, title: newTask.title, deletedAt: null, substitutionId: substitution.id, originalReciterId: fromReciterId },
        });
        created += 1;
        taskChanges.push({ taskId: newTask.id, action: "created", platformName: op.extra.platformName, previousTitle: null, newTitle: newTask.title, fromMemberIds: [], toMemberId: op.memberId });
        notifications.push({ memberId: op.memberId, kind: "assigned", taskId: newTask.id, title: newTask.title, platformName: op.extra.platformName, dateKey: op.extra.slot.date, prayer: op.extra.slot.prayer });
      }

      return substitution.id as number;
    });
  } catch (error) {
    if (error instanceof StaleRowError) {
      const fresh = await buildSubstitutionPlan(input).catch(() => null);
      throw new SubstitutionError(409, "plan_stale", "تغيّرت حالة إحدى المهام أثناء التطبيق (اكتملت أو رُفع لها شاهد) — لم يُطبَّق أي شيء، راجع الشاشة من جديد", fresh ? { plan: publicPlan(fresh) } : undefined);
    }
    throw error;
  }

  return {
    substitutionId,
    reassigned,
    deleted,
    created,
    protected: protectedCount,
    notifications,
    taskChanges,
    fromReciterName: plan.fromReciter.name,
    toReciterName: plan.toReciter.name,
  };
}

// ── التراجع ─────────────────────────────────────────────────────────────────────────────────

export type UndoResult = {
  substitutionId: number;
  restored: number;
  undeleted: number;
  removedCreated: number;
  skipped: Array<{ taskId: number; reason: string }>;
  notifications: SubstitutionNotification[];
  fromReciterName: string | null;
  toReciterName: string | null;
};

type Snapshot = ReturnType<typeof snapshotOf>;

export async function undoSubstitution(substitutionId: number, userId: number | null): Promise<UndoResult> {
  const [substitution] = await db.select().from(reciterSubstitutionsTable).where(eq(reciterSubstitutionsTable.id, substitutionId)).limit(1);
  if (!substitution) throw new SubstitutionError(404, "substitution_not_found", "عملية النيابة غير موجودة");
  if (substitution.status !== "applied") throw new SubstitutionError(400, "already_undone", "تم التراجع عن هذه النيابة مسبقًا");

  const reciterRows = await db
    .select({ id: recitersTable.id, name: recitersTable.name })
    .from(recitersTable)
    .where(inArray(recitersTable.id, [substitution.fromReciterId ?? 0, substitution.toReciterId ?? 0]));
  const reciterName = new Map(reciterRows.map((r) => [r.id, r.name]));

  const items = await db
    .select()
    .from(reciterSubstitutionItemsTable)
    .where(and(eq(reciterSubstitutionItemsTable.substitutionId, substitutionId), isNull(reciterSubstitutionItemsTable.undoneAt)))
    .orderBy(reciterSubstitutionItemsTable.id);

  const skipped: UndoResult["skipped"] = [];
  const notifications: SubstitutionNotification[] = [];
  let restored = 0;
  let undeleted = 0;
  let removedCreated = 0;

  await db.transaction(async (tx: any) => {
    for (const item of items) {
      const [task] = await tx
        .select({
          id: tasksTable.id,
          title: tasksTable.title,
          memberId: tasksTable.memberId,
          substitutionId: tasksTable.substitutionId,
          deletedAt: tasksTable.deletedAt,
          prayer: tasksTable.prayer,
          dateKey: taskDateKeySql,
          platformName: platformsTable.name,
        })
        .from(tasksTable)
        .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
        .where(eq(tasksTable.id, item.taskId))
        .for("update");
      if (!task) {
        skipped.push({ taskId: item.taskId, reason: "المهمة حُذفت نهائيًا" });
        continue;
      }
      if (task.substitutionId !== substitutionId) {
        skipped.push({ taskId: task.id, reason: "تغيّرت المهمة بعد النيابة (نيابة أخرى)" });
        continue;
      }
      const before = item.before as Snapshot | null;
      const after = item.after as Snapshot | null;
      const common = { taskId: task.id, platformName: task.platformName, dateKey: task.dateKey ?? null, prayer: task.prayer ?? null };

      if (item.action === "reassigned" && before) {
        const currentMemberIds = await taskMemberIdsUsing(tx, task.id, task.memberId);
        const updated = await tx.update(tasksTable)
          .set({
            reciterId: before.reciterId,
            memberId: before.memberId,
            pageId: before.pageId,
            title: before.title,
            substitutionId: before.substitutionId,
            originalReciterId: before.originalReciterId,
          })
          .where(and(eq(tasksTable.id, task.id), eq(tasksTable.substitutionId, substitutionId), NOT_PROTECTED_SQL))
          .returning({ id: tasksTable.id });
        if (updated.length !== 1) {
          skipped.push({ taskId: task.id, reason: "المهمة اكتملت أو رُفع لها شاهد بعد النيابة — تبقى كما هي" });
          continue;
        }
        await syncTaskMembersUsing(tx, task.id, before.memberIds?.length ? before.memberIds : [before.memberId]);
        restored += 1;
        const restoredMembers = before.memberIds?.length ? before.memberIds : [before.memberId];
        for (const memberId of restoredMembers) {
          notifications.push({ memberId, kind: currentMemberIds.includes(memberId) ? "reciter_changed" : "assigned", title: before.title, ...common });
        }
        for (const memberId of currentMemberIds) {
          if (!restoredMembers.includes(memberId)) notifications.push({ memberId, kind: "moved_away", title: after?.title ?? task.title, ...common });
        }
      } else if (item.action === "deleted" && before) {
        const updated = await tx.update(tasksTable)
          .set({ deletedAt: null, substitutionId: before.substitutionId, originalReciterId: before.originalReciterId })
          .where(and(eq(tasksTable.id, task.id), eq(tasksTable.substitutionId, substitutionId), sql`${tasksTable.deletedAt} IS NOT NULL`))
          .returning({ id: tasksTable.id });
        if (updated.length !== 1) {
          skipped.push({ taskId: task.id, reason: "المهمة استُرجعت مسبقًا" });
          continue;
        }
        undeleted += 1;
        for (const memberId of before.memberIds?.length ? before.memberIds : [before.memberId]) {
          notifications.push({ memberId, kind: "assigned", title: before.title, ...common });
        }
      } else if (item.action === "created") {
        const currentMemberIds = await taskMemberIdsUsing(tx, task.id, task.memberId);
        const updated = await tx.update(tasksTable)
          .set({ deletedAt: new Date() })
          .where(and(eq(tasksTable.id, task.id), eq(tasksTable.substitutionId, substitutionId), NOT_PROTECTED_SQL))
          .returning({ id: tasksTable.id });
        if (updated.length !== 1) {
          skipped.push({ taskId: task.id, reason: "المهمة الجديدة اكتملت أو رُفع لها شاهد أو حُذفت — تبقى كما هي" });
          continue;
        }
        removedCreated += 1;
        for (const memberId of currentMemberIds) notifications.push({ memberId, kind: "cancelled", title: task.title, ...common });
      } else {
        skipped.push({ taskId: task.id, reason: "بند غير معروف" });
        continue;
      }
      await tx.update(reciterSubstitutionItemsTable).set({ undoneAt: new Date() }).where(eq(reciterSubstitutionItemsTable.id, item.id));
    }

    await tx.update(reciterSubstitutionsTable)
      .set({ status: skipped.length > 0 ? "partially_undone" : "undone", undoneAt: new Date(), undoneByUserId: userId })
      .where(eq(reciterSubstitutionsTable.id, substitutionId));
  });

  return {
    substitutionId,
    restored,
    undeleted,
    removedCreated,
    skipped,
    notifications,
    fromReciterName: substitution.fromReciterId ? reciterName.get(substitution.fromReciterId) ?? null : null,
    toReciterName: substitution.toReciterId ? reciterName.get(substitution.toReciterId) ?? null : null,
  };
}

// ── سجلّ النيابات لمهمة ─────────────────────────────────────────────────────────────────────

export async function listTaskSubstitutions(taskId: number) {
  const itemRows = await db
    .select({ substitutionId: reciterSubstitutionItemsTable.substitutionId, action: reciterSubstitutionItemsTable.action })
    .from(reciterSubstitutionItemsTable)
    .where(eq(reciterSubstitutionItemsTable.taskId, taskId));
  const ids = [...new Set(itemRows.map((r) => r.substitutionId))];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(reciterSubstitutionsTable)
    .where(inArray(reciterSubstitutionsTable.id, ids))
    .orderBy(sql`${reciterSubstitutionsTable.id} DESC`);
  const reciterIds = [...new Set(rows.flatMap((r) => [r.fromReciterId, r.toReciterId]).filter((x): x is number => Boolean(x)))];
  const reciters = reciterIds.length > 0
    ? await db.select({ id: recitersTable.id, name: recitersTable.name }).from(recitersTable).where(inArray(recitersTable.id, reciterIds))
    : [];
  const nameById = new Map(reciters.map((r) => [r.id, r.name]));
  const counts = await db
    .select({ substitutionId: reciterSubstitutionItemsTable.substitutionId, action: reciterSubstitutionItemsTable.action, count: sql<number>`count(*)::int` })
    .from(reciterSubstitutionItemsTable)
    .where(inArray(reciterSubstitutionItemsTable.substitutionId, ids))
    .groupBy(reciterSubstitutionItemsTable.substitutionId, reciterSubstitutionItemsTable.action);
  return rows.map((row) => {
    const itemCounts: Record<string, number> = {};
    for (const c of counts) if (c.substitutionId === row.id) itemCounts[c.action] = c.count;
    return {
      id: row.id,
      status: row.status,
      scopeKind: row.scopeKind,
      slots: row.slots,
      createdAt: row.createdAt,
      undoneAt: row.undoneAt,
      fromReciterName: row.fromReciterId ? nameById.get(row.fromReciterId) ?? null : null,
      toReciterName: row.toReciterId ? nameById.get(row.toReciterId) ?? null : null,
      counts: itemCounts,
      taskAction: itemRows.find((r) => r.substitutionId === row.id)?.action ?? null,
    };
  });
}
