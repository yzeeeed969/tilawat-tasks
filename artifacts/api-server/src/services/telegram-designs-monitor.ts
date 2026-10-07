// قناة «تصاميم الحرمين»: توثيق تلقائي بالمطابقة باليوم — منطق مستقل تمامًا عن قناة التلاوات.
//
// - التصميم = منشور فيديو + كابشن فيه هاشتاق اليوم (#الأحد … #السبت). غير الفيديو يُتجاهل بصمت.
// - اليوم المقصود: من الهاشتاق، وتاريخه = يوم المنشور نفسه أو اليوم السابق له (مهلة حتى نهاية اليوم التالي)
//   بتوقيت الرياض. لا يُعتمد على تاريخ النشر وحده.
// - المطابقة مقصورة على منصة القناة + صفحتها (مثل صفحة 67) فقط.
// - أول منشور يكمل مهمة اليوم المعلّقة (شاهده رابط المنشور). المنشورات اللاحقة لنفس اليوم تُضاف شواهد
//   إضافية لنفس المهمة دون تغيير حالتها ودون إشعار ثانٍ. مهمة أُكملت من خارج القناة لا تُمس.

import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  tasksTable,
  taskProofsTable,
  telegramChannelPostsTable,
  telegramChannelsTable,
} from "@workspace/db";
import { safeAnchorFromDateKey } from "../lib/hijri";
import { addExtraProof, documentTaskAutomatically } from "./auto-documentation";

type Post = typeof telegramChannelPostsTable.$inferSelect;
type Channel = typeof telegramChannelsTable.$inferSelect;

