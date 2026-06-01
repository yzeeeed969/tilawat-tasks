import crypto from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  membersTable,
  notificationLogsTable,
  platformsTable,
  recitersTable,
  taskProofsTable,
  tasksTable,
  taskMembersTable,
  telegramLinkTokensTable,
  telegramRecipientsTable,
  telegramSettingsTable,
  usersTable,
  type TelegramSettings,
} from "@workspace/db";
import { ensureTelegramSchema } from "./telegram-schema";
import { ensureTaskQuotaSchema } from "./task-quota-schema";
import { sendTelegramMessage } from "./telegram";

const RIYADH_OFFSET_HOURS = 3;
const LINK_TOKEN_BYTES = 18;

type NotificationType =
  | "telegram_daily_reminder"
  | "telegram_member_overdue"
  | "telegram_admin_overdue"
  | "telegram_admin_task_completed"
  | "telegram_admin_daily_summary"
  | "telegram_daily_public_summary"
  | "telegram_daily_public_summary_manual"
  | "telegram_task_assigned"
  | "telegram_task_dependency_ready"
  | "telegram_weekly_quota_reminder"
  | "telegram_password_reset"
  | "telegram_test";

type Recipient = {
  userId: number;
  memberId: number | null;
  displayName: string | null;
  username: string;
  memberName: string | null;
  chatId: string;
};

type TaskRow = {
  id: number;
  title: string;
  status: string;
  dueDate: Date | null;
  completedAt: Date | null;
  submissionUrl: string | null;
  memberId: number;
  memberName: string;
  platformName: string;
  reciterName: string | null;
};

type WeeklyQuotaTaskRow = TaskRow & {
  weeklyQuotaRequired: number | null;
  weeklyQuotaPeriodStart: Date | null;
  weeklyQuotaPeriodEnd: Date | null;
  proofCount: number;
};

type PublicPostTaskRow = Pick<TaskRow, "id" | "title" | "dueDate" | "completedAt" | "submissionUrl" | "platformName" | "reciterName">;

type DailyPublication = PublicPostTaskRow & {
  proofUrl: string;
  proofIndex: number;
  proofTotal: number;
};

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseTime(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function riyadhParts(now = new Date()) {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

function riyadhDateKey(now = new Date()) {
  const p = riyadhParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function riyadhLocalToUtc(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, hours - RIYADH_OFFSET_HOURS, minutes, seconds, ms));
}

function riyadhDayRange(now = new Date()) {
  const p = riyadhParts(now);
  return {
    start: riyadhLocalToUtc(p.year, p.month, p.day, 0, 0, 0, 0),
    end: riyadhLocalToUtc(p.year, p.month, p.day, 23, 59, 59, 999),
  };
}

function riyadhDateInputRange(dateInput: string | undefined, now = new Date()) {
  if (!dateInput) {
    return {
      ...riyadhDayRange(now),
      displayDate: now,
      dateKey: riyadhDateKey(now),
    };
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (!match) throw new Error("تاريخ ملخص النشر غير صحيح");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));

  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error("تاريخ ملخص النشر غير صحيح");
  }

  return {
    start: riyadhLocalToUtc(year, month, day, 0, 0, 0, 0),
    end: riyadhLocalToUtc(year, month, day, 23, 59, 59, 999),
    displayDate: riyadhLocalToUtc(year, month, day, 12, 0, 0, 0),
    dateKey: dateInput,
  };
}

function riyadhWeekRange(now = new Date()) {
  const p = riyadhParts(now);
  return {
    start: riyadhLocalToUtc(p.year, p.month, p.day - p.weekday, 0, 0, 0, 0),
    end: riyadhLocalToUtc(p.year, p.month, p.day - p.weekday + 6, 23, 59, 59, 999),
  };
}

function riyadhWeekKey(now = new Date()) {
  const { start } = riyadhWeekRange(now);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(start);
}

function isTimeReached(now: Date, time: string) {
  const parsed = parseTime(time);
  if (!parsed) return false;
  const p = riyadhParts(now);
  return p.hours * 60 + p.minutes >= parsed.hours * 60 + parsed.minutes;
}

function overdueCutoff(now: Date, overdueAfterTime: string) {
  const p = riyadhParts(now);
  const parsed = parseTime(overdueAfterTime) ?? { hours: 23, minutes: 59 };
  const currentMinutes = p.hours * 60 + p.minutes;
  const overdueMinutes = parsed.hours * 60 + parsed.minutes;
  if (currentMinutes >= overdueMinutes) return now;
  return new Date(riyadhLocalToUtc(p.year, p.month, p.day, 0, 0, 0, 0).getTime() - 1);
}

