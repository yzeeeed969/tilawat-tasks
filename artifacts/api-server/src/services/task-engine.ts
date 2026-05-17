import { and, desc, eq, sql } from "drizzle-orm";
import { db, tasksTable, taskMembersTable, taskSeriesTable } from "@workspace/db";

const GENERATION_WINDOW_DAYS = 60;
const SYNC_THRESHOLD_DAYS = 14;

type RecurrenceType = "weekly" | "monthly";

type GenerateInput = {
  seriesId: number;
  title: string;
  description?: string | null;
  platformId: number;
  memberIds: number[];
  reciterId?: number | null;
  pageId?: number | null;
  priority?: "urgent" | "normal" | "low";
  startDate: Date;
  recurrenceType: RecurrenceType;
};

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

function upcomingDates(startDate: Date, recurrenceType: RecurrenceType): Date[] {
  const start = startOfDay(startDate);
  const windowEnd = addDays(startOfDay(new Date()), GENERATION_WINDOW_DAYS);
  const dates: Date[] = [];

  if (recurrenceType === "weekly") {
    for (let cursor = start; cursor <= windowEnd; cursor = addDays(cursor, 7)) {
      if (cursor >= startOfDay(new Date())) dates.push(new Date(cursor));
    }
    return dates;
  }

  for (let step = 0, cursor = start; cursor <= windowEnd; step += 1, cursor = addMonthsClamped(start, step)) {
    if (cursor >= startOfDay(new Date())) dates.push(new Date(cursor));
  }
  return dates;
}

async function syncTaskMembers(taskId: number, memberIds: number[], tx: any) {
  if (memberIds.length === 0) return;
  await tx.insert(taskMembersTable).values(memberIds.map((memberId) => ({ taskId, memberId })));
}

export async function generateUpcomingTasksForSeries(input: GenerateInput) {
  if (!["weekly", "monthly"].includes(input.recurrenceType)) {
    throw new Error("Unsupported recurrence type");
  }
  if (input.memberIds.length === 0) {
    throw new Error("At least one member is required");
  }

  const dates = upcomingDates(input.startDate, input.recurrenceType);
  const generatedIds: number[] = [];
  const generateUntil = dates.length > 0 ? dates[dates.length - 1] : input.startDate;

  await db.transaction(async (tx: any) => {
    for (const dueDate of dates) {
      const existing = await tx
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(and(
          eq(tasksTable.seriesId, input.seriesId),
          sql`date(${tasksTable.dueDate}) = date(${dueDate})`,
        ))
        .limit(1);

      if (existing.length > 0) continue;

      const [task] = await tx.insert(tasksTable).values({
        seriesId: input.seriesId,
        title: input.title,
        description: input.description ?? undefined,
        platformId: input.platformId,
        memberId: input.memberIds[0],
        reciterId: input.reciterId ?? null,
        status: "pending",
        priority: input.priority ?? "normal",
        progress: 0,
        startDate: dueDate,
        endDate: null,
        dueDate,
        recurrence: "none",
        recurrenceIntervalDays: null,
        recurrenceDurationDays: null,
        recurrenceDays: null,
        pageId: input.pageId ?? null,
      }).onConflictDoNothing({
        target: [tasksTable.seriesId, tasksTable.dueDate],
      }).returning();

      if (!task) continue;

      await syncTaskMembers(task.id, input.memberIds, tx);
      generatedIds.push(task.id);
    }

    await tx
      .update(taskSeriesTable)
      .set({ generateUntil, updatedAt: new Date() })
      .where(eq(taskSeriesTable.id, input.seriesId));
  });

  return generatedIds;
}

function isNearGenerationEnd(generateUntil: Date | null) {
  if (!generateUntil) return true;
  const threshold = addDays(startOfDay(new Date()), SYNC_THRESHOLD_DAYS);
  return startOfDay(generateUntil) <= threshold;
}

export async function syncActiveSeries() {
  const activeSeries = await db
    .select()
    .from(taskSeriesTable)
    .where(and(
      eq(taskSeriesTable.status, "active"),
      eq(taskSeriesTable.seriesType, "operational"),
    ));

  const syncedSeriesIds: number[] = [];

  for (const series of activeSeries) {
    if (series.recurrenceType !== "weekly" && series.recurrenceType !== "monthly") continue;
    if (!isNearGenerationEnd(series.generateUntil)) continue;

    const [templateTask] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.seriesId, series.id))
      .orderBy(desc(tasksTable.dueDate))
      .limit(1);

    if (!templateTask) continue;

    const assignedMembers = await db
      .select({ memberId: taskMembersTable.memberId })
      .from(taskMembersTable)
      .where(eq(taskMembersTable.taskId, templateTask.id));

    const memberIds = assignedMembers.length > 0
      ? assignedMembers.map((row) => row.memberId)
      : [templateTask.memberId];

    await generateUpcomingTasksForSeries({
      seriesId: series.id,
      title: series.title,
      description: templateTask.description,
      platformId: templateTask.platformId,
      memberIds,
      reciterId: templateTask.reciterId,
      pageId: templateTask.pageId,
      priority: templateTask.priority,
      startDate: series.startDate,
      recurrenceType: series.recurrenceType,
    });

    syncedSeriesIds.push(series.id);
  }

  return syncedSeriesIds;
}

export { GENERATION_WINDOW_DAYS, SYNC_THRESHOLD_DAYS };
