import { pgTable, serial, integer, varchar, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const resetTokensTable = pgTable("reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
