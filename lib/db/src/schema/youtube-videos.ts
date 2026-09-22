import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { youtubeChannelsTable } from "./youtube-channels";
import { tasksTable } from "./tasks";
import { taskProofsTable } from "./task-proofs";
import { usersTable } from "./users";

// كل مقطع رآه المراقب. video_id فريد — هذا هو الضمان المطلق من معالجة نفس المقطع مرتين.
// الحالة (status) هي القيمة المرجعية النهائية لهذا المقطع، وتُقرأ لا تُخمَّن:
//   historical            — نُشر قبل بدء مراقبة القناة، لم يُعالَج إطلاقًا.
//   ignored               — خاص/غير مدرج/بث جارٍ أو مجدول/مقطع قصير — تجاهل تلقائي.
//   ignored_manual        — تجاهله المدير يدويًا من صفحة الإدارة.
//   no_marker              — لا تحتوي وصفه علامة *1 بعد (قابل لإعادة الفحص طالما بقي ضمن آخر المقاطع).
//   needs_review           — علامة *1 موجودة لكن تعذّر التأكد (عنوان غير مفهوم / أكثر من مهمة / تعارض).
//   no_task                — علامة *1 موجودة والعنوان مفهوم لكن لا توجد مهمة معلّقة مطابقة.
//   documented             — وُثِّق فعليًا (أُضيف شاهد وأُكملت المهمة).
//   reverted               — كان موثَّقًا ثم تراجع عنه المدير.
//   trial_would_document   — في وضع التجربة: كان سيُوثَّق لو كان التوثيق مفعَّلًا.
//   trial_would_review     — في وضع التجربة: كان سيذهب للمراجعة.
//   trial_no_task          — في وضع التجربة: كان سيُصنَّف بلا مهمة.
export const youtubeVideosTable = pgTable("youtube_videos", {
  id: serial("id").primaryKey(),
  channelRowId: integer("channel_row_id").notNull().references(() => youtubeChannelsTable.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  publishedAt: timestamp("published_at").notNull(),
  url: text("url").notNull(),
  hasMarker: boolean("has_marker").notNull().default(false),
  // الثوابت المستخرجة من العنوان (NULL إن تعذّر الاستخراج)
  extractedPrayer: text("extracted_prayer"),
  extractedHijriDay: integer("extracted_hijri_day"),
  extractedHijriMonth: integer("extracted_hijri_month"),
  matchedTaskId: integer("matched_task_id").references(() => tasksTable.id, { onDelete: "set null" }),
  // معرّف الشاهد الذي أنشأه التوثيق التلقائي — يُستخدم للتراجع الدقيق (حذف هذا الشاهد بعينه فقط).
  createdProofId: integer("created_proof_id").references(() => taskProofsTable.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  decisionReason: text("decision_reason"),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_youtube_videos_video_id").on(table.videoId),
  index("idx_youtube_videos_channel_row_id").on(table.channelRowId),
  index("idx_youtube_videos_status").on(table.status),
  index("idx_youtube_videos_matched_task_id").on(table.matchedTaskId),
]);

export type YoutubeVideo = typeof youtubeVideosTable.$inferSelect;
