import { Router } from "express";
import { db, tasksTable, membersTable, platformsTable, taskMembersTable, recitersTable, notificationsTable, activityLogTable, usersTable, taskSeriesTable, taskProofsTable, platformPagesTable, pageMembersTable, taskDependenciesTable, reciterTaskFlowRuleAssigneesTable, reciterTaskFlowRulesTable, taskFlowLinksTable, taskCreationGroupsTable } from "@workspace/db";
import { eq, and, inArray, isNull, isNotNull, ilike, or, sql } from "drizzle-orm";
import {
  CreateTaskBody,
  UpdateTaskBody,
  GetTaskParams,
  DeleteTaskParams,
  UpdateTaskParams,
  ListTasksQueryParams,
} from "@workspace/api-zod";
import { generateUpcomingTasksForSeries, syncActiveSeries } from "../services/task-engine";
import { notifyTelegramTaskAssigned, notifyTelegramTaskCompleted, notifyTelegramTaskDependencyReady } from "../services/telegram-notification-engine";
import { canCreateTask, canDeleteTask, canEditTask, canViewTask } from "../lib/permissions";
import { ensureTaskQuotaSchema } from "../services/task-quota-schema";
import { ensureTaskDependenciesSchema } from "../services/task-dependencies-schema";
import { ensureTaskFlowLinksSchema } from "../services/task-flow-links-schema";
import { ensureTaskCreationGroupsSchema } from "../services/task-creation-groups-schema";

const router = Router();

router.use(async (_req, _res, next) => {
  try {
    await ensureTaskQuotaSchema();
    await ensureTaskDependenciesSchema();
    await ensureTaskFlowLinksSchema();
    await ensureTaskCreationGroupsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

// Helper: fetch all members for a set of task IDs
async function fetchTaskMembersMap(taskIds: number[]): Promise<Map<number, { id: number; name: string; role: string; createdAt: Date; isActive: boolean; phone: string | null; avatarUrl: string | null; lastLoginAt: Date | null }[]>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({
      taskId: taskMembersTable.taskId,
      id: membersTable.id,
      name: membersTable.name,
      role: membersTable.role,
      createdAt: membersTable.createdAt,
      isActive: membersTable.isActive,
      phone: membersTable.phone,
      avatarUrl: membersTable.avatarUrl,
      lastLoginAt: membersTable.lastLoginAt,
    })
    .from(taskMembersTable)
    .innerJoin(membersTable, eq(taskMembersTable.memberId, membersTable.id))
    .where(inArray(taskMembersTable.taskId, taskIds));

  const map = new Map<number, { id: number; name: string; role: string; createdAt: Date; isActive: boolean; phone: string | null; avatarUrl: string | null; lastLoginAt: Date | null }[]>();
  for (const row of rows) {
    const { taskId, ...member } = row;
    if (!map.has(taskId)) map.set(taskId, []);
    map.get(taskId)!.push(member);
  }
  return map;
}

// Helper: sync task_members for a task
async function syncTaskMembers(taskId: number, memberIds: number[]) {
  await syncTaskMembersUsing(db, taskId, memberIds);
}

async function syncTaskMembersUsing(client: any, taskId: number, memberIds: number[]) {
  await client.delete(taskMembersTable).where(eq(taskMembersTable.taskId, taskId));
  if (memberIds.length > 0) {
    await client.insert(taskMembersTable).values(
      memberIds.map((memberId) => ({ taskId, memberId }))
    );
  }
}

// Helper: compute next due date for recurrence
function nextDueDate(currentDue: Date | null, recurrence: string, intervalDays?: number | null, recurrenceDays?: string | null): Date {
  const base = currentDue ?? new Date();
  const next = new Date(base);
  if (intervalDays && intervalDays > 0) {
    next.setDate(next.getDate() + intervalDays);
  } else if (recurrence === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === "weekly") {
    next.setDate(next.getDate() + 7);
  } else if (recurrence === "monthly") {
    next.setMonth(next.getMonth() + 1);
  } else if (recurrence === "custom_days" && recurrenceDays) {
    const days = recurrenceDays.split(",").map(Number).filter((d) => !isNaN(d));
    if (days.length > 0) {
      const candidate = new Date(base);
      candidate.setDate(candidate.getDate() + 1);
      for (let i = 0; i < 7; i++) {
        if (days.includes(candidate.getDay())) return candidate;
        candidate.setDate(candidate.getDate() + 1);
      }
    }
  }
  return next;
}

// Helper: spawn a new recurring task after one is completed
async function spawnRecurringTask(completedTask: {
  id: number;
  title: string;
  description: string | null;
  platformId: number;
  memberId: number;
  reciterId: number | null;
  recurrence: string;
  dueDate: Date | null;
  endDate?: Date | null;
  pageId?: number | null;
  recurrenceIntervalDays?: number | null;
  recurrenceDurationDays?: number | null;
  recurrenceDays?: string | null;
  priority?: string;
}, memberIds: number[]) {
  if (completedTask.recurrence === "none" && !completedTask.recurrenceIntervalDays) return;

  const due = nextDueDate(completedTask.dueDate, completedTask.recurrence, completedTask.recurrenceIntervalDays, completedTask.recurrenceDays);

  const [newTask] = await db.insert(tasksTable).values({
    title: completedTask.title,
    description: completedTask.description ?? undefined,
    platformId: completedTask.platformId,
    memberId: completedTask.memberId,
    reciterId: completedTask.reciterId,
    status: "pending",
    priority: (completedTask.priority ?? "normal") as "urgent" | "normal" | "low",
    dueDate: due,
    endDate: completedTask.endDate ?? null,
    recurrence: completedTask.recurrence as "none" | "weekly" | "monthly" | "daily" | "custom_days",
    recurrenceIntervalDays: completedTask.recurrenceIntervalDays,
    recurrenceDurationDays: completedTask.recurrenceDurationDays,
    recurrenceDays: completedTask.recurrenceDays ?? null,
    lastRecurredAt: new Date(),
    pageId: completedTask.pageId,
  }).returning();

  await syncTaskMembers(newTask.id, memberIds);

  await db.update(tasksTable)
    .set({ lastRecurredAt: new Date() })
    .where(eq(tasksTable.id, completedTask.id));
}

// Helper: log an activity
async function logActivity(req: any, action: string, entityType: string | null, entityId: number | null, entityName: string | null, meta?: Record<string, unknown>) {
  const user = req.currentUser;
  if (!user) return;
  await db.insert(activityLogTable).values({
    userId: user.id,
    userName: user.displayName ?? user.username,
    action,
    entityType,
    entityId,
    entityName,
    meta: meta ?? null,
  });
}

// Helper: notify assigned members on task creation
async function notifyTaskAssigned(taskId: number, taskTitle: string, memberIds: number[]) {
  // Find users linked to these members
  const users = await db
    .select({ id: usersTable.id, memberId: usersTable.memberId })
    .from(usersTable)
    .where(and(
      inArray(usersTable.memberId as any, memberIds),
      eq(usersTable.isApproved, true)
    ));

  if (users.length === 0) return;
  await db.insert(notificationsTable).values(
    users.map((u) => ({
      userId: u.id,
      type: "task_assigned",
      title: "تم إسناد مهمة جديدة لك",
      body: taskTitle,
      taskId,
      isRead: false,
    }))
  );

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

  await Promise.all(
    memberIds.map((memberId) =>
      notifyTelegramTaskAssigned({
        id: task.id,
        title: task.title || taskTitle,
        memberId,
        dueDate: task.dueDate ?? null,
        reciterName: task.reciterName ?? null,
        platformName: task.platformName ?? null,
      }).catch(() => {})
    )
  );
}

async function notifyTaskAssignedAfterReciterChange(input: {
  taskId: number;
  taskTitle: string;
  memberId: number;
  reciterName: string;
  platformName: string;
  dueDate: Date | null;
}) {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.memberId, input.memberId),
      eq(usersTable.isApproved, true),
    ));

  if (users.length === 0) return;

  const body = [
    `المهمة: ${input.taskTitle}`,
    `القارئ: ${input.reciterName}`,
    `المنصة: ${input.platformName}`,
    input.dueDate ? `التاريخ: ${input.dueDate.toISOString()}` : null,
    `فتح المهمة: /tasks/${input.taskId}`,
  ].filter(Boolean).join("\n");

  await db.insert(notificationsTable).values(
    users.map((u) => ({
      userId: u.id,
      type: "task_assigned",
      title: "تم إسناد مهمة إليك",
      body,
      taskId: input.taskId,
      isRead: false,
    }))
  );
}

// Helper: notify admins on task completion
async function notifyTaskCompleted(task: {
  id: number;
  title: string;
  memberId: number;
  submissionUrl?: string | null;
  completedAt?: Date | null;
}) {
  const admins = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.role, "admin"), eq(usersTable.isApproved, true)));

  if (admins.length === 0) return;

  const [member] = await db.select({ name: membersTable.name }).from(membersTable).where(eq(membersTable.id, task.memberId));
  const existingNotifications = await db
    .select({ userId: notificationsTable.userId })
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.type, "task_completed"),
      eq(notificationsTable.taskId, task.id),
      inArray(notificationsTable.userId, admins.map((admin) => admin.id)),
    ));
  const notifiedAdminIds = new Set(existingNotifications.map((notification) => notification.userId));
  const completedAt = task.completedAt ?? new Date();
  const body = [
    `العضو: ${member?.name ?? "غير معروف"}`,
    `المهمة: ${task.title}`,
    `وقت الإكمال: ${completedAt.toISOString()}`,
    task.submissionUrl ? `الشاهد: ${task.submissionUrl}` : null,
    `فتح المهمة: /tasks/${task.id}`,
  ].filter(Boolean).join("\n");
  const pendingAdmins = admins.filter((admin) => !notifiedAdminIds.has(admin.id));

  if (pendingAdmins.length === 0) return;

  await db.insert(notificationsTable).values(
    pendingAdmins.map((admin) => ({
      userId: admin.id,
      type: "task_completed",
      title: `تم إكمال مهمة: ${task.title}`,
      body,
      taskId: task.id,
      isRead: false,
    }))
  );
}

// Helper: notify assigned members on task update  
async function notifyTaskUpdated(taskId: number, taskTitle: string, memberIds: number[]) {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      inArray(usersTable.memberId as any, memberIds),
      eq(usersTable.isApproved, true)
    ));

  if (users.length === 0) return;
  await db.insert(notificationsTable).values(
    users.map((u) => ({
      userId: u.id,
      type: "task_updated",
      title: "تم تعديل مهمة خاصة بك",
      body: taskTitle,
      taskId,
      isRead: false,
    }))
  );
}

const TASK_SELECT = {
  id: tasksTable.id,
  seriesId: tasksTable.seriesId,
  creationGroupId: tasksTable.creationGroupId,
  source: tasksTable.source,
  title: tasksTable.title,
  description: tasksTable.description,
  status: tasksTable.status,
  priority: tasksTable.priority,
  progress: tasksTable.progress,
  startDate: tasksTable.startDate,
  endDate: tasksTable.endDate,
  dueDate: tasksTable.dueDate,
  completedAt: tasksTable.completedAt,
  recurrence: tasksTable.recurrence,
  recurrenceIntervalDays: tasksTable.recurrenceIntervalDays,
  recurrenceDurationDays: tasksTable.recurrenceDurationDays,
  recurrenceDays: tasksTable.recurrenceDays,
  weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
  weeklyQuotaPeriodStart: tasksTable.weeklyQuotaPeriodStart,
  weeklyQuotaPeriodEnd: tasksTable.weeklyQuotaPeriodEnd,
  lastRecurredAt: tasksTable.lastRecurredAt,
  submissionUrl: tasksTable.submissionUrl,
  assigneeNote: tasksTable.assigneeNote,
  pageId: tasksTable.pageId,
  deletedAt: tasksTable.deletedAt,
  createdAt: tasksTable.createdAt,
  platform: {
    id: platformsTable.id,
    name: platformsTable.name,
    icon: platformsTable.icon,
    color: platformsTable.color,
    isMain: platformsTable.isMain,
  },
  member: {
    id: membersTable.id,
    name: membersTable.name,
    role: membersTable.role,
    createdAt: membersTable.createdAt,
    isActive: membersTable.isActive,
    phone: membersTable.phone,
    avatarUrl: membersTable.avatarUrl,
    lastLoginAt: membersTable.lastLoginAt,
  },
};

type SeriesType = "temporary" | "operational";
type SeriesRecurrenceType = "none" | "weekly" | "monthly";
type TaskUpdateScope = "single" | "future" | "series" | "group";
type FlowChangeAction = "delete_safe_children" | "delete_safe_and_regenerate" | "keep_children";

const STATE_UPDATE_KEYS = new Set(["status", "completedAt", "progress", "submissionUrl"]);
const DATE_UPDATE_KEYS = new Set(["startDate", "endDate", "dueDate"]);

function parseSeriesType(value: unknown): SeriesType {
  if (value === undefined || value === null) return "temporary";
  if (value === "temporary" || value === "operational") return value;
  throw new Error("INVALID_SERIES_TYPE");
}

function parseSeriesRecurrenceType(value: unknown): SeriesRecurrenceType {
  if (value === undefined || value === null || value === "") return "none";
  if (value === "none" || value === "weekly" || value === "monthly") return value;
  throw new Error("INVALID_RECURRENCE_TYPE");
}

function parseTaskUpdateScope(value: unknown, hasSeries: boolean): TaskUpdateScope {
  if (value === undefined || value === null || value === "") {
    return hasSeries ? "series" : "single";
  }
  if (value === "single" || value === "future" || value === "series" || value === "group") return value;
  throw new Error("INVALID_TASK_UPDATE_SCOPE");
}

function normalizeRecurrenceDays(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("INVALID_RECURRENCE_DAYS");

  const rawDays = value.split(",").map((day) => day.trim()).filter(Boolean);
  if (rawDays.length === 0) return null;

  const days = [...new Set(rawDays.map((day) => Number(day)))];
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("INVALID_RECURRENCE_DAYS");
  }

  return days.sort((a, b) => a - b).join(",");
}

function normalizeDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function taskDateKey(value: unknown) {
  const date = normalizeDate(value);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

function normalizeComparableTitle(value: unknown) {
  return String(value ?? "")
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function taskFlowTitleMatches(a: string, b: string) {
  const left = normalizeComparableTitle(a);
  const right = normalizeComparableTitle(b);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function buildFlowChildTitle(parentTitle: string | null | undefined, sourcePlatformName: string | null | undefined, targetPlatformName: string, reciterName: string) {
  const title = String(parentTitle ?? "").trim();
  if (title) {
    if (sourcePlatformName && title.includes(sourcePlatformName)) {
      return title.replace(sourcePlatformName, targetPlatformName);
    }

    const titleParts = title.split(/\s+—\s+/).map((part) => part.trim()).filter(Boolean);
    if (titleParts.length >= 2) {
      return [...titleParts.slice(0, -1), targetPlatformName].join(" — ");
    }
  }

  return [targetPlatformName, reciterName].filter(Boolean).join(" — ");
}

function isApplicationPlatformName(name?: string | null) {
  if (!name) return false;
  const normalized = name.trim().toLowerCase();
  return (
    /تطبيق/.test(normalized) ||
    /app|application/i.test(normalized) ||
    (/تلاوات/.test(normalized) && /الحرمين/.test(normalized))
  );
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getWeekRange(date: Date) {
  const start = normalizeDate(date)!;
  start.setDate(start.getDate() - start.getDay());
  const end = addDays(start, 6);
  return { start, end };
}

function parseWeeklyQuotaRequired(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const quota = Number(value);
  if (!Number.isInteger(quota) || quota < 1 || quota > 50) {
    throw new Error("INVALID_WEEKLY_QUOTA");
  }
  return quota;
}

function validateMemberTaskUpdate(reqBody: Record<string, unknown>, user: any, currentTask: any): string | null {
  if (user?.role === "admin") return null;
  if (!user?.memberId) return "Forbidden";

  const allowedAdminCreatedKeys = new Set(["status", "progress", "submissionUrl"]);
  if (currentTask.source !== "member_created") {
    const requestedKeys = Object.keys(reqBody).filter((key) => key !== "updateScope");
    return requestedKeys.every((key) => allowedAdminCreatedKeys.has(key))
      ? null
      : "Members cannot edit admin-created task details";
  }

  if (currentTask.seriesId) return "Members cannot edit series tasks";

  if ("memberIds" in reqBody) {
    const memberIds = Array.isArray(reqBody.memberIds) ? reqBody.memberIds.map((id) => Number(id)) : [];
    if (memberIds.length !== 1 || memberIds[0] !== user.memberId) {
      return "Members can only assign self-created tasks to themselves";
    }
  }

  const seriesType = reqBody.seriesType;
  const recurrence = reqBody.recurrence ?? reqBody.recurrenceType;
  if (seriesType !== undefined && seriesType !== null && seriesType !== "" && seriesType !== "temporary") {
    return "Members cannot create or edit task series";
  }
  if (recurrence !== undefined && recurrence !== null && recurrence !== "" && recurrence !== "none") {
    return "Members cannot create recurring tasks";
  }

  const forbiddenKeys = [
    "dependsOnTaskId",
    "weeklyQuotaRequired",
    "recurrenceIntervalDays",
    "recurrenceDurationDays",
    "recurrenceDays",
  ];
  for (const key of forbiddenKeys) {
    const value = reqBody[key];
    if (value !== undefined && value !== null && value !== "" && value !== false) {
      return "Members can only edit simple self-created tasks";
    }
  }

  if (reqBody.endDate !== undefined && reqBody.endDate !== null && reqBody.endDate !== "") {
    return "Members cannot create date ranges";
  }

  return null;
}

function daysBetweenDates(from: Date, to: Date) {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((normalizeDate(to)!.getTime() - normalizeDate(from)!.getTime()) / dayMs);
}

function getSeriesDateDelta(body: Record<string, unknown>, currentTask: { startDate?: Date | null; dueDate?: Date | null }) {
  const incomingDate = "dueDate" in body
    ? normalizeDate(body.dueDate)
    : "startDate" in body
      ? normalizeDate(body.startDate)
      : null;
  const currentDate = normalizeDate(currentTask.dueDate ?? currentTask.startDate);
  if (!incomingDate || !currentDate) return 0;
  return daysBetweenDates(currentDate, incomingDate);
}

function splitUpdateData(updateData: Record<string, unknown>) {
  const sharedUpdateData: Record<string, unknown> = {};
  const selectedTaskOnlyUpdateData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(updateData)) {
    if (STATE_UPDATE_KEYS.has(key)) {
      selectedTaskOnlyUpdateData[key] = value;
      continue;
    }
    if (DATE_UPDATE_KEYS.has(key)) continue;
    sharedUpdateData[key] = value;
  }

  return { sharedUpdateData, selectedTaskOnlyUpdateData };
}

function getDateRange(startDate: Date, endDate: Date): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function getTaskFlowDateRange(parent: { startDate: Date | null; endDate: Date | null; dueDate: Date | null }) {
  const singleDate = normalizeDate(parent.dueDate ?? parent.startDate);
  const startDate = normalizeDate(parent.startDate);
  const endDate = normalizeDate(parent.endDate);
  if (startDate && endDate && endDate.getTime() >= startDate.getTime()) {
    return getDateRange(startDate, endDate);
  }
  return singleDate ? [singleDate] : [];
}

function buildTaskFlowSummary(dates: Date[], enabledPagesCount: number) {
  const sortedDates = [...dates].sort((a, b) => a.getTime() - b.getTime());
  return {
    firstDate: sortedDates[0] ? taskDateKey(sortedDates[0]) : null,
    lastDate: sortedDates[sortedDates.length - 1] ? taskDateKey(sortedDates[sortedDates.length - 1]) : null,
    daysCount: sortedDates.length,
    enabledPagesCount,
    expectedTasks: sortedDates.length * enabledPagesCount,
  };
}

async function validateMemberIds(memberIds: unknown): Promise<number[]> {
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new Error("INVALID_MEMBER_IDS");
  }
  const uniqueIds = [...new Set(memberIds.map((id) => Number(id)))];
  if (uniqueIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("INVALID_MEMBER_IDS");
  }
  const existingMembers = await db
    .select({ id: membersTable.id })
    .from(membersTable)
    .where(inArray(membersTable.id, uniqueIds));
  if (existingMembers.length !== uniqueIds.length) {
    throw new Error("INVALID_MEMBER_IDS");
  }
  return uniqueIds;
}

type PlatformAssignment = {
  platformId: number;
  pageId: number | null;
  memberIds: number[];
  platformName: string;
  assigneeNote: string | null;
};

function parsePlatformAssignmentInputs(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = item as Record<string, unknown>;
    const platformId = Number(row.platformId);
    const pageId = row.pageId === undefined || row.pageId === null || row.pageId === "" ? null : Number(row.pageId);
    const memberIdsRaw = Array.isArray(row.assigneeIds) ? row.assigneeIds : Array.isArray(row.memberIds) ? row.memberIds : [];
    const memberIds = [...new Set(memberIdsRaw.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    const noteRaw = typeof row.assigneeNote === "string" ? row.assigneeNote.trim() : "";
    const assigneeNote = noteRaw.length > 0 ? noteRaw : null;
    return { platformId, pageId, memberIds, assigneeNote };
  }).filter((row) => Number.isInteger(row.platformId) && row.platformId > 0);
}

async function validatePlatformAssignments(raw: unknown, currentUser: any): Promise<PlatformAssignment[]> {
  const inputs = parsePlatformAssignmentInputs(raw);
  if (inputs.length === 0) return [];
  const platformIds = [...new Set(inputs.map((item) => item.platformId))];
  const pageIds = [...new Set(inputs.map((item) => item.pageId).filter((id): id is number => id !== null && Number.isInteger(id) && id > 0))];

  const platforms = await db
    .select({ id: platformsTable.id, name: platformsTable.name })
    .from(platformsTable)
    .where(inArray(platformsTable.id, platformIds));
  const platformById = new Map(platforms.map((platform) => [platform.id, platform]));
  if (platformById.size !== platformIds.length) throw new Error("INVALID_PLATFORM_ASSIGNMENTS");

  const pages = pageIds.length > 0
    ? await db
      .select({ id: platformPagesTable.id, platformId: platformPagesTable.platformId })
      .from(platformPagesTable)
      .where(inArray(platformPagesTable.id, pageIds))
    : [];
  const pageById = new Map(pages.map((page) => [page.id, page]));

  const assignments: PlatformAssignment[] = [];
  for (const input of inputs) {
    if (input.memberIds.length === 0) throw new Error("INVALID_PLATFORM_ASSIGNMENTS");
    const memberIds = await validateMemberIds(input.memberIds);
    if (!canCreateTask(currentUser, memberIds)) throw new Error("FORBIDDEN_PLATFORM_ASSIGNMENTS");
    if (input.pageId !== null) {
      const page = pageById.get(input.pageId);
      if (!page || page.platformId !== input.platformId) throw new Error("INVALID_PLATFORM_ASSIGNMENTS");
    }
    assignments.push({
      platformId: input.platformId,
      pageId: input.pageId,
      memberIds,
      platformName: platformById.get(input.platformId)?.name ?? `#${input.platformId}`,
      assigneeNote: input.assigneeNote,
    });
  }
  return assignments;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

async function flowChildRows(parentTaskId: number) {
  const result = await db.execute(sql`
    SELECT
      l.child_task_id AS "childTaskId",
      t.status AS "status",
      t.completed_at AS "completedAt",
      t.submission_url AS "submissionUrl",
      t.deleted_at AS "deletedAt",
      count(p.id)::int AS "proofCount"
    FROM task_flow_links l
    INNER JOIN tasks t ON t.id = l.child_task_id
    LEFT JOIN task_proofs p ON p.task_id = t.id AND p.deleted_at IS NULL
    WHERE l.parent_task_id = ${parentTaskId}
    GROUP BY l.child_task_id, t.status, t.completed_at, t.submission_url, t.deleted_at
  `);

  return rowsFromExecute<{
    childTaskId: number;
    status: string | null;
    completedAt: Date | string | null;
    submissionUrl: string | null;
    deletedAt: Date | string | null;
    proofCount: number;
  }>(result);
}

function isSafeFlowChild(row: Awaited<ReturnType<typeof flowChildRows>>[number]) {
  return (
    !row.deletedAt &&
    row.status !== "completed" &&
    !row.completedAt &&
    !row.submissionUrl &&
    Number(row.proofCount ?? 0) === 0
  );
}

async function findExistingFlowLink(parentTaskId: number, targetPageId: number, flowDate: Date) {
  const [existingLink] = await db
    .select({
      id: taskFlowLinksTable.id,
      childTaskId: taskFlowLinksTable.childTaskId,
      childDeletedAt: tasksTable.deletedAt,
    })
    .from(taskFlowLinksTable)
    .leftJoin(tasksTable, eq(taskFlowLinksTable.childTaskId, tasksTable.id))
    .where(and(
      eq(taskFlowLinksTable.parentTaskId, parentTaskId),
      eq(taskFlowLinksTable.targetPageId, targetPageId),
      eq(taskFlowLinksTable.flowDate, flowDate),
    ))
    .limit(1);
  return existingLink ?? null;
}

async function buildFlowChangeImpact(parentTaskId: number, newReciterId: number) {
  const [parent] = await db
    .select({
      id: tasksTable.id,
      platformId: tasksTable.platformId,
      platformName: platformsTable.name,
      reciterId: tasksTable.reciterId,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .where(and(eq(tasksTable.id, parentTaskId), isNull(tasksTable.deletedAt)))
    .limit(1);

  if (!parent || !isApplicationPlatformName(parent.platformName)) {
    return null;
  }

  const children = await flowChildRows(parentTaskId);
  const safeChildren = children.filter(isSafeFlowChild);
  const protectedChildren = children.filter((child) => !isSafeFlowChild(child));

  const rules = await db
    .select({
      ruleId: reciterTaskFlowRulesTable.id,
      pageId: reciterTaskFlowRulesTable.pageId,
      enabled: reciterTaskFlowRulesTable.enabled,
      platformId: platformPagesTable.platformId,
      pageName: platformPagesTable.name,
      platformName: platformsTable.name,
    })
    .from(reciterTaskFlowRulesTable)
    .innerJoin(platformPagesTable, eq(reciterTaskFlowRulesTable.pageId, platformPagesTable.id))
    .innerJoin(platformsTable, eq(platformPagesTable.platformId, platformsTable.id))
    .where(eq(reciterTaskFlowRulesTable.reciterId, newReciterId));
  const enabledRules = rules.filter((rule) => rule.enabled && rule.platformId !== parent.platformId);
  const ruleIds = enabledRules.map((rule) => rule.ruleId);
  const assigneeRows = ruleIds.length > 0
    ? await db
      .select({
        ruleId: reciterTaskFlowRuleAssigneesTable.ruleId,
        memberId: reciterTaskFlowRuleAssigneesTable.memberId,
      })
      .from(reciterTaskFlowRuleAssigneesTable)
      .where(inArray(reciterTaskFlowRuleAssigneesTable.ruleId, ruleIds))
    : [];
  const assigneeRuleIds = new Set(assigneeRows.map((row) => row.ruleId));
  const pagesWithoutAssignees = enabledRules
    .filter((rule) => !assigneeRuleIds.has(rule.ruleId))
    .map((rule) => ({
      pageId: rule.pageId,
      pageName: rule.pageName,
      platformName: rule.platformName,
    }));

  return {
    parentTaskId,
    currentReciterId: parent.reciterId,
    newReciterId,
    totalChildren: children.length,
    deletableChildren: safeChildren.length,
    protectedChildren: protectedChildren.length,
    deletableChildIds: safeChildren.map((child) => Number(child.childTaskId)),
    protectedChildIds: protectedChildren.map((child) => Number(child.childTaskId)),
    newReciterRulesConfigured: rules.length > 0,
    enabledPagesCount: enabledRules.length,
    pagesWithoutAssignees,
    pagesWithoutAssigneesCount: pagesWithoutAssignees.length,
  };
}

async function createFlowChildrenFromDefaultRules(parentTaskId: number, currentUser: any, req: any) {
  const [parent] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      description: tasksTable.description,
      platformId: tasksTable.platformId,
      platformName: platformsTable.name,
      reciterId: tasksTable.reciterId,
      reciterName: recitersTable.name,
      priority: tasksTable.priority,
      startDate: tasksTable.startDate,
      endDate: tasksTable.endDate,
      dueDate: tasksTable.dueDate,
      pageId: tasksTable.pageId,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(and(eq(tasksTable.id, parentTaskId), isNull(tasksTable.deletedAt)))
    .limit(1);

  if (!parent?.reciterId || !parent.reciterName || !isApplicationPlatformName(parent.platformName)) {
    return { created: [], skipped: [{ reason: "invalid_parent" }] };
  }
  const flowDates = getTaskFlowDateRange(parent);
  if (flowDates.length === 0) return { created: [], skipped: [{ reason: "invalid_date" }] };

  const rules = await db
    .select({
      ruleId: reciterTaskFlowRulesTable.id,
      pageId: reciterTaskFlowRulesTable.pageId,
      enabled: reciterTaskFlowRulesTable.enabled,
      pageName: platformPagesTable.name,
      pageReciterId: platformPagesTable.reciterId,
      platformId: platformPagesTable.platformId,
      platformName: platformsTable.name,
    })
    .from(reciterTaskFlowRulesTable)
    .innerJoin(platformPagesTable, eq(reciterTaskFlowRulesTable.pageId, platformPagesTable.id))
    .innerJoin(platformsTable, eq(platformPagesTable.platformId, platformsTable.id))
    .where(eq(reciterTaskFlowRulesTable.reciterId, parent.reciterId));
  const enabledRules = rules.filter((rule) => rule.enabled && rule.platformId !== parent.platformId);
  if (rules.length === 0) return { created: [], skipped: [{ reason: "rules_not_configured" }] };

  const defaultRows = enabledRules.length > 0
    ? await db
      .select({
        ruleId: reciterTaskFlowRuleAssigneesTable.ruleId,
        memberId: reciterTaskFlowRuleAssigneesTable.memberId,
      })
      .from(reciterTaskFlowRuleAssigneesTable)
      .where(inArray(reciterTaskFlowRuleAssigneesTable.ruleId, enabledRules.map((rule) => rule.ruleId)))
    : [];
  const defaultAssigneesByRuleId = new Map<number, number[]>();
  for (const row of defaultRows) {
    if (!defaultAssigneesByRuleId.has(row.ruleId)) defaultAssigneesByRuleId.set(row.ruleId, []);
    defaultAssigneesByRuleId.get(row.ruleId)!.push(row.memberId);
  }

  const created: Array<{ taskId: number; platformName: string; pageName: string; dueDate?: string }> = [];
  const skipped: Array<{ pageId?: number; platformName?: string; pageName?: string; reason: string; existingTaskId?: number; dueDate?: string }> = [];
  const batchKey = `task-flow-change-${parent.id}-${Date.now()}`;
  for (const rule of enabledRules) {
    if (rule.pageReciterId !== parent.reciterId) {
      skipped.push({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "invalid_page" });
      continue;
    }
    const allowedRows = await db.select({ memberId: pageMembersTable.memberId }).from(pageMembersTable).where(eq(pageMembersTable.pageId, rule.pageId));
    const allowedMemberIds = new Set(allowedRows.map((row) => row.memberId));
    const memberIds = [...new Set(defaultAssigneesByRuleId.get(rule.ruleId) ?? [])].filter((memberId) => allowedMemberIds.has(memberId));
    if (memberIds.length === 0) {
      skipped.push({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "no_assignee" });
      continue;
    }
    const childTitle = buildFlowChildTitle(parent.title, parent.platformName, rule.platformName, parent.reciterName);
    for (const flowDate of flowDates) {
      const flowDateKey = taskDateKey(flowDate);
      const existingLink = await findExistingFlowLink(parent.id, rule.pageId, flowDate);
      const canReplaceExistingLink = Boolean(existingLink?.childDeletedAt);
      if (existingLink && !canReplaceExistingLink) {
        skipped.push({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "existing_flow_child_for_date", existingTaskId: existingLink.childTaskId, dueDate: flowDateKey });
        continue;
      }
      const similarTasks = await db
        .select({ id: tasksTable.id, title: tasksTable.title })
        .from(tasksTable)
        .where(and(
          isNull(tasksTable.deletedAt),
          eq(tasksTable.reciterId, parent.reciterId),
          eq(tasksTable.platformId, rule.platformId),
          eq(tasksTable.pageId, rule.pageId),
          sql`${tasksTable.dueDate}::date = ${flowDateKey}::date`,
        ));
      const duplicateTask = similarTasks.find((task) => taskFlowTitleMatches(task.title, childTitle));
      if (duplicateTask) {
        skipped.push({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "duplicate_same_day", existingTaskId: duplicateTask.id, dueDate: flowDateKey });
        continue;
      }

      try {
        const childTask = await db.transaction(async (tx) => {
          const [newTask] = await tx.insert(tasksTable).values({
            source: "admin_created",
            title: childTitle,
            description: parent.description,
            platformId: rule.platformId,
            memberId: memberIds[0],
            reciterId: parent.reciterId,
            status: "pending",
            priority: (parent.priority ?? "normal") as "urgent" | "normal" | "low",
            progress: 0,
            startDate: flowDate,
            endDate: flowDate,
            dueDate: flowDate,
            recurrence: "none",
            recurrenceIntervalDays: null,
            recurrenceDurationDays: null,
            recurrenceDays: null,
            weeklyQuotaRequired: null,
            weeklyQuotaPeriodStart: null,
            weeklyQuotaPeriodEnd: null,
            pageId: rule.pageId,
          }).returning();
          await syncTaskMembersUsing(tx, newTask.id, memberIds);
          if (canReplaceExistingLink && existingLink) {
            await tx.update(taskFlowLinksTable)
              .set({
                childTaskId: newTask.id,
                reciterId: parent.reciterId!,
                sourcePageId: parent.pageId ?? null,
                targetPlatformId: rule.platformId,
                batchKey,
                createdByUserId: currentUser?.id ?? null,
                createdAt: new Date(),
              })
              .where(eq(taskFlowLinksTable.id, existingLink.id));
          } else {
            await tx.insert(taskFlowLinksTable).values({
              parentTaskId: parent.id,
              childTaskId: newTask.id,
              reciterId: parent.reciterId!,
              sourcePageId: parent.pageId ?? null,
              targetPageId: rule.pageId,
              targetPlatformId: rule.platformId,
              flowDate,
              batchKey,
              createdByUserId: currentUser?.id ?? null,
            });
          }
          return newTask;
        });
        created.push({ taskId: childTask.id, platformName: rule.platformName, pageName: rule.pageName, dueDate: flowDateKey });
        await logActivity(req, "task_flow_child_created", "task", childTask.id, childTask.title, {
          parentTaskId: parent.id,
          targetPageId: rule.pageId,
          targetPlatformId: rule.platformId,
          flowChangeRegeneration: true,
          flowDate: flowDateKey,
        });
        await notifyTaskAssigned(childTask.id, childTask.title, memberIds).catch(() => {});
      } catch (error: any) {
        const code = String(error?.code ?? "");
        skipped.push({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: code === "23505" ? "duplicate_same_day" : "create_failed", dueDate: flowDateKey });
      }
    }
  }
  return { created, skipped, summary: buildTaskFlowSummary(flowDates, enabledRules.length) };
}

async function fetchTaskForPermission(taskId: number) {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task) return null;
  const rows = await db
    .select({ memberId: taskMembersTable.memberId })
    .from(taskMembersTable)
    .where(eq(taskMembersTable.taskId, taskId));
  const memberIds = rows.length > 0 ? rows.map((row) => row.memberId) : [task.memberId];
  return { ...task, memberIds };
}

async function fetchTaskProofsMap(taskIds: number[]) {
  if (taskIds.length === 0) return new Map<number, { id: number; taskId: number; url: string; note: string | null; createdByUserId: number | null; createdAt: Date }[]>();
  const rows = await db
    .select({
      id: taskProofsTable.id,
      taskId: taskProofsTable.taskId,
      url: taskProofsTable.url,
      note: taskProofsTable.note,
      createdByUserId: taskProofsTable.createdByUserId,
      createdAt: taskProofsTable.createdAt,
    })
    .from(taskProofsTable)
    .where(and(
      inArray(taskProofsTable.taskId, taskIds),
      isNull(taskProofsTable.deletedAt),
    ))
    .orderBy(taskProofsTable.createdAt);

  const map = new Map<number, { id: number; taskId: number; url: string; note: string | null; createdByUserId: number | null; createdAt: Date }[]>();
  for (const row of rows) {
    if (!map.has(row.taskId)) map.set(row.taskId, []);
    map.get(row.taskId)!.push(row);
  }
  return map;
}

function parseOptionalTaskId(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "none") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error("INVALID_TASK_DEPENDENCY");
  return id;
}

async function fetchTaskDependenciesMap(taskIds: number[]) {
  if (taskIds.length === 0) return new Map<number, number>();
  const rows = await db
    .select({
      dependentTaskId: taskDependenciesTable.dependentTaskId,
      prerequisiteTaskId: taskDependenciesTable.prerequisiteTaskId,
    })
    .from(taskDependenciesTable)
    .where(inArray(taskDependenciesTable.dependentTaskId, taskIds));
  return new Map(rows.map((row) => [row.dependentTaskId, row.prerequisiteTaskId]));
}

async function assertDependencyAllowed(dependentTaskId: number, prerequisiteTaskId: number) {
  if (dependentTaskId === prerequisiteTaskId) throw new Error("SELF_DEPENDENCY");

  const [dependent] = await db
    .select({ id: tasksTable.id, deletedAt: tasksTable.deletedAt })
    .from(tasksTable)
    .where(eq(tasksTable.id, dependentTaskId))
    .limit(1);
  const [prerequisite] = await db
    .select({ id: tasksTable.id, deletedAt: tasksTable.deletedAt })
    .from(tasksTable)
    .where(eq(tasksTable.id, prerequisiteTaskId))
    .limit(1);

  if (!dependent || dependent.deletedAt || !prerequisite || prerequisite.deletedAt) {
    throw new Error("INVALID_TASK_DEPENDENCY");
  }

  let current = prerequisiteTaskId;
  const seen = new Set<number>();
  for (let depth = 0; depth < 100; depth += 1) {
    if (current === dependentTaskId) throw new Error("CIRCULAR_TASK_DEPENDENCY");
    if (seen.has(current)) return;
    seen.add(current);

    const [next] = await db
      .select({ prerequisiteTaskId: taskDependenciesTable.prerequisiteTaskId })
      .from(taskDependenciesTable)
      .where(eq(taskDependenciesTable.dependentTaskId, current))
      .limit(1);
    if (!next) return;
    current = next.prerequisiteTaskId;
  }

  throw new Error("CIRCULAR_TASK_DEPENDENCY");
}

async function assertPrerequisiteTaskExists(prerequisiteTaskId: number) {
  const [prerequisite] = await db
    .select({ id: tasksTable.id, deletedAt: tasksTable.deletedAt })
    .from(tasksTable)
    .where(eq(tasksTable.id, prerequisiteTaskId))
    .limit(1);

  if (!prerequisite || prerequisite.deletedAt) {
    throw new Error("INVALID_TASK_DEPENDENCY");
  }
}

async function setTaskDependency(taskId: number, dependsOnTaskId: number | null, createdByUserId: number | null) {
  if (dependsOnTaskId === null) {
    await db.delete(taskDependenciesTable).where(eq(taskDependenciesTable.dependentTaskId, taskId));
    return;
  }

  await assertDependencyAllowed(taskId, dependsOnTaskId);
  await db.delete(taskDependenciesTable).where(eq(taskDependenciesTable.dependentTaskId, taskId));
  await db.insert(taskDependenciesTable).values({
    prerequisiteTaskId: dependsOnTaskId,
    dependentTaskId: taskId,
    createdByUserId,
  }).onConflictDoNothing();
}

async function syncDependencyForTask(taskId: number | null | undefined, dependsOnTaskId: number | null | undefined, createdByUserId: number | null) {
  if (dependsOnTaskId === undefined) return;
  if (!taskId) return;
  await setTaskDependency(taskId, dependsOnTaskId, createdByUserId);
}

async function getTaskTelegramDetails(taskId: number) {
  const [task] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      dueDate: tasksTable.dueDate,
      status: tasksTable.status,
      memberId: tasksTable.memberId,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return task ?? null;
}

async function notifyDependentTasksReady(prerequisiteTaskId: number) {
  const dependencies = await db
    .select({
      id: taskDependenciesTable.id,
      dependentTaskId: taskDependenciesTable.dependentTaskId,
    })
    .from(taskDependenciesTable)
    .where(eq(taskDependenciesTable.prerequisiteTaskId, prerequisiteTaskId));
  if (dependencies.length === 0) return;

  const prerequisite = await getTaskTelegramDetails(prerequisiteTaskId);
  if (!prerequisite) return;

  for (const dependency of dependencies) {
    const dependent = await getTaskTelegramDetails(dependency.dependentTaskId);
    if (!dependent || dependent.status === "completed") continue;

    const assignedRows = await db
      .select({ memberId: taskMembersTable.memberId })
      .from(taskMembersTable)
      .where(eq(taskMembersTable.taskId, dependency.dependentTaskId));
    const memberIds = assignedRows.length > 0
      ? assignedRows.map((row) => row.memberId)
      : [dependent.memberId];

    await notifyTelegramTaskDependencyReady({
      dependencyId: dependency.id,
      memberIds,
      prerequisite,
      dependent,
    }).catch(() => {});
  }
}

// Helper: build full task response
async function buildTaskResponse(taskId: number) {
  const [fullTask] = await db
    .select(TASK_SELECT)
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .where(eq(tasksTable.id, taskId));

  if (!fullTask) return null;

  const membersMap = await fetchTaskMembersMap([taskId]);
  const [taskRow] = await db.select({ reciterId: tasksTable.reciterId }).from(tasksTable).where(eq(tasksTable.id, taskId));
  let reciter = null;
  if (taskRow?.reciterId) {
    const [r] = await db.select().from(recitersTable).where(eq(recitersTable.id, taskRow.reciterId));
    reciter = r ?? null;
  }

  const proofsMap = await fetchTaskProofsMap([taskId]);
  const dependenciesMap = await fetchTaskDependenciesMap([taskId]);
  return {
    ...fullTask,
    members: membersMap.get(taskId) ?? [fullTask.member],
    reciter,
    proofs: proofsMap.get(taskId) ?? [],
    dependsOnTaskId: dependenciesMap.get(taskId) ?? null,
  };
}

router.get("/tasks", async (req, res) => {
  const currentUser = (req as any).currentUser;
  const isAdmin = currentUser?.role === "admin";

  await syncActiveSeries().catch((err) => {
    req.log?.warn?.({ err }, "Failed to sync active task series");
  });

  const platformId = req.query.platformId ? Number(req.query.platformId) : undefined;
  // Non-admins always see only their own tasks — ignore any memberId from query
  const memberId = !isAdmin && currentUser?.memberId
    ? (currentUser.memberId as number)
    : req.query.memberId ? Number(req.query.memberId) : undefined;
  const reciterId = req.query.reciterId ? Number(req.query.reciterId) : undefined;
  const status = req.query.status as string | undefined;
  const search = req.query.search as string | undefined;
  const trash = req.query.trash === "true";
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  // Non-admin with no linked member → no tasks
  if (!isAdmin && !currentUser?.memberId) {
    res.json([]);
    return;
  }

  const conditions: any[] = [];

  // Trash filter: show only soft-deleted or only active
  if (trash) {
    conditions.push(isNotNull(tasksTable.deletedAt));
  } else {
    conditions.push(isNull(tasksTable.deletedAt));
  }

  if (platformId) conditions.push(eq(tasksTable.platformId, platformId));
  if (memberId) {
    // Filter by any assigned member (via task_members)
    const taskIdsForMember = await db
      .select({ taskId: taskMembersTable.taskId })
      .from(taskMembersTable)
      .where(eq(taskMembersTable.memberId, memberId));
    const ids = taskIdsForMember.map((r) => r.taskId);
    if (ids.length === 0) {
      res.json([]);
      return;
    }
    conditions.push(inArray(tasksTable.id, ids));
  }
  if (reciterId) conditions.push(eq(tasksTable.reciterId, reciterId));
  if (status && (status === "pending" || status === "completed")) conditions.push(eq(tasksTable.status, status));
  if (dateFrom) conditions.push(sql`${tasksTable.dueDate} >= ${new Date(dateFrom)}`);
  if (dateTo) conditions.push(sql`${tasksTable.dueDate} <= ${new Date(dateTo)}`);

  let tasks = await db
    .select(TASK_SELECT)
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(tasksTable.createdAt);

  // Search filter (post-query on title/platform/member)
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    tasks = tasks.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      t.platform.name.toLowerCase().includes(q) ||
      t.member.name.toLowerCase().includes(q)
    );
  }

  const taskIds = tasks.map((t) => t.id);
  const membersMap = await fetchTaskMembersMap(taskIds);
  const proofsMap = await fetchTaskProofsMap(taskIds);
  const dependenciesMap = await fetchTaskDependenciesMap(taskIds);

  // Fetch reciters for tasks
  const reciterIds = [...new Set(
    (await db.select({ id: tasksTable.id, reciterId: tasksTable.reciterId })
      .from(tasksTable)
      .where(taskIds.length > 0 ? inArray(tasksTable.id, taskIds) : sql`false`))
      .filter(r => r.reciterId !== null).map(r => r.reciterId as number)
  )];

  const recitersMap = new Map<number, { id: number; name: string; mosque: string; createdAt: Date }>();
  if (reciterIds.length > 0) {
    const rs = await db.select().from(recitersTable).where(inArray(recitersTable.id, reciterIds));
    for (const r of rs) recitersMap.set(r.id, r);
  }

  const taskReciterMap = new Map<number, number | null>();
  if (taskIds.length > 0) {
    const taskRows = await db.select({ id: tasksTable.id, reciterId: tasksTable.reciterId })
      .from(tasksTable).where(inArray(tasksTable.id, taskIds));
    for (const row of taskRows) taskReciterMap.set(row.id, row.reciterId);
  }

  const result = tasks.map((t) => ({
    ...t,
    members: membersMap.get(t.id) ?? [t.member],
    reciter: taskReciterMap.get(t.id) != null
      ? recitersMap.get(taskReciterMap.get(t.id)!) ?? null
      : null,
    proofs: proofsMap.get(t.id) ?? [],
    dependsOnTaskId: dependenciesMap.get(t.id) ?? null,
  }));

  res.json(result);
});

function disabledTaskGenerationResponse(_req: any, res: any) {
  res.status(410).json({ error: "task_generation_disabled", message: "ميزة توليد المهام غير مفعلة حاليًا" });
}

function isTaskGenerationEnabled() {
  return false;
}

router.get("/tasks/:id/flow-change-impact", disabledTaskGenerationResponse);
router.post("/tasks/:id/flow-change-action", disabledTaskGenerationResponse);
router.post("/tasks/:id/flow-children", disabledTaskGenerationResponse);

router.get("/tasks/:id/flow-change-impact", async (req, res) => {
  const id = Number(req.params.id);
  const newReciterId = Number(req.query.newReciterId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(newReciterId) || newReciterId <= 0) {
    res.status(400).json({ error: "Invalid task id or reciter id" });
    return;
  }
  const currentUser = (req as any).currentUser;
  if (currentUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const impact = await buildFlowChangeImpact(id, newReciterId);
  if (!impact) {
    res.status(404).json({ error: "Task not found or not an application task" });
    return;
  }
  res.json(impact);
});

router.post("/tasks/:id/flow-change-action", async (req, res) => {
  const id = Number(req.params.id);
  const newReciterId = Number(req.body?.newReciterId);
  const action = req.body?.action as FlowChangeAction | undefined;
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(newReciterId) || newReciterId <= 0) {
    res.status(400).json({ error: "Invalid task id or reciter id" });
    return;
  }
  if (action !== "delete_safe_children" && action !== "delete_safe_and_regenerate" && action !== "keep_children") {
    res.status(400).json({ error: "Invalid flow change action" });
    return;
  }
  const currentUser = (req as any).currentUser;
  if (currentUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [reciter] = await db.select({ id: recitersTable.id }).from(recitersTable).where(eq(recitersTable.id, newReciterId)).limit(1);
  if (!reciter) {
    res.status(400).json({ error: "Invalid reciterId" });
    return;
  }

  const impact = await buildFlowChangeImpact(id, newReciterId);
  if (!impact) {
    res.status(404).json({ error: "Task not found or not an application task" });
    return;
  }

  if (action === "delete_safe_children" || action === "delete_safe_and_regenerate") {
    if (impact.deletableChildIds.length > 0) {
      await db.update(tasksTable)
        .set({ deletedAt: new Date() })
        .where(inArray(tasksTable.id, impact.deletableChildIds));
    }
  }

  await db.update(tasksTable)
    .set({ reciterId: newReciterId })
    .where(eq(tasksTable.id, id));

  const regenerated = action === "delete_safe_and_regenerate"
    ? await createFlowChildrenFromDefaultRules(id, currentUser, req)
    : { created: [], skipped: [] };

  await logActivity(req, "task_flow_change_action", "task", id, null, {
    action,
    newReciterId,
    deletedChildren: action === "keep_children" ? 0 : impact.deletableChildIds.length,
    protectedChildren: impact.protectedChildren,
    regeneratedCreated: regenerated.created.length,
    regeneratedSkipped: regenerated.skipped.length,
  });

  res.json({
    action,
    deletedChildIds: action === "keep_children" ? [] : impact.deletableChildIds,
    protectedChildIds: impact.protectedChildIds,
    regenerated,
    impact,
  });
});

router.post("/tasks/:id/flow-children", async (req, res) => {
  const id = Number(req.params.id);
  const traceIdHeader = req.headers["x-task-flow-trace-id"];
  const traceId = typeof traceIdHeader === "string" && traceIdHeader.trim()
    ? traceIdHeader.trim()
    : `task-flow-${id || "invalid"}-${Date.now()}`;
  if (!Number.isInteger(id) || id <= 0) {
    req.log?.warn?.({ traceId, parentTaskId: req.params.id }, "task_flow_children_invalid_task_id");
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const currentUser = (req as any).currentUser;
  if (currentUser?.role !== "admin") {
    req.log?.warn?.({ traceId, parentTaskId: id, role: currentUser?.role ?? null }, "task_flow_children_forbidden");
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const assignmentInput = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  req.log?.info?.({
    traceId,
    parentTaskId: id,
    assignmentInputCount: assignmentInput.length,
  }, "task_flow_children_start");
  const requestedAssigneesByPageId = new Map<number, number[]>();
  for (const item of assignmentInput) {
    const pageId = Number(item?.pageId);
    const rawMemberIds = Array.isArray(item?.memberIds) ? item.memberIds : [];
    const memberIds: number[] = [...new Set<number>(
      rawMemberIds
        .map((memberId: unknown) => Number(memberId))
        .filter((memberId: number) => Number.isInteger(memberId) && memberId > 0),
    )];
    if (Number.isInteger(pageId) && pageId > 0) {
      requestedAssigneesByPageId.set(pageId, memberIds);
    }
  }

  const [parent] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      description: tasksTable.description,
      platformId: tasksTable.platformId,
      platformName: platformsTable.name,
      memberId: tasksTable.memberId,
      reciterId: tasksTable.reciterId,
      reciterName: recitersTable.name,
      priority: tasksTable.priority,
      startDate: tasksTable.startDate,
      endDate: tasksTable.endDate,
      dueDate: tasksTable.dueDate,
      pageId: tasksTable.pageId,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(and(eq(tasksTable.id, id), isNull(tasksTable.deletedAt)))
    .limit(1);

  if (!parent) {
    req.log?.warn?.({ traceId, parentTaskId: id }, "task_flow_children_parent_not_found");
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!isApplicationPlatformName(parent.platformName)) {
    req.log?.warn?.({
      traceId,
      parentTaskId: parent.id,
      platformId: parent.platformId,
      platformName: parent.platformName,
    }, "task_flow_children_parent_not_application");
    res.status(400).json({ error: "Task flow can only start from the application platform" });
    return;
  }
  if (!parent.reciterId || !parent.reciterName) {
    req.log?.warn?.({ traceId, parentTaskId: parent.id, reciterId: parent.reciterId }, "task_flow_children_parent_missing_reciter");
    res.status(400).json({ error: "Parent task must have a reciter" });
    return;
  }

  const flowDates = getTaskFlowDateRange(parent);
  if (flowDates.length === 0) {
    req.log?.warn?.({
      traceId,
      parentTaskId: parent.id,
      dueDate: parent.dueDate,
      startDate: parent.startDate,
    }, "task_flow_children_parent_invalid_date");
    res.status(400).json({ error: "Parent task must have a valid date" });
    return;
  }

  const rules = await db
    .select({
      ruleId: reciterTaskFlowRulesTable.id,
      pageId: reciterTaskFlowRulesTable.pageId,
      enabled: reciterTaskFlowRulesTable.enabled,
      pageName: platformPagesTable.name,
      pageReciterId: platformPagesTable.reciterId,
      platformId: platformPagesTable.platformId,
      platformName: platformsTable.name,
    })
    .from(reciterTaskFlowRulesTable)
    .innerJoin(platformPagesTable, eq(reciterTaskFlowRulesTable.pageId, platformPagesTable.id))
    .innerJoin(platformsTable, eq(platformPagesTable.platformId, platformsTable.id))
    .where(eq(reciterTaskFlowRulesTable.reciterId, parent.reciterId));

  const enabledRules = rules.filter((rule) => rule.enabled && rule.platformId !== parent.platformId);
  if (rules.length === 0) {
    const skipped = [{ reason: "rules_not_configured" }];
    req.log?.info?.({
      traceId,
      parentTaskId: parent.id,
      reciterId: parent.reciterId,
      rulesCount: 0,
      enabledRulesCount: 0,
      createdCount: 0,
      skipped,
    }, "task_flow_children_response");
    res.json({ traceId, created: [], skipped });
    return;
  }

  const created: Array<{ taskId: number; platformName: string; pageName: string; dueDate?: string }> = [];
  const skipped: Array<{ pageId?: number; platformName?: string; pageName?: string; reason: string; existingTaskId?: number; dueDate?: string }> = [];
  const pushSkipped = (entry: { pageId?: number; platformName?: string; pageName?: string; reason: string; existingTaskId?: number; dueDate?: string }) => {
    skipped.push(entry);
    req.log?.info?.({ traceId, parentTaskId: parent.id, ...entry }, "task_flow_child_skipped");
  };
  const batchKey = `task-flow-${parent.id}-${Date.now()}`;
  const enabledRuleIds = enabledRules.map((rule) => rule.ruleId);
  const defaultAssigneeRows = enabledRuleIds.length > 0
    ? await db
      .select({
        ruleId: reciterTaskFlowRuleAssigneesTable.ruleId,
        memberId: reciterTaskFlowRuleAssigneesTable.memberId,
      })
      .from(reciterTaskFlowRuleAssigneesTable)
      .where(inArray(reciterTaskFlowRuleAssigneesTable.ruleId, enabledRuleIds))
    : [];
  const defaultAssigneesByRuleId = new Map<number, number[]>();
  for (const row of defaultAssigneeRows) {
    if (!defaultAssigneesByRuleId.has(row.ruleId)) defaultAssigneesByRuleId.set(row.ruleId, []);
    defaultAssigneesByRuleId.get(row.ruleId)!.push(row.memberId);
  }
  req.log?.info?.({
    traceId,
    parentTaskId: parent.id,
    reciterId: parent.reciterId,
    flowFirstDate: taskDateKey(flowDates[0]),
    flowLastDate: taskDateKey(flowDates[flowDates.length - 1]),
    flowDaysCount: flowDates.length,
    expectedTasks: flowDates.length * enabledRules.length,
    requestedAssignmentPagesCount: requestedAssigneesByPageId.size,
    rulesCount: rules.length,
    enabledRulesCount: enabledRules.length,
    defaultAssigneeRowsCount: defaultAssigneeRows.length,
  }, "task_flow_children_rules_loaded");

  for (const rule of enabledRules) {
    if (rule.pageReciterId !== parent.reciterId) {
      pushSkipped({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "invalid_page" });
      continue;
    }

    const assignedRows = await db
      .select({ memberId: pageMembersTable.memberId })
      .from(pageMembersTable)
      .where(eq(pageMembersTable.pageId, rule.pageId));
    const allowedMemberIds = new Set(assignedRows.map((row) => Number(row.memberId)).filter((memberId) => Number.isInteger(memberId) && memberId > 0));
    const requestedMemberIds = requestedAssigneesByPageId.has(rule.pageId)
      ? requestedAssigneesByPageId.get(rule.pageId) ?? []
      : defaultAssigneesByRuleId.get(rule.ruleId) ?? [];
    const memberIds = [...new Set(requestedMemberIds)];
    req.log?.info?.({
      traceId,
      parentTaskId: parent.id,
      pageId: rule.pageId,
      pageName: rule.pageName,
      platformId: rule.platformId,
      platformName: rule.platformName,
      allowedMemberIds: [...allowedMemberIds],
      requestedMemberIds,
      memberIds,
      assignmentSource: requestedAssigneesByPageId.has(rule.pageId) ? "request" : "default_rule",
    }, "task_flow_child_candidate");
    if (memberIds.some((memberId) => !allowedMemberIds.has(memberId))) {
      pushSkipped({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "invalid_assignee" });
      continue;
    }
    if (memberIds.length === 0) {
      pushSkipped({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "no_assignee" });
      continue;
    }

    const childTitle = buildFlowChildTitle(parent.title, parent.platformName, rule.platformName, parent.reciterName);

    for (const flowDate of flowDates) {
      const flowDateKey = taskDateKey(flowDate);
      const existingLink = await findExistingFlowLink(parent.id, rule.pageId, flowDate);
      const canReplaceExistingLink = Boolean(existingLink?.childDeletedAt);
      if (existingLink && !canReplaceExistingLink) {
        pushSkipped({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "existing_flow_child_for_date", existingTaskId: existingLink.childTaskId, dueDate: flowDateKey });
        continue;
      }
      if (existingLink && canReplaceExistingLink) {
        req.log?.info?.({
          traceId,
          parentTaskId: parent.id,
          pageId: rule.pageId,
          existingTaskId: existingLink.childTaskId,
          flowDate: flowDateKey,
        }, "task_flow_child_replacing_deleted_link");
      }

      const similarTasks = await db
        .select({ id: tasksTable.id, title: tasksTable.title })
        .from(tasksTable)
        .where(and(
          isNull(tasksTable.deletedAt),
          eq(tasksTable.reciterId, parent.reciterId),
          eq(tasksTable.platformId, rule.platformId),
          eq(tasksTable.pageId, rule.pageId),
          sql`${tasksTable.dueDate}::date = ${flowDateKey}::date`,
        ));
      const duplicateTask = similarTasks.find((task) => taskFlowTitleMatches(task.title, childTitle));
      if (duplicateTask) {
        pushSkipped({ pageId: rule.pageId, platformName: rule.platformName, pageName: rule.pageName, reason: "duplicate_same_day", existingTaskId: duplicateTask.id, dueDate: flowDateKey });
        continue;
      }

      try {
        req.log?.info?.({
          traceId,
          parentTaskId: parent.id,
          pageId: rule.pageId,
          platformId: rule.platformId,
          memberIds,
          childTitle,
          flowDate: flowDateKey,
        }, "task_flow_child_create_attempt");
        const childTask = await db.transaction(async (tx) => {
          const [newTask] = await tx.insert(tasksTable).values({
            source: "admin_created",
            title: childTitle,
            description: parent.description,
            platformId: rule.platformId,
            memberId: memberIds[0],
            reciterId: parent.reciterId,
            status: "pending",
            priority: (parent.priority ?? "normal") as "urgent" | "normal" | "low",
            progress: 0,
            startDate: flowDate,
            endDate: flowDate,
            dueDate: flowDate,
            recurrence: "none",
            recurrenceIntervalDays: null,
            recurrenceDurationDays: null,
            recurrenceDays: null,
            weeklyQuotaRequired: null,
            weeklyQuotaPeriodStart: null,
            weeklyQuotaPeriodEnd: null,
            pageId: rule.pageId,
          }).returning();

          await syncTaskMembersUsing(tx, newTask.id, memberIds);
          if (canReplaceExistingLink && existingLink) {
            await tx.update(taskFlowLinksTable)
              .set({
                childTaskId: newTask.id,
                reciterId: parent.reciterId!,
                sourcePageId: parent.pageId ?? null,
                targetPlatformId: rule.platformId,
                batchKey,
                createdByUserId: currentUser.id ?? null,
                createdAt: new Date(),
              })
              .where(eq(taskFlowLinksTable.id, existingLink.id));
          } else {
            await tx.insert(taskFlowLinksTable).values({
              parentTaskId: parent.id,
              childTaskId: newTask.id,
              reciterId: parent.reciterId!,
              sourcePageId: parent.pageId ?? null,
              targetPageId: rule.pageId,
              targetPlatformId: rule.platformId,
              flowDate,
              batchKey,
              createdByUserId: currentUser.id ?? null,
            });
          }
          return newTask;
        });

        created.push({ taskId: childTask.id, platformName: rule.platformName, pageName: rule.pageName, dueDate: flowDateKey });
        const taskMemberRows = await db
          .select({ memberId: taskMembersTable.memberId })
          .from(taskMembersTable)
          .where(eq(taskMembersTable.taskId, childTask.id));
        const [taskRow] = await db
          .select({
            id: tasksTable.id,
            deletedAt: tasksTable.deletedAt,
            status: tasksTable.status,
            startDate: tasksTable.startDate,
            endDate: tasksTable.endDate,
            dueDate: tasksTable.dueDate,
            platformId: tasksTable.platformId,
            pageId: tasksTable.pageId,
            reciterId: tasksTable.reciterId,
            memberId: tasksTable.memberId,
          })
          .from(tasksTable)
          .where(eq(tasksTable.id, childTask.id))
          .limit(1);
        req.log?.info?.({
          traceId,
          parentTaskId: parent.id,
          taskId: childTask.id,
          taskRow,
          taskMemberIds: taskMemberRows.map((row) => row.memberId),
          flowDate: flowDateKey,
        }, "task_flow_child_created_verified");
        await logActivity(req, "task_flow_child_created", "task", childTask.id, childTask.title, {
          parentTaskId: parent.id,
          targetPageId: rule.pageId,
          targetPlatformId: rule.platformId,
          flowDate: flowDateKey,
        });
        try {
          await notifyTaskAssigned(childTask.id, childTask.title, memberIds);
          req.log?.info?.({
            traceId,
            parentTaskId: parent.id,
            taskId: childTask.id,
            memberIds,
            flowDate: flowDateKey,
          }, "task_flow_child_notification_attempted");
        } catch (notifyError: any) {
          req.log?.warn?.({
            traceId,
            parentTaskId: parent.id,
            taskId: childTask.id,
            memberIds,
            message: notifyError?.message,
            flowDate: flowDateKey,
          }, "task_flow_child_notification_failed");
        }
      } catch (error: any) {
        const code = String(error?.code ?? "");
        req.log?.error?.({
          traceId,
          parentTaskId: parent.id,
          pageId: rule.pageId,
          platformName: rule.platformName,
          code,
          message: error?.message,
          flowDate: flowDateKey,
        }, "task_flow_child_create_failed");
        pushSkipped({
          pageId: rule.pageId,
          platformName: rule.platformName,
          pageName: rule.pageName,
          reason: code === "23505" ? "duplicate_same_day" : "create_failed",
          dueDate: flowDateKey,
        });
      }
    }
  }

  req.log?.info?.({
    traceId,
    parentTaskId: parent.id,
    createdCount: created.length,
    skippedCount: skipped.length,
    created,
    skipped,
  }, "task_flow_children_response");
  res.status(201).json({ traceId, created, skipped, summary: buildTaskFlowSummary(flowDates, enabledRules.length) });
});

router.post("/tasks", async (req, res) => {
  const parsedBody = CreateTaskBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid task payload" });
    return;
  }
  const body = parsedBody.data;
  const currentUser = (req as any).currentUser;
  const isAdmin = currentUser?.role === "admin";
  const isMemberSelfTask = !isAdmin;
  const hasPlatformAssignments = Array.isArray((req.body as any).platformAssignments) && (req.body as any).platformAssignments.length > 0;

  if (isMemberSelfTask) {
    if (!currentUser?.memberId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const requestedMemberIds = Array.isArray((req.body as any).memberIds)
      ? (req.body as any).memberIds.map((id: unknown) => Number(id))
      : [];
    if (requestedMemberIds.some((memberId: number) => memberId !== currentUser.memberId)) {
      res.status(403).json({ error: "Members can only create tasks for themselves" });
      return;
    }

    const rawSeriesType = (req.body as any).seriesType;
    const rawRecurrence = (req.body as any).recurrence ?? (req.body as any).recurrenceType;
    if (
      (rawSeriesType && rawSeriesType !== "temporary") ||
      (rawRecurrence && rawRecurrence !== "none") ||
      (req.body as any).endDate ||
      (req.body as any).weeklyQuotaRequired ||
      (req.body as any).recurrenceIntervalDays ||
      (req.body as any).recurrenceDurationDays ||
      (req.body as any).recurrenceDays ||
      (req.body as any).expandDailyInstances ||
      (req.body as any).dependsOnTaskId
    ) {
      res.status(403).json({ error: "Members can only create one-off self tasks" });
      return;
    }
    if (hasPlatformAssignments) {
      res.status(403).json({ error: "Members cannot create multi-platform tasks" });
      return;
    }

    body.memberIds = [currentUser.memberId];
    body.status = "pending";
    body.recurrence = "none";
  }

  let platformAssignments: PlatformAssignment[] = [];
  if (isAdmin && hasPlatformAssignments) {
    try {
      platformAssignments = await validatePlatformAssignments((req.body as any).platformAssignments, currentUser);
    } catch (error) {
      res.status((error as Error).message === "FORBIDDEN_PLATFORM_ASSIGNMENTS" ? 403 : 400).json({ error: "Invalid platformAssignments" });
      return;
    }
    if (platformAssignments.length === 1) {
      body.platformId = platformAssignments[0].platformId;
      body.pageId = platformAssignments[0].pageId;
      body.memberIds = platformAssignments[0].memberIds;
    }
  }

  let validatedMemberIds: number[];
  try {
    validatedMemberIds = await validateMemberIds(body.memberIds);
  } catch {
    res.status(400).json({ error: "Invalid memberIds" });
    return;
  }

  if (!canCreateTask(currentUser, validatedMemberIds)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  body.memberIds = validatedMemberIds;
  const primaryMemberId = body.memberIds[0];
  const taskSource = isMemberSelfTask ? "member_created" : "admin_created";
  let dependsOnTaskId: number | null | undefined;
  try {
    dependsOnTaskId = isAdmin ? parseOptionalTaskId((req.body as any).dependsOnTaskId) : undefined;
  } catch {
    res.status(400).json({ error: "Invalid task dependency" });
    return;
  }
  if (dependsOnTaskId !== undefined && dependsOnTaskId !== null) {
    try {
      await assertPrerequisiteTaskExists(dependsOnTaskId);
    } catch {
      res.status(400).json({ error: "Invalid task dependency" });
      return;
    }
  }
  let seriesType: SeriesType;
  let seriesRecurrenceType: SeriesRecurrenceType;
  try {
    seriesType = parseSeriesType((req.body as any).seriesType);
    seriesRecurrenceType = parseSeriesRecurrenceType((req.body as any).recurrence ?? (req.body as any).recurrenceType);
  } catch {
    res.status(400).json({ error: "Invalid recurrence settings" });
    return;
  }
  let weeklyQuotaRequired: number | null = null;
  try {
    weeklyQuotaRequired = parseWeeklyQuotaRequired((req.body as any).weeklyQuotaRequired);
  } catch {
    res.status(400).json({ error: "Invalid weeklyQuotaRequired" });
    return;
  }
  const recurrence = seriesType === "operational" ? seriesRecurrenceType : ((body.recurrence ?? "none") as string);
  if (weeklyQuotaRequired && (seriesType !== "operational" || seriesRecurrenceType !== "weekly")) {
    res.status(400).json({ error: "Weekly quota tasks require operational weekly recurrence" });
    return;
  }
  const startDate = normalizeDate(body.startDate ?? body.dueDate);
  const endDate = normalizeDate((req.body as any).endDate);
  const intervalDays = body.recurrenceIntervalDays && body.recurrenceIntervalDays > 0 ? body.recurrenceIntervalDays : 1;
  let weeklyRecurrenceDays: string | null = null;
  try {
    weeklyRecurrenceDays = seriesType === "operational" && seriesRecurrenceType === "weekly"
      ? normalizeRecurrenceDays((req.body as any).recurrenceDays)
      : null;
  } catch {
    res.status(400).json({ error: "Invalid recurrenceDays" });
    return;
  }
  const customDaysList: string[] = recurrence === "custom_days"
    ? ((body as any).recurrenceDays ?? "").split(",").filter(Boolean)
    : [];

  if (!startDate) {
    res.status(400).json({ error: "Start date is required" });
    return;
  }

  if (endDate && endDate < startDate) {
    res.status(400).json({ error: "End date must be after start date" });
    return;
  }

  if (isAdmin && platformAssignments.length > 1) {
    const [creationGroup] = await db.insert(taskCreationGroupsTable).values({
      createdByUserId: currentUser?.id ?? null,
      title: body.title,
    }).returning();

    const createdTaskIds: number[] = [];
    const createdByPlatform: Record<string, number> = {};
    const notifyQueue: Array<{ taskId: number; title: string; memberIds: number[] }> = [];

    for (const assignment of platformAssignments) {
      const assignmentPrimaryMemberId = assignment.memberIds[0];
      if (seriesType === "operational") {
        if (seriesRecurrenceType !== "weekly" && seriesRecurrenceType !== "monthly") {
          res.status(400).json({ error: "Operational tasks require weekly or monthly recurrence" });
          return;
        }

        const [series] = await db.insert(taskSeriesTable).values({
          title: body.title,
          recurrenceType: seriesRecurrenceType,
          seriesType: "operational",
          startDate,
          endDate: null,
          generateUntil: null,
          status: "active",
        }).returning();

        const generatedIds = await generateUpcomingTasksForSeries({
          seriesId: series.id,
          title: body.title,
          description: body.description,
          platformId: assignment.platformId,
          memberIds: assignment.memberIds,
          reciterId: body.reciterId ?? null,
          pageId: assignment.pageId,
          creationGroupId: creationGroup.id,
          priority: (body.priority ?? "normal") as "urgent" | "normal" | "low",
          startDate,
          recurrenceType: seriesRecurrenceType,
          recurrenceDays: weeklyRecurrenceDays,
          weeklyQuotaRequired,
        });
        createdTaskIds.push(...generatedIds);
        if (generatedIds[0]) {
          notifyQueue.push({ taskId: generatedIds[0], title: body.title, memberIds: assignment.memberIds });
          if (dependsOnTaskId !== undefined) {
            await syncDependencyForTask(generatedIds[0], dependsOnTaskId, currentUser?.id ?? null);
          }
        }
        createdByPlatform[assignment.platformName] = (createdByPlatform[assignment.platformName] ?? 0) + generatedIds.length;
        continue;
      }

      if (endDate && endDate >= startDate) {
        const dates: Date[] = recurrence === "custom_days"
          ? getDateRange(startDate, endDate).filter((date) => customDaysList.includes(String(date.getDay())))
          : getDateRange(startDate, endDate).filter((_, index) => index % intervalDays === 0);

        if (dates.length === 0) {
          res.status(400).json({ error: "No matching days in the given date range" });
          return;
        }

        const [series] = await db.insert(taskSeriesTable).values({
          title: body.title,
          recurrenceType: "none",
          seriesType: "temporary",
          startDate,
          endDate,
          generateUntil: endDate,
          status: "active",
        }).returning();

        let firstTaskId: number | null = null;
        for (const date of dates) {
          const [t] = await db.insert(tasksTable).values({
            seriesId: series.id,
            creationGroupId: creationGroup.id,
            source: taskSource,
            title: body.title,
            description: body.description,
            platformId: assignment.platformId,
            memberId: assignmentPrimaryMemberId,
            reciterId: body.reciterId ?? null,
            status: "pending",
            priority: (body.priority ?? "normal") as "urgent" | "normal" | "low",
            startDate: date,
            endDate: date,
            dueDate: date,
            recurrence: "none",
            recurrenceIntervalDays: null,
            recurrenceDurationDays: null,
            recurrenceDays: null,
            weeklyQuotaRequired: null,
            weeklyQuotaPeriodStart: null,
            weeklyQuotaPeriodEnd: null,
            pageId: assignment.pageId,
            assigneeNote: assignment.assigneeNote,
          }).returning();
          await syncTaskMembers(t.id, assignment.memberIds);
          if (firstTaskId === null) firstTaskId = t.id;
          createdTaskIds.push(t.id);
        }
        if (firstTaskId) {
          notifyQueue.push({ taskId: firstTaskId, title: body.title, memberIds: assignment.memberIds });
          if (dependsOnTaskId !== undefined) {
            await syncDependencyForTask(firstTaskId, dependsOnTaskId, currentUser?.id ?? null);
          }
        }
        createdByPlatform[assignment.platformName] = (createdByPlatform[assignment.platformName] ?? 0) + dates.length;
        continue;
      }

      const [task] = await db.insert(tasksTable).values({
        creationGroupId: creationGroup.id,
        source: taskSource,
        title: body.title,
        description: body.description,
        platformId: assignment.platformId,
        memberId: assignmentPrimaryMemberId,
        reciterId: body.reciterId ?? null,
        status: (body.status ?? "pending") as "pending" | "completed",
        priority: (body.priority ?? "normal") as "urgent" | "normal" | "low",
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: endDate,
        dueDate: startDate,
        recurrence: recurrence as "none" | "weekly" | "monthly" | "daily" | "custom_days",
        recurrenceIntervalDays: body.recurrenceIntervalDays ?? null,
        recurrenceDurationDays: body.recurrenceDurationDays ?? null,
        recurrenceDays: (body as any).recurrenceDays ?? null,
        weeklyQuotaRequired,
        weeklyQuotaPeriodStart: weeklyQuotaRequired ? getWeekRange(startDate).start : null,
        weeklyQuotaPeriodEnd: weeklyQuotaRequired ? getWeekRange(startDate).end : null,
        pageId: assignment.pageId,
        assigneeNote: assignment.assigneeNote,
      }).returning();
      await syncTaskMembers(task.id, assignment.memberIds);
      if (dependsOnTaskId !== undefined) {
        await syncDependencyForTask(task.id, dependsOnTaskId, currentUser?.id ?? null);
      }
      createdTaskIds.push(task.id);
      notifyQueue.push({ taskId: task.id, title: task.title, memberIds: assignment.memberIds });
      createdByPlatform[assignment.platformName] = (createdByPlatform[assignment.platformName] ?? 0) + 1;
    }

    if (createdTaskIds.length === 0) {
      res.status(400).json({ error: "No tasks were created" });
      return;
    }

    await logActivity(req, "task_creation_group_created", "task_creation_group", creationGroup.id, body.title, {
      createdTasks: createdTaskIds.length,
      createdByPlatform,
    });
    await Promise.all(notifyQueue.map((item) => notifyTaskAssigned(item.taskId, item.title, item.memberIds).catch(() => {})));
    const taskResponse = await buildTaskResponse(createdTaskIds[0]);
    res.status(201).json({
      ...taskResponse,
      creationGroupId: creationGroup.id,
      createdTasksCount: createdTaskIds.length,
      createdTaskIds,
      createdByPlatform,
    });
    return;
  }

  if (seriesType === "operational") {
    if (seriesRecurrenceType !== "weekly" && seriesRecurrenceType !== "monthly") {
      res.status(400).json({ error: "Operational tasks require weekly or monthly recurrence" });
      return;
    }

    const [series] = await db.insert(taskSeriesTable).values({
      title: body.title,
      recurrenceType: seriesRecurrenceType,
      seriesType: "operational",
      startDate,
      endDate: null,
      generateUntil: null,
      status: "active",
    }).returning();

    const generatedIds = await generateUpcomingTasksForSeries({
      seriesId: series.id,
      title: body.title,
      description: body.description,
      platformId: body.platformId,
      memberIds: body.memberIds,
      reciterId: body.reciterId ?? null,
      pageId: body.pageId ?? null,
      priority: (body.priority ?? "normal") as "urgent" | "normal" | "low",
      startDate,
      recurrenceType: seriesRecurrenceType,
      recurrenceDays: weeklyRecurrenceDays,
      weeklyQuotaRequired,
    });

    const firstTaskId = generatedIds[0] ?? null;
    try {
      await syncDependencyForTask(firstTaskId, dependsOnTaskId, currentUser?.id ?? null);
    } catch {
      res.status(400).json({ error: "Invalid task dependency" });
      return;
    }
    await logActivity(req, "task_series_created", "task_series", series.id, body.title, {
      generatedTasks: generatedIds.length,
      recurrenceDays: weeklyRecurrenceDays,
      weeklyQuotaRequired,
    });
    if (firstTaskId) {
      await notifyTaskAssigned(firstTaskId, body.title, body.memberIds).catch(() => {});
      const taskResponse = await buildTaskResponse(firstTaskId);
      res.status(201).json(taskResponse);
      return;
    }

    res.status(201).json({ seriesId: series.id, generatedTasks: [] });
    return;
  }

  // Temporary range tasks stay as actual independent daily tasks, linked by one series.
  if (endDate && endDate >= startDate) {
    const dates: Date[] = recurrence === "custom_days"
      ? getDateRange(startDate, endDate).filter((date) => customDaysList.includes(String(date.getDay())))
      : getDateRange(startDate, endDate).filter((_, index) => index % intervalDays === 0);

    if (dates.length === 0) {
      res.status(400).json({ error: "No matching days in the given date range" });
      return;
    }

    const [series] = await db.insert(taskSeriesTable).values({
      title: body.title,
      recurrenceType: "none",
      seriesType: "temporary",
      startDate,
      endDate,
      generateUntil: endDate,
      status: "active",
    }).returning();

    let firstTaskId: number | null = null;
    const createdTaskIds: number[] = [];
    for (const date of dates) {
      const [t] = await db.insert(tasksTable).values({
        seriesId: series.id,
        source: taskSource,
        title: body.title,
        description: body.description,
        platformId: body.platformId,
        memberId: primaryMemberId,
        reciterId: body.reciterId ?? null,
        status: "pending",
        priority: (body.priority ?? "normal") as "urgent" | "normal" | "low",
        startDate: date,
        endDate: date,
        dueDate: date,
        recurrence: "none",
        recurrenceIntervalDays: null,
        recurrenceDurationDays: null,
        recurrenceDays: null,
        weeklyQuotaRequired: null,
        weeklyQuotaPeriodStart: null,
        weeklyQuotaPeriodEnd: null,
        pageId: body.pageId ?? null,
      }).returning();
      await syncTaskMembers(t.id, body.memberIds);
      if (firstTaskId === null) firstTaskId = t.id;
      createdTaskIds.push(t.id);
    }

    try {
      await syncDependencyForTask(firstTaskId, dependsOnTaskId, currentUser?.id ?? null);
    } catch {
      res.status(400).json({ error: "Invalid task dependency" });
      return;
    }

    await logActivity(req, "task_series_created", "task_series", series.id, body.title, {
      generatedTasks: dates.length,
      seriesType: "temporary",
    });
    await logActivity(req, "task_created", "task", firstTaskId!, body.title);
    await notifyTaskAssigned(firstTaskId!, body.title, body.memberIds).catch(() => {});
    const taskResponse = await buildTaskResponse(firstTaskId!);
    res.status(201).json(taskResponse);
    return;
  }

  // Single task (no range expansion)
  const [task] = await db.insert(tasksTable).values({
    source: taskSource,
    title: body.title,
    description: body.description,
    platformId: body.platformId,
    memberId: primaryMemberId,
    reciterId: body.reciterId ?? null,
    status: (body.status ?? "pending") as "pending" | "completed",
    priority: (body.priority ?? "normal") as "urgent" | "normal" | "low",
    startDate: body.startDate ? new Date(body.startDate) : null,
    endDate: endDate,
    dueDate: startDate,
    recurrence: recurrence as "none" | "weekly" | "monthly" | "daily" | "custom_days",
    recurrenceIntervalDays: body.recurrenceIntervalDays ?? null,
    recurrenceDurationDays: body.recurrenceDurationDays ?? null,
    recurrenceDays: (body as any).recurrenceDays ?? null,
    weeklyQuotaRequired,
    weeklyQuotaPeriodStart: weeklyQuotaRequired ? getWeekRange(startDate).start : null,
    weeklyQuotaPeriodEnd: weeklyQuotaRequired ? getWeekRange(startDate).end : null,
    pageId: body.pageId ?? null,
  }).returning();

  await syncTaskMembers(task.id, body.memberIds);
  try {
    await syncDependencyForTask(task.id, dependsOnTaskId, currentUser?.id ?? null);
  } catch {
    res.status(400).json({ error: "Invalid task dependency" });
    return;
  }
  await logActivity(req, "task_created", "task", task.id, task.title);
  await notifyTaskAssigned(task.id, task.title, body.memberIds).catch(() => {});

  const taskResponse = await buildTaskResponse(task.id);
  res.status(201).json(taskResponse);
});

router.get("/tasks/:id", async (req, res) => {
  const { id } = GetTaskParams.parse({ id: Number(req.params.id) });
  const permissionTask = await fetchTaskForPermission(id);
  if (!permissionTask) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!canViewTask((req as any).currentUser, permissionTask)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const taskResponse = await buildTaskResponse(id);
  if (!taskResponse) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(taskResponse);
});

type ReciterDecisionKind = "no_member" | "multi_member" | "no_page";
type ReciterDecisionRow = {
  taskId: number;
  platformId: number;
  platformName: string;
  kind: ReciterDecisionKind;
  candidateMembers: Array<{ id: number; name: string }>;
};

// إشعار عضو واحد بإسناد مهمة إليه بعد تغيير القارئ (داخلي + Telegram).
async function notifyReciterAssignment(
  n: { taskId: number; title: string; memberId: number; platformName: string; dueDate: Date | null },
  reciterName: string,
) {
  await notifyTaskAssignedAfterReciterChange({
    taskId: n.taskId,
    taskTitle: n.title,
    memberId: n.memberId,
    reciterName,
    platformName: n.platformName,
    dueDate: n.dueDate,
  }).catch(() => {});
  await notifyTelegramTaskAssigned({
    id: n.taskId,
    title: n.title,
    memberId: n.memberId,
    dueDate: n.dueDate,
    reciterName,
    platformName: n.platformName,
  }).catch(() => {});
}

function reciterTitleReplace(currentTitle: string, oldReciterName: string | undefined, newReciterName: string) {
  return oldReciterName && currentTitle.includes(oldReciterName)
    ? currentTitle.replace(oldReciterName, newReciterName)
    : currentTitle;
}

// المرحلة (أ): يفحص مهام مجموعة المهمة الأساسية، ويطبّق فورًا المنصات ذات العضو الواحد
// (تحديث القارئ/الصفحة/المسؤول + إشعار)، ويُعيد قائمة المنصات التي تحتاج قرار المستخدم:
// «بلا عضو» / «تعدد أعضاء» / «بلا صفحة». المنصات التي تحتاج قرارًا لا تُلمس هنا إطلاقًا.
async function analyzeAndApplyReciterPropagation(params: {
  baseTaskId: number;
  creationGroupId: number;
  newReciterId: number;
  newReciterName: string;
}): Promise<{ autoAppliedCount: number; decisions: ReciterDecisionRow[] }> {
  const { baseTaskId, creationGroupId, newReciterId, newReciterName } = params;

  const groupTasks = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      platformId: tasksTable.platformId,
      platformName: platformsTable.name,
      reciterId: tasksTable.reciterId,
      memberId: tasksTable.memberId,
      dueDate: tasksTable.dueDate,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .where(and(eq(tasksTable.creationGroupId, creationGroupId), isNull(tasksTable.deletedAt)));

  const siblings = groupTasks.filter((task) => task.id !== baseTaskId);
  if (siblings.length === 0) return { autoAppliedCount: 0, decisions: [] };

  const oldReciterIds = [...new Set(siblings.map((s) => s.reciterId).filter((x): x is number => Number.isInteger(x as number) && (x as number) > 0))];
  const oldReciterRows = oldReciterIds.length > 0
    ? await db.select({ id: recitersTable.id, name: recitersTable.name }).from(recitersTable).where(inArray(recitersTable.id, oldReciterIds))
    : [];
  const oldReciterNameById = new Map(oldReciterRows.map((r) => [r.id, r.name]));

  const allActiveMembers = await db
    .select({ id: membersTable.id, name: membersTable.name })
    .from(membersTable)
    .where(eq(membersTable.isActive, true));

  const decisions: ReciterDecisionRow[] = [];
  const notifications: Array<{ taskId: number; title: string; memberId: number; platformName: string; dueDate: Date | null }> = [];
  let autoAppliedCount = 0;

  for (const sib of siblings) {
    const newTitle = reciterTitleReplace(sib.title, sib.reciterId ? oldReciterNameById.get(sib.reciterId) : undefined, newReciterName);

    const [page] = await db
      .select({ id: platformPagesTable.id })
      .from(platformPagesTable)
      .where(and(eq(platformPagesTable.platformId, sib.platformId), eq(platformPagesTable.reciterId, newReciterId)))
      .limit(1);

    if (!page) {
      decisions.push({ taskId: sib.id, platformId: sib.platformId, platformName: sib.platformName, kind: "no_page", candidateMembers: [] });
      continue;
    }

    const linkedMembers = await db
      .select({ id: membersTable.id, name: membersTable.name })
      .from(pageMembersTable)
      .innerJoin(membersTable, eq(pageMembersTable.memberId, membersTable.id))
      .where(eq(pageMembersTable.pageId, page.id));

    if (linkedMembers.length === 1) {
      const newMemberId = linkedMembers[0].id;
      const memberChanged = newMemberId !== sib.memberId;
      const updateValues: Record<string, unknown> = { reciterId: newReciterId, title: newTitle, pageId: page.id };
      if (memberChanged) updateValues.memberId = newMemberId;
      await db.update(tasksTable).set(updateValues).where(eq(tasksTable.id, sib.id));
      autoAppliedCount++;
      if (memberChanged) {
        await syncTaskMembers(sib.id, [newMemberId]);
        notifications.push({ taskId: sib.id, title: newTitle, memberId: newMemberId, platformName: sib.platformName, dueDate: sib.dueDate });
      }
    } else if (linkedMembers.length === 0) {
      decisions.push({ taskId: sib.id, platformId: sib.platformId, platformName: sib.platformName, kind: "no_member", candidateMembers: allActiveMembers });
    } else {
      decisions.push({ taskId: sib.id, platformId: sib.platformId, platformName: sib.platformName, kind: "multi_member", candidateMembers: linkedMembers });
    }
  }

  for (const n of notifications) await notifyReciterAssignment(n, newReciterName);

  return { autoAppliedCount, decisions };
}

router.patch("/tasks/:id/quick-reciter", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const reciterId = Number(req.body?.reciterId);
  const requestedMemberId = req.body?.memberId === undefined || req.body?.memberId === null
    ? null
    : Number(req.body.memberId);

  if (!Number.isInteger(reciterId) || reciterId <= 0) {
    res.status(400).json({ error: "Invalid reciterId" });
    return;
  }
  if (requestedMemberId !== null && (!Number.isInteger(requestedMemberId) || requestedMemberId <= 0)) {
    res.status(400).json({ error: "Invalid memberId" });
    return;
  }

  const currentUser = (req as any).currentUser;
  if (currentUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const currentTask = await fetchTaskForPermission(id);
  if (!currentTask) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, reciterId)).limit(1);
  if (!reciter) {
    res.status(404).json({ error: "Reciter not found" });
    return;
  }

  const [platform] = await db.select().from(platformsTable).where(eq(platformsTable.id, currentTask.platformId)).limit(1);
  if (!platform) {
    res.status(404).json({ error: "Platform not found" });
    return;
  }

  const [oldReciter] = currentTask.reciterId
    ? await db.select().from(recitersTable).where(eq(recitersTable.id, currentTask.reciterId)).limit(1)
    : [];

  const [page] = await db
    .select()
    .from(platformPagesTable)
    .where(and(eq(platformPagesTable.platformId, currentTask.platformId), eq(platformPagesTable.reciterId, reciterId)))
    .limit(1);

  const linkedMemberRows = page
    ? await db.select({ memberId: pageMembersTable.memberId }).from(pageMembersTable).where(eq(pageMembersTable.pageId, page.id))
    : [];
  const linkedMemberIds = linkedMemberRows.map((row) => row.memberId);

  let memberId = requestedMemberId;
  if (linkedMemberIds.length === 1 && memberId === null) {
    memberId = linkedMemberIds[0];
  }
  if (linkedMemberIds.length > 1 && memberId === null) {
    res.status(400).json({ error: "Multiple linked members, memberId is required", linkedMemberIds });
    return;
  }
  if (linkedMemberIds.length > 0 && memberId !== null && !linkedMemberIds.includes(memberId)) {
    res.status(400).json({ error: "Member is not linked to this reciter page" });
    return;
  }
  if (memberId === null) {
    res.status(400).json({ error: "No linked member for this reciter, memberId is required" });
    return;
  }

  const [member] = await db.select().from(membersTable).where(eq(membersTable.id, memberId)).limit(1);
  if (!member) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  if (isTaskGenerationEnabled() && (req.body as any).flowChangeAcknowledged !== true) {
    const impact = await buildFlowChangeImpact(id, reciterId);
    if (impact && impact.totalChildren > 0) {
      res.status(409).json({ error: "flow_change_required", impact });
      return;
    }
  }

  const oldMemberIds = currentTask.memberIds ?? [currentTask.memberId];
  const oldMemberRows = oldMemberIds.length > 0
    ? await db.select({ id: membersTable.id, name: membersTable.name }).from(membersTable).where(inArray(membersTable.id, oldMemberIds))
    : [];
  const title = oldReciter?.name && currentTask.title.includes(oldReciter.name)
    ? currentTask.title.replace(oldReciter.name, reciter.name)
    : currentTask.title;

  await db.transaction(async (tx: any) => {
    await tx
      .update(tasksTable)
      .set({
        reciterId,
        memberId,
        pageId: page?.id ?? null,
        title,
      })
      .where(eq(tasksTable.id, id));
    await syncTaskMembersUsing(tx, id, [memberId!]);
  });

  await notifyTaskAssignedAfterReciterChange({
    taskId: id,
    taskTitle: title,
    memberId,
    reciterName: reciter.name,
    platformName: platform.name,
    dueDate: currentTask.dueDate,
  }).catch(() => {});
  await notifyTelegramTaskAssigned({
    id,
    title,
    memberId,
    dueDate: currentTask.dueDate,
    reciterName: reciter.name,
    platformName: platform.name,
  }).catch(() => {});

  await logActivity(req, "task_quick_reciter_changed", "task", id, title, {
    fromReciterId: currentTask.reciterId,
    fromReciterName: oldReciter?.name ?? null,
    toReciterId: reciterId,
    toReciterName: reciter.name,
    fromMemberIds: oldMemberIds,
    fromMemberNames: oldMemberRows.map((row) => row.name),
    toMemberId: memberId,
    toMemberName: member.name,
    platformName: platform.name,
    previousTitle: currentTask.title,
    newTitle: title,
    pageId: page?.id ?? null,
  });

  // نشر القارئ للمجموعة — فقط عند تغيير القارئ في مهمة «تطبيق تلاوات الحرمين»
  let reciterPropagation: { autoAppliedCount: number } | null = null;
  let pendingReciterDecisions: Record<string, unknown> | null = null;
  if (currentTask.creationGroupId && isApplicationPlatformName(platform.name)) {
    const analysis = await analyzeAndApplyReciterPropagation({
      baseTaskId: id,
      creationGroupId: currentTask.creationGroupId,
      newReciterId: reciterId,
      newReciterName: reciter.name,
    });
    reciterPropagation = { autoAppliedCount: analysis.autoAppliedCount };
    if (analysis.decisions.length > 0) {
      pendingReciterDecisions = {
        baseTaskId: id,
        creationGroupId: currentTask.creationGroupId,
        newReciterId: reciterId,
        newReciterName: reciter.name,
        autoAppliedCount: analysis.autoAppliedCount,
        decisions: analysis.decisions,
      };
    }
  }

  const taskResponse = await buildTaskResponse(id);
  res.json({ ...taskResponse, reciterPropagation, pendingReciterDecisions });
});

// تطبيق قرارات شاشة اختيار القارئ للمنصات الناقصة. يعيد التحقق من كل شيء ولا يثق بالواجهة:
// الصلاحية (مدير)، انتماء المهمة الأساسية والتوابع لنفس المجموعة، منصة «تطبيق تلاوات الحرمين»،
// وصلاحية العضو. تحقّق أولًا لكل القرارات، فإن كان أي قرار غير صالح لا يُطبَّق شيء إطلاقًا.
router.post("/tasks/:id/reciter-decisions", async (req, res) => {
  const baseId = Number(req.params.id);
  const currentUser = (req as any).currentUser;
  if (currentUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const creationGroupId = Number((req.body as any)?.creationGroupId);
  const newReciterId = Number((req.body as any)?.newReciterId);
  const resolutions = Array.isArray((req.body as any)?.resolutions) ? (req.body as any).resolutions : [];
  if (
    !Number.isInteger(baseId) || baseId <= 0 ||
    !Number.isInteger(creationGroupId) || creationGroupId <= 0 ||
    !Number.isInteger(newReciterId) || newReciterId <= 0
  ) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  const [base] = await db
    .select({ id: tasksTable.id, platformName: platformsTable.name, creationGroupId: tasksTable.creationGroupId })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .where(and(eq(tasksTable.id, baseId), isNull(tasksTable.deletedAt)))
    .limit(1);
  if (!base || base.creationGroupId !== creationGroupId || !isApplicationPlatformName(base.platformName)) {
    res.status(400).json({ error: "Invalid base task" });
    return;
  }

  const [newReciter] = await db.select({ id: recitersTable.id, name: recitersTable.name }).from(recitersTable).where(eq(recitersTable.id, newReciterId)).limit(1);
  if (!newReciter) {
    res.status(404).json({ error: "Reciter not found" });
    return;
  }

  type ApplyOp =
    | { type: "assign"; taskId: number; pageId: number; memberId: number; newTitle: string; oldMemberId: number; platformName: string; dueDate: Date | null }
    | { type: "delete"; taskId: number }
    | { type: "keep" };
  const ops: ApplyOp[] = [];

  // المرور الأول: تحقّق فقط (لا تطبيق)
  for (const raw of resolutions) {
    const taskId = Number(raw?.taskId);
    const action = raw?.action;
    if (!Number.isInteger(taskId) || taskId <= 0 || taskId === baseId) {
      res.status(400).json({ error: "Invalid resolution taskId" });
      return;
    }

    const [sib] = await db
      .select({
        id: tasksTable.id,
        title: tasksTable.title,
        platformId: tasksTable.platformId,
        platformName: platformsTable.name,
        reciterId: tasksTable.reciterId,
        memberId: tasksTable.memberId,
        dueDate: tasksTable.dueDate,
        creationGroupId: tasksTable.creationGroupId,
      })
      .from(tasksTable)
      .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
      .where(and(eq(tasksTable.id, taskId), isNull(tasksTable.deletedAt)))
      .limit(1);
    if (!sib || sib.creationGroupId !== creationGroupId) {
      res.status(400).json({ error: "Task not in group" });
      return;
    }

    const [page] = await db
      .select({ id: platformPagesTable.id })
      .from(platformPagesTable)
      .where(and(eq(platformPagesTable.platformId, sib.platformId), eq(platformPagesTable.reciterId, newReciterId)))
      .limit(1);
    const linkedMemberIds = page
      ? (await db.select({ memberId: pageMembersTable.memberId }).from(pageMembersTable).where(eq(pageMembersTable.pageId, page.id))).map((r) => r.memberId)
      : [];

    if (action === "delete") {
      if (page) {
        res.status(400).json({ error: "Cannot delete a platform that has a page for the new reciter" });
        return;
      }
      ops.push({ type: "delete", taskId: sib.id });
      continue;
    }
    if (action === "keep") {
      if (page) {
        res.status(400).json({ error: "Cannot keep a platform that needs a member" });
        return;
      }
      ops.push({ type: "keep" });
      continue;
    }
    if (action === "assign") {
      if (!page) {
        res.status(400).json({ error: "Cannot assign without a page" });
        return;
      }
      const memberId = Number(raw?.memberId);
      if (!Number.isInteger(memberId) || memberId <= 0) {
        res.status(400).json({ error: "Invalid memberId" });
        return;
      }
      if (linkedMemberIds.length > 1) {
        if (!linkedMemberIds.includes(memberId)) {
          res.status(400).json({ error: "Member not linked to this page" });
          return;
        }
      } else {
        const [m] = await db.select({ id: membersTable.id }).from(membersTable).where(and(eq(membersTable.id, memberId), eq(membersTable.isActive, true))).limit(1);
        if (!m) {
          res.status(400).json({ error: "Invalid member" });
          return;
        }
      }
      const [oldReciter] = sib.reciterId
        ? await db.select({ name: recitersTable.name }).from(recitersTable).where(eq(recitersTable.id, sib.reciterId)).limit(1)
        : [];
      const newTitle = reciterTitleReplace(sib.title, oldReciter?.name, newReciter.name);
      ops.push({ type: "assign", taskId: sib.id, pageId: page.id, memberId, newTitle, oldMemberId: sib.memberId, platformName: sib.platformName, dueDate: sib.dueDate });
      continue;
    }

    res.status(400).json({ error: "Invalid action" });
    return;
  }

  // المرور الثاني: تطبيق (كل القرارات صالحة)
  let assigned = 0;
  let deleted = 0;
  let kept = 0;
  const notifications: Array<{ taskId: number; title: string; memberId: number; platformName: string; dueDate: Date | null }> = [];

  for (const op of ops) {
    if (op.type === "delete") {
      await db.update(tasksTable).set({ deletedAt: new Date() }).where(eq(tasksTable.id, op.taskId));
      deleted++;
    } else if (op.type === "keep") {
      kept++;
    } else {
      await db.update(tasksTable).set({ reciterId: newReciterId, pageId: op.pageId, memberId: op.memberId, title: op.newTitle }).where(eq(tasksTable.id, op.taskId));
      await syncTaskMembers(op.taskId, [op.memberId]);
      assigned++;
      if (op.memberId !== op.oldMemberId) {
        notifications.push({ taskId: op.taskId, title: op.newTitle, memberId: op.memberId, platformName: op.platformName, dueDate: op.dueDate });
      }
    }
  }

  for (const n of notifications) await notifyReciterAssignment(n, newReciter.name);

  await logActivity(req, "task_reciter_decisions_applied", "task_creation_group", creationGroupId, base.platformName, {
    baseTaskId: baseId,
    newReciterId,
    assigned,
    deleted,
    kept,
  });

  res.json({ assigned, deleted, kept });
});

router.put("/tasks/:id", async (req, res) => {
  const { id } = UpdateTaskParams.parse({ id: Number(req.params.id) });
  const parsedBody = UpdateTaskBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid task payload" });
    return;
  }
  const body = parsedBody.data;

  const currentTask = await fetchTaskForPermission(id);

  if (!currentTask) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const currentUser = (req as any).currentUser;
  if (!canEditTask(currentUser, currentTask)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const memberUpdateError = validateMemberTaskUpdate(req.body as Record<string, unknown>, currentUser, currentTask);
  if (memberUpdateError) {
    res.status(403).json({ error: memberUpdateError });
    return;
  }

  let dependsOnTaskId: number | null | undefined;
  if ("dependsOnTaskId" in (req.body as any)) {
    if (currentUser?.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    try {
      dependsOnTaskId = parseOptionalTaskId((req.body as any).dependsOnTaskId);
    } catch {
      res.status(400).json({ error: "Invalid task dependency" });
      return;
    }
    if (dependsOnTaskId !== null) {
      try {
        await assertDependencyAllowed(id, dependsOnTaskId);
      } catch {
        res.status(400).json({ error: "Invalid task dependency" });
        return;
      }
    }
  }

  if (body.memberIds !== undefined) {
    let validatedMemberIds: number[];
    try {
      validatedMemberIds = await validateMemberIds(body.memberIds);
    } catch {
      res.status(400).json({ error: "Invalid memberIds" });
      return;
    }
    if (!canCreateTask(currentUser, validatedMemberIds)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    body.memberIds = validatedMemberIds;
  }

  let requestedUpdateScope: TaskUpdateScope;
  try {
    requestedUpdateScope = parseTaskUpdateScope((req.body as any).updateScope, Boolean(currentTask.seriesId));
  } catch {
    res.status(400).json({ error: "Invalid updateScope" });
    return;
  }
  const canApplySeriesScope = currentUser?.role === "admin" && Boolean(currentTask.seriesId);
  const canApplyGroupScope = currentUser?.role === "admin" && Boolean(currentTask.creationGroupId);
  let updateScope: TaskUpdateScope = requestedUpdateScope;
  if (updateScope === "group" && !canApplyGroupScope) updateScope = "single";
  if ((updateScope === "series" || updateScope === "future") && !canApplySeriesScope) updateScope = "single";
  const requestedReciterId = "reciterId" in body ? body.reciterId ?? null : currentTask.reciterId ?? null;
  if (
    isTaskGenerationEnabled() &&
    currentUser?.role === "admin" &&
    "reciterId" in body &&
    requestedReciterId &&
    requestedReciterId !== currentTask.reciterId &&
    (req.body as any).flowChangeAcknowledged !== true
  ) {
    const impact = await buildFlowChangeImpact(id, requestedReciterId);
    if (impact && impact.totalChildren > 0) {
      res.status(409).json({ error: "flow_change_required", impact });
      return;
    }
  }

  const updateData: Record<string, unknown> = {};
  let weeklyQuotaRequired: number | null | undefined;
  if ("weeklyQuotaRequired" in (req.body as any)) {
    try {
      weeklyQuotaRequired = parseWeeklyQuotaRequired((req.body as any).weeklyQuotaRequired);
      updateData.weeklyQuotaRequired = weeklyQuotaRequired;
    } catch {
      res.status(400).json({ error: "Invalid weeklyQuotaRequired" });
      return;
    }
  }
  if (body.title !== undefined) updateData.title = body.title;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.platformId !== undefined) updateData.platformId = body.platformId;
  if (body.memberIds !== undefined && body.memberIds.length > 0) {
    updateData.memberId = body.memberIds[0];
  }
  if ("reciterId" in body) updateData.reciterId = body.reciterId ?? null;
  if ("startDate" in body) updateData.startDate = body.startDate ? new Date(body.startDate as unknown as string) : null;
  if ("endDate" in body) updateData.endDate = (body as any).endDate ? new Date((body as any).endDate) : null;
  if (body.dueDate !== undefined) updateData.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  if (body.recurrence !== undefined) updateData.recurrence = body.recurrence;
  if ("recurrenceIntervalDays" in body) updateData.recurrenceIntervalDays = body.recurrenceIntervalDays ?? null;
  if ("recurrenceDurationDays" in body) updateData.recurrenceDurationDays = body.recurrenceDurationDays ?? null;
  if ("recurrenceDays" in body) {
    try {
      updateData.recurrenceDays = normalizeRecurrenceDays((body as any).recurrenceDays);
    } catch {
      res.status(400).json({ error: "Invalid recurrenceDays" });
      return;
    }
  }
  if (weeklyQuotaRequired && body.startDate) {
    const range = getWeekRange(new Date(body.startDate as unknown as string));
    updateData.weeklyQuotaPeriodStart = range.start;
    updateData.weeklyQuotaPeriodEnd = range.end;
    updateData.dueDate = range.end;
    updateData.startDate = range.start;
    updateData.endDate = range.end;
  }
  const completedAt = body.status === "completed" ? new Date() : null;
  if (body.status !== undefined) {
    updateData.status = body.status;
    updateData.completedAt = completedAt;
  }
  if (body.priority !== undefined) updateData.priority = body.priority;
  if (body.progress !== undefined) updateData.progress = body.progress;
  if ("submissionUrl" in body) updateData.submissionUrl = body.submissionUrl ?? null;
  if ("pageId" in body) updateData.pageId = body.pageId ?? null;

  const effectiveWeeklyQuotaRequired = weeklyQuotaRequired ?? (currentTask as any).weeklyQuotaRequired ?? null;
  if (body.status === "completed" && effectiveWeeklyQuotaRequired) {
    const proofCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, id), isNull(taskProofsTable.deletedAt)));
    if ((proofCount[0]?.count ?? 0) < effectiveWeeklyQuotaRequired) {
      res.status(400).json({ error: "Weekly quota requires more proofs before completion" });
      return;
    }
  }

  let updatedTaskIds = [id];
  if (updateScope === "single") {
    await db.update(tasksTable).set(updateData).where(eq(tasksTable.id, id));

    if (body.memberIds !== undefined && body.memberIds.length > 0) {
      await syncTaskMembers(id, body.memberIds);
    }
  } else if (updateScope === "group") {
    // Group scope: only the DATE is shared across the group. All other edited
    // fields stay on the selected task. Dates are shifted by the same delta so
    // multi-day groups keep their relative structure.
    const creationGroupId = currentTask.creationGroupId!;
    const groupTasks = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(eq(tasksTable.creationGroupId, creationGroupId), isNull(tasksTable.deletedAt)));

    updatedTaskIds = groupTasks.map((task) => task.id);
    if (!updatedTaskIds.includes(id)) updatedTaskIds.push(id);

    const { sharedUpdateData, selectedTaskOnlyUpdateData } = splitUpdateData(updateData);
    const selectedTaskData = { ...sharedUpdateData, ...selectedTaskOnlyUpdateData };
    const dateDeltaDays = getSeriesDateDelta(body as Record<string, unknown>, currentTask);

    await db.transaction(async (tx: any) => {
      if (Object.keys(selectedTaskData).length > 0) {
        await tx.update(tasksTable).set(selectedTaskData).where(eq(tasksTable.id, id));
      }

      if (dateDeltaDays !== 0 && updatedTaskIds.length > 0) {
        await tx.update(tasksTable).set({
          startDate: sql`${tasksTable.startDate} + (${dateDeltaDays} * interval '1 day')`,
          dueDate: sql`${tasksTable.dueDate} + (${dateDeltaDays} * interval '1 day')`,
          endDate: sql`${tasksTable.endDate} + (${dateDeltaDays} * interval '1 day')`,
        }).where(inArray(tasksTable.id, updatedTaskIds));
      }

      if (body.memberIds !== undefined && body.memberIds.length > 0) {
        await syncTaskMembersUsing(tx, id, body.memberIds);
      }
    });
  } else {
    const seriesId = currentTask.seriesId!;
    const targetConditions: any[] = [
      eq(tasksTable.seriesId, seriesId),
      isNull(tasksTable.deletedAt),
    ];

    if (updateScope === "future") {
      const currentDueDate = currentTask.dueDate ?? currentTask.startDate;
      if (!currentDueDate) {
        res.status(400).json({ error: "Cannot apply future scope without a task date" });
        return;
      }
      targetConditions.push(sql`${tasksTable.dueDate} >= ${currentDueDate}`);
    }

    const targetTasks = await db
      .select({
        id: tasksTable.id,
        dueDate: tasksTable.dueDate,
        startDate: tasksTable.startDate,
        endDate: tasksTable.endDate,
      })
      .from(tasksTable)
      .where(and(...targetConditions));

    updatedTaskIds = targetTasks.map((task) => task.id);
    if (!updatedTaskIds.includes(id)) updatedTaskIds.push(id);

    const { sharedUpdateData, selectedTaskOnlyUpdateData } = splitUpdateData(updateData);
    const dateDeltaDays = getSeriesDateDelta(body as Record<string, unknown>, currentTask);
    const bulkUpdateData: Record<string, unknown> = { ...sharedUpdateData };

    if (dateDeltaDays !== 0) {
      bulkUpdateData.startDate = sql`${tasksTable.startDate} + (${dateDeltaDays} * interval '1 day')`;
      bulkUpdateData.dueDate = sql`${tasksTable.dueDate} + (${dateDeltaDays} * interval '1 day')`;
      bulkUpdateData.endDate = sql`${tasksTable.endDate} + (${dateDeltaDays} * interval '1 day')`;
    }

    await db.transaction(async (tx: any) => {
      if (Object.keys(bulkUpdateData).length > 0 && updatedTaskIds.length > 0) {
        await tx.update(tasksTable).set(bulkUpdateData).where(inArray(tasksTable.id, updatedTaskIds));
      }

      if (Object.keys(selectedTaskOnlyUpdateData).length > 0) {
        await tx.update(tasksTable).set(selectedTaskOnlyUpdateData).where(eq(tasksTable.id, id));
      }

      if (body.memberIds !== undefined && body.memberIds.length > 0) {
        for (const taskId of updatedTaskIds) {
          await syncTaskMembersUsing(tx, taskId, body.memberIds);
        }
      }

      const seriesUpdateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.title !== undefined) seriesUpdateData.title = body.title;
      if (dateDeltaDays !== 0 && updateScope === "series") {
        seriesUpdateData.startDate = sql`${taskSeriesTable.startDate} + (${dateDeltaDays} * interval '1 day')`;
        seriesUpdateData.endDate = sql`${taskSeriesTable.endDate} + (${dateDeltaDays} * interval '1 day')`;
        seriesUpdateData.generateUntil = sql`${taskSeriesTable.generateUntil} + (${dateDeltaDays} * interval '1 day')`;
      }
      await tx.update(taskSeriesTable).set(seriesUpdateData).where(eq(taskSeriesTable.id, seriesId));
    });
  }

  try {
    await syncDependencyForTask(id, dependsOnTaskId, currentUser?.id ?? null);
  } catch {
    res.status(400).json({ error: "Invalid task dependency" });
    return;
  }

  // Log activity
  await logActivity(req, "task_updated", "task", id, currentTask.title, {
    updateScope,
    affectedTasks: updatedTaskIds.length,
    seriesId: currentTask.seriesId ?? null,
  });

  // Notify on status → completed (notify admins)
  const beingCompleted = body.status === "completed" && currentTask.status !== "completed";
  if (beingCompleted) {
    await notifyTaskCompleted({
      id,
      title: (updateData.title as string | undefined) ?? currentTask.title,
      memberId: (updateData.memberId as number | undefined) ?? currentTask.memberId,
      submissionUrl: (updateData.submissionUrl as string | null | undefined) ?? currentTask.submissionUrl ?? null,
      completedAt,
    }).catch(() => {});
    await notifyTelegramTaskCompleted({
      id,
      title: (updateData.title as string | undefined) ?? currentTask.title,
      memberId: (updateData.memberId as number | undefined) ?? currentTask.memberId,
      submissionUrl: (updateData.submissionUrl as string | null | undefined) ?? currentTask.submissionUrl ?? null,
      completedAt,
    }).catch(() => {});
    await notifyDependentTasksReady(id).catch(() => {});
  }

  // Notify assigned members on task update (if not completing)
  if (!beingCompleted && body.memberIds && body.memberIds.length > 0) {
    await notifyTaskUpdated(id, currentTask.title, body.memberIds).catch(() => {});
  }

  // Spawn recurring task if being completed
  const effectiveRecurrence = (body.recurrence ?? currentTask.recurrence) as string;
  const effectiveInterval = body.recurrenceIntervalDays ?? currentTask.recurrenceIntervalDays;
  if (beingCompleted && (effectiveRecurrence !== "none" || (effectiveInterval && effectiveInterval > 0))) {
    const currentMemberIds = await db
      .select({ memberId: taskMembersTable.memberId })
      .from(taskMembersTable)
      .where(eq(taskMembersTable.taskId, id));

    const memberIds = currentMemberIds.length > 0
      ? currentMemberIds.map((r) => r.memberId)
      : [currentTask.memberId];

    await spawnRecurringTask(
      {
        ...currentTask,
        reciterId: ("reciterId" in body ? body.reciterId : currentTask.reciterId) ?? null,
        recurrence: effectiveRecurrence,
        recurrenceIntervalDays: effectiveInterval,
        recurrenceDurationDays: body.recurrenceDurationDays ?? currentTask.recurrenceDurationDays,
        recurrenceDays: (body as any).recurrenceDays ?? (currentTask as any).recurrenceDays ?? null,
        endDate: (body as any).endDate ? new Date((body as any).endDate) : (currentTask as any).endDate ?? null,
      },
      body.memberIds ?? memberIds
    );
  }

  // نشر القارئ للمجموعة من نافذة التعديل الكاملة — فقط عند تغيير القارئ في مهمة
  // «تطبيق تلاوات الحرمين». المهمة الأساسية تبقى بما اختاره المستخدم؛ يُطبَّق على التابعة فقط.
  let reciterPropagation: { autoAppliedCount: number } | null = null;
  let pendingReciterDecisions: Record<string, unknown> | null = null;
  if (
    currentUser?.role === "admin" &&
    currentTask.creationGroupId &&
    "reciterId" in body &&
    requestedReciterId &&
    requestedReciterId !== currentTask.reciterId
  ) {
    const [basePlatform] = await db
      .select({ name: platformsTable.name })
      .from(platformsTable)
      .where(eq(platformsTable.id, currentTask.platformId))
      .limit(1);
    if (basePlatform && isApplicationPlatformName(basePlatform.name)) {
      const [newReciter] = await db
        .select({ name: recitersTable.name })
        .from(recitersTable)
        .where(eq(recitersTable.id, requestedReciterId))
        .limit(1);
      if (newReciter) {
        const analysis = await analyzeAndApplyReciterPropagation({
          baseTaskId: id,
          creationGroupId: currentTask.creationGroupId,
          newReciterId: requestedReciterId,
          newReciterName: newReciter.name,
        });
        reciterPropagation = { autoAppliedCount: analysis.autoAppliedCount };
        if (analysis.decisions.length > 0) {
          pendingReciterDecisions = {
            baseTaskId: id,
            creationGroupId: currentTask.creationGroupId,
            newReciterId: requestedReciterId,
            newReciterName: newReciter.name,
            autoAppliedCount: analysis.autoAppliedCount,
            decisions: analysis.decisions,
          };
        }
      }
    }
  }

  const taskResponse = await buildTaskResponse(id);
  res.json({ ...taskResponse, reciterPropagation, pendingReciterDecisions });
});

