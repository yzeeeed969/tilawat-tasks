import { pgTable, serial, integer, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { recitersTable } from "./reciters";
import { platformsTable } from "./platforms";
import { platformPagesTable } from "./platform-pages";
import { membersTable } from "./members";
import { usersTable } from "./users";

// قالب النشر الثابت: لكل قارئ ← منصة ← نوع تصوير ← العضو المسؤول (وصفحة اختيارية).
// نوع التصوير: "affairs" (تصوير الشؤون) / "tv" (تصوير التلفزيون) / NULL للمنصات بلا أنواع.
// الفرادة على (القارئ + المنصة + نوع التصوير) مضمونة بفهرس تعبيري في ضمان المخطط (coalesce للفراغ).
export const reciterPublishingTemplatesTable = pgTable("reciter_publishing_templates", {
  id: serial("id").primaryKey(),
  reciterId: integer("reciter_id").notNull().references(() => recitersTable.id, { onDelete: "cascade" }),
  platformId: integer("platform_id").notNull().references(() => platformsTable.id, { onDelete: "cascade" }),
  filmingType: text("filming_type"),
  memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
  pageId: integer("page_id").references(() => platformPagesTable.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_reciter_publishing_templates_reciter").on(table.reciterId),
]);

// سجل كل إنشاء لجدول أسبوعي: الأسبوع (الأحد→السبت)، اختيارات الأئمة، والمجموعات الناتجة.
export const weeklyScheduleBatchesTable = pgTable("weekly_schedule_batches", {
  id: serial("id").primaryKey(),
  weekStart: text("week_start").notNull(), // YYYY-MM-DD (الأحد)
  weekEnd: text("week_end").notNull(), // YYYY-MM-DD (السبت)
  // [{ mosque, prayer, reciterId, reciterName, creationGroupId, createdTasks, skippedDuplicates }]
  assignments: jsonb("assignments").notNull(),
  createdTasks: integer("created_tasks").notNull().default(0),
  skippedDuplicates: integer("skipped_duplicates").notNull().default(0),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_weekly_schedule_batches_week").on(table.weekStart),
]);

// إعدادات الميزة (صف واحد): المعاينة قبل الإنشاء، ووقت استيراد القالب.
export const weeklyScheduleSettingsTable = pgTable("weekly_schedule_settings", {
  id: serial("id").primaryKey(),
  previewEnabled: boolean("preview_enabled").notNull().default(true),
  templateImportedAt: timestamp("template_imported_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ReciterPublishingTemplate = typeof reciterPublishingTemplatesTable.$inferSelect;
export type WeeklyScheduleBatch = typeof weeklyScheduleBatchesTable.$inferSelect;
