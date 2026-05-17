import { pgTable, serial, integer, varchar, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const otpCodesTable = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 6 }).notNull(),
  tempToken: varchar("temp_token", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