function formatRiyadhDate(date: Date | null) {
  if (!date) return "بدون تاريخ";
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    timeZone: "Asia/Riyadh",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

function formatRiyadhDateWithYear(date: Date | null) {
  if (!date) return "بدون تاريخ";
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    timeZone: "Asia/Riyadh",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatRiyadhDateTime(date: Date | null) {
  if (!date) return "غير محدد";
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export async function getTelegramSettings(): Promise<TelegramSettings> {
  await ensureTelegramSchema();
  const [existing] = await db
    .select()
    .from(telegramSettingsTable)
    .orderBy(asc(telegramSettingsTable.id))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(telegramSettingsTable)
    .values({})
    .returning();
  return created;
}

export async function updateTelegramSettings(input: Partial<{
  enabled: boolean;
  dailyReminderTime: string;
  dailySummaryTime: string;
  dailyPublicSummaryTime: string;
  overdueAfterTime: string;
  notifyDailyReminder: boolean;
  notifyMemberOverdue: boolean;
  notifyAdminOverdue: boolean;
  notifyAdminCompleted: boolean;
  notifyAdminDailySummary: boolean;
  notifyDailyPublicSummary: boolean;
  suppressRepeatHours: number;
}>) {
  const current = await getTelegramSettings();
  const update: Partial<typeof telegramSettingsTable.$inferInsert> = { updatedAt: new Date() };

  if (typeof input.enabled === "boolean") update.enabled = input.enabled;
  if (input.dailyReminderTime !== undefined) {
    if (!parseTime(input.dailyReminderTime)) throw new Error("وقت التذكير اليومي غير صحيح");
    update.dailyReminderTime = input.dailyReminderTime;
  }
  if (input.dailySummaryTime !== undefined) {
    if (!parseTime(input.dailySummaryTime)) throw new Error("وقت ملخص المدير غير صحيح");
    update.dailySummaryTime = input.dailySummaryTime;
  }
  if (input.dailyPublicSummaryTime !== undefined) {
    if (!parseTime(input.dailyPublicSummaryTime)) throw new Error("وقت ملخص النشر غير صحيح");
    update.dailyPublicSummaryTime = input.dailyPublicSummaryTime;
  }
  if (input.overdueAfterTime !== undefined) {
    if (!parseTime(input.overdueAfterTime)) throw new Error("وقت التأخير غير صحيح");
    update.overdueAfterTime = input.overdueAfterTime;
  }
  if (typeof input.notifyDailyReminder === "boolean") update.notifyDailyReminder = input.notifyDailyReminder;
  if (typeof input.notifyMemberOverdue === "boolean") update.notifyMemberOverdue = input.notifyMemberOverdue;
  if (typeof input.notifyAdminOverdue === "boolean") update.notifyAdminOverdue = input.notifyAdminOverdue;
  if (typeof input.notifyAdminCompleted === "boolean") update.notifyAdminCompleted = input.notifyAdminCompleted;
  if (typeof input.notifyAdminDailySummary === "boolean") update.notifyAdminDailySummary = input.notifyAdminDailySummary;
  if (typeof input.notifyDailyPublicSummary === "boolean") update.notifyDailyPublicSummary = input.notifyDailyPublicSummary;
  if (input.suppressRepeatHours !== undefined) {
    if (!Number.isInteger(input.suppressRepeatHours) || input.suppressRepeatHours < 1 || input.suppressRepeatHours > 168) {
      throw new Error("مدة منع التكرار يجب أن تكون بين 1 و 168 ساعة");
    }
    update.suppressRepeatHours = input.suppressRepeatHours;
  }

  const [saved] = await db
    .update(telegramSettingsTable)
    .set(update)
    .where(eq(telegramSettingsTable.id, current.id))
    .returning();
  return saved;
}

async function reserveLog(input: {
  type: NotificationType;
  dedupeKey: string;
  recipientUserId?: number | null;
  recipientMemberId?: number | null;
  taskId?: number | null;
}) {
  const [log] = await db
    .insert(notificationLogsTable)
    .values({
      channel: "telegram",
      type: input.type,
      recipientUserId: input.recipientUserId ?? null,
      recipientMemberId: input.recipientMemberId ?? null,
      taskId: input.taskId ?? null,
      dedupeKey: input.dedupeKey,
      status: "pending",
    })
    .onConflictDoNothing({ target: notificationLogsTable.dedupeKey })
    .returning();
  return log;
}

async function finalizeLog(id: number, result: { ok: boolean; error?: string }) {
  await db
    .update(notificationLogsTable)
    .set({
      status: result.ok ? "success" : "failed",
      failureReason: result.ok ? null : result.error ?? "Unknown Telegram error",
      sentAt: result.ok ? new Date() : null,
    })
    .where(eq(notificationLogsTable.id, id));
}

async function sendLoggedTelegram(input: {
  type: NotificationType;
  dedupeKey: string;
  chatId: string;
  text: string;
  replyMarkup?: unknown;
  recipientUserId?: number | null;
  recipientMemberId?: number | null;
  taskId?: number | null;
}) {
  const log = await reserveLog(input);
  if (!log) return { sent: false, skipped: true };
  const result = await sendTelegramMessage(input.chatId, input.text, { replyMarkup: input.replyMarkup });
  await finalizeLog(log.id, result);
  return { sent: result.ok, skipped: false, error: result.error };
}

async function getAdminRecipients(): Promise<Recipient[]> {
  const rows = await db
    .select({
      userId: usersTable.id,
      memberId: usersTable.memberId,
      displayName: usersTable.displayName,
      username: usersTable.username,
      memberName: membersTable.name,
      chatId: telegramRecipientsTable.chatId,
    })
    .from(usersTable)
    .innerJoin(telegramRecipientsTable, eq(telegramRecipientsTable.userId, usersTable.id))
    .leftJoin(membersTable, eq(usersTable.memberId, membersTable.id))
    .where(and(
      eq(usersTable.role, "admin"),
      eq(usersTable.isApproved, true),
      eq(telegramRecipientsTable.isEnabled, true),
    ));
  return rows;
}

async function getMemberRecipients(memberIds?: number[]): Promise<Recipient[]> {
  const conditions = [
    eq(usersTable.isApproved, true),
    eq(telegramRecipientsTable.isEnabled, true),
  ];
  if (memberIds && memberIds.length > 0) conditions.push(inArray(usersTable.memberId as any, memberIds));

  const rows = await db
    .select({
      userId: usersTable.id,
      memberId: usersTable.memberId,
      displayName: usersTable.displayName,
      username: usersTable.username,
      memberName: membersTable.name,
      chatId: telegramRecipientsTable.chatId,
    })
    .from(usersTable)
    .innerJoin(telegramRecipientsTable, eq(telegramRecipientsTable.userId, usersTable.id))
    .leftJoin(membersTable, eq(usersTable.memberId, membersTable.id))
    .where(and(...conditions));
  return rows;
}

async function getAssignedMemberIds(taskId: number, fallbackMemberId: number) {
  const rows = await db
    .select({ memberId: taskMembersTable.memberId })
    .from(taskMembersTable)
    .where(eq(taskMembersTable.taskId, taskId));
  const ids = rows.map((row) => row.memberId);
  return ids.length > 0 ? ids : [fallbackMemberId];
}

async function getAssignedMembersMap(tasks: TaskRow[]) {
  const map = new Map<number, number[]>();
  if (tasks.length === 0) return map;

  const taskIds = tasks.map((task) => task.id);
  const rows = await db
    .select({
      taskId: taskMembersTable.taskId,
      memberId: taskMembersTable.memberId,
    })
    .from(taskMembersTable)
    .where(inArray(taskMembersTable.taskId, taskIds));

  for (const task of tasks) map.set(task.id, [task.memberId]);
  for (const row of rows) {
    const ids = map.get(row.taskId) ?? [];
    if (!ids.includes(row.memberId)) ids.push(row.memberId);
    map.set(row.taskId, ids);
  }
  return map;
}

async function getTasksInRange(start: Date, end: Date) {
  return db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      dueDate: tasksTable.dueDate,
      completedAt: tasksTable.completedAt,
      submissionUrl: tasksTable.submissionUrl,
      memberId: tasksTable.memberId,
      memberName: membersTable.name,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
    })
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(and(
      isNull(tasksTable.deletedAt),
      gte(tasksTable.dueDate, start),
      lte(tasksTable.dueDate, end),
    ))
    .orderBy(asc(tasksTable.dueDate), asc(tasksTable.id));
}

async function getOverdueTasks(cutoff: Date) {
  return db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      dueDate: tasksTable.dueDate,
      completedAt: tasksTable.completedAt,
      submissionUrl: tasksTable.submissionUrl,
      memberId: tasksTable.memberId,
      memberName: membersTable.name,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
    })
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(and(
      isNull(tasksTable.deletedAt),
      or(eq(tasksTable.status, "pending"), eq(tasksTable.status, "in_progress")),
      lte(tasksTable.dueDate, cutoff),
    ))
    .orderBy(asc(tasksTable.dueDate), asc(tasksTable.id));
}

