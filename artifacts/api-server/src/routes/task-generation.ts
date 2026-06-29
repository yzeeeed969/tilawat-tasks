import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  membersTable,
  notificationsTable,
  pageMembersTable,
  platformPagesTable,
  platformsTable,
  recitersTable,
  taskGenerationBatchesTable,
  taskMembersTable,
  tasksTable,
  usersTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { notifyTelegramTaskAssigned } from "../services/telegram-notification-engine";
import { ensureTaskGenerationSchema } from "../services/task-generation-schema";

const router = Router();

router.use(requireAdmin);
router.use(async (_req, _res, next) => {
  try {
    await ensureTaskGenerationSchema();
    next();
  } catch (error) {
    next(error);
  }
});

type GenerationTargetInput = {
  platformId: number;
  pageId: number;
  memberIds: number[];
  startDate: Date;
  endDate: Date;
  enabled?: boolean;
};

type GenerationInput = {
  sourceTaskId: number;
  targets: GenerationTargetInput[];
};

type SourceTaskDetails = {
  id: number;
  title: string;
  description: string | null;
  platformId: number;
  platformName: string;
  memberId: number;
  reciterId: number | null;
  reciterName: string | null;
  status: "pending" | "in_progress" | "completed";
  priority: "urgent" | "normal" | "low";
  startDate: Date | null;
  endDate: Date | null;
  dueDate: Date | null;
  deletedAt: Date | null;
};

type GenerationItem = {
  platformId: number;
  platformName: string;
  pageId: number;
  pageName: string;
  memberIds: number[];
  memberNames: string[];
  startDate: string;
  endDate: string;
  daysCount: number;
  expectedTasks: number;
  warnings: string[];
};

type SkippedItem = {
  platformId?: number;
  platformName?: string;
  pageId?: number;
  pageName?: string;
  dueDate?: string;
  reason: string;
  existingTaskId?: number;
};

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function isSourcePlatformName(name: string | null | undefined) {
  const normalized = normalizeText(name);
  return normalized.includes("تطبيق") && normalized.includes("تلاوات") && normalized.includes("الحرمين");
}

function isInstagramPlatformName(name: string | null | undefined) {
  const normalized = normalizeText(name);
  return normalized.includes("instagram") || normalized.includes("انست") || normalized.includes("إنست");
}

