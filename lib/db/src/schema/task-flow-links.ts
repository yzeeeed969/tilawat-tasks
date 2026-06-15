import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { platformsTable } from "./platforms";
import { platformPagesTable } from "./platform-pages";
import { recitersTable } from "./reciters";
import { tasksTable } from "./tasks";
import { usersTable } from "./users";

export const taskFlowLinksTable = pgTable(
  "task_flow_links",
  {
    id: serial("id").primaryKey(),
    parentTaskId: integer("parent_task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
    childTaskId: integer("child_task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
    reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "cascade" }),
    sourcePageId: integer("source_page_id").references(() => platformPagesTable.id, { onDelete: "set null" }),
    targetPageId: integer("target_page_id").notNull().references(() => platformPagesTable.id, { onDelete: "cascade" }),
    targetPlatformId: integer("target_platform_id").notNull().references(() => platformsTable.id, { onDelete: "cascade" }),
    flowDate: timestamp("flow_date").notNull(),
    batchKey: text("batch_key").notNull(),
    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    childTaskUnique: uniqueIndex("uq_task_flow_links_child_task").on(table.childTaskId),
    parentTargetDateUnique: uniqueIndex("uq_task_flow_links_parent_target_date").on(
      table.parentTaskId,
      table.targetPageId,
      table.flowDate,
    ),
    parentTaskIdx: index("idx_task_flow_links_parent_task").on(table.parentTaskId),
    childTaskIdx: index("idx_task_flow_links_child_task").on(table.childTaskId),
  }),
);

export type TaskFlowLink = typeof taskFlowLinksTable.$inferSelect;
