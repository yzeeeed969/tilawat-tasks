import { pgTable, integer, primaryKey } from "drizzle-orm/pg-core";
import { tasksTable } from "./tasks";
import { membersTable } from "./members";

export const taskMembersTable = pgTable(
  "task_members",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.memberId] })]
);
