import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  userName: text("user_name"),
  action: text("action").notNull(), // task_created | task_updated | task_deleted | task_completed | task_restored | member_created | member_deleted | platform_created | user_login
  entityType: text("entity_type"), // task | member | platform | user
  entityId: integer("entity_id"),
  entityName: text("entity_name"),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ActivityLog = typeof activityLogTable.$inferSelect;