async function getWeeklyQuotaReminderTasks(start: Date, end: Date): Promise<WeeklyQuotaTaskRow[]> {
  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      dueDate: tasksTable.dueDate,
      completedAt: tasksTable.completedAt,
      submissionUrl: tasksTable.submissionUrl,
      memberId: tasksTable.memberId,
      memberName: membersTable.name,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
      weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
      weeklyQuotaPeriodStart: tasksTable.weeklyQuotaPeriodStart,
      weeklyQuotaPeriodEnd: tasksTable.weeklyQuotaPeriodEnd,
      proofCount: sql<number>`count(${taskProofsTable.id})::int`,
    })
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .leftJoin(taskProofsTable, and(
      eq(taskProofsTable.taskId, tasksTable.id),
      isNull(taskProofsTable.deletedAt),
    ))
    .where(and(
      isNull(tasksTable.deletedAt),
      or(eq(tasksTable.status, "pending"), eq(tasksTable.status, "in_progress")),
      sql`${tasksTable.weeklyQuotaRequired} IS NOT NULL`,
      sql`${tasksTable.weeklyQuotaRequired} > 0`,
      sql`coalesce(${tasksTable.weeklyQuotaPeriodEnd}, ${tasksTable.dueDate}) >= ${start}`,
      sql`coalesce(${tasksTable.weeklyQuotaPeriodStart}, ${tasksTable.dueDate}) <= ${end}`,
    ))
    .groupBy(
      tasksTable.id,
      tasksTable.title,
      tasksTable.status,
      tasksTable.dueDate,
      tasksTable.completedAt,
      tasksTable.submissionUrl,
      tasksTable.memberId,
      membersTable.name,
      platformsTable.name,
      recitersTable.name,
      tasksTable.weeklyQuotaRequired,
      tasksTable.weeklyQuotaPeriodStart,
      tasksTable.weeklyQuotaPeriodEnd,
    )
    .orderBy(asc(tasksTable.dueDate), asc(tasksTable.id));

  return rows.map((row) => ({ ...row, proofCount: Number(row.proofCount ?? 0) }));
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/[()（）\[\]{}]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function platformEmoji(platformName: string | null | undefined) {
  const normalized = normalizeText(platformName);
  if (normalized.includes("يوتيوب") || normalized.includes("youtube")) return "🎬";
  if (normalized.includes("انست") || normalized.includes("instagram")) return "📸";
  if (normalized.includes("تلجرام") || normalized.includes("telegram")) return "✈️";
  if (normalized.includes("تطبيق")) return "📱";
  return "📌";
}

