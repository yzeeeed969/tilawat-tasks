import { pgTable, serial, integer, bigint, text, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { platformsTable } from "./platforms";
import { recitersTable } from "./reciters";
import { tasksTable } from "./tasks";
import { taskProofsTable } from "./task-proofs";
import { usersTable } from "./users";

// إعدادات مراقبة قناة تلقرام العامة (صف واحد — النطاق قناة واحدة حاليًا).
export const telegramMonitorSettingsTable = pgTable("telegram_monitor_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  // مفعَّل افتراضيًا: يسجّل ما كان سيفعله دون توثيق فعلي حتى يُطفأ يدويًا.
  trialMode: boolean("trial_mode").notNull().default(true),
  channelChatId: text("channel_chat_id"),
  channelTitle: text("channel_title"),
  channelUsername: text("channel_username"),
  // منصة تلقرام للمهام العامة (بلا قارئ، بالمسجد)، ومنصة التطبيق (مهام القرّاء).
  telegramPlatformId: integer("telegram_platform_id").references(() => platformsTable.id, { onDelete: "set null" }),
  appPlatformId: integer("app_platform_id").references(() => platformsTable.id, { onDelete: "set null" }),
  // المنشورات قبل هذا الوقت لا تُعالَج (تُضبط عند تسجيل القناة).
  monitoringStartedAt: timestamp("monitoring_started_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// كل منشور رآه المراقب من القناة المسجّلة. (chat_id + message_id) فريد — ضمان عدم معالجته مرتين.
// لكل منشور نتيجتان مستقلتان: جانب تلقرام (المهمة العامة) وجانب التطبيق (مهمة القارئ)،
// لكلٍّ حالته وسببه ومهمته وشاهده، فيُراجَع ويُتراجَع عن كل جانب على حدة.
// الحالات (لكل جانب): pending، not_applicable، documented، needs_review، no_task، ignored_manual،
// reverted، trial_would_document، trial_would_review، trial_no_task.
export const telegramChannelPostsTable = pgTable("telegram_channel_posts", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  publishedAt: timestamp("published_at").notNull(),
  editedAt: timestamp("edited_at"),
  caption: text("caption"),
  hashtags: jsonb("hashtags"),
  siteUrl: text("site_url"),
  postUrl: text("post_url"),
  kind: text("kind").notNull().default("pending"), // pending | recitation | other
  ignoreReason: text("ignore_reason"),
  reciterId: integer("reciter_id").references(() => recitersTable.id, { onDelete: "set null" }),
  mosque: text("mosque"),
  extractedPrayer: text("extracted_prayer"),
  hijriDay: integer("hijri_day"),
  hijriMonth: integer("hijri_month"),
  hijriYear: integer("hijri_year"),
  parseError: text("parse_error"),
  editedAfterDocumented: boolean("edited_after_documented").notNull().default(false),
  telegramStatus: text("telegram_status").notNull().default("pending"),
  telegramReason: text("telegram_reason"),
  telegramTaskId: integer("telegram_task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  telegramProofId: integer("telegram_proof_id").references(() => taskProofsTable.id, { onDelete: "set null" }),
  appStatus: text("app_status").notNull().default("pending"),
  appReason: text("app_reason"),
  appTaskId: integer("app_task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  appProofId: integer("app_proof_id").references(() => taskProofsTable.id, { onDelete: "set null" }),
  processedAt: timestamp("processed_at"),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_telegram_channel_posts_message").on(table.chatId, table.messageId),
  index("idx_telegram_channel_posts_published").on(table.publishedAt),
]);

// ربط هاشتاق (مطبَّع) بقارئ — حين لا يطابق الهاشتاق اسم القارئ في قاعدة البيانات حرفيًا.
export const telegramHashtagAliasesTable = pgTable("telegram_hashtag_aliases", {
  id: serial("id").primaryKey(),
  hashtag: text("hashtag").notNull(),
  reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_telegram_hashtag_aliases_hashtag").on(table.hashtag),
]);

// محادثات أُضيف إليها البوت أو وصل منها منشور ولم تُسجَّل بعد — للعرض والتسجيل فقط، لا تُعالَج.
export const telegramSeenChatsTable = pgTable("telegram_seen_chats", {
  chatId: text("chat_id").primaryKey(),
  title: text("title"),
  username: text("username"),
  type: text("type"),
  botStatus: text("bot_status"),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
});

export type TelegramChannelPost = typeof telegramChannelPostsTable.$inferSelect;
export type TelegramMonitorSettings = typeof telegramMonitorSettingsTable.$inferSelect;