function parseDateOnly(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateKey(date: Date | null | undefined) {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function dateKeyStrict(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDateRange(start: Date, end: Date) {
  const dates: Date[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(new Date(cursor));
  }
  return dates;
}

function titleMatches(existingTitle: string, requestedTitle: string) {
  const a = normalizeText(existingTitle);
  const b = normalizeText(requestedTitle);
  return a === b || a.includes(b) || b.includes(a);
}

function riyadhParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function riyadhLocalToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number) {
  return new Date(Date.UTC(year, month, day, hour - 3, minute, second, ms));
}

function currentRiyadhWeekRange(now = new Date()) {
  const parts = riyadhParts(now);
  return {
    start: riyadhLocalToUtc(parts.year, parts.month, parts.day - parts.weekday, 0, 0, 0, 0),
    end: riyadhLocalToUtc(parts.year, parts.month, parts.day - parts.weekday + 6, 23, 59, 59, 999),
  };
}

function sourceTaskRange(task: Pick<SourceTaskDetails, "startDate" | "endDate" | "dueDate">) {
  const start = task.startDate ?? task.dueDate ?? task.endDate;
  const end = task.endDate ?? task.dueDate ?? task.startDate;
  if (!start || !end) return null;
  const startOnly = parseDateOnly(dateKeyStrict(start));
  const endOnly = parseDateOnly(dateKeyStrict(end));
  if (!startOnly || !endOnly || endOnly < startOnly) return null;
  return { start: startOnly, end: endOnly };
}

function buildGeneratedTitle(sourceTitle: string, sourcePlatformName: string, targetPlatformName: string, pageName: string) {
  const trimmed = sourceTitle.trim();
  if (trimmed.includes(sourcePlatformName)) return trimmed.replace(sourcePlatformName, targetPlatformName);
  if (normalizeText(trimmed).includes(normalizeText(targetPlatformName))) return trimmed;
  return `${targetPlatformName} - ${pageName}`;
}

function parseGenerationInput(body: unknown): GenerationInput | { error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const sourceTaskId = Number(input.sourceTaskId);
  if (!Number.isInteger(sourceTaskId) || sourceTaskId <= 0) return { error: "invalid_source_task" };
  if (!Array.isArray(input.targets)) return { error: "targets_required" };

  const targets = input.targets.reduce<GenerationTargetInput[]>((acc, rawTarget) => {
    const target = rawTarget as Record<string, unknown>;
    if (target.enabled === false) return acc;
    const startDate = parseDateOnly(target.startDate);
    const endDate = parseDateOnly(target.endDate);
    const platformId = Number(target.platformId);
    const pageId = Number(target.pageId);
    if (!Number.isInteger(platformId) || platformId <= 0) return acc;
    if (!Number.isInteger(pageId) || pageId <= 0) return acc;
    if (!startDate || !endDate || endDate < startDate) return acc;
    acc.push({
      platformId,
      pageId,
      memberIds: Array.isArray(target.memberIds)
        ? [...new Set(target.memberIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
        : [],
      startDate,
      endDate,
      enabled: true,
    });
    return acc;
  }, []);

  if (targets.length === 0) return { error: "targets_required" };
  return { sourceTaskId, targets };
}

async function getSourceTask(sourceTaskId: number): Promise<SourceTaskDetails | null> {
  const [task] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      description: tasksTable.description,
      platformId: platformsTable.id,
      platformName: platformsTable.name,
      memberId: tasksTable.memberId,
      reciterId: tasksTable.reciterId,
      reciterName: recitersTable.name,
      status: tasksTable.status,
      priority: tasksTable.priority,
      startDate: tasksTable.startDate,
      endDate: tasksTable.endDate,
      dueDate: tasksTable.dueDate,
      deletedAt: tasksTable.deletedAt,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(eq(tasksTable.id, sourceTaskId))
    .limit(1);
  return task ?? null;
}

function validateSourceTask(task: SourceTaskDetails | null) {
  if (!task) throw new Error("source_task_not_found");
  if (task.deletedAt) throw new Error("source_task_deleted");
  if (!isSourcePlatformName(task.platformName)) throw new Error("source_task_must_be_haramain_app");
  if (!task.reciterId) throw new Error("source_task_missing_reciter");
  const range = sourceTaskRange(task);
  if (!range) throw new Error("source_task_missing_date");
  return range;
}

async function listSourceTasks() {
  const week = currentRiyadhWeekRange();
  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      platformId: platformsTable.id,
      platformName: platformsTable.name,
      reciterId: tasksTable.reciterId,
      reciterName: recitersTable.name,
      status: tasksTable.status,
      startDate: tasksTable.startDate,
      endDate: tasksTable.endDate,
      dueDate: tasksTable.dueDate,
      createdAt: tasksTable.createdAt,
      deletedAt: tasksTable.deletedAt,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(and(
      isNull(tasksTable.deletedAt),
      sql`${tasksTable.reciterId} IS NOT NULL`,
      sql`coalesce(${tasksTable.endDate}, ${tasksTable.dueDate}, ${tasksTable.startDate}, ${tasksTable.createdAt}) >= ${week.start}`,
      sql`coalesce(${tasksTable.startDate}, ${tasksTable.dueDate}, ${tasksTable.endDate}, ${tasksTable.createdAt}) <= ${week.end}`,
    ));

  return {
    week: { start: dateKeyStrict(week.start), end: dateKeyStrict(week.end) },
    tasks: rows
      .filter((task) => isSourcePlatformName(task.platformName))
      .map((task) => ({
        id: task.id,
        title: task.title,
        platformId: task.platformId,
        platformName: task.platformName,
        reciterId: task.reciterId,
        reciterName: task.reciterName,
        status: task.status,
        startDate: dateKey(task.startDate),
        endDate: dateKey(task.endDate),
        dueDate: dateKey(task.dueDate),
      })),
  };
}

async function buildPreview(input: GenerationInput) {
  const sourceTask = await getSourceTask(input.sourceTaskId);
  const sourceRange = validateSourceTask(sourceTask);
  const reciterId = sourceTask!.reciterId!;

  const requestedPageIds = [...new Set(input.targets.map((target) => target.pageId))];
  const requestedMemberIds = [...new Set(input.targets.flatMap((target) => target.memberIds))];

  const pages = requestedPageIds.length > 0
    ? await db
      .select({
        pageId: platformPagesTable.id,
        pageName: platformPagesTable.name,
        pageReciterId: platformPagesTable.reciterId,
        platformId: platformsTable.id,
        platformName: platformsTable.name,
      })
      .from(platformPagesTable)
      .innerJoin(platformsTable, eq(platformPagesTable.platformId, platformsTable.id))
      .where(inArray(platformPagesTable.id, requestedPageIds))
    : [];
  const pageById = new Map(pages.map((page) => [page.pageId, page]));

  const pageMemberRows = requestedPageIds.length > 0
    ? await db.select().from(pageMembersTable).where(inArray(pageMembersTable.pageId, requestedPageIds))
    : [];
  const allowedMembersByPage = new Map<number, Set<number>>();
  for (const row of pageMemberRows) {
    if (!allowedMembersByPage.has(row.pageId)) allowedMembersByPage.set(row.pageId, new Set());
    allowedMembersByPage.get(row.pageId)!.add(row.memberId);
  }

  const memberRows = requestedMemberIds.length > 0
    ? await db.select({ id: membersTable.id, name: membersTable.name }).from(membersTable).where(inArray(membersTable.id, requestedMemberIds))
    : [];
  const memberNameById = new Map(memberRows.map((member) => [member.id, member.name]));

  const items: GenerationItem[] = [];
  for (const target of input.targets) {
    const page = pageById.get(target.pageId);
    const warnings: string[] = [];
    if (!page || page.platformId !== target.platformId) warnings.push("missing_page");
    if (page?.platformId === sourceTask!.platformId) warnings.push("source_platform_target_not_allowed");
    if (page?.pageReciterId && page.pageReciterId !== reciterId) warnings.push("page_reciter_mismatch");
    if (!page?.pageReciterId) warnings.push("page_not_linked_to_reciter");
    const allowed = allowedMembersByPage.get(target.pageId) ?? new Set<number>();
    const memberIds = target.memberIds.filter((memberId) => allowed.has(memberId));
    if (memberIds.length === 0) warnings.push("missing_assignee");
    if (target.memberIds.length > 0 && memberIds.length !== target.memberIds.length) warnings.push("invalid_assignee");
    if (target.endDate < target.startDate) warnings.push("invalid_date_range");
    const dates = getDateRange(target.startDate, target.endDate);
    items.push({
      platformId: target.platformId,
      platformName: page?.platformName ?? "غير معروف",
      pageId: target.pageId,
      pageName: page?.pageName ?? "غير محددة",
      memberIds,
      memberNames: memberIds.map((memberId) => memberNameById.get(memberId) ?? `#${memberId}`),
      startDate: dateKeyStrict(target.startDate),
      endDate: dateKeyStrict(target.endDate),
      daysCount: dates.length,
      expectedTasks: warnings.length === 0 ? dates.length : 0,
      warnings,
    });
  }

  const readyItems = items.filter((item) => item.warnings.length === 0);
  return {
    sourceTask: {
      id: sourceTask!.id,
      title: sourceTask!.title,
      platformId: sourceTask!.platformId,
      platformName: sourceTask!.platformName,
      reciterId,
      reciterName: sourceTask!.reciterName,
      startDate: dateKey(sourceTask!.startDate),
      endDate: dateKey(sourceTask!.endDate),
      dueDate: dateKey(sourceTask!.dueDate),
      defaultStartDate: dateKeyStrict(sourceRange.start),
      defaultEndDate: dateKeyStrict(sourceRange.end),
    },
    daysCount: readyItems.reduce((sum, item) => sum + item.daysCount, 0),
    platformsCount: readyItems.length,
    totalExpected: readyItems.reduce((sum, item) => sum + item.expectedTasks, 0),
    items,
    warnings: items.flatMap((item) => item.warnings.map((warning) => ({ pageId: item.pageId, warning }))),
  };
}

async function notifyAssigned(taskId: number, taskTitle: string, memberIds: number[]) {
  const users = memberIds.length > 0
    ? await db
      .select({ id: usersTable.id, memberId: usersTable.memberId })
      .from(usersTable)
      .where(and(inArray(usersTable.memberId as any, memberIds), eq(usersTable.isApproved, true)))
    : [];

  if (users.length > 0) {
    await db.insert(notificationsTable).values(users.map((user) => ({
      userId: user.id,
      type: "task_assigned",
      title: "تم إسناد مهمة جديدة لك",
      body: taskTitle,
      taskId,
      isRead: false,
    })));
  }

  const [task] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      dueDate: tasksTable.dueDate,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(eq(tasksTable.id, taskId))
    .limit(1);

  if (!task) return;
  await Promise.all(memberIds.map((memberId) => notifyTelegramTaskAssigned({
    id: task.id,
    title: task.title || taskTitle,
    memberId,
    dueDate: task.dueDate ?? null,
    reciterName: task.reciterName ?? null,
    platformName: task.platformName ?? null,
  }).catch(() => {})));
}

async function findGeneratedDuplicate(sourceTaskId: number, reciterId: number, platformId: number, pageId: number, dueDateKey: string) {
  const batches = await db
    .select({ id: taskGenerationBatchesTable.id })
    .from(taskGenerationBatchesTable)
    .where(eq(taskGenerationBatchesTable.sourceTaskId, sourceTaskId));
  if (batches.length === 0) return null;
  const batchIds = batches.map((batch) => batch.id);
  const [task] = await db
    .select({ id: tasksTable.id, title: tasksTable.title })
    .from(tasksTable)
    .where(and(
      isNull(tasksTable.deletedAt),
      inArray(tasksTable.generationBatchId, batchIds),
      eq(tasksTable.reciterId, reciterId),
      eq(tasksTable.platformId, platformId),
      eq(tasksTable.pageId, pageId),
      sql`${tasksTable.dueDate}::date = ${dueDateKey}::date`,
    ))
    .limit(1);
  return task ?? null;
}

async function createGeneration(input: GenerationInput, currentUserId: number | null) {
  const sourceTask = await getSourceTask(input.sourceTaskId);
  const sourceRange = validateSourceTask(sourceTask);
  const reciterId = sourceTask!.reciterId!;
  const preview = await buildPreview(input);
  if (preview.totalExpected <= 0) throw new Error("no_ready_items");

  const created: Array<{ taskId: number; platformId: number; platformName: string; pageId: number; pageName: string; dueDate: string; memberIds: number[] }> = [];
  const skipped: SkippedItem[] = [];

  const [batch] = await db.insert(taskGenerationBatchesTable).values({
    createdByUserId: currentUserId,
    sourceTaskId: sourceTask!.id,
    title: sourceTask!.title,
    sourcePlatformId: sourceTask!.platformId,
    reciterId,
    startDate: sourceRange.start,
    endDate: sourceRange.end,
    note: sourceTask!.description,
  }).returning();

  for (const item of preview.items) {
    if (item.warnings.length > 0) {
      const reason = item.warnings.includes("missing_assignee") || item.warnings.includes("invalid_assignee")
        ? "missing_assignee"
        : item.warnings[0] ?? "not_ready";
      skipped.push({ platformId: item.platformId, platformName: item.platformName, pageId: item.pageId, pageName: item.pageName, reason });
      continue;
    }

    const dates = getDateRange(parseDateOnly(item.startDate)!, parseDateOnly(item.endDate)!);
    const generatedTitle = buildGeneratedTitle(sourceTask!.title, sourceTask!.platformName, item.platformName, item.pageName);

    for (const dueDate of dates) {
      const dueDateKey = dateKeyStrict(dueDate);
      const generatedDuplicate = await findGeneratedDuplicate(sourceTask!.id, reciterId, item.platformId, item.pageId, dueDateKey);
      if (generatedDuplicate) {
        skipped.push({
          platformId: item.platformId,
          platformName: item.platformName,
          pageId: item.pageId,
          pageName: item.pageName,
          dueDate: dueDateKey,
          reason: "already_generated_for_source_task",
          existingTaskId: generatedDuplicate.id,
        });
        continue;
      }

      const duplicateRows = await db
        .select({ id: tasksTable.id, title: tasksTable.title })
        .from(tasksTable)
        .where(and(
          isNull(tasksTable.deletedAt),
          eq(tasksTable.reciterId, reciterId),
          eq(tasksTable.platformId, item.platformId),
          eq(tasksTable.pageId, item.pageId),
          sql`${tasksTable.dueDate}::date = ${dueDateKey}::date`,
        ));
      const duplicate = duplicateRows.find((task) => titleMatches(task.title, generatedTitle));
      if (duplicate) {
        skipped.push({
          platformId: item.platformId,
          platformName: item.platformName,
          pageId: item.pageId,
          pageName: item.pageName,
          dueDate: dueDateKey,
          reason: "duplicate_same_day",
          existingTaskId: duplicate.id,
        });
        continue;
      }

      const [task] = await db.insert(tasksTable).values({
        source: "admin_created",
        generationBatchId: batch.id,
        title: generatedTitle,
        description: sourceTask!.description,
        platformId: item.platformId,
        memberId: item.memberIds[0],
        reciterId,
        status: "pending",
        priority: sourceTask!.priority ?? "normal",
        progress: 0,
        startDate: dueDate,
        endDate: dueDate,
        dueDate,
        completedAt: null,
        recurrence: "none",
        recurrenceIntervalDays: null,
        recurrenceDurationDays: null,
        recurrenceDays: null,
        weeklyQuotaRequired: null,
        weeklyQuotaPeriodStart: null,
        weeklyQuotaPeriodEnd: null,
        submissionUrl: null,
        pageId: item.pageId,
        deletedAt: null,
      }).returning();

      await db.insert(taskMembersTable).values(item.memberIds.map((memberId) => ({ taskId: task.id, memberId })));
      created.push({ taskId: task.id, platformId: item.platformId, platformName: item.platformName, pageId: item.pageId, pageName: item.pageName, dueDate: dueDateKey, memberIds: item.memberIds });
      await notifyAssigned(task.id, task.title, item.memberIds);
    }
  }

  const createdByPlatform = created.reduce<Record<string, number>>((acc, item) => {
    acc[item.platformName] = (acc[item.platformName] ?? 0) + 1;
    return acc;
  }, {});
  const skippedByReason = skipped.reduce<Record<string, number>>((acc, item) => {
    acc[item.reason] = (acc[item.reason] ?? 0) + 1;
    return acc;
  }, {});

  return {
    batchId: batch.id,
    sourceTaskId: sourceTask!.id,
    created,
    skipped,
    summary: {
      createdCount: created.length,
      skippedCount: skipped.length,
      createdByPlatform,
      skippedByReason,
      firstDate: created[0]?.dueDate ?? null,
      lastDate: created[created.length - 1]?.dueDate ?? null,
    },
  };
}

router.get("/task-generation/source-tasks", async (_req, res) => {
  try {
    res.json(await listSourceTasks());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "source_tasks_failed" });
  }
});

router.post("/task-generation/preview", async (req, res) => {
  const input = parseGenerationInput(req.body);
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  try {
    const preview = await buildPreview(input);
    res.json(preview);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "preview_failed" });
  }
});

router.post("/task-generation/commit", async (req, res) => {
  const input = parseGenerationInput(req.body);
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  try {
    const user = (req as any).currentUser;
    const result = await createGeneration(input, typeof user?.id === "number" ? user.id : null);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "commit_failed" });
  }
});

export default router;
