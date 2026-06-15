import { boolean, index, integer, pgTable, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { platformPagesTable } from "./platform-pages";
import { recitersTable } from "./reciters";

export const reciterTaskFlowRulesTable = pgTable("reciter_task_flow_rules", {
  id: serial("id").primaryKey(),
  reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "cascade" }),
  pageId: integer("page_id").notNull().references(() => platformPagesTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("reciter_task_flow_rules_reciter_page_unique").on(table.reciterId, table.pageId),
  index("reciter_task_flow_rules_reciter_idx").on(table.reciterId),
]);

export type ReciterTaskFlowRule = typeof reciterTaskFlowRulesTable.$inferSelect;
