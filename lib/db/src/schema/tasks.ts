import { pgTable, serial, text, integer, timestamp, pgEnum, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { membersTable } from "./members";
import { platformsTable } from "./platforms";
import { platformPagesTable } from "./platform-pages";
import { recitersTable } from "./reciters";
import { taskSeriesTable } from "./task-series";
import { taskGenerationBatchesTable } from "./task-generation-batches";

export const taskStatusEnum = pgEnum("task_status", ["pending", "in_progress", "completed"]);
export const taskRecurrenceEnum = pgEnum("task_recurrence", ["none", "daily", "weekly", "monthly", "custom_days"]);
export const taskPriorityEnum = pgEnum("task_priority", ["urgent", "normal", "low"]);

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").references(() => taskSeriesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  platformId: integer("platform_id").notNull().references(() => platformsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
  reciterId: integer("reciter_id").references(() => recitersTable.id, { onDelete: "set null" }),
  status: taskStatusEnum("status").notNull().default("pending"),
  priority: taskPriorityEnum("priority").notNull().default("normal"),
  progress: integer("progress").notNull().default(0),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  dueDate: timestamp("due_date"),
  completedAt: timestamp("completed_at"),
  recurrence: taskRecurrenceEnum("recurrence").notNull().default("none"),
  recurrenceIntervalDays: integer("recurrence_interval_days"),
  recurrenceDurationDays: integer("recurrence_duration_days"),
  recurrenceDays: text("recurrence_days"),
  weeklyQuotaRequired: integer("weekly_quota_required"),
  weeklyQuotaPeriodStart: timestamp("weekly_quota_period_start"),
  weeklyQuotaPeriodEnd: timestamp("weekly_quota_period_end"),
  source: text("source").notNull().default("admin_created"),
  generationBatchId: integer("generation_batch_id").references(() => taskGenerationBatchesTable.id, { onDelete: "set null" }),
  lastRecurredAt: timestamp("last_recurred_at"),
  submissionUrl: text("submission_url"),
  pageId: integer("page_id").references(() => platformPagesTable.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_tasks_series_id").on(table.seriesId),
  uniqueIndex("uq_tasks_series_due_date").on(table.seriesId, table.dueDate),
]);

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
