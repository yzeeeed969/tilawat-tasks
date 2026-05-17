import { pgTable, serial, text, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const platformsTable = pgTable("platforms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  color: text("color").notNull(),
  isMain: boolean("is_main").notNull().default(false),
});

export const insertPlatformSchema = createInsertSchema(platformsTable).omit({ id: true });
export type InsertPlatform = z.infer<typeof insertPlatformSchema>;
export type Platform = typeof platformsTable.$inferSelect;