function taskDisplayParts(task: { title: string; platformName?: string | null; reciterName?: string | null }) {
  const platformName = task.platformName || "";
  const reciterName = task.reciterName || "";
  const platformNorm = normalizeText(platformName);
  const reciterNorm = normalizeText(reciterName);
  const seen = new Set<string>();
  const titleWithoutPlatformParen = task.title
    .replace(/\(([^)]*)\)/g, (_match, inner) => normalizeText(inner) === platformNorm ? "" : `(${inner})`)
    .trim();

  const parts = titleWithoutPlatformParen
    .split(/\s*[—–-]\s*/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const normalized = normalizeText(part);
      if (!normalized) return false;
      if (platformNorm && normalized === platformNorm) return false;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

  if (reciterName && !parts.some((part) => normalizeText(part) === reciterNorm)) {
    parts.push(reciterName);
  }

  const title = parts.length > 0 ? parts.join(" — ") : task.title;
  return { title, platformName, emoji: platformEmoji(platformName) };
}

function taskLine(task: TaskRow) {
  const display = taskDisplayParts(task);
  const platform = display.platformName ? ` (${escapeHtml(display.platformName)})` : "";
  return `• ${display.emoji} ${escapeHtml(display.title)}${platform}`;
}

function taskFieldLine(task: { title: string; platformName?: string | null; reciterName?: string | null }) {
  const display = taskDisplayParts(task);
  const platform = display.platformName ? ` (${escapeHtml(display.platformName)})` : "";
  return `${display.emoji} ${escapeHtml(display.title)}${platform}`;
}

async function getDailyPublications(start: Date, end: Date): Promise<DailyPublication[]> {
  await ensureTaskQuotaSchema();
  const tasks = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      dueDate: tasksTable.dueDate,
      completedAt: tasksTable.completedAt,
      submissionUrl: tasksTable.submissionUrl,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
    })
    .from(tasksTable)
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(and(
      isNull(tasksTable.deletedAt),
      eq(tasksTable.status, "completed"),
      gte(tasksTable.dueDate, start),
      lte(tasksTable.dueDate, end),
    ))
    .orderBy(asc(platformsTable.name), asc(tasksTable.dueDate), asc(tasksTable.id));

  if (tasks.length === 0) return [];

  const taskIds = tasks.map((task) => task.id);
  const proofRows = await db
    .select({
      taskId: taskProofsTable.taskId,
      url: taskProofsTable.url,
      createdAt: taskProofsTable.createdAt,
    })
    .from(taskProofsTable)
    .where(and(
      inArray(taskProofsTable.taskId, taskIds),
      isNull(taskProofsTable.deletedAt),
    ))
    .orderBy(asc(taskProofsTable.createdAt), asc(taskProofsTable.id));

  const proofsByTask = new Map<number, string[]>();
  for (const proof of proofRows) {
    const url = proof.url?.trim();
    if (!url) continue;
    const urls = proofsByTask.get(proof.taskId) ?? [];
    urls.push(url);
    proofsByTask.set(proof.taskId, urls);
  }

  return tasks.flatMap((task) => {
    const proofUrls = proofsByTask.get(task.id);
    const urls = proofUrls && proofUrls.length > 0
      ? proofUrls
      : task.submissionUrl?.trim()
        ? [task.submissionUrl.trim()]
        : [];

    return urls.map((proofUrl, index) => ({
      ...task,
      proofUrl,
      proofIndex: index + 1,
      proofTotal: urls.length,
    }));
  });
}

function publicationLine(publication: DailyPublication) {
  const display = taskDisplayParts(publication);
  const proofLabel = publication.proofTotal > 1
    ? `الشاهد ${publication.proofIndex}:`
    : "الشاهد:";
  return [
    `• ${display.emoji} ${escapeHtml(display.title)}`,
    `  ${proofLabel} ${escapeHtml(publication.proofUrl)}`,
  ].join("\n");
}

function buildDailyPublicSummaryMessages(publications: DailyPublication[], now: Date) {
  const grouped = new Map<string, DailyPublication[]>();
  for (const publication of publications) {
    const key = publication.platformName || "منصة غير محددة";
    grouped.set(key, [...(grouped.get(key) ?? []), publication]);
  }

  const header = [
    "<b>منشورات اليوم — تلاوات الحرمين</b>",
    "",
    escapeHtml(formatRiyadhDateWithYear(now)),
    "",
    `إجمالي المنشورات: ${publications.length}`,
  ].join("\n");

  const sections = [...grouped.entries()].map(([platformName, rows]) => [
    `<b>${platformEmoji(platformName)} ${escapeHtml(platformName)}</b>`,
    "",
    ...rows.map(publicationLine),
  ].join("\n"));

  const messages: string[] = [];
  let current = header;

  for (const section of sections) {
    const next = `${current}\n\n${section}`;
    if (next.length > 3600 && current !== header) {
      messages.push(current);
      current = `${header}\n\n<b>متابعة المنشورات</b>\n\n${section}`;
    } else {
      current = next;
    }
  }

  if (current.trim()) messages.push(current);
  return messages;
}

