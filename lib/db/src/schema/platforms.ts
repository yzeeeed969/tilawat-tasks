import { pgTable, serial, text, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const platformsTable = pgTable("platforms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  color: text("color").notNull(),
  isMain: boolean("is_main").notNull().default(false),
  baselinePostsCount: integer("baseline_posts_count").notNull().default(0),
  // المنصة تشمل كل القرّاء (تطبيق تلاوات الحرمين): القارئ متاح عليها دائمًا في النيابة حتى بلا صفحة خاصة به.
  coversAllReciters: boolean("covers_all_reciters").notNull().default(false),
});

export const insertPlatformSchema = createInsertSchema(platformsTable).omit({ id: true });
export type InsertPlatform = z.infer<typeof insertPlatformSchema>;
export type Platform = typeof platformsTable.$inferSelect;
