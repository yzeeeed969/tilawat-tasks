import { pgTable, serial, varchar, text, boolean, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

export const usersTable = pgTable("app_users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: varchar("display_name", { length: 100 }),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  isApproved: boolean("is_approved").notNull().default(false),
  isFrozen: boolean("is_frozen").notNull().default(false),
  email: varchar("email", { length: 200 }),
  twoFaEnabled: boolean("two_fa_enabled").notNull().default(false),
  memberId: integer("member_id"),
  permissions: jsonb("permissions"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AppUser = typeof usersTable.$inferSelect;