async function sendDailyMemberReminders(settings: TelegramSettings, now: Date) {
  if (!settings.notifyDailyReminder || !isTimeReached(now, settings.dailyReminderTime)) return 0;
  const dateKey = riyadhDateKey(now);
  const { start, end } = riyadhDayRange(now);
  const tasks = await getTasksInRange(start, end);
  if (tasks.length === 0) return 0;

  const assignedMap = await getAssignedMembersMap(tasks);
  const memberIds = [...new Set([...assignedMap.values()].flat())];
  const recipients = await getMemberRecipients(memberIds);
  let sent = 0;

  for (const recipient of recipients) {
    if (!recipient.memberId) continue;
    const memberTasks = tasks.filter((task) => assignedMap.get(task.id)?.includes(recipient.memberId!));
    if (memberTasks.length === 0) continue;
    const completedTasks = memberTasks.filter((task) => task.status === "completed");
    const incompleteTasks = memberTasks.filter((task) => task.status !== "completed");
    const completedLines = completedTasks.length > 0
      ? ["✅ <b>مكتملة:</b>", ...completedTasks.map(taskLine)]
      : [];
    const incompleteLines = incompleteTasks.length > 0
      ? ["⏳ <b>غير مكتملة:</b>", ...incompleteTasks.map(taskLine)]
      : [];
    const text = [
      "<b>ملخص مهامك اليوم</b>",
      `التاريخ: ${escapeHtml(formatRiyadhDate(now))}`,
      "",
      ...completedLines,
      ...(completedLines.length > 0 && incompleteLines.length > 0 ? [""] : []),
      ...incompleteLines,
    ].join("\n");

    const result = await sendLoggedTelegram({
      type: "telegram_daily_reminder",
      dedupeKey: `telegram:daily_reminder:${dateKey}:member:${recipient.memberId}`,
      chatId: recipient.chatId,
      text,
      recipientUserId: recipient.userId,
      recipientMemberId: recipient.memberId,
    });
    if (result.sent) sent += 1;
  }
  return sent;
}

async function sendOverdueNotifications(settings: TelegramSettings, now: Date) {
  const cutoff = overdueCutoff(now, settings.overdueAfterTime);
  const dateKey = riyadhDateKey(now);
  const overdueTasks = await getOverdueTasks(cutoff);
  if (overdueTasks.length === 0) return 0;

  const admins = settings.notifyAdminOverdue ? await getAdminRecipients() : [];
  let sent = 0;

  for (const task of overdueTasks) {
    const assignedMemberIds = await getAssignedMemberIds(task.id, task.memberId);
    if (settings.notifyMemberOverdue) {
      const memberRecipients = await getMemberRecipients(assignedMemberIds);
      for (const recipient of memberRecipients) {
        const text = [
          "<b>تنبيه تأخر مهمة</b>",
          taskLine(task),
          `الاستحقاق: ${escapeHtml(formatRiyadhDate(task.dueDate))}`,
          "يرجى إكمال المهمة أو إضافة الشاهد عند الانتهاء.",
        ].join("\n");
        const result = await sendLoggedTelegram({
          type: "telegram_member_overdue",
          dedupeKey: `telegram:member_overdue:${dateKey}:task:${task.id}:member:${recipient.memberId}`,
          chatId: recipient.chatId,
          text,
          recipientUserId: recipient.userId,
          recipientMemberId: recipient.memberId,
          taskId: task.id,
        });
        if (result.sent) sent += 1;
      }
    }

    for (const admin of admins) {
      const text = [
        "<b>تنبيه للمدير: مهمة متأخرة</b>",
        taskLine(task),
        `العضو: ${escapeHtml(task.memberName)}`,
        `الاستحقاق: ${escapeHtml(formatRiyadhDate(task.dueDate))}`,
      ].join("\n");
      const result = await sendLoggedTelegram({
        type: "telegram_admin_overdue",
        dedupeKey: `telegram:admin_overdue:${dateKey}:task:${task.id}:admin:${admin.userId}`,
        chatId: admin.chatId,
        text,
        recipientUserId: admin.userId,
        recipientMemberId: admin.memberId,
        taskId: task.id,
      });
      if (result.sent) sent += 1;
    }
  }
  return sent;
}

async function sendAdminDailySummary(settings: TelegramSettings, now: Date) {
  if (!settings.notifyAdminDailySummary || !isTimeReached(now, settings.dailySummaryTime)) return 0;
  const dateKey = riyadhDateKey(now);
  const { start, end } = riyadhDayRange(now);
  const tasks = await getTasksInRange(start, end);
  const cutoff = overdueCutoff(now, settings.overdueAfterTime);
  const completed = tasks.filter((task) => task.status === "completed");
  const overdue = tasks.filter((task) => task.status !== "completed" && task.dueDate && task.dueDate <= cutoff);
  const incomplete = tasks.filter((task) => task.status !== "completed" && !overdue.some((overdueTask) => overdueTask.id === task.id));
  const admins = await getAdminRecipients();
  let sent = 0;

  for (const admin of admins) {
    const text = [
      "<b>ملخص المدير اليومي</b>",
      `التاريخ: ${escapeHtml(formatRiyadhDate(now))}`,
      "",
      `✅ المنجزة: ${completed.length}`,
      `⚠️ المتأخرة: ${overdue.length}`,
      `📝 غير المكتملة: ${incomplete.length}`,
      "",
      overdue.length > 0 ? "<b>المهام المتأخرة:</b>" : "",
      ...overdue.slice(0, 10).map((task) => `${taskLine(task)} — ${escapeHtml(task.memberName)}`),
      overdue.length > 10 ? `... و ${overdue.length - 10} مهمة أخرى` : "",
    ].filter(Boolean).join("\n");

    const result = await sendLoggedTelegram({
      type: "telegram_admin_daily_summary",
      dedupeKey: `telegram:admin_summary:${dateKey}:admin:${admin.userId}`,
      chatId: admin.chatId,
      text,
      recipientUserId: admin.userId,
      recipientMemberId: admin.memberId,
    });
    if (result.sent) sent += 1;
  }
  return sent;
}

