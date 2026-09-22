import { pgTable, serial, boolean, integer, timestamp } from "drizzle-orm/pg-core";

// صف إعدادات واحد (نمط telegram_settings نفسه). مفتاح الإيقاف العام ووضع التجربة هنا.
export const youtubeSettingsTable = pgTable("youtube_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  // مفعَّل افتراضيًا عند أول تشغيل: يسجّل القرارات دون توثيق فعلي حتى يُطفأ يدويًا من صفحة الإدارة.
  trialMode: boolean("trial_mode").notNull().default(true),
  checkIntervalMinutes: integer("check_interval_minutes").notNull().default(10),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type YoutubeSettings = typeof youtubeSettingsTable.$inferSelect;
