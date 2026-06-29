import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { platformsTable } from "./platforms";
import { recitersTable } from "./reciters";

export const taskGenerationBatchesTable = pgTable("task_generation_batches", {
  id: serial("id").primaryKey(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  sourcePlatformId: integer("source_platform_id").notNull().references(() => platformsTable.id, { onDelete: "restrict" }),
  reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "restrict" }),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_task_generation_batches_created_by").on(table.createdByUserId),
  index("idx_task_generation_batches_reciter").on(table.reciterId),
]);

export type TaskGenerationBatch = typeof taskGenerationBatchesTable.$inferSelect;