async function sendDailyPublicSummary(settings: TelegramSettings, now: Date) {
  if (!settings.notifyDailyPublicSummary || !isTimeReached(now, settings.dailyPublicSummaryTime)) return 0;
  const dateKey = riyadhDateKey(now);
  const { start, end } = riyadhDayRange(now);
  const publications = await getDailyPublications(start, end);
  if (publications.length === 0) return 0;

  const admins = await getAdminRecipients();
  if (admins.length === 0) return 0;

  const messages = buildDailyPublicSummaryMessages(publications, now);
  let sent = 0;

  for (const admin of admins) {
    for (const [index, text] of messages.entries()) {
      const result = await sendLoggedTelegram({
        type: "telegram_daily_public_summary",
        dedupeKey: `telegram:daily_public_summary:${dateKey}:admin:${admin.userId}:part:${index + 1}`,
        chatId: admin.chatId,
        text,
        recipientUserId: admin.userId,
        recipientMemberId: admin.memberId,
      });
      if (result.sent) sent += 1;
    }
  }

  return sent;
}

export async function sendDailyPublicSummaryNow(userId: number, dateInput?: string, now = new Date()) {
  await ensureTelegramSchema();
  const recipient = await getRecipientForUser(userId);
  if (!recipient) throw new Error("لا يوجد ربط Telegram لهذا المستخدم");

  const { start, end, displayDate, dateKey } = riyadhDateInputRange(dateInput, now);
  const publications = await getDailyPublications(start, end);
  if (publications.length === 0) {
    return { sent: 0, publications: 0, messages: 0, date: dateKey };
  }

  const messages = buildDailyPublicSummaryMessages(publications, displayDate);
  const manualRunId = crypto.randomUUID();
  let sent = 0;
  let lastError: string | undefined;

  for (const [index, text] of messages.entries()) {
    const result = await sendLoggedTelegram({
      type: "telegram_daily_public_summary_manual",
      dedupeKey: `telegram:daily_public_summary_manual:${userId}:${manualRunId}:part:${index + 1}`,
      chatId: recipient.chatId,
      text,
      recipientUserId: recipient.userId,
      recipientMemberId: recipient.memberId,
    });
    if (result.sent) sent += 1;
    if (result.error) lastError = result.error;
  }

  if (sent === 0 && messages.length > 0) {
    throw new Error(lastError ?? "فشل إرسال ملخص منشورات اليوم");
  }

  return { sent, publications: publications.length, messages: messages.length, date: dateKey };
}

async function sendWeeklyQuotaReminders(settings: TelegramSettings, now: Date) {
  if (!settings.notifyDailyReminder || !isTimeReached(now, settings.dailyReminderTime)) return 0;
  const parts = riyadhParts(now);
  if (parts.weekday < 4) return 0; // يبدأ التنبيه من الخميس حتى نهاية الأسبوع.

  const { start, end } = riyadhWeekRange(now);
  const weekKey = riyadhWeekKey(now);
  const tasks = await getWeeklyQuotaReminderTasks(start, end);
  const incompleteQuotaTasks = tasks.filter((task) => {
    const required = Number(task.weeklyQuotaRequired ?? 0);
    return required > 0 && Number(task.proofCount ?? 0) < required;
  });
  if (incompleteQuotaTasks.length === 0) return 0;

  let sent = 0;
  for (const task of incompleteQuotaTasks) {
    const required = Number(task.weeklyQuotaRequired ?? 0);
    const done = Number(task.proofCount ?? 0);
    const remaining = Math.max(required - done, 0);
    const assignedMemberIds = await getAssignedMemberIds(task.id, task.memberId);
    const recipients = await getMemberRecipients(assignedMemberIds);

    for (const recipient of recipients) {
      if (!recipient.memberId) continue;
      const text = [
        "<b>تنبيه الهدف الأسبوعي</b>",
        taskLine(task),
        `المضاف: ${done}/${required}`,
        `المتبقي: ${remaining} شاهد`,
        `نهاية الأسبوع: ${escapeHtml(formatRiyadhDate(task.weeklyQuotaPeriodEnd ?? task.dueDate))}`,
        "يرجى إضافة الشواهد قبل انتهاء الأسبوع.",
      ].join("\n");

      const result = await sendLoggedTelegram({
        type: "telegram_weekly_quota_reminder",
        dedupeKey: `telegram:weekly_quota:${weekKey}:task:${task.id}:member:${recipient.memberId}`,
        chatId: recipient.chatId,
        text,
        recipientUserId: recipient.userId,
        recipientMemberId: recipient.memberId,
        taskId: task.id,
      });
      if (result.sent) sent += 1;
    }
  }

  return sent;
}

