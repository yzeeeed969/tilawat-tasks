import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { tasksTable } from "./tasks";
import { usersTable } from "./users";

export const taskProofsTable = pgTable("task_proofs", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  note: text("note"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_task_proofs_task_id").on(table.taskId),
  index("idx_task_proofs_created_by_user_id").on(table.createdByUserId),
]);

export type TaskProof = typeof taskProofsTable.$inferSelect;
