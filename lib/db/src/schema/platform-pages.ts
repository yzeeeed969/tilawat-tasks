import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { platformsTable } from "./platforms";
import { recitersTable } from "./reciters";

export const platformPagesTable = pgTable("platform_pages", {
  id: serial("id").primaryKey(),
  platformId: integer("platform_id").notNull().references(() => platformsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  reciterId: integer("reciter_id").references(() => recitersTable.id, { onDelete: "set null" }),
  pageUrl: text("page_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPlatformPageSchema = createInsertSchema(platformPagesTable).omit({ id: true, createdAt: true });
export type InsertPlatformPage = z.infer<typeof insertPlatformPageSchema>;
export type PlatformPage = typeof platformPagesTable.$inferSelect;