router.post("/tasks/:id/proofs", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid proof URL" });
    return;
  }

  const task = await fetchTaskForPermission(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (!canEditTask((req as any).currentUser, task)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const currentUser = (req as any).currentUser;
  let shouldNotifyCompleted = false;
  let completedAt: Date | null = null;

  await db.transaction(async (tx: any) => {
    await tx.insert(taskProofsTable).values({
      taskId: id,
      url,
      createdByUserId: currentUser?.id ?? null,
    });

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, id), isNull(taskProofsTable.deletedAt)));

    const required = (task as any).weeklyQuotaRequired as number | null;
    const progress = required ? Math.min(100, Math.round((count / required) * 100)) : task.progress;
    const updateData: Record<string, unknown> = {
      submissionUrl: task.submissionUrl ?? url,
      progress,
    };

    if (required && count >= required && task.status !== "completed") {
      completedAt = new Date();
      updateData.status = "completed";
      updateData.completedAt = completedAt;
      shouldNotifyCompleted = true;
    }

    await tx.update(tasksTable).set(updateData).where(eq(tasksTable.id, id));
  });

  if (shouldNotifyCompleted) {
    await notifyTaskCompleted({
      id,
      title: task.title,
      memberId: task.memberId,
      submissionUrl: task.submissionUrl ?? url,
      completedAt,
    }).catch(() => {});
    await notifyTelegramTaskCompleted({
      id,
      title: task.title,
      memberId: task.memberId,
      submissionUrl: task.submissionUrl ?? url,
      completedAt,
    }).catch(() => {});
    await notifyDependentTasksReady(id).catch(() => {});
  }

  await logActivity(req, "task_proof_created", "task", id, task.title, { url });
  const taskResponse = await buildTaskResponse(id);
  res.status(201).json(taskResponse);
});

