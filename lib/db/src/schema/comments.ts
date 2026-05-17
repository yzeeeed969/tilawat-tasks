import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { tasksTable } from "./tasks";
import { membersTable } from "./members";

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").references(() => membersTable.id, { onDelete: "set null" }),
  authorName: text("author_name").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Comment = typeof commentsTable.$inferSelect;
