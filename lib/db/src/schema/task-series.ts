import { pgTable, serial, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const taskSeriesRecurrenceEnum = pgEnum("task_series_recurrence", ["none", "weekly", "monthly"]);
export const taskSeriesTypeEnum = pgEnum("task_series_type", ["temporary", "operational"]);
export const taskSeriesStatusEnum = pgEnum("task_series_status", ["active", "paused", "stopped"]);

export const taskSeriesTable = pgTable("task_series", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  recurrenceType: taskSeriesRecurrenceEnum("recurrence_type").notNull().default("none"),
  seriesType: taskSeriesTypeEnum("series_type").notNull().default("temporary"),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  generateUntil: timestamp("generate_until"),
  status: taskSeriesStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type TaskSeries = typeof taskSeriesTable.$inferSelect;
