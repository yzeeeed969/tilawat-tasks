import { Router } from "express";
import { db, tasksTable, membersTable, platformsTable, taskMembersTable, recitersTable, notificationsTable, activityLogTable, usersTable, taskSeriesTable } from "@workspace/db";
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
import { canCreateTask, canDeleteTask, canEditTask, canViewTask } from "../lib/permissions";

const router = Router();

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
  await db.delete(taskMembersTable).where(eq(taskMembersTable.taskId, taskId));
  if (memberIds.length > 0) {
    await db.insert(taskMembersTable).values(
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
  lastRecurredAt: tasksTable.lastRecurredAt,
  submissionUrl: tasksTable.submissionUrl,
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

  return { ...fullTask, members: membersMap.get(taskId) ?? [fullTask.member], reciter };
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
  }));

  res.json(result);
});

router.post("/tasks", async (req, res) => {
  const parsedBody = CreateTaskBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid task payload" });
    return;
  }
  const body = parsedBody.data;
  let validatedMemberIds: number[];
  try {
    validatedMemberIds = await validateMemberIds(body.memberIds);
  } catch {
    res.status(400).json({ error: "Invalid memberIds" });
    return;
  }

  const currentUser = (req as any).currentUser;
  if (!canCreateTask(currentUser, validatedMemberIds)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  body.memberIds = validatedMemberIds;
  const primaryMemberId = body.memberIds[0];
  let seriesType: SeriesType;
  let seriesRecurrenceType: SeriesRecurrenceType;
  try {
    seriesType = parseSeriesType((req.body as any).seriesType);
    seriesRecurrenceType = parseSeriesRecurrenceType((req.body as any).recurrence ?? (req.body as any).recurrenceType);
  } catch {
    res.status(400).json({ error: "Invalid recurrence settings" });
    return;
  }
  const recurrence = seriesType === "operational" ? seriesRecurrenceType : ((body.recurrence ?? "none") as string);
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
    });

    const firstTaskId = generatedIds[0] ?? null;
    await logActivity(req, "task_series_created", "task_series", series.id, body.title, {
      generatedTasks: generatedIds.length,
      recurrenceDays: weeklyRecurrenceDays,
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

  // Temporary range tasks stay as actual independent daily tasks.
  if (endDate && endDate >= startDate) {
    const dates: Date[] = recurrence === "custom_days"
      ? getDateRange(startDate, endDate).filter((date) => customDaysList.includes(String(date.getDay())))
      : getDateRange(startDate, endDate).filter((_, index) => index % intervalDays === 0);

    if (dates.length === 0) {
      res.status(400).json({ error: "No matching days in the given date range" });
      return;
    }

    let firstTaskId: number | null = null;
    for (const date of dates) {
      const [t] = await db.insert(tasksTable).values({
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
        pageId: body.pageId ?? null,
      }).returning();
      await syncTaskMembers(t.id, body.memberIds);
      if (firstTaskId === null) firstTaskId = t.id;
    }

    await logActivity(req, "task_created", "task", firstTaskId!, body.title);
    await notifyTaskAssigned(firstTaskId!, body.title, body.memberIds).catch(() => {});
    const taskResponse = await buildTaskResponse(firstTaskId!);
    res.status(201).json(taskResponse);
    return;
  }

  // Single task (no range expansion)
  const [task] = await db.insert(tasksTable).values({
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
    pageId: body.pageId ?? null,
  }).returning();

  await syncTaskMembers(task.id, body.memberIds);
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

  const updateData: Record<string, unknown> = {};
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
  const completedAt = body.status === "completed" ? new Date() : null;
  if (body.status !== undefined) {
    updateData.status = body.status;
    updateData.completedAt = completedAt;
  }
  if (body.priority !== undefined) updateData.priority = body.priority;
  if (body.progress !== undefined) updateData.progress = body.progress;
  if ("submissionUrl" in body) updateData.submissionUrl = body.submissionUrl ?? null;
  if ("pageId" in body) updateData.pageId = body.pageId ?? null;

  await db.update(tasksTable).set(updateData).where(eq(tasksTable.id, id));

  if (body.memberIds !== undefined && body.memberIds.length > 0) {
    await syncTaskMembers(id, body.memberIds);
  }

  // Log activity
  await logActivity(req, "task_updated", "task", id, currentTask.title);

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

// Duplicate task
router.post("/tasks/:id/duplicate", async (req, res) => {
  const id = Number(req.params.id);
  const original = await fetchTaskForPermission(id);
  if (!original) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!canViewTask((req as any).currentUser, original) || !canCreateTask((req as any).currentUser, original.memberIds)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [newTask] = await db.insert(tasksTable).values({
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
