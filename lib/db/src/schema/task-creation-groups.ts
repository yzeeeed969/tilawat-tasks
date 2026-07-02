import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const taskCreationGroupsTable = pgTable("task_creation_groups", {
  id: serial("id").primaryKey(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_task_creation_groups_created_by").on(table.createdByUserId),
]);

export type TaskCreationGroup = typeof taskCreationGroupsTable.$inferSelect;
