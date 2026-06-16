import { integer, pgTable, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { membersTable } from "./members";
import { reciterTaskFlowRulesTable } from "./reciter-task-flow-rules";

export const reciterTaskFlowRuleAssigneesTable = pgTable(
  "reciter_task_flow_rule_assignees",
  {
    ruleId: integer("rule_id").notNull().references(() => reciterTaskFlowRulesTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ruleId, table.memberId] })],
);

export type ReciterTaskFlowRuleAssignee = typeof reciterTaskFlowRuleAssigneesTable.$inferSelect;