export class DesignsMonitorError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const DAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function normalizeDayToken(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[#_\s]/g, "")
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

const DAY_BY_TOKEN = new Map<string, number>(
  DAY_LABELS.map((label, dow) => [normalizeDayToken(label), dow] as const),
);

// اليوم من هاشتاقات المنشور: يوم واحد واضح فقط. لا هاشتاق يوم أو أكثر من يوم ⇐ لا تخمين.
export function dayFromHashtags(hashtags: string[]): { ok: true; dow: number } | { ok: false; reason: string } {
  const days = new Set<number>();
  for (const tag of hashtags) {
    const dow = DAY_BY_TOKEN.get(normalizeDayToken(tag));
    if (dow !== undefined) days.add(dow);
  }
  if (days.size === 0) return { ok: false, reason: "لا يوجد هاشتاق يوم (#الأحد … #السبت) في المنشور" };
  if (days.size > 1) return { ok: false, reason: `أكثر من هاشتاق يوم في المنشور (${[...days].map((d) => DAY_LABELS[d]).join("، ")})` };
  return { ok: true, dow: [...days][0] };
}

function riyadhDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDaysToKey(key: string, days: number) {
  const anchor = safeAnchorFromDateKey(key);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

// تاريخ اليوم المقصود: يوم المنشور (بتوقيت الرياض) أو اليوم السابق له — أيّهما يوافق يوم الهاشتاق.
// (يومان متتاليان يختلفان دائمًا في يوم الأسبوع، فالنتيجة واحدة أو لا شيء.)
export function targetDateForDay(publishedAt: Date, dow: number): string | null {
  const postKey = riyadhDateKey(publishedAt);
  for (const key of [postKey, addDaysToKey(postKey, -1)]) {
    if (safeAnchorFromDateKey(key).getUTCDay() === dow) return key;
  }
  return null;
}

async function setDesignSide(postId: number, values: Record<string, unknown>) {
  await db.update(telegramChannelPostsTable).set(values).where(eq(telegramChannelPostsTable.id, postId));
}

async function claimDesignSide(postId: number) {
  const claimed = await db.update(telegramChannelPostsTable)
    .set({ telegramStatus: "processing", processedAt: new Date() })
    .where(and(eq(telegramChannelPostsTable.id, postId), eq(telegramChannelPostsTable.telegramStatus, "pending")))
    .returning({ id: telegramChannelPostsTable.id });
  return claimed.length === 1;
}

// مهام اليوم على صفحة القناة ومنصتها (غير محذوفة، ليست حصة أسبوعية) — الأقدم أولًا.
async function dayTasks(channel: Channel, dateKey: string) {
  return db
    .select({ id: tasksTable.id, status: tasksTable.status })
    .from(tasksTable)
    .where(and(
      eq(tasksTable.platformId, channel.telegramPlatformId!),
      eq(tasksTable.pageId, channel.pageId!),
      isNull(tasksTable.deletedAt),
      isNull(tasksTable.weeklyQuotaRequired),
      sql`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD') = ${dateKey}`,
    ))
    .orderBy(tasksTable.id);
}

// منشورات هذه القناة المرتبطة بالمهمة بحالات معيّنة (لتمييز «أُكملت من هذه القناة» ولترقيم الإضافي).
async function channelPostsOnTask(channelId: number, taskId: number, statuses: string[], excludePostId?: number) {
  const rows = await db
    .select({ id: telegramChannelPostsTable.id })
    .from(telegramChannelPostsTable)
    .where(and(
      eq(telegramChannelPostsTable.channelId, channelId),
      eq(telegramChannelPostsTable.telegramTaskId, taskId),
      inArray(telegramChannelPostsTable.telegramStatus, statuses),
    ));
  return rows.filter((r) => r.id !== excludePostId).length;
}

function proofNote(channel: Channel, post: Post, extra: boolean) {
  return `${extra ? "شاهد إضافي" : "وثّقه النظام تلقائيًا"} من منشور قناة${channel.title ? ` «${channel.title}»` : " التصاميم"} — نُشر بتاريخ ${post.publishedAt.toISOString()}`;
}

export async function processDesignPost(post: Post, channel: Channel) {
  // التصنيف والاستخراج (مرة لكل منشور، أو بعد تعديله/إعادة معالجته).
  if (post.kind === "pending") {
    if (!post.hasVideo) {
      await setDesignSide(post.id, {
        kind: "other",
        ignoreReason: "ليس فيديو — لا يُوثَّق",
        telegramStatus: post.telegramStatus === "pending" ? "not_applicable" : post.telegramStatus,
        appStatus: "not_applicable",
        processedAt: new Date(),
      });
      return;
    }
    const hashtags = Array.isArray(post.hashtags) ? (post.hashtags as string[]) : [];
    const day = dayFromHashtags(hashtags);
    await setDesignSide(post.id, {
      kind: "design",
      ignoreReason: null,
      dayOfWeek: day.ok ? day.dow : null,
      parseError: day.ok ? null : day.reason,
      appStatus: "not_applicable",
      processedAt: new Date(),
      ...(!day.ok && post.telegramStatus === "pending" ? { telegramStatus: "needs_review", telegramReason: day.reason } : {}),
    });
    if (!day.ok) return;
    [post] = await db.select().from(telegramChannelPostsTable).where(eq(telegramChannelPostsTable.id, post.id)).limit(1);
  }
  if (post.kind !== "design" || post.dayOfWeek === null || post.dayOfWeek === undefined) return;
  if (!(await claimDesignSide(post.id))) return;

  try {
    await decideDesignPost(post, channel);
  } catch (error) {
    await setDesignSide(post.id, { telegramStatus: "needs_review", telegramReason: `خطأ أثناء المعالجة: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
  }
}

async function decideDesignPost(post: Post, channel: Channel, retried = false): Promise<void> {
  if (!channel.telegramPlatformId || !channel.pageId) {
    await setDesignSide(post.id, { telegramStatus: "needs_review", telegramReason: "حدّد منصة تلقرام وصفحة التصاميم في إعدادات القناة" });
    return;
  }
  if (!post.postUrl) {
    await setDesignSide(post.id, { telegramStatus: "needs_review", telegramReason: "لا يوجد رابط عام للمنشور يصلح شاهدًا (القناة بلا اسم مستخدم)" });
    return;
  }
  const dateKey = targetDateForDay(post.publishedAt, post.dayOfWeek!);
  if (!dateKey) {
    await setDesignSide(post.id, {
      telegramStatus: "needs_review",
      telegramReason: `هاشتاق ${DAY_LABELS[post.dayOfWeek!]} لا يوافق تاريخ النشر (المهلة: اليوم نفسه حتى نهاية اليوم التالي)`,
      telegramTaskId: null,
    });
    return;
  }

  const tasks = await dayTasks(channel, dateKey);
  const pending = tasks.filter((t) => t.status === "pending");
  const completed = tasks.filter((t) => t.status === "completed");

  // تجربة: نحاكي «أول منشور» و«إضافي» بحسب ما سجّلته منشورات التجربة السابقة لنفس المهمة.
  if (channel.trialMode) {
    const firstPending = pending[0];
    if (firstPending) {
      const earlier = await channelPostsOnTask(channel.id, firstPending.id, ["trial_would_document", "trial_would_extra"], post.id);
      await setDesignSide(post.id, earlier === 0
        ? { telegramStatus: "trial_would_document", telegramReason: `أول منشور لمهمة ${DAY_LABELS[post.dayOfWeek!]} ${dateKey}`, telegramTaskId: firstPending.id, extraIndex: null }
        : { telegramStatus: "trial_would_extra", telegramReason: `منشور إضافي لمهمة ${DAY_LABELS[post.dayOfWeek!]} ${dateKey}`, telegramTaskId: firstPending.id, extraIndex: earlier + 1 });
      return;
    }
    for (const task of completed) {
      if (await channelPostsOnTask(channel.id, task.id, ["documented"]) > 0) {
        const count = await channelPostsOnTask(channel.id, task.id, ["documented", "documented_extra", "trial_would_extra"], post.id);
        await setDesignSide(post.id, { telegramStatus: "trial_would_extra", telegramReason: `منشور إضافي لمهمة ${DAY_LABELS[post.dayOfWeek!]} ${dateKey}`, telegramTaskId: task.id, extraIndex: count + 1 });
        return;
      }
    }
    await setDesignSide(post.id, { telegramStatus: "trial_no_task", telegramReason: noTaskReason(dateKey, post.dayOfWeek!, completed.length > 0), telegramTaskId: null });
    return;
  }

  // أول منشور: مهمة اليوم المعلّقة (إن وُجدت أكثر من واحدة — نظريًا — الأقدم، وتُوثَّق واحدة فقط).
  if (pending.length > 0) {
    const task = pending[0];
    const result = await documentTaskAutomatically({
      taskId: task.id,
      proofUrl: post.postUrl,
      publishedAt: post.publishedAt,
      note: proofNote(channel, post, false),
      activityUserName: "مراقبة تلقرام — التصاميم (تلقائي)",
      activityAction: "telegram_design_documented",
      meta: { postId: post.id, postUrl: post.postUrl, dateKey },
    });
    if (result.documented) {
      await setDesignSide(post.id, { telegramStatus: "documented", telegramReason: `أول منشور لمهمة ${DAY_LABELS[post.dayOfWeek!]} ${dateKey}`, telegramTaskId: task.id, telegramProofId: result.createdProofId, extraIndex: null });
      return;
    }
    // سباق: أكملها منشور آخر للتو ⇐ نعيد التقييم مرة واحدة (فيصير إضافيًا).
    if (!retried) return decideDesignPost(post, channel, true);
  }

  // منشور إضافي: مهمة اليوم المكتملة من منشور سابق في هذه القناة (لا تُمس مهمة أُكملت من خارجها).
  for (const task of completed) {
    if (await channelPostsOnTask(channel.id, task.id, ["documented"]) === 0) continue;
    const count = await channelPostsOnTask(channel.id, task.id, ["documented", "documented_extra"], post.id);
    const result = await addExtraProof({
      taskId: task.id,
      proofUrl: post.postUrl,
      note: proofNote(channel, post, true),
      activityUserName: "مراقبة تلقرام — التصاميم (تلقائي)",
      activityAction: "telegram_design_extra_proof",
      meta: { postId: post.id, postUrl: post.postUrl, dateKey, extraIndex: count + 1 },
    });
    if (result.added) {
      await setDesignSide(post.id, { telegramStatus: "documented_extra", telegramReason: `منشور إضافي (${count + 1}) لمهمة ${DAY_LABELS[post.dayOfWeek!]} ${dateKey}`, telegramTaskId: task.id, telegramProofId: result.createdProofId, extraIndex: count + 1 });
      return;
    }
  }

  await setDesignSide(post.id, { telegramStatus: "no_task", telegramReason: noTaskReason(dateKey, post.dayOfWeek!, completed.length > 0), telegramTaskId: null });
}

function noTaskReason(dateKey: string, dow: number, hasCompletedOutside: boolean) {
  return hasCompletedOutside
    ? `مهمة ${DAY_LABELS[dow]} ${dateKey} مكتملة مسبقًا من خارج القناة — لا تُمس`
    : `لا توجد مهمة تصاميم لـ${DAY_LABELS[dow]} ${dateKey} على صفحة القناة`;
}

// إعادة فحص دورية: منشورات تصاميم خلال آخر يومين لم تُوثَّق (مهمة أُنشئت متأخرة مثلًا).
export async function recheckDesignPosts(channelIds: number[]) {
  if (channelIds.length === 0) return;
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await db.update(telegramChannelPostsTable).set({ telegramStatus: "pending" })
    .where(and(
      inArray(telegramChannelPostsTable.channelId, channelIds),
      eq(telegramChannelPostsTable.kind, "design"),
      gte(telegramChannelPostsTable.publishedAt, since),
      sql`${telegramChannelPostsTable.dayOfWeek} IS NOT NULL`,
      inArray(telegramChannelPostsTable.telegramStatus, ["no_task", "needs_review", "trial_no_task"]),
    ));
}

// ── إجراءات يدوية (للمدير) ──────────────────────────────────────────────────────────────────
async function loadDesignContext(postId: number) {
  const [post] = await db.select().from(telegramChannelPostsTable).where(eq(telegramChannelPostsTable.id, postId)).limit(1);
  if (!post) throw new DesignsMonitorError(404, "المنشور غير موجود");
  const [channel] = await db.select().from(telegramChannelsTable).where(eq(telegramChannelsTable.id, post.channelId ?? 0)).limit(1);
  if (!channel || channel.kind !== "designs") throw new DesignsMonitorError(400, "المنشور ليس من قناة تصاميم");
  return { post, channel };
}

export async function linkDesignPost(postId: number, taskId: number, userId: number | null) {
  const { post, channel } = await loadDesignContext(postId);
  if (post.telegramStatus === "documented" || post.telegramStatus === "documented_extra") throw new DesignsMonitorError(409, "المنشور موثَّق مسبقًا — تراجع عنه أولًا");
  if (!post.postUrl) throw new DesignsMonitorError(400, "لا يوجد رابط عام للمنشور يصلح شاهدًا");
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task || task.deletedAt) throw new DesignsMonitorError(404, "المهمة غير موجودة");
  if (task.platformId !== channel.telegramPlatformId || task.pageId !== channel.pageId) throw new DesignsMonitorError(400, "المهمة ليست على صفحة هذه القناة");
  const meta = { postId, postUrl: post.postUrl, manual: true, userId };
  if (task.status === "pending") {
    const result = await documentTaskAutomatically({
      taskId, proofUrl: post.postUrl, publishedAt: post.publishedAt, note: `رُبط يدويًا — ${proofNote(channel, post, false)}`,
      activityUserName: "مراقبة تلقرام — التصاميم (ربط يدوي)", activityAction: "telegram_design_linked_manually", meta,
    });
    if (!result.documented) throw new DesignsMonitorError(409, result.reason ?? "تعذّر التوثيق");
    await setDesignSide(postId, { telegramStatus: "documented", telegramReason: "رُبط يدويًا (أول منشور)", telegramTaskId: taskId, telegramProofId: result.createdProofId, extraIndex: null, reviewedByUserId: userId, reviewedAt: new Date() });
  } else {
    const count = await channelPostsOnTask(channel.id, taskId, ["documented", "documented_extra"], postId);
    const result = await addExtraProof({
      taskId, proofUrl: post.postUrl, note: `رُبط يدويًا — ${proofNote(channel, post, true)}`,
      activityUserName: "مراقبة تلقرام — التصاميم (ربط يدوي)", activityAction: "telegram_design_extra_linked_manually", meta,
    });
    if (!result.added) throw new DesignsMonitorError(409, result.reason ?? "تعذّر إضافة الشاهد");
    await setDesignSide(postId, { telegramStatus: "documented_extra", telegramReason: `رُبط يدويًا (منشور إضافي ${count + 1})`, telegramTaskId: taskId, telegramProofId: result.createdProofId, extraIndex: count + 1, reviewedByUserId: userId, reviewedAt: new Date() });
  }
}

export async function ignoreDesignPost(postId: number, userId: number | null) {
  const { post } = await loadDesignContext(postId);
  if (post.telegramStatus === "documented" || post.telegramStatus === "documented_extra") throw new DesignsMonitorError(409, "المنشور موثَّق — تراجع عنه أولًا");
  await setDesignSide(postId, { telegramStatus: "ignored_manual", telegramReason: "تجاهله المدير يدويًا", reviewedByUserId: userId, reviewedAt: new Date() });
}

// تراجع: يحذف حذفًا ناعمًا شاهد هذا المنشور فقط. المنشور الإضافي لا يمسّ اكتمال المهمة.
// المنشور الأول: تعود المهمة معلّقة فقط إن لم يبقَ لها أي شاهد فعّال (ويُمسح رابط التسليم إن كان شاهده).
export async function revertDesignPost(postId: number, userId: number | null) {
  const { post } = await loadDesignContext(postId);
  if ((post.telegramStatus !== "documented" && post.telegramStatus !== "documented_extra") || !post.telegramTaskId) {
    throw new DesignsMonitorError(400, "لا يوجد توثيق في هذا المنشور للتراجع عنه");
  }
  const isFirst = post.telegramStatus === "documented";
  await db.transaction(async (tx: any) => {
    let revertedUrl: string | null = null;
    if (post.telegramProofId) {
      const [proof] = await tx.update(taskProofsTable).set({ deletedAt: new Date() }).where(eq(taskProofsTable.id, post.telegramProofId)).returning({ url: taskProofsTable.url });
      revertedUrl = proof?.url ?? null;
    }
    if (!isFirst) return;
    const [remaining] = await tx.select({ id: taskProofsTable.id }).from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, post.telegramTaskId!), isNull(taskProofsTable.deletedAt))).limit(1);
    if (!remaining) {
      await tx.update(tasksTable).set({
        status: "pending",
        completedAt: null,
        ...(revertedUrl ? { submissionUrl: sql`CASE WHEN ${tasksTable.submissionUrl} = ${revertedUrl} THEN NULL ELSE ${tasksTable.submissionUrl} END` } : {}),
      }).where(eq(tasksTable.id, post.telegramTaskId!));
    }
  });
  await setDesignSide(postId, { telegramStatus: "reverted", telegramReason: "تراجع عنه المدير — الإشعارات المُرسَلة سابقًا لم تُسحَب", reviewedByUserId: userId, reviewedAt: new Date() });
}

// مرشّحو الربط اليدوي: مهام صفحة القناة القريبة من تاريخ المنشور (معلّقة أو مكتملة).
export async function designLinkCandidates(postId: number) {
  const { post, channel } = await loadDesignContext(postId);
  if (!channel.telegramPlatformId || !channel.pageId) return [];
  const from = new Date(post.publishedAt.getTime() - 4 * 24 * 60 * 60 * 1000);
  const to = new Date(post.publishedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
  return db
    .select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, prayer: tasksTable.prayer, mosque: tasksTable.mosque, dueDate: sql<string>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')` })
    .from(tasksTable)
    .where(and(
      eq(tasksTable.platformId, channel.telegramPlatformId),
      eq(tasksTable.pageId, channel.pageId),
      isNull(tasksTable.deletedAt),
      gte(tasksTable.dueDate, from),
      lt(tasksTable.dueDate, to),
    ))
    .orderBy(tasksTable.dueDate)
    .limit(50);
}

// مهام بلا منشور: مهام صفحة القناة المعلّقة التي انتهت مهلتها (نهاية اليوم التالي) خلال آخر 14 يومًا.
export async function designTasksWithoutPost(channel: Channel) {
  if (!channel.telegramPlatformId || !channel.pageId) return [];
  const todayKey = riyadhDateKey(new Date());
  const lastOpenDue = addDaysToKey(todayKey, -2); // مهمة أمس ما زالت ضمن مهلتها
  const since = addDaysToKey(todayKey, -14);
  const rows = await db
    .select({ id: tasksTable.id, title: tasksTable.title, dueDate: sql<string>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')` })
    .from(tasksTable)
    .where(and(
      eq(tasksTable.platformId, channel.telegramPlatformId),
      eq(tasksTable.pageId, channel.pageId),
      eq(tasksTable.status, "pending"),
      isNull(tasksTable.deletedAt),
      sql`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD') BETWEEN ${since} AND ${lastOpenDue}`,
    ))
    .orderBy(desc(tasksTable.dueDate))
    .limit(100);
  return rows.map((r) => ({ ...r, side: "telegram" as const, prayer: null, mosque: null }));
}

// إجراء وقائي: مهام الصفحة التي لا يقع تاريخها المخزَّن عند منتصف الليل (قد تكون مزاحة بيوم).
export async function designDateCheck(channel: Channel) {
  if (!channel.pageId) return { tasks: 0, notMidnight: 0 };
  const result: any = await db.execute(sql`
    SELECT count(*)::int AS tasks, count(*) FILTER (WHERE due_date::time <> '00:00:00')::int AS not_midnight
    FROM tasks WHERE page_id = ${channel.pageId} AND deleted_at IS NULL
  `);
  const row = (Array.isArray(result) ? result : result?.rows ?? [])[0] ?? {};
  return { tasks: Number(row.tasks ?? 0), notMidnight: Number(row.not_midnight ?? 0) };
}