router.put("/tasks/:id/proofs/:proofId", async (req, res) => {
  const id = Number(req.params.id);
  const proofId = Number(req.params.proofId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(proofId) || proofId <= 0) {
    res.status(400).json({ error: "Invalid task or proof id" });
    return;
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid proof URL" });
    return;
  }

  const task = await fetchTaskForPermission(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (!canEditTask((req as any).currentUser, task)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [proof] = await db
    .select()
    .from(taskProofsTable)
    .where(and(eq(taskProofsTable.id, proofId), eq(taskProofsTable.taskId, id), isNull(taskProofsTable.deletedAt)))
    .limit(1);

  if (!proof) {
    res.status(404).json({ error: "Proof not found" });
    return;
  }

  await db.transaction(async (tx: any) => {
    await tx
      .update(taskProofsTable)
      .set({ url })
      .where(and(eq(taskProofsTable.id, proofId), eq(taskProofsTable.taskId, id)));

    if (task.submissionUrl === proof.url) {
      await tx.update(tasksTable).set({ submissionUrl: url }).where(eq(tasksTable.id, id));
    }
  });

  await logActivity(req, "task_proof_updated", "task", id, task.title, { proofId, url });
  const taskResponse = await buildTaskResponse(id);
  res.json(taskResponse);
});

// Soft delete (move to trash)
router.delete("/tasks/:id", async (req, res) => {
  const { id } = DeleteTaskParams.parse({ id: Number(req.params.id) });
  const task = await fetchTaskForPermission(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!canDeleteTask((req as any).currentUser, task)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.update(tasksTable).set({ deletedAt: new Date() }).where(eq(tasksTable.id, id));
  if (task) await logActivity(req, "task_deleted", "task", id, task.title);
  res.status(204).end();
});

type DeleteTaskScope = "single" | "from_this_forward" | "entire_series" | "entire_group";

function parseDeleteTaskScope(value: unknown): DeleteTaskScope {
  if (value === "single" || value === "from_this_forward" || value === "entire_series" || value === "entire_group") return value;
  throw new Error("INVALID_DELETE_SCOPE");
}

function taskDateValue(task: { dueDate: Date | null; startDate: Date | null; createdAt?: Date }) {
  return task.dueDate ?? task.startDate ?? task.createdAt ?? new Date(0);
}

// Soft delete a task, future tasks in the same series, or the entire series.
router.post("/tasks/:id/delete-scope", async (req, res) => {
  const { id } = DeleteTaskParams.parse({ id: Number(req.params.id) });
  const body = (req.body ?? {}) as { scope?: unknown; preview?: unknown; confirmedProtected?: unknown };
  let scope: DeleteTaskScope;
  try {
    scope = parseDeleteTaskScope(body.scope);
  } catch {
    res.status(400).json({ error: "Invalid delete scope" });
    return;
  }

  const currentUser = (req as any).currentUser;
  const task = await fetchTaskForPermission(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (scope !== "single" && currentUser?.role !== "admin") {
    res.status(403).json({ error: "Only admins can delete a task series scope" });
    return;
  }
  if (!canDeleteTask(currentUser, task)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (scope === "entire_group" && !task.creationGroupId) {
    res.status(400).json({ error: "Task is not part of a group" });
    return;
  }
  if ((scope === "from_this_forward" || scope === "entire_series") && !task.seriesId) {
    res.status(400).json({ error: "Task is not part of a series" });
    return;
  }

  const targetConditions: any[] = [isNull(tasksTable.deletedAt)];
  if (scope === "single") {
    targetConditions.push(eq(tasksTable.id, id));
  } else if (scope === "entire_group") {
    targetConditions.push(eq(tasksTable.creationGroupId, task.creationGroupId!));
  } else {
    targetConditions.push(eq(tasksTable.seriesId, task.seriesId!));
    if (scope === "from_this_forward") {
      const currentDate = taskDateValue(task);
      targetConditions.push(sql`coalesce(${tasksTable.dueDate}, ${tasksTable.startDate}, ${tasksTable.createdAt}) >= ${currentDate}`);
    }
  }

  const targetTasks = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      completedAt: tasksTable.completedAt,
      submissionUrl: tasksTable.submissionUrl,
      dueDate: tasksTable.dueDate,
      startDate: tasksTable.startDate,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .where(and(...targetConditions));

  if (targetTasks.length === 0) {
    res.status(404).json({ error: "No tasks matched delete scope" });
    return;
  }

  const targetIds = targetTasks.map((row) => row.id);
  const proofRows = await db
    .select({
      taskId: taskProofsTable.taskId,
      count: sql<number>`count(*)::int`,
    })
    .from(taskProofsTable)
    .where(and(inArray(taskProofsTable.taskId, targetIds), isNull(taskProofsTable.deletedAt)))
    .groupBy(taskProofsTable.taskId);
  const proofCountByTask = new Map(proofRows.map((row) => [row.taskId, Number(row.count) || 0]));
  const taskDates = targetTasks
    .map((row) => taskDateValue(row))
    .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const completedCount = targetTasks.filter((row) => row.status === "completed" || Boolean(row.completedAt)).length;
  const withProofsCount = targetTasks.filter((row) => Boolean(row.submissionUrl) || (proofCountByTask.get(row.id) ?? 0) > 0).length;
  const summary = {
    total: targetIds.length,
    completedCount,
    withProofsCount,
    firstDate: taskDates[0]?.toISOString() ?? null,
    lastDate: taskDates[taskDates.length - 1]?.toISOString() ?? null,
    title: task.title,
    softDelete: true,
  };

  if (body.preview === true) {
    res.json({
      preview: true,
      scope,
      seriesId: task.seriesId ?? null,
      deletedTaskIds: targetIds,
      summary,
    });
    return;
  }

  if ((completedCount > 0 || withProofsCount > 0) && body.confirmedProtected !== true) {
    res.status(409).json({
      error: "Protected tasks require explicit confirmation",
      requiresConfirmation: true,
      scope,
      seriesId: task.seriesId ?? null,
      deletedTaskIds: targetIds,
      summary,
    });
    return;
  }

  const deletedAt = new Date();

  await db.update(tasksTable)
    .set({ deletedAt })
    .where(inArray(tasksTable.id, targetIds));

  await logActivity(req, "task_delete_scope", "task", id, task.title, {
    scope,
    seriesId: task.seriesId ?? null,
    deletedTaskIds: targetIds,
    deletedCount: targetIds.length,
    completedCount,
    withProofsCount,
  });

  res.json({
    scope,
    seriesId: task.seriesId ?? null,
    deletedTaskIds: targetIds,
    summary,
  });
});

// Duplicate task
router.post("/tasks/:id/duplicate", async (req, res) => {
  const id = Number(req.params.id);
  const original = await fetchTaskForPermission(id);
  if (!original) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const currentUser = (req as any).currentUser;
  if (!canViewTask(currentUser, original) || !canCreateTask(currentUser, original.memberIds)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (currentUser?.role !== "admin" && original.source !== "member_created") {
    res.status(403).json({ error: "Members can only duplicate self-created tasks" });
    return;
  }

  const [newTask] = await db.insert(tasksTable).values({
    source: currentUser?.role === "admin" ? original.source : "member_created",
    title: `${original.title} (نسخة)`,
    description: original.description,
    platformId: original.platformId,
    memberId: original.memberId,
    reciterId: original.reciterId,
    status: "pending",
    priority: original.priority,
    progress: 0,
    startDate: original.startDate,
    dueDate: original.dueDate,
    recurrence: original.recurrence,
    recurrenceIntervalDays: original.recurrenceIntervalDays,
    recurrenceDurationDays: original.recurrenceDurationDays,
    pageId: original.pageId,
    recurrenceDays: original.recurrenceDays,
    weeklyQuotaRequired: (original as any).weeklyQuotaRequired ?? null,
    weeklyQuotaPeriodStart: (original as any).weeklyQuotaPeriodStart ?? null,
    weeklyQuotaPeriodEnd: (original as any).weeklyQuotaPeriodEnd ?? null,
  }).returning();

  // Copy task members
  const originalMembers = await db
    .select({ memberId: taskMembersTable.memberId })
    .from(taskMembersTable)
    .where(eq(taskMembersTable.taskId, id));
  const memberIds = originalMembers.length > 0
    ? originalMembers.map((r) => r.memberId)
    : [original.memberId];
  await syncTaskMembers(newTask.id, memberIds);

  await logActivity(req, "task_created", "task", newTask.id, newTask.title, { duplicatedFrom: id });

  const taskResponse = await buildTaskResponse(newTask.id);
  res.status(201).json(taskResponse);
});

// Restore from trash
router.post("/tasks/:id/restore", async (req, res) => {
  const id = Number(req.params.id);
  const taskForPermission = await fetchTaskForPermission(id);
  if (!taskForPermission) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!canDeleteTask((req as any).currentUser, taskForPermission)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.update(tasksTable).set({ deletedAt: null }).where(eq(tasksTable.id, id));
  const [task] = await db.select({ title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.id, id));
  if (task) await logActivity(req, "task_restored", "task", id, task.title);
  const taskResponse = await buildTaskResponse(id);
  res.json(taskResponse);
});

// Permanent delete
router.delete("/tasks/:id/permanent", async (req, res) => {
  const id = Number(req.params.id);
  const task = await fetchTaskForPermission(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!canDeleteTask((req as any).currentUser, task)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (task.seriesId) {
    await db.update(tasksTable).set({ deletedAt: new Date() }).where(eq(tasksTable.id, id));
  } else {
    await db.delete(tasksTable).where(eq(tasksTable.id, id));
  }
  if (task) await logActivity(req, "task_permanently_deleted", "task", id, task.title);
  res.status(204).end();
});

export default router;
