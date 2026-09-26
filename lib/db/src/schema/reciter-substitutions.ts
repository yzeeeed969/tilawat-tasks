import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { recitersTable } from "./reciters";
import { tasksTable } from "./tasks";
import { usersTable } from "./users";

// عملية نيابة واحدة: قارئ ينوب عن قارئ في نطاق من الفروض (فرض / أيام محددة / لآخر الأسبوع).
// كل ما غيّرته العملية محفوظ في reciter_substitution_items بلقطة «قبل» كاملة، فيمكن التراجع عنها كلها.
export const reciterSubstitutionsTable = pgTable("reciter_substitutions", {
  id: serial("id").primaryKey(),
  baseTaskId: integer("base_task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  fromReciterId: integer("from_reciter_id").references(() => recitersTable.id, { onDelete: "set null" }),
  toReciterId: integer("to_reciter_id").references(() => recitersTable.id, { onDelete: "set null" }),
  scopeKind: text("scope_kind").notNull(), // single | dates | rest_of_week
  // الفروض المختارة: [{ date: "YYYY-MM-DD", prayer: "maghrib" | null, creationGroupId: number | null }]
  slots: jsonb("slots").notNull(),
  status: text("status").notNull().default("applied"), // applied | undone
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  undoneAt: timestamp("undone_at"),
  undoneByUserId: integer("undone_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
});

// أثر النيابة على مهمة واحدة. before/after لقطتان كاملتان للحقول التي تمسّها النيابة:
// { reciterId, memberId, memberIds, pageId, title, deletedAt, substitutionId, originalReciterId }
export const reciterSubstitutionItemsTable = pgTable("reciter_substitution_items", {
  id: serial("id").primaryKey(),
  substitutionId: integer("substitution_id").notNull().references(() => reciterSubstitutionsTable.id, { onDelete: "cascade" }),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(), // reassigned | deleted | created
  before: jsonb("before"),
  after: jsonb("after"),
  undoneAt: timestamp("undone_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_reciter_substitution_items_substitution").on(table.substitutionId),
  index("idx_reciter_substitution_items_task").on(table.taskId),
]);

export type ReciterSubstitution = typeof reciterSubstitutionsTable.$inferSelect;
export type ReciterSubstitutionItem = typeof reciterSubstitutionItemsTable.$inferSelect;
