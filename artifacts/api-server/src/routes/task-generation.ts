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
  enabled?: boolean;
};

type GenerationInput = {
  title: string;
  reciterId: number;
  startDate: Date;
  endDate: Date;
  note: string | null;
  targets: GenerationTargetInput[];
};

type GenerationItem = {
  platformId: number;
  platformName: string;
  pageId: number;
  pageName: string;
  memberIds: number[];
  memberNames: string[];
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
    .replace(/[()（）\[\]{}]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function isSourcePlatformName(name: string | null | undefined) {
  const normalized = normalizeText(name);
  return normalized.includes("تطبيق") && normalized.includes("تلاوات") && normalized.includes("الحرمين");
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

function dateKey(date: Date) {
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

function parseGenerationInput(body: unknown): GenerationInput | { error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const reciterId = Number(input.reciterId);
  const startDate = parseDateOnly(input.startDate);
  const endDate = parseDateOnly(input.endDate);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  if (title.length < 2 || title.length > 300) return { error: "title_required" };
  if (!Number.isInteger(reciterId) || reciterId <= 0) return { error: "invalid_reciter" };
  if (!startDate || !endDate || endDate < startDate) return { error: "invalid_date_range" };
  if (!Array.isArray(input.targets)) return { error: "targets_required" };

  const targets = input.targets
    .map((target) => target as Record<string, unknown>)
    .filter((target) => target.enabled !== false)
    .map((target) => ({
      platformId: Number(target.platformId),
      pageId: Number(target.pageId),
      memberIds: Array.isArray(target.memberIds)
        ? [...new Set(target.memberIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
        : [],
      enabled: true,
    }))
    .filter((target) => Number.isInteger(target.platformId) && target.platformId > 0);

  if (targets.length === 0) return { error: "targets_required" };
  return { title, reciterId, startDate, endDate, note, targets };
}

async function sourcePlatform() {
  const platforms = await db.select().from(platformsTable);
  return platforms.find((platform) => isSourcePlatformName(platform.name)) ?? null;
}

async function buildPreview(input: GenerationInput) {
  const source = await sourcePlatform();
  if (!source) throw new Error("source_platform_not_found");

  const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, input.reciterId)).limit(1);
  if (!reciter) throw new Error("reciter_not_found");

  const dates = getDateRange(input.startDate, input.endDate);
  const requestedPageIds = [...new Set(input.targets.map((target) => target.pageId).filter((id) => Number.isInteger(id) && id > 0))];
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
    if (!page || page.platformId !== target.platformId) {
      warnings.push("missing_page");
    }
    if (page?.pageReciterId && page.pageReciterId !== input.reciterId) {
      warnings.push("page_reciter_mismatch");
    }
    const allowed = allowedMembersByPage.get(target.pageId) ?? new Set<number>();
    const memberIds = target.memberIds.filter((memberId) => allowed.has(memberId));
    if (memberIds.length === 0) warnings.push("missing_assignee");
    if (target.memberIds.length > 0 && memberIds.length !== target.memberIds.length) warnings.push("invalid_assignee");
    items.push({
      platformId: target.platformId,
      platformName: page?.platformName ?? "غير معروف",
      pageId: target.pageId,
      pageName: page?.pageName ?? "غير محددة",
      memberIds,
      memberNames: memberIds.map((memberId) => memberNameById.get(memberId) ?? `#${memberId}`),
      daysCount: dates.length,
      expectedTasks: warnings.length === 0 ? dates.length : 0,
      warnings,
    });
  }

  const readyItems = items.filter((item) => item.warnings.length === 0);
  return {
    sourcePlatform: { id: source.id, name: source.name },
    reciter: { id: reciter.id, name: reciter.name },
    startDate: dateKey(input.startDate),
    endDate: dateKey(input.endDate),
    daysCount: dates.length,
    platformsCount: readyItems.length,
    totalExpected: readyItems.length * dates.length,
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

async function createGeneration(input: GenerationInput, currentUserId: number | null) {
  const preview = await buildPreview(input);
  if (preview.totalExpected <= 0) throw new Error("no_ready_items");
  const dates = getDateRange(input.startDate, input.endDate);
  const created: Array<{ taskId: number; platformId: number; platformName: string; pageId: number; pageName: string; dueDate: string }> = [];
  const skipped: SkippedItem[] = [];

  const [batch] = await db.insert(taskGenerationBatchesTable).values({
    createdByUserId: currentUserId,
    title: input.title,
    sourcePlatformId: preview.sourcePlatform.id,
    reciterId: input.reciterId,
    startDate: input.startDate,
    endDate: input.endDate,
    note: input.note,
  }).returning();

  for (const item of preview.items) {
    if (item.warnings.includes("missing_page")) {
      skipped.push({ platformId: item.platformId, platformName: item.platformName, pageId: item.pageId, pageName: item.pageName, reason: "missing_page" });
      continue;
    }
    if (item.warnings.includes("missing_assignee") || item.warnings.includes("invalid_assignee")) {
      skipped.push({ platformId: item.platformId, platformName: item.platformName, pageId: item.pageId, pageName: item.pageName, reason: "missing_assignee" });
      continue;
    }
    if (item.warnings.includes("page_reciter_mismatch")) {
      skipped.push({ platformId: item.platformId, platformName: item.platformName, pageId: item.pageId, pageName: item.pageName, reason: "missing_page" });
      continue;
    }

    for (const dueDate of dates) {
      const dueDateKey = dateKey(dueDate);
      const duplicateRows = await db
        .select({ id: tasksTable.id, title: tasksTable.title })
        .from(tasksTable)
        .where(and(
          isNull(tasksTable.deletedAt),
          eq(tasksTable.reciterId, input.reciterId),
          eq(tasksTable.platformId, item.platformId),
          eq(tasksTable.pageId, item.pageId),
          sql`${tasksTable.dueDate}::date = ${dueDateKey}::date`,
        ));
      const duplicate = duplicateRows.find((task) => titleMatches(task.title, input.title));
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
        title: input.title,
        description: input.note,
        platformId: item.platformId,
        memberId: item.memberIds[0],
        reciterId: input.reciterId,
        status: "pending",
        priority: "normal",
        progress: 0,
        startDate: dueDate,
        endDate: dueDate,
        dueDate,
        recurrence: "none",
        recurrenceIntervalDays: null,
        recurrenceDurationDays: null,
        recurrenceDays: null,
        weeklyQuotaRequired: null,
        weeklyQuotaPeriodStart: null,
        weeklyQuotaPeriodEnd: null,
        pageId: item.pageId,
      }).returning();

      await db.insert(taskMembersTable).values(item.memberIds.map((memberId) => ({ taskId: task.id, memberId })));
      created.push({ taskId: task.id, platformId: item.platformId, platformName: item.platformName, pageId: item.pageId, pageName: item.pageName, dueDate: dueDateKey });
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
    created,
    skipped,
    summary: {
      createdCount: created.length,
      skippedCount: skipped.length,
      createdByPlatform,
      skippedByReason,
    },
  };
}

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
