import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tasksTable } from "./tasks";

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // task_assigned | task_completed | task_overdue | due_soon | task_updated | message
  title: text("title").notNull(),
  body: text("body"),
  taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  isRead: boolean("is_read").notNull().default(false),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Notification = typeof notificationsTable.$inferSelect;
