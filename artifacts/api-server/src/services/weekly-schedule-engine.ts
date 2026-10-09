// محرّك «إنشاء الجدول الأسبوعي»: يطبّق قالب النشر على الأئمة المختارين لكل صلاة، وينشئ مهامًا مؤقتة
// لكل يوم من الأسبوع (الأحد → السبت). للإنشاء فقط: لا يعدّل ولا يحذف أي مهمة قائمة إطلاقًا.
//
// الضمانات:
// - كل الإنشاء في معاملة واحدة، بقفل استشاري يمنع إنشاءين متزامنين (نقرتين مثلًا).
// - منع التكرار يُعاد فحصه داخل المعاملة: (القارئ + الصلاة + اليوم + المنصة + نوع التصوير).
//   مهمة قائمة بلا نوع تصوير تُعدّ مكافئة لـ«الشؤون» (كما تفعل مراقبة يوتيوب مع *توثيق*).
// - المهام مؤقتة (سلسلة temporary لكل صف قالب) — لا يولّد منها المولّد شيئًا.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  tasksTable,
  taskMembersTable,
  taskSeriesTable,
  taskCreationGroupsTable,
  recitersTable,
  usersTable,
  notificationsTable,
  weeklyScheduleBatchesTable,
  weeklyScheduleSettingsTable,
} from "@workspace/db";
import { safeAnchorFromDateKey } from "../lib/hijri";
import { activeTemplateRowsFor, TemplateError } from "./weekly-schedule-template";
import { notifyTelegramWeeklyScheduleDigest } from "./telegram-notification-engine";

export type SchedulePrayer = "fajr" | "maghrib" | "isha" | "jumuah";
export type Mosque = "haram" | "nabawi";
export type ScheduleAssignment = { mosque: Mosque; prayer: SchedulePrayer; reciterId: number };

export const PRAYER_TITLE: Record<SchedulePrayer, string> = {
  fajr: "صلاة الفجر",
  maghrib: "صلاة المغرب",
  isha: "صلاة العشاء",
  jumuah: "خطبة وصلاة الجمعة",
};
const FILMING_NOTE: Record<string, string> = { affairs: "تصوير الشؤون", tv: "تصوير التلفزيون" };
const WEEKDAY = new Intl.DateTimeFormat("ar-SA", { timeZone: "Asia/Riyadh", weekday: "long" });
const HIJRI = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura", { timeZone: "Asia/Riyadh", day: "numeric", month: "long" });

