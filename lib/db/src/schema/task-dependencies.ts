import { pgTable, serial, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tasksTable } from "./tasks";

export const taskDependenciesTable = pgTable("task_dependencies", {
  id: serial("id").primaryKey(),
  prerequisiteTaskId: integer("prerequisite_task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  dependentTaskId: integer("dependent_task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_task_dependencies_pair").on(table.prerequisiteTaskId, table.dependentTaskId),
  index("idx_task_dependencies_prerequisite").on(table.prerequisiteTaskId),
  index("idx_task_dependencies_dependent").on(table.dependentTaskId),
]);

export type TaskDependency = typeof taskDependenciesTable.$inferSelect;