export async function notifyTelegramTaskCompleted(task: {
  id: number;
  title: string;
  memberId: number;
  submissionUrl?: string | null;
  completedAt?: Date | null;
}) {
  const settings = await getTelegramSettings();
  if (!settings.enabled || !settings.notifyAdminCompleted) return { sent: 0 };

  const admins = await getAdminRecipients();
  if (admins.length === 0) return { sent: 0 };

  const [details] = await db
    .select({
      memberName: membersTable.name,
      taskTitle: tasksTable.title,
      dueDate: tasksTable.dueDate,
      platformName: platformsTable.name,
      reciterName: recitersTable.name,
    })
    .from(tasksTable)
    .innerJoin(membersTable, eq(tasksTable.memberId, membersTable.id))
    .innerJoin(platformsTable, eq(tasksTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(tasksTable.reciterId, recitersTable.id))
    .where(eq(tasksTable.id, task.id))
    .limit(1);

  let sent = 0;
  for (const admin of admins) {
    const text = [
      "✅ <b>تم إكمال مهمة</b>",
      "",
      `👤 العضو: ${escapeHtml(details?.memberName ?? "غير معروف")}`,
      `🎬 المهمة: ${taskFieldLine({
        title: details?.taskTitle ?? task.title,
        platformName: details?.platformName ?? null,
        reciterName: details?.reciterName ?? null,
      })}`,
      `📅 الاستحقاق: ${escapeHtml(formatRiyadhDateWithYear(details?.dueDate ?? null))}`,
      `🕒 وقت الإكمال: ${escapeHtml(formatRiyadhDateTime(task.completedAt ?? new Date()))}`,
      task.submissionUrl ? `🔗 الشاهد: ${escapeHtml(task.submissionUrl)}` : "",
    ].filter(Boolean).join("\n");

    const result = await sendLoggedTelegram({
      type: "telegram_admin_task_completed",
      dedupeKey: `telegram:admin_completed:task:${task.id}:admin:${admin.userId}`,
      chatId: admin.chatId,
      text,
      recipientUserId: admin.userId,
      recipientMemberId: admin.memberId,
      taskId: task.id,
    });
    if (result.sent) sent += 1;
  }
  return { sent };
}

export async function notifyTelegramTaskAssigned(task: {
  id: number;
  title: string;
  memberId: number;
  dueDate?: Date | null;
  reciterName?: string | null;
  platformName?: string | null;
}) {
  const settings = await getTelegramSettings();
  if (!settings.enabled) return { sent: 0 };

  const recipients = await getMemberRecipients([task.memberId]);
  if (recipients.length === 0) return { sent: 0 };

  let sent = 0;
  for (const recipient of recipients) {
    const text = [
      "<b>تم إسناد مهمة إليك</b>",
      `المهمة: ${taskFieldLine({
        title: task.title,
        platformName: task.platformName ?? null,
        reciterName: task.reciterName ?? null,
      })}`,
      task.reciterName ? `القارئ: ${escapeHtml(task.reciterName)}` : "",
      task.platformName ? `المنصة: ${escapeHtml(task.platformName)}` : "",
      `التاريخ: ${escapeHtml(formatRiyadhDate(task.dueDate ?? null))}`,
    ].filter(Boolean).join("\n");

    const result = await sendLoggedTelegram({
      type: "telegram_task_assigned",
      dedupeKey: `telegram:task_assigned:${task.id}:member:${task.memberId}:${Date.now()}`,
      chatId: recipient.chatId,
      text,
      recipientUserId: recipient.userId,
      recipientMemberId: recipient.memberId,
      taskId: task.id,
    });
    if (result.sent) sent += 1;
  }
  return { sent };
}

export async function notifyTelegramTaskDependencyReady(input: {
  dependencyId: number;
  memberIds: number[];
  prerequisite: Pick<TaskRow, "id" | "title" | "dueDate" | "platformName" | "reciterName">;
  dependent: Pick<TaskRow, "id" | "title" | "dueDate" | "platformName" | "reciterName">;
}) {
  const settings = await getTelegramSettings();
  if (!settings.enabled) return { sent: 0 };

  const recipients = await getMemberRecipients(input.memberIds);
  if (recipients.length === 0) return { sent: 0 };

  let sent = 0;
  for (const recipient of recipients) {
    if (!recipient.memberId) continue;
    const text = [
      "✅ <b>اكتملت المهمة السابقة</b>",
      "",
      "تم إكمال:",
      taskFieldLine(input.prerequisite),
      "",
      "يمكنك الآن تنفيذ مهمتك:",
      taskFieldLine(input.dependent),
      `📅 التاريخ: ${escapeHtml(formatRiyadhDate(input.dependent.dueDate ?? null))}`,
      `فتح المهمة: /tasks/${input.dependent.id}`,
    ].join("\n");

    const result = await sendLoggedTelegram({
      type: "telegram_task_dependency_ready",
      dedupeKey: `telegram:dependency_ready:${input.dependencyId}:member:${recipient.memberId}`,
      chatId: recipient.chatId,
      text,
      recipientUserId: recipient.userId,
      recipientMemberId: recipient.memberId,
      taskId: input.dependent.id,
    });
    if (result.sent) sent += 1;
  }
  return { sent };
}

export async function runTelegramNotificationCycle(now = new Date()) {
  await ensureTelegramSchema();
  const settings = await getTelegramSettings();
  if (!settings.enabled) return { enabled: false, sent: 0 };

  const daily = await sendDailyMemberReminders(settings, now);
  const overdue = await sendOverdueNotifications(settings, now);
  const weeklyQuota = await sendWeeklyQuotaReminders(settings, now);
  const summary = await sendAdminDailySummary(settings, now);
  const publicSummary = await sendDailyPublicSummary(settings, now);

  return {
    enabled: true,
    sent: daily + overdue + weeklyQuota + summary + publicSummary,
    daily,
    overdue,
    weeklyQuota,
    summary,
    publicSummary,
  };
}

export async function listTelegramLogs(limit = 100) {
  await ensureTelegramSchema();
  return db
    .select()
    .from(notificationLogsTable)
    .where(eq(notificationLogsTable.channel, "telegram"))
    .orderBy(desc(notificationLogsTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function listTelegramRecipients() {
  await ensureTelegramSchema();
  return db
    .select({
      id: telegramRecipientsTable.id,
      userId: telegramRecipientsTable.userId,
      memberId: telegramRecipientsTable.memberId,
      chatId: telegramRecipientsTable.chatId,
      telegramUsername: telegramRecipientsTable.telegramUsername,
      isEnabled: telegramRecipientsTable.isEnabled,
      linkedAt: telegramRecipientsTable.linkedAt,
      memberName: membersTable.name,
      displayName: usersTable.displayName,
      username: usersTable.username,
    })
    .from(telegramRecipientsTable)
    .leftJoin(usersTable, eq(telegramRecipientsTable.userId, usersTable.id))
    .leftJoin(membersTable, eq(telegramRecipientsTable.memberId, membersTable.id))
    .orderBy(desc(telegramRecipientsTable.linkedAt));
}

export async function createTelegramLinkToken(input: { userId: number; requestedByUserId: number; requestedByRole: string }) {
  await ensureTelegramSchema();
  if (input.requestedByRole !== "admin" && input.userId !== input.requestedByUserId) {
    throw new Error("غير مصرح بإنشاء رمز ربط لمستخدم آخر");
  }

  const [user] = await db
    .select({ id: usersTable.id, memberId: usersTable.memberId })
    .from(usersTable)
    .where(eq(usersTable.id, input.userId))
    .limit(1);
  if (!user) throw new Error("المستخدم غير موجود");

  const token = crypto.randomBytes(LINK_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await db.insert(telegramLinkTokensTable).values({
    tokenHash: tokenHash(token),
    userId: user.id,
    memberId: user.memberId,
    expiresAt,
  });

  return { token, expiresAt };
}

export async function linkTelegramChat(input: {
  token: string;
  chatId: string;
  telegramUsername?: string | null;
}) {
  await ensureTelegramSchema();
  const hash = tokenHash(input.token);
  const [linkToken] = await db
    .select()
    .from(telegramLinkTokensTable)
    .where(and(
      eq(telegramLinkTokensTable.tokenHash, hash),
      isNull(telegramLinkTokensTable.usedAt),
      gte(telegramLinkTokensTable.expiresAt, new Date()),
    ))
    .limit(1);

  if (!linkToken?.userId) throw new Error("رمز الربط غير صالح أو منتهي");

  await db.transaction(async (tx: any) => {
    await tx
      .insert(telegramRecipientsTable)
      .values({
        userId: linkToken.userId,
        memberId: linkToken.memberId,
        chatId: input.chatId,
        telegramUsername: input.telegramUsername ?? null,
        isEnabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: telegramRecipientsTable.chatId,
        set: {
          userId: linkToken.userId,
          memberId: linkToken.memberId,
          telegramUsername: input.telegramUsername ?? null,
          isEnabled: true,
          updatedAt: new Date(),
        },
      });

    await tx
      .update(telegramLinkTokensTable)
      .set({ usedAt: new Date() })
      .where(eq(telegramLinkTokensTable.id, linkToken.id));
  });

  return { linked: true };
}

export async function disconnectTelegramForUser(userId: number) {
  await ensureTelegramSchema();
  await db
    .update(telegramRecipientsTable)
    .set({ isEnabled: false, updatedAt: new Date() })
    .where(eq(telegramRecipientsTable.userId, userId));
}

async function getRecipientForUser(userId: number) {
  const [recipient] = await getMemberRecipients().then((recipients) => recipients.filter((row) => row.userId === userId));
  return recipient ?? null;
}

export async function sendTelegramTestMessage(userId: number) {
  await ensureTelegramSchema();
  const recipient = await getRecipientForUser(userId);
  if (!recipient) throw new Error("لا يوجد ربط Telegram لهذا المستخدم");

  const result = await sendLoggedTelegram({
    type: "telegram_test",
    dedupeKey: `telegram:test:${userId}:${Date.now()}`,
    chatId: recipient.chatId,
    text: "<b>اختبار Telegram</b>\nتم إرسال هذه الرسالة من نظام إدارة مهام تلاوة الحرمين.",
    recipientUserId: recipient.userId,
    recipientMemberId: recipient.memberId,
  });

  if (!result.sent) throw new Error(result.error ?? "فشل إرسال رسالة الاختبار");
  return result;
}

export async function sendTelegramPasswordReset(input: {
  userId: number;
  displayName: string;
  resetLink: string;
  expiresAt: Date;
}) {
  await ensureTelegramSchema();
  const recipient = await getRecipientForUser(input.userId);
  if (!recipient) return { sent: false, skipped: true, reason: "not_linked" };

  const text = [
    "🔐 <b>استعادة كلمة المرور</b>",
    "",
    `مرحبًا ${escapeHtml(input.displayName)}،`,
    "وصلنا طلبًا لإعادة تعيين كلمة مرور حسابك في نظام مهام تلاوة الحرمين.",
    "",
    `ينتهي الرابط: ${escapeHtml(formatRiyadhDateTime(input.expiresAt))}`,
    "",
    `رابط إعادة التعيين:\n${escapeHtml(input.resetLink)}`,
    "",
    "إذا لم تطلب هذا الإجراء، تجاهل هذه الرسالة.",
  ].join("\n");

  return sendLoggedTelegram({
    type: "telegram_password_reset",
    dedupeKey: `telegram:password_reset:user:${input.userId}:${Date.now()}`,
    chatId: recipient.chatId,
    text,
    replyMarkup: /^https?:\/\//i.test(input.resetLink)
      ? { inline_keyboard: [[{ text: "🔐 إعادة تعيين كلمة المرور", url: input.resetLink }]] }
      : undefined,
    recipientUserId: recipient.userId,
    recipientMemberId: recipient.memberId,
  });
}
