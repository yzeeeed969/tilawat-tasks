import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { platformsTable } from "./platforms";
import { platformPagesTable } from "./platform-pages";
import { recitersTable } from "./reciters";
import { membersTable } from "./members";
import { tasksTable } from "./tasks";
import { taskProofsTable } from "./task-proofs";
import { usersTable } from "./users";

// مراقبة إنستقرام (Instagram API with Instagram Login). المطابقة بالحساب فقط: لكل قارئ حساب احترافي
// مربوط بصفحته على منصة إنستقرام. أول منشور في الأسبوع (الأحد→السبت بتوقيت الرياض) يُنشئ مهمة الأسبوع
// من قالب الحساب ويوثّقها، والمنشورات التالية شواهد إضافية لنفس المهمة.

export const instagramSettingsTable = pgTable("instagram_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  // وضع التجربة: يُسجّل ما كان سيحدث دون إنشاء مهام أو شواهد.
  trialMode: boolean("trial_mode").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const instagramAccountsTable = pgTable("instagram_accounts", {
  id: serial("id").primaryKey(),
  // القالب: صفحة القارئ على منصة إنستقرام + العضو المسؤول عن مهمة الأسبوع.
  pageId: integer("page_id").notNull().references(() => platformPagesTable.id, { onDelete: "cascade" }),
  platformId: integer("platform_id").notNull().references(() => platformsTable.id, { onDelete: "cascade" }),
  reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  // الربط (OAuth): يُملأ بعد موافقة صاحب الحساب.
  igUserId: text("ig_user_id"),
  username: text("username"),
  // مفتاح الوصول طويل الأمد، مشفَّر (AES-256-GCM) — لا يُرسَل للواجهة أبدًا.
  accessTokenEncrypted: text("access_token_encrypted"),
  tokenExpiresAt: timestamp("token_expires_at"),
  tokenRefreshedAt: timestamp("token_refreshed_at"),
  // not_connected | connected | needs_reconnect
  status: text("status").notNull().default("not_connected"),
  lastError: text("last_error"),
  // تنبيه «يحتاج إعادة ربط» يُرسل مرة واحدة لكل انقطاع.
  reconnectAlertSentAt: timestamp("reconnect_alert_sent_at"),
  connectedAt: timestamp("connected_at"),
  // المنشورات قبل هذا الوقت سجل قديم لا يُعالَج (يُضبط عند أول ربط ناجح).
  monitoringStartedAt: timestamp("monitoring_started_at"),
  lastCheckedAt: timestamp("last_checked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_instagram_accounts_page").on(table.pageId),
  index("idx_instagram_accounts_reciter").on(table.reciterId),
]);

// رمز «state» لمرة واحدة يربط رحلة تسجيل الدخول بحساب معيّن ويمنع تزوير الطلب (CSRF).
export const instagramOauthStatesTable = pgTable("instagram_oauth_states", {
  state: text("state").primaryKey(),
  accountId: integer("account_id").notNull().references(() => instagramAccountsTable.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// كل منشور/ريل رآه المراقب. (account_id + ig_media_id) فريد — لا يُعالَج منشور مرتين.
export const instagramMediaTable = pgTable("instagram_media", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => instagramAccountsTable.id, { onDelete: "cascade" }),
  igMediaId: text("ig_media_id").notNull(),
  permalink: text("permalink"),
  caption: text("caption"),
  mediaType: text("media_type"), // IMAGE | VIDEO | CAROUSEL_ALBUM
  mediaProductType: text("media_product_type"), // FEED | REELS
  publishedAt: timestamp("published_at").notNull(),
  // الأحد (YYYY-MM-DD) بتوقيت الرياض للأسبوع الذي نُشر فيه.
  weekStart: text("week_start").notNull(),
  // documented | extra_proof | trial_would_create | trial_would_add | ignored | needs_review | reverted
  status: text("status").notNull(),
  reason: text("reason"),
  taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  proofId: integer("proof_id").references(() => taskProofsTable.id, { onDelete: "set null" }),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_instagram_media_account_media").on(table.accountId, table.igMediaId),
  index("idx_instagram_media_week").on(table.accountId, table.weekStart),
]);

// مهمة الأسبوع لكل حساب: (الحساب + الأحد) فريد — يضمن مهمة واحدة فقط لكل قارئ في الأسبوع.
export const instagramWeeklyTasksTable = pgTable("instagram_weekly_tasks", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => instagramAccountsTable.id, { onDelete: "cascade" }),
  weekStart: text("week_start").notNull(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_instagram_weekly_tasks_week").on(table.accountId, table.weekStart),
]);

export type InstagramAccount = typeof instagramAccountsTable.$inferSelect;
export type InstagramMedia = typeof instagramMediaTable.$inferSelect;
export type InstagramSettings = typeof instagramSettingsTable.$inferSelect;