function addDaysToKey(dateKey: string, days: number) {
  const anchor = safeAnchorFromDateKey(dateKey);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

// تاريخ المهمة: منتصف ليل اليوم الحرفي (يُخزَّن «YYYY-MM-DD 00:00» في عمود timestamp بلا منطقة زمنية)،
// فيقرأه to_char (مطابقة يوتيوب والنيابة) يومًا صحيحًا بصرف النظر عن توقيت الخادم.
function dateOfKey(dateKey: string) {
  return new Date(`${dateKey}T00:00:00Z`);
}

export function riyadhTodayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// الأحد القادم (أو اليوم إن كان أحدًا) بتوقيت الرياض.
export function defaultWeekStart() {
  const today = riyadhTodayKey();
  const dow = safeAnchorFromDateKey(today).getUTCDay();
  return dow === 0 ? today : addDaysToKey(today, 7 - dow);
}

function parseInput(input: { weekStart: unknown; assignments: unknown }) {
  const weekStart = String(input.weekStart ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(safeAnchorFromDateKey(weekStart).getTime())) {
    throw new TemplateError(400, "invalid_week", "تاريخ بداية الأسبوع غير صالح");
  }
  if (safeAnchorFromDateKey(weekStart).getUTCDay() !== 0) {
    throw new TemplateError(400, "week_must_start_sunday", "الأسبوع يبدأ يوم الأحد — اختر يوم أحد");
  }
  const raw = Array.isArray(input.assignments) ? input.assignments : [];
  const seen = new Set<string>();
  const assignments: ScheduleAssignment[] = [];
  for (const item of raw) {
    const mosque = item?.mosque;
    const prayer = item?.prayer;
    const reciterId = Number(item?.reciterId);
    if (mosque !== "haram" && mosque !== "nabawi") throw new TemplateError(400, "invalid_mosque", "مسجد غير صالح");
    if (prayer !== "fajr" && prayer !== "maghrib" && prayer !== "isha" && prayer !== "jumuah") throw new TemplateError(400, "invalid_prayer", "الصلوات المدعومة: الفجر والمغرب والعشاء والجمعة");
    if (!Number.isInteger(reciterId) || reciterId <= 0) continue; // خانة بلا إمام = لا شيء لهذه الصلاة
    const key = `${mosque}|${prayer}`;
    if (seen.has(key)) throw new TemplateError(400, "duplicate_slot", "إمام واحد فقط لكل صلاة في كل مسجد");
    seen.add(key);
    assignments.push({ mosque, prayer, reciterId });
  }
  if (assignments.length === 0) throw new TemplateError(400, "no_assignments", "اختر إمامًا لصلاة واحدة على الأقل");
  const dates = Array.from({ length: 7 }, (_, i) => addDaysToKey(weekStart, i));
  return { weekStart, weekEnd: dates[6], dates, assignments };
}

export type PlannedTask = {
  assignmentKey: string;
  mosque: Mosque;
  prayer: SchedulePrayer;
  reciterId: number;
  reciterName: string;
  dateKey: string;
  platformId: number;
  platformName: string;
  filmingType: "affairs" | "tv" | null;
  memberId: number;
  memberName: string;
  pageId: number | null;
  title: string;
  note: string | null;
  templateRowId: number;
  duplicate: boolean;
};

type CountRow = { label: string; total: number; toCreate: number };

function tally(items: PlannedTask[], labelOf: (t: PlannedTask) => string): CountRow[] {
  const map = new Map<string, CountRow>();
  for (const item of items) {
    const label = labelOf(item);
    const row = map.get(label) ?? { label, total: 0, toCreate: 0 };
    row.total += 1;
    if (!item.duplicate) row.toCreate += 1;
    map.set(label, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

async function buildPlanUsing(client: any, input: { weekStart: unknown; assignments: unknown }) {
  const { weekStart, weekEnd, dates, assignments } = parseInput(input);
  const warnings: string[] = [];

  const reciterIds = [...new Set(assignments.map((a) => a.reciterId))];
  const reciters = await client.select({ id: recitersTable.id, name: recitersTable.name, mosque: recitersTable.mosque }).from(recitersTable).where(inArray(recitersTable.id, reciterIds));
  const reciterById = new Map<number, { id: number; name: string; mosque: string }>(reciters.map((r: any) => [r.id, r]));
  for (const a of assignments) {
    const reciter = reciterById.get(a.reciterId);
    if (!reciter) throw new TemplateError(400, "invalid_reciter", "إمام غير موجود");
    if (reciter.mosque !== a.mosque) throw new TemplateError(400, "mosque_mismatch", `الإمام ${reciter.name} ليس من أئمة ${a.mosque === "haram" ? "المسجد الحرام" : "المسجد النبوي"}`);
  }

  const templateRows = await activeTemplateRowsFor(reciterIds, client);
  const items: PlannedTask[] = [];
  for (const a of assignments) {
    const reciter = reciterById.get(a.reciterId)!;
    const rows = templateRows.filter((row) => row.reciterId === a.reciterId);
    if (rows.length === 0) {
      warnings.push(`${PRAYER_TITLE[a.prayer]} (${a.mosque === "haram" ? "الحرام" : "النبوي"}): الإمام ${reciter.name} بلا قالب نشر — لن تُنشأ له مهام`);
      continue;
    }
    for (const row of rows) {
      if (!row.memberActive) {
        warnings.push(`${reciter.name} — ${row.platformName}${row.filmingType ? ` (${FILMING_NOTE[row.filmingType]})` : ""}: العضو ${row.memberName} غير نشط — لن تُنشأ هذه المهام`);
        continue;
      }
      // الفروض: كل أيام الأسبوع. الجمعة: حدث واحد يوم الجمعة (الأحد + 5) — وبقية السلوك كالفروض تمامًا.
      for (const dateKey of a.prayer === "jumuah" ? [dates[5]] : dates) {
        items.push({
          assignmentKey: `${a.mosque}|${a.prayer}`,
          mosque: a.mosque,
          prayer: a.prayer,
          reciterId: a.reciterId,
          reciterName: reciter.name,
          dateKey,
          platformId: row.platformId,
          platformName: row.platformName,
          filmingType: (row.filmingType as "affairs" | "tv" | null) ?? null,
          memberId: row.memberId,
          memberName: row.memberName,
          pageId: row.pageId ?? null,
          title: `${PRAYER_TITLE[a.prayer]} — ${reciter.name} — ${row.platformName}`,
          note: row.filmingType ? FILMING_NOTE[row.filmingType] ?? null : null,
          templateRowId: row.id,
          duplicate: false,
        });
      }
    }
  }

  // منع التكرار: مهام قائمة غير محذوفة لنفس (القارئ + الصلاة + اليوم + المنصة + نوع التصوير).
  if (items.length > 0) {
    const existing = await client
      .select({
        reciterId: tasksTable.reciterId,
        prayer: tasksTable.prayer,
        platformId: tasksTable.platformId,
        filmingType: tasksTable.filmingType,
        dateKey: sql<string>`to_char(coalesce(${tasksTable.dueDate}, ${tasksTable.startDate}), 'YYYY-MM-DD')`,
      })
      .from(tasksTable)
      .where(and(
        isNull(tasksTable.deletedAt),
        inArray(tasksTable.reciterId, reciterIds),
        inArray(tasksTable.prayer, [...new Set(assignments.map((a) => a.prayer))]),
        sql`to_char(coalesce(${tasksTable.dueDate}, ${tasksTable.startDate}), 'YYYY-MM-DD') BETWEEN ${weekStart} AND ${weekEnd}`,
      ));
    const existingKeys = new Set(existing.map((e: any) => `${e.reciterId}|${e.prayer}|${e.dateKey}|${e.platformId}|${e.filmingType ?? ""}`));
    for (const item of items) {
      const base = `${item.reciterId}|${item.prayer}|${item.dateKey}|${item.platformId}|`;
      item.duplicate = item.filmingType === "tv"
        ? existingKeys.has(`${base}tv`)
        : item.filmingType === "affairs"
          ? existingKeys.has(`${base}affairs`) || existingKeys.has(base)
          : existingKeys.has(base) || existingKeys.has(`${base}affairs`);
    }
  }

  const previousBatches = await client
    .select({ id: weeklyScheduleBatchesTable.id, createdAt: weeklyScheduleBatchesTable.createdAt, createdTasks: weeklyScheduleBatchesTable.createdTasks })
    .from(weeklyScheduleBatchesTable)
    .where(eq(weeklyScheduleBatchesTable.weekStart, weekStart))
    .orderBy(desc(weeklyScheduleBatchesTable.id));
  if (previousBatches.length > 0) {
    warnings.unshift(`سبق إنشاء جدول لهذا الأسبوع (${previousBatches.length} مرة). المهام الموجودة مسبقًا لن تُنشأ مرة أخرى.`);
  }
  const duplicates = items.filter((i) => i.duplicate).length;
  if (duplicates > 0) warnings.push(`${duplicates} مهمة موجودة مسبقًا لهذا الأسبوع — لن تُنشأ (منع التكرار).`);
  if (weekStart < riyadhTodayKey() && weekEnd < riyadhTodayKey()) warnings.push("الأسبوع المختار مضى بالكامل.");

  return {
    weekStart,
    weekEnd,
    assignments: assignments.map((a) => ({ ...a, reciterName: reciterById.get(a.reciterId)!.name })),
    items,
    summary: {
      total: items.length,
      toCreate: items.length - duplicates,
      duplicates,
      byPrayer: tally(items, (t) => `${PRAYER_TITLE[t.prayer]} — ${t.mosque === "haram" ? "الحرام" : "النبوي"} — ${t.reciterName}`),
      byPlatform: tally(items, (t) => t.platformName + (t.filmingType ? ` (${FILMING_NOTE[t.filmingType]})` : "")),
      byMember: tally(items, (t) => t.memberName),
    },
    warnings,
    previousBatches,
  };
}

export async function previewWeeklySchedule(input: { weekStart: unknown; assignments: unknown }) {
  const plan = await buildPlanUsing(db, input);
  const { items, ...rest } = plan;
  return { ...rest, items: items.map(({ templateRowId: _t, ...item }) => item) };
}

export async function createWeeklySchedule(input: { weekStart: unknown; assignments: unknown }, userId: number | null) {
  type Created = { taskId: number; item: PlannedTask };
  const created: Created[] = [];
  let batchId = 0;
  let planOut: Awaited<ReturnType<typeof buildPlanUsing>> | null = null;

  await db.transaction(async (tx: any) => {
    // قفل استشاري على مستوى المعاملة: إنشاءان متزامنان لا يتداخلان، والثاني يرى مهام الأول كمكرّرة.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('weekly_schedule_create'))`);
    const plan = await buildPlanUsing(tx, input);
    planOut = plan;
    const toCreate = plan.items.filter((i) => !i.duplicate);

    const assignmentResults: Array<Record<string, unknown>> = [];
    for (const a of plan.assignments) {
      const key = `${a.mosque}|${a.prayer}`;
      const mine = toCreate.filter((i) => i.assignmentKey === key);
      const skipped = plan.items.filter((i) => i.assignmentKey === key && i.duplicate).length;
      if (mine.length === 0) {
        assignmentResults.push({ ...a, creationGroupId: null, createdTasks: 0, skippedDuplicates: skipped });
        continue;
      }
      const [group] = await tx.insert(taskCreationGroupsTable).values({
        createdByUserId: userId,
        title: `${PRAYER_TITLE[a.prayer]} — ${a.reciterName} — جدول ${plan.weekStart}`,
      }).returning();

      // سلسلة مؤقتة لكل صف قالب (منصة + نوع تصوير)، كما يفعل الإنشاء الحالي متعدد الأيام،
      // فتعمل خيارات «هذه وما بعدها» في التعديل والحذف كما هي.
      const byRow = new Map<number, PlannedTask[]>();
      for (const item of mine) {
        if (!byRow.has(item.templateRowId)) byRow.set(item.templateRowId, []);
        byRow.get(item.templateRowId)!.push(item);
      }
      for (const rowItems of byRow.values()) {
        rowItems.sort((x, y) => x.dateKey.localeCompare(y.dateKey));
        const first = rowItems[0];
        const [series] = await tx.insert(taskSeriesTable).values({
          title: first.title,
          recurrenceType: "none",
          seriesType: "temporary",
          startDate: dateOfKey(first.dateKey),
          endDate: dateOfKey(rowItems[rowItems.length - 1].dateKey),
          generateUntil: dateOfKey(rowItems[rowItems.length - 1].dateKey),
          status: "active",
        }).returning();
        for (const item of rowItems) {
          const day = dateOfKey(item.dateKey);
          const [task] = await tx.insert(tasksTable).values({
            seriesId: series.id,
            creationGroupId: group.id,
            source: "admin_created",
            title: item.title,
            platformId: item.platformId,
            memberId: item.memberId,
            reciterId: item.reciterId,
            status: "pending",
            priority: "normal",
            progress: 0,
            startDate: day,
            endDate: day,
            dueDate: day,
            recurrence: "none",
            pageId: item.pageId,
            prayer: item.prayer,
            mosque: item.mosque,
            assigneeNote: item.note,
            filmingType: item.filmingType,
          }).returning({ id: tasksTable.id });
          await tx.insert(taskMembersTable).values({ taskId: task.id, memberId: item.memberId });
          created.push({ taskId: task.id, item });
        }
      }
      assignmentResults.push({ ...a, creationGroupId: group.id, createdTasks: mine.length, skippedDuplicates: skipped });
    }

    const [batch] = await tx.insert(weeklyScheduleBatchesTable).values({
      weekStart: plan.weekStart,
      weekEnd: plan.weekEnd,
      assignments: assignmentResults,
      createdTasks: toCreate.length,
      skippedDuplicates: plan.items.length - toCreate.length,
      createdByUserId: userId,
    }).returning();
    batchId = batch.id;
  });

  const plan = planOut!;
  await notifyMembers(created, plan.weekStart, plan.weekEnd, batchId).catch(() => {});
  return {
    batchId,
    weekStart: plan.weekStart,
    weekEnd: plan.weekEnd,
    createdTasks: created.length,
    skippedDuplicates: plan.items.length - created.length,
    warnings: plan.warnings,
  };
}

function dayLabel(dateKey: string) {
  const anchor = safeAnchorFromDateKey(dateKey);
  return `${WEEKDAY.format(anchor)} ${HIJRI.format(anchor)}`;
}

// إشعار واحد لكل عضو عن مهام أسبوعه (داخلي + تيليجرام)، مجمّعًا حسب (الصلاة + الإمام + المنصة + النوع).
async function notifyMembers(created: Array<{ taskId: number; item: PlannedTask }>, weekStart: string, weekEnd: string, batchId: number) {
  if (created.length === 0) return;
  const byMember = new Map<number, Array<{ taskId: number; item: PlannedTask }>>();
  for (const entry of created) {
    if (!byMember.has(entry.item.memberId)) byMember.set(entry.item.memberId, []);
    byMember.get(entry.item.memberId)!.push(entry);
  }
  const heading = `مهامك لأسبوع ${dayLabel(weekStart)} — ${dayLabel(weekEnd)}`;
  const users = await db
    .select({ id: usersTable.id, memberId: usersTable.memberId })
    .from(usersTable)
    .where(and(inArray(usersTable.memberId as any, [...byMember.keys()]), eq(usersTable.isApproved, true)));

  for (const [memberId, entries] of byMember) {
    const groups = new Map<string, { label: string; days: string[] }>();
    for (const { item } of entries) {
      const label = `${item.title}${item.note ? ` (${item.note})` : ""}`;
      const group = groups.get(label) ?? { label, days: [] };
      group.days.push(item.dateKey);
      groups.set(label, group);
    }
    const lines = [...groups.values()].map((g) => `${g.label}: ${g.days.length === 7 ? "كل أيام الأسبوع" : g.days.map((d) => WEEKDAY.format(safeAnchorFromDateKey(d))).join("، ")}`);
    const body = [`عدد المهام: ${entries.length}`, ...lines.map((l) => `• ${l}`)].join("\n");
    const memberUsers = users.filter((u) => u.memberId === memberId);
    if (memberUsers.length > 0) {
      await db.insert(notificationsTable).values(memberUsers.map((u) => ({
        userId: u.id,
        type: "task_assigned",
        title: heading,
        body,
        taskId: entries[0].taskId,
        isRead: false,
      }))).catch(() => {});
    }
    await notifyTelegramWeeklyScheduleDigest({
      memberId,
      heading: `${heading} (${entries.length} مهمة)`,
      lines,
      dedupeKey: `telegram:weekly_schedule:${batchId}:member:${memberId}`,
      taskId: entries[0].taskId,
    }).catch(() => {});
  }
}

// ── الإعدادات والصفحة ─────────────────────────────────────────────────────────────────────
export async function getScheduleSettings() {
  const [settings] = await db.select().from(weeklyScheduleSettingsTable).limit(1);
  return { previewEnabled: settings?.previewEnabled ?? true, templateImportedAt: settings?.templateImportedAt ?? null };
}

export async function setPreviewEnabled(value: boolean) {
  const [settings] = await db.select().from(weeklyScheduleSettingsTable).limit(1);
  if (settings) {
    await db.update(weeklyScheduleSettingsTable).set({ previewEnabled: value, updatedAt: new Date() }).where(eq(weeklyScheduleSettingsTable.id, settings.id));
  } else {
    await db.insert(weeklyScheduleSettingsTable).values({ previewEnabled: value });
  }
  return getScheduleSettings();
}

export async function getScheduleSetup() {
  const reciters = await db.select({ id: recitersTable.id, name: recitersTable.name, mosque: recitersTable.mosque }).from(recitersTable).orderBy(recitersTable.id);
  const rows = await activeTemplateRowsFor(reciters.map((r) => r.id));
  const countByReciter = new Map<number, number>();
  for (const row of rows) countByReciter.set(row.reciterId, (countByReciter.get(row.reciterId) ?? 0) + 1);
  const recentBatches = await db
    .select({
      id: weeklyScheduleBatchesTable.id,
      weekStart: weeklyScheduleBatchesTable.weekStart,
      weekEnd: weeklyScheduleBatchesTable.weekEnd,
      createdTasks: weeklyScheduleBatchesTable.createdTasks,
      skippedDuplicates: weeklyScheduleBatchesTable.skippedDuplicates,
      assignments: weeklyScheduleBatchesTable.assignments,
      createdAt: weeklyScheduleBatchesTable.createdAt,
    })
    .from(weeklyScheduleBatchesTable)
    .orderBy(desc(weeklyScheduleBatchesTable.id))
    .limit(10);
  return {
    settings: await getScheduleSettings(),
    defaultWeekStart: defaultWeekStart(),
    reciters: reciters.map((r) => ({ ...r, templateRows: countByReciter.get(r.id) ?? 0 })),
    recentBatches,
  };
}
