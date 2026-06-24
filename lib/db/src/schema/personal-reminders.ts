import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const personalRemindersTable = pgTable("personal_reminders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  remindAt: timestamp("remind_at").notNull(),
  timezone: text("timezone").notNull().default("Asia/Riyadh"),
  status: text("status").notNull().default("active"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_personal_reminders_user_id").on(table.userId),
  index("idx_personal_reminders_active_due").on(table.status, table.remindAt),
]);

export type PersonalReminder = typeof personalRemindersTable.$inferSelect;
