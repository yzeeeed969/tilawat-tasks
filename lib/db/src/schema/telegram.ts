import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { membersTable } from "./members";
import { tasksTable } from "./tasks";

export const telegramSettingsTable = pgTable("telegram_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  dailyReminderTime: text("daily_reminder_time").notNull().default("09:00"),
  dailySummaryTime: text("daily_summary_time").notNull().default("21:00"),
  overdueAfterTime: text("overdue_after_time").notNull().default("23:59"),
  timezone: text("timezone").notNull().default("Asia/Riyadh"),
  notifyDailyReminder: boolean("notify_daily_reminder").notNull().default(true),
  notifyMemberOverdue: boolean("notify_member_overdue").notNull().default(true),
  notifyAdminOverdue: boolean("notify_admin_overdue").notNull().default(true),
  notifyAdminCompleted: boolean("notify_admin_completed").notNull().default(true),
  notifyAdminDailySummary: boolean("notify_admin_daily_summary").notNull().default(true),
  suppressRepeatHours: integer("suppress_repeat_hours").notNull().default(24),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const telegramRecipientsTable = pgTable("telegram_recipients", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").references(() => membersTable.id, { onDelete: "cascade" }),
  chatId: text("chat_id").notNull(),
  telegramUsername: text("telegram_username"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  linkedAt: timestamp("linked_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_telegram_recipients_chat_id").on(table.chatId),
  index("idx_telegram_recipients_user_id").on(table.userId),
  index("idx_telegram_recipients_member_id").on(table.memberId),
]);

export const telegramLinkTokensTable = pgTable("telegram_link_tokens", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").references(() => membersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_telegram_link_tokens_hash").on(table.tokenHash),
  index("idx_telegram_link_tokens_user_id").on(table.userId),
]);

export const notificationLogsTable = pgTable("notification_logs", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull().default("telegram"),
  type: text("type").notNull(),
  recipientUserId: integer("recipient_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  recipientMemberId: integer("recipient_member_id").references(() => membersTable.id, { onDelete: "set null" }),
  taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").notNull().default("pending"),
  failureReason: text("failure_reason"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_notification_logs_dedupe_key").on(table.dedupeKey),
  index("idx_notification_logs_type").on(table.type),
  index("idx_notification_logs_task_id").on(table.taskId),
]);

export type TelegramSettings = typeof telegramSettingsTable.$inferSelect;
export type TelegramRecipient = typeof telegramRecipientsTable.$inferSelect;
export type NotificationLog = typeof notificationLogsTable.$inferSelect;
