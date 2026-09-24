import { pgTable, serial, boolean, integer, timestamp } from "drizzle-orm/pg-core";

// صف إعدادات واحد (نمط telegram_settings نفسه). مفتاح الإيقاف العام ووضع التجربة هنا.
export const youtubeSettingsTable = pgTable("youtube_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  // مفعَّل افتراضيًا عند أول تشغيل: يسجّل القرارات دون توثيق فعلي حتى يُطفأ يدويًا من صفحة الإدارة.
  trialMode: boolean("trial_mode").notNull().default(true),
  checkIntervalMinutes: integer("check_interval_minutes").notNull().default(10),
  // علامة داخلية لمرة واحدة: هل تمت إعادة فحص المقاطع القصيرة التي تجاهلها خلل سابق رغم حملها
  // العلامة *1؟ تمنع تكرار إعادة الفحص في كل إقلاع بعد أن تُنفَّذ مرة واحدة.
  shortDurationMarkerBackfillDone: boolean("short_duration_marker_backfill_done").notNull().default(false),
  // علامة داخلية لمرة واحدة منفصلة: هل أُعيد فحص المقاطع التي وصلت لحالة "لم تُوثَّق" (مراجعة/بلا
  // مهمة) بسبب خلل تفسير توقيت due_date عند حساب التاريخ الهجري؟ لا تتعارض مع العلامة أعلاه.
  dueDateTimezoneBackfillDone: boolean("due_date_timezone_backfill_done").notNull().default(false),
  // علامة داخلية لمرة واحدة منفصلة: هل أُعيد فحص المقاطع التي فشلت مطابقة اسم الشيخ فيها بسبب
  // كتابته كوسم يوتيوب (# و_) بدل مسافة عادية؟ لا تتعارض مع العلامتين أعلاه.
  hashtagNameBackfillDone: boolean("hashtag_name_backfill_done").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type YoutubeSettings = typeof youtubeSettingsTable.$inferSelect;
