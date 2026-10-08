import { Router } from "express";
import { db, tasksTable, membersTable, platformsTable, taskMembersTable, recitersTable, notificationsTable, activityLogTable, usersTable, taskSeriesTable, taskProofsTable, platformPagesTable, pageMembersTable, taskDependenciesTable, taskCreationGroupsTable, reciterSubstitutionItemsTable } from "@workspace/db";
import { eq, and, inArray, isNull, isNotNull, ilike, or, sql, desc } from "drizzle-orm";
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
import { InvalidPrayerError, parsePrayerCode } from "../lib/prayer";
import { ensureTaskQuotaSchema } from "../services/task-quota-schema";
import { ensureTaskDependenciesSchema } from "../services/task-dependencies-schema";
import { ensureTaskFlowLinksSchema } from "../services/task-flow-links-schema";
import { ensureTaskCreationGroupsSchema } from "../services/task-creation-groups-schema";
import { ensureTaskPrayerSchema } from "../services/task-prayer-schema";
import { ensureReciterSubstitutionSchema } from "../services/reciter-substitution-schema";
import { ensureWeeklyScheduleSchema } from "../services/weekly-schedule-schema";
import { checkYoutubeProofDate } from "../services/youtube-proof-date-check";

const router = Router();

router.use(async (_req, _res, next) => {
  try {
    await ensureTaskPrayerSchema();
    await ensureReciterSubstitutionSchema();
    await ensureWeeklyScheduleSchema();
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

// لقطة المهمة قبل أول نيابة مسّتها (القارئ/المسؤول/الصفحة/العنوان المجدولة أصلًا).
async function preSubstitutionSnapshot(taskId: number) {
  const [item] = await db
    .select({ before: reciterSubstitutionItemsTable.before })
    .from(reciterSubstitutionItemsTable)
    .where(and(eq(reciterSubstitutionItemsTable.taskId, taskId), eq(reciterSubstitutionItemsTable.action, "reassigned")))
    .orderBy(reciterSubstitutionItemsTable.id)
    .limit(1);
  const before = item?.before as { reciterId: number | null; memberId: number; memberIds?: number[]; pageId: number | null; title: string } | null | undefined;
  return before ?? null;
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
  prayer?: string | null;
  mosque?: string | null;
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
    prayer: completedTask.prayer ?? null,
    mosque: completedTask.mosque ?? null,
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

// Helper: notify admins on task completion
export async function notifyTaskCompleted(task: {
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
  prayer: tasksTable.prayer,
  // النيابة: لإظهار شارة «نيابة» في الواجهة.
  substitutionId: tasksTable.substitutionId,
  originalReciterId: tasksTable.originalReciterId,
  filmingType: tasksTable.filmingType,
  mosque: tasksTable.mosque,
  // حالة السلسلة (active / stopped …) لإظهار شارة «سلسلة متوقفة» على المهام المتبقية.
  seriesStatus: sql<string | null>`(SELECT ts.status::text FROM task_series ts WHERE ts.id = ${tasksTable.seriesId})`,
  deletedAt: tasksTable.deletedAt,
  createdAt: tasksTable.createdAt,
  platform: {
    id: platformsTable.id,
    name: platformsTable.name,
    icon: platformsTable.icon,
    color: platformsTable.color,
    isMain: platformsTable.isMain,
    coversAllReciters: platformsTable.coversAllReciters,
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

type TaskMosque = "haram" | "nabawi";

function parseTaskMosque(value: unknown): TaskMosque | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "haram" || value === "nabawi") return value;
  throw new Error("INVALID_MOSQUE");
}

// مسجد المهمة: من مسجد القارئ إن وُجد قارئ، وإلا القيمة المختارة يدويًا (للمهام العامة).
async function resolveTaskMosque(reciterId: number | null | undefined, requested: unknown): Promise<TaskMosque | null> {
  const manual = parseTaskMosque(requested);
  if (!reciterId) return manual;
  const [reciter] = await db.select({ mosque: recitersTable.mosque }).from(recitersTable).where(eq(recitersTable.id, reciterId)).limit(1);
  return (reciter?.mosque as TaskMosque | undefined) ?? null;
}

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

export async function notifyDependentTasksReady(prerequisiteTaskId: number) {
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

// مسارات قديمة أُلغيت لصالح نظام النيابة (/tasks/:id/substitution/*). تُرجع 410 برسالة واضحة
// لأي نسخة قديمة من الواجهة ما زالت مفتوحة في متصفح، بدل سلوك صامت أو جزئي.
function removedInFavorOfSubstitution(_req: any, res: any) {
  res.status(410).json({
    error: "replaced_by_substitution",
    message: "تغيير القارئ يتم الآن عبر «النيابة» من نافذة تعديل المهمة. حدّث الصفحة.",
  });
}

router.get("/tasks/:id/flow-change-impact", removedInFavorOfSubstitution);
router.post("/tasks/:id/flow-change-action", removedInFavorOfSubstitution);
router.post("/tasks/:id/flow-children", removedInFavorOfSubstitution);
router.patch("/tasks/:id/quick-reciter", removedInFavorOfSubstitution);
router.post("/tasks/:id/reciter-decisions", removedInFavorOfSubstitution);

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

  // نوع الصلاة (رمز داخلي): واحد للمجموعة كلها، يُكتب على كل مهمة تُنشأ في هذا الطلب.
  // قيمة غير معروفة → 400 قبل أي كتابة. مهام الأعضاء الذاتية لا تحمل صلاة.
  let requestedPrayer: string | null;
  try {
    requestedPrayer = parsePrayerCode((req.body as any).prayer);
  } catch (error) {
    if (error instanceof InvalidPrayerError) {
      res.status(400).json({ error: "Invalid prayer" });
      return;
    }
    throw error;
  }
  const prayer = isAdmin ? requestedPrayer : null;

  // المسجد: لمهمة لها قارئ يُؤخذ من مسجد القارئ دائمًا (لا يُوثق بقيمة الواجهة)، ولمهمة عامة بلا قارئ
  // يُقبل اختيار المدير (haram / nabawi / فارغ). قيمة غير معروفة → 400 قبل أي كتابة.
  let mosque: TaskMosque | null = null;
  try {
    mosque = await resolveTaskMosque(body.reciterId ?? null, isAdmin ? (req.body as any).mosque : null);
  } catch {
    res.status(400).json({ error: "Invalid mosque" });
    return;
  }

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
          prayer,
          mosque,
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
            prayer,
            mosque,
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
        prayer,
        mosque,
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
      prayer,
      mosque,
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
        prayer,
        mosque,
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
    prayer,
    mosque,
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

// اقتراح العضو المسؤول عند الإنشاء بناءً على (المنصة + القارئ).
// المصدر الأساسي: أعضاء صفحة (المنصة+القارئ) في page_members. وإن لم يوجد ربط مُعدّ:
// العضو المسؤول في آخر مهمة غير محذوفة بنفس المنصة والقارئ. قراءة فقط، لا يغيّر بيانات.
// مسجّل قبل مسار "/tasks/:id" كي لا يلتقطه كمعرّف.
router.get("/tasks/member-suggestion", async (req, res) => {
  const platformId = Number(req.query.platformId);
  const reciterId = Number(req.query.reciterId);
  if (!Number.isInteger(platformId) || platformId <= 0 || !Number.isInteger(reciterId) || reciterId <= 0) {
    res.json({ memberIds: [], source: "none" });
    return;
  }

  const [page] = await db
    .select({ id: platformPagesTable.id })
    .from(platformPagesTable)
    .where(and(eq(platformPagesTable.platformId, platformId), eq(platformPagesTable.reciterId, reciterId)))
    .limit(1);

  if (page) {
    const linked = await db
      .select({ memberId: pageMembersTable.memberId })
      .from(pageMembersTable)
      .innerJoin(membersTable, eq(pageMembersTable.memberId, membersTable.id))
      .where(and(eq(pageMembersTable.pageId, page.id), eq(membersTable.isActive, true)));
    const memberIds = [...new Set(linked.map((row) => row.memberId))];
    if (memberIds.length > 0) {
      res.json({ memberIds, source: "page_members" });
      return;
    }
  }

  // احتياط: آخر مهمة بنفس المنصة والقارئ
  const [lastTask] = await db
    .select({ memberId: tasksTable.memberId })
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .where(and(
      eq(tasksTable.platformId, platformId),
      eq(tasksTable.reciterId, reciterId),
      isNull(tasksTable.deletedAt),
      eq(membersTable.isActive, true),
    ))
    .orderBy(desc(tasksTable.createdAt))
    .limit(1);

  if (lastTask?.memberId) {
    res.json({ memberIds: [lastTask.memberId], source: "last_task" });
    return;
  }

  res.json({ memberIds: [], source: "none" });
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
  // تغيير قارئ مهمة لها قارئ يتم فقط عبر «النيابة» (/tasks/:id/substitution/*) كي ينعكس على كل منصات
  // الفرض والأعضاء والإشعارات بشكل متّسق. هنا يُسمح فقط بتحديد القارئ لأول مرة لمهمة بلا قارئ.
  const requestedReciterId = "reciterId" in body ? body.reciterId ?? null : currentTask.reciterId ?? null;
  if ("reciterId" in body && currentTask.reciterId && requestedReciterId !== currentTask.reciterId) {
    res.status(400).json({
      error: "reciter_change_requires_substitution",
      message: "تغيير القارئ يتم عبر «النيابة» من نافذة تعديل المهمة.",
    });
    return;
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
  // لا نكتب القارئ إن لم يتغيّر، كي لا يُنسخ قارئ هذه المهمة إلى بقية السلسلة في نطاق «السلسلة».
  if ("reciterId" in body && requestedReciterId !== (currentTask.reciterId ?? null)) updateData.reciterId = requestedReciterId;
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
  // المسجد: لمهمة لها قارئ يتبع مسجد القارئ ولا يُعدَّل يدويًا (ويبقى ثابتًا عند النيابة).
  // يُعدَّل يدويًا فقط لمهمة عامة بلا قارئ. وعند تحديد قارئ لأول مرة يُؤخذ من مسجده.
  const effectiveReciterId = requestedReciterId ?? null;
  if (!currentTask.reciterId && effectiveReciterId) {
    updateData.mosque = await resolveTaskMosque(effectiveReciterId, null);
  } else if (!effectiveReciterId && "mosque" in (req.body as any)) {
    try {
      updateData.mosque = parseTaskMosque((req.body as any).mosque);
    } catch {
      res.status(400).json({ error: "Invalid mosque" });
      return;
    }
  }
  // تعديل الصلاة يخصّ هذه المهمة وحدها (لا ينتقل للمهام الشقيقة)، ولا يُكتب إلا إن أُرسل صراحة.
  if ("prayer" in (req.body as any)) {
    try {
      updateData.prayer = parsePrayerCode((req.body as any).prayer);
    } catch (error) {
      if (error instanceof InvalidPrayerError) {
        res.status(400).json({ error: "Invalid prayer" });
        return;
      }
      throw error;
    }
  }

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
        substitutionId: tasksTable.substitutionId,
      })
      .from(tasksTable)
      .where(and(...targetConditions));

    updatedTaskIds = targetTasks.map((task) => task.id);
    if (!updatedTaskIds.includes(id)) updatedTaskIds.push(id);
    // مهام السلسلة التي غيّرتها نيابة تحتفظ بقارئها ومسؤولها وصفحتها وعنوانها: تعديل السلسلة
    // لا ينسخ إليها بيانات المهمة المختارة (وإلا لأُلغيت النيابة بصمت). التواريخ وحدها تُزاح معها.
    const substitutedTaskIds = targetTasks.filter((task) => task.substitutionId && task.id !== id).map((task) => task.id);
    const regularTaskIds = updatedTaskIds.filter((taskId) => !substitutedTaskIds.includes(taskId));

    const { sharedUpdateData, selectedTaskOnlyUpdateData } = splitUpdateData(updateData);
    const dateDeltaDays = getSeriesDateDelta(body as Record<string, unknown>, currentTask);
    const bulkUpdateData: Record<string, unknown> = { ...sharedUpdateData };

    if (dateDeltaDays !== 0) {
      bulkUpdateData.startDate = sql`${tasksTable.startDate} + (${dateDeltaDays} * interval '1 day')`;
      bulkUpdateData.dueDate = sql`${tasksTable.dueDate} + (${dateDeltaDays} * interval '1 day')`;
      bulkUpdateData.endDate = sql`${tasksTable.endDate} + (${dateDeltaDays} * interval '1 day')`;
    }

    const substitutedBulkUpdateData: Record<string, unknown> = { ...bulkUpdateData };
    for (const key of ["reciterId", "memberId", "pageId", "title"]) delete substitutedBulkUpdateData[key];

    await db.transaction(async (tx: any) => {
      if (Object.keys(bulkUpdateData).length > 0 && regularTaskIds.length > 0) {
        await tx.update(tasksTable).set(bulkUpdateData).where(inArray(tasksTable.id, regularTaskIds));
      }
      if (Object.keys(substitutedBulkUpdateData).length > 0 && substitutedTaskIds.length > 0) {
        await tx.update(tasksTable).set(substitutedBulkUpdateData).where(inArray(tasksTable.id, substitutedTaskIds));
      }

      if (Object.keys(selectedTaskOnlyUpdateData).length > 0) {
        await tx.update(tasksTable).set(selectedTaskOnlyUpdateData).where(eq(tasksTable.id, id));
      }

      if (body.memberIds !== undefined && body.memberIds.length > 0) {
        for (const taskId of regularTaskIds) {
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
  // الآلية القديمة (نسخة عند الإكمال) للمهام المستقلة فقط. مهام السلاسل تتولّد من السلسلة نفسها،
  // فلا نُنشئ منها نسخًا خارج السلسلة (تكرار غير مرغوب، أو توليد من سلسلة موقوفة).
  if (beingCompleted && !currentTask.seriesId && (effectiveRecurrence !== "none" || (effectiveInterval && effectiveInterval > 0))) {
    const currentMemberIds = await db
      .select({ memberId: taskMembersTable.memberId })
      .from(taskMembersTable)
      .where(eq(taskMembersTable.taskId, id));

    let memberIds = currentMemberIds.length > 0
      ? currentMemberIds.map((r) => r.memberId)
      : [currentTask.memberId];

    // مهمة مُنابة: التكرار القادم يعود للقارئ المجدول أصلًا (ومسؤوله وصفحته وعنوانه) لا للنائب.
    const preSubstitution = currentTask.substitutionId ? await preSubstitutionSnapshot(id) : null;
    if (preSubstitution) {
      memberIds = preSubstitution.memberIds?.length ? preSubstitution.memberIds : [preSubstitution.memberId];
    }

    await spawnRecurringTask(
      {
        ...currentTask,
        ...(preSubstitution
          ? { memberId: preSubstitution.memberId, pageId: preSubstitution.pageId, title: preSubstitution.title }
          : {}),
        reciterId: preSubstitution
          ? preSubstitution.reciterId
          : ("reciterId" in body ? body.reciterId : currentTask.reciterId) ?? null,
        recurrence: effectiveRecurrence,
        recurrenceIntervalDays: effectiveInterval,
        recurrenceDurationDays: body.recurrenceDurationDays ?? currentTask.recurrenceDurationDays,
        recurrenceDays: (body as any).recurrenceDays ?? (currentTask as any).recurrenceDays ?? null,
        endDate: (body as any).endDate ? new Date((body as any).endDate) : (currentTask as any).endDate ?? null,
      },
      preSubstitution ? memberIds : body.memberIds ?? memberIds
    );
  }

  const taskResponse = await buildTaskResponse(id);
  res.json(taskResponse);
});

// تحذير وقائي قبل حفظ شاهد يوتيوب يدويًا: يقارن صلاة/تاريخ/يوم عنوان الفيديو بالمهمة. للقراءة فقط،
// لا يحفظ شيئًا ولا يمنع الحفظ — الواجهة تعرض التأكيد. أي تعذّر ⇐ { warning: null }.
router.post("/tasks/:id/proof-date-check", async (req, res) => {
  const id = Number(req.params.id);
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!Number.isInteger(id) || id <= 0 || !url) {
    res.json({ warning: null });
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
  res.json({ warning: await checkYoutubeProofDate(id, url) });
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

  // «هذه وما بعدها» و«السلسلة كاملة» و«المجموعة» توقف السلاسل المعنية نهائيًا (stopped) في نفس المعاملة،
  // كي لا يعيد المولّد إحياءها أبدًا. «هذه المهمة فقط» لا يوقف شيئًا — السلسلة تستمر.
  let seriesToStop: number[] = [];
  if ((scope === "from_this_forward" || scope === "entire_series") && task.seriesId) {
    seriesToStop = [task.seriesId];
  } else if (scope === "entire_group" && task.creationGroupId) {
    const groupSeries = await db
      .selectDistinct({ seriesId: tasksTable.seriesId })
      .from(tasksTable)
      .where(and(eq(tasksTable.creationGroupId, task.creationGroupId), isNotNull(tasksTable.seriesId)));
    seriesToStop = groupSeries.map((row) => row.seriesId).filter((value): value is number => typeof value === "number");
  }
  // نهاية السلسلة الموقوفة من نقطة = اليوم السابق للمهمة المختارة (للتوثيق فقط).
  const stoppedEndDate = scope === "from_this_forward" ? new Date(taskDateValue(task).getTime() - 24 * 60 * 60 * 1000) : null;

  let deletedTaskIds: number[] = targetIds;
  await db.transaction(async (tx: any) => {
    if (seriesToStop.length > 0) {
      // قفل صفوف السلاسل أولًا: المولّد يقفلها كذلك، فلا يتداخل توليد جديد مع الإيقاف.
      await tx.select({ id: taskSeriesTable.id }).from(taskSeriesTable).where(inArray(taskSeriesTable.id, seriesToStop)).for("update");
      await tx.update(taskSeriesTable)
        .set({
          status: "stopped",
          updatedAt: new Date(),
          ...(stoppedEndDate ? { endDate: stoppedEndDate } : {}),
        })
        .where(inArray(taskSeriesTable.id, seriesToStop));
    }

    // بعد القفل نعيد تطبيق نفس شروط النطاق، فيشمل الحذف أي مهمة ولّدها المولّد قبل لحظات.
    // المهام المحمية (مكتملة/لها شاهد) لا تُحذف إلا إن كانت ضمن ما عُرض وأكّده المستخدم.
    const deleted = await tx.update(tasksTable)
      .set({ deletedAt })
      .where(and(
        ...targetConditions,
        or(
          inArray(tasksTable.id, targetIds),
          and(
            sql`${tasksTable.status} <> 'completed'`,
            isNull(tasksTable.completedAt),
            sql`coalesce(btrim(${tasksTable.submissionUrl}), '') = ''`,
            sql`NOT EXISTS (SELECT 1 FROM task_proofs tp WHERE tp.task_id = ${tasksTable.id} AND tp.deleted_at IS NULL)`,
          ),
        ),
      ))
      .returning({ id: tasksTable.id });
    deletedTaskIds = deleted.map((row: { id: number }) => row.id);
  });

  await logActivity(req, "task_delete_scope", "task", id, task.title, {
    scope,
    seriesId: task.seriesId ?? null,
    deletedTaskIds,
    deletedCount: deletedTaskIds.length,
    completedCount,
    withProofsCount,
    stoppedSeriesIds: seriesToStop,
  });

  res.json({
    scope,
    seriesId: task.seriesId ?? null,
    deletedTaskIds,
    stoppedSeriesIds: seriesToStop,
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
    prayer: original.prayer ?? null,
    mosque: original.mosque ?? null,
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
