import { pgTable, serial, text, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { platformsTable } from "./platforms";
import { recitersTable } from "./reciters";

// قناة يوتيوب مراقَبة. صف واحد لكل قناة — إضافة قناة جديدة = صف جديد، بلا كود إضافي.
export const youtubeChannelsTable = pgTable("youtube_channels", {
  id: serial("id").primaryKey(),
  handle: text("handle").notNull(), // مثل "@Bandarbalilaah"
  displayName: text("display_name").notNull(),
  // الصيغة الثابتة لاسم الشيخ في عناوين هذه القناة تحديدًا (مثل "بندر بليلة") — تُقرأ من عنوان كل مقطع.
  reciterNameConstant: text("reciter_name_constant").notNull(),
  platformId: integer("platform_id").notNull().references(() => platformsTable.id, { onDelete: "cascade" }),
  reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  // تُملأ تلقائيًا عند أول فحص ناجح عبر channels.list?forHandle=
  channelId: text("channel_id"),
  uploadsPlaylistId: text("uploads_playlist_id"),
  lastCheckedAt: timestamp("last_checked_at"),
  // المقاطع المنشورة قبل هذا الوقت تُعتبر سجلًا قديمًا ولا تُعالَج إطلاقًا (تُضبط عند إنشاء الصف).
  monitoringStartedAt: timestamp("monitoring_started_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_youtube_channels_handle").on(table.handle),
]);

export type YoutubeChannel = typeof youtubeChannelsTable.$inferSelect;
