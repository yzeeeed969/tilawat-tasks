// مراقبة قناة تلقرام العامة («تطبيق تلاوات الحرمين») والتوثيق التلقائي منها.
//
// كل منشور «تلاوةٌ للشيخ …» يحمل رابط tilawatalharamain.com/p/ يوثّق مهمتين مستقلتين:
//   (أ) جانب تلقرام: المهمة العامة على منصة تلقرام — بلا قارئ، بالمسجد المستنتج من مسجد الشيخ + الصلاة + التاريخ.
//   (ب) جانب التطبيق: مهمة القارئ على منصة «تشمل كل القرّاء» — بالقارئ + الصلاة + التاريخ.
// كل جانب يُعالَج وحده: ما ينجح يُوثَّق، وما يفشل يذهب لمراجعة/بلا مهمة بسببه، وفشل أحدهما لا يمنع الآخر.
// بلا تخمين أبدًا، والقصر التام على منصتي تلقرام والتطبيق. الشاهد للجانبين: رابط الموقع من المنشور.

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  platformsTable,
  recitersTable,
  tasksTable,
  taskProofsTable,
  telegramChannelPostsTable,
  telegramHashtagAliasesTable,
  telegramMonitorSettingsTable,
  telegramSeenChatsTable,
} from "@workspace/db";
import { findBarePrayers, findHijriDates, isPlausibleHijriDayMonth, normalizeDigits, normalizeForNameCheck } from "../lib/recitation-text";
import { type PrayerCode } from "../lib/prayer";
import { matchRecitationToTask } from "./recitation-matcher";
import { documentTaskAutomatically } from "./auto-documentation";
import { normalizeName } from "./weekly-schedule-template";
import { ensureTelegramMonitorSchema } from "./telegram-monitor-schema";

export type Side = "telegram" | "app";
export const PUBLISH_WINDOW_HOURS = 72;

// حالات نهائية لا يُعاد فيها معالجة الجانب تلقائيًا.
const FINAL_SIDE_STATUSES = new Set(["documented", "reverted", "ignored_manual", "not_applicable"]);
// حالات يُعاد فحصها دوريًا ضمن نافذة النشر (مهمة أُنشئت متأخرة مثلًا).
const RECHECK_SIDE_STATUSES = ["needs_review", "no_task", "trial_would_review", "trial_no_task"];

export class TelegramMonitorError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── الإعدادات ───────────────────────────────────────────────────────────────────────────────
export async function getMonitorSettings() {
  await ensureTelegramMonitorSchema();
  const [existing] = await db.select().from(telegramMonitorSettingsTable).limit(1);
  if (existing) return existing;
  // افتراضيًا: منصة التطبيق = المنصة الوحيدة المعلَّمة «تشمل كل القرّاء» إن وُجدت واحدة فقط.
  const coversAll = await db.select({ id: platformsTable.id }).from(platformsTable).where(eq(platformsTable.coversAllReciters, true));
  const [created] = await db.insert(telegramMonitorSettingsTable).values({
    appPlatformId: coversAll.length === 1 ? coversAll[0].id : null,
  }).returning();
  return created;
}

// ── التخزين (يُستدعى من الـ webhook) ─────────────────────────────────────────────────────────
async function recordSeenChat(chat: any, botStatus?: string | null) {
  if (!chat || chat.id === undefined || chat.id === null) return;
  const chatId = String(chat.id);
  await db.insert(telegramSeenChatsTable).values({
    chatId,
    title: typeof chat.title === "string" ? chat.title : null,
    username: typeof chat.username === "string" ? chat.username : null,
    type: typeof chat.type === "string" ? chat.type : null,
    botStatus: botStatus ?? null,
  }).onConflictDoUpdate({
    target: telegramSeenChatsTable.chatId,
    set: {
      title: typeof chat.title === "string" ? chat.title : sql`${telegramSeenChatsTable.title}`,
      username: typeof chat.username === "string" ? chat.username : sql`${telegramSeenChatsTable.username}`,
      type: typeof chat.type === "string" ? chat.type : sql`${telegramSeenChatsTable.type}`,
      ...(botStatus ? { botStatus } : {}),
      lastSeenAt: new Date(),
    },
  });
}

export async function handleMyChatMemberUpdate(update: any) {
  await ensureTelegramMonitorSchema();
  const info = update?.my_chat_member;
  await recordSeenChat(info?.chat, info?.new_chat_member?.status ?? null);
}

function extractHashtags(caption: string, entities: any[]): string[] {
  const tags: string[] = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (entity?.type !== "hashtag") continue;
    const offset = Number(entity.offset);
    const length = Number(entity.length);
    if (!Number.isInteger(offset) || !Number.isInteger(length)) continue;
    // إزاحات تلقرام بوحدات UTF-16 — تطابق فهرسة سلاسل JavaScript مباشرة.
    tags.push(caption.substring(offset, offset + length));
  }
  if (tags.length === 0) {
    for (const match of caption.matchAll(/#[\p{L}\p{N}_]+/gu)) tags.push(match[0]);
  }
  return [...new Set(tags)];
}

// يخزّن المنشور قبل أي معالجة (فإن فشلت القاعدة يرجع الـ webhook بخطأ ويعيد تلقرام الإرسال).
// يُرجع معرّف المنشور المخزَّن للمعالجة، أو null إن لم يكن من القناة المسجّلة.
export async function storeChannelUpdate(update: any): Promise<number | null> {
  await ensureTelegramMonitorSchema();
  const edited = Boolean(update?.edited_channel_post);
  const post = update?.channel_post ?? update?.edited_channel_post;
  if (!post?.chat) return null;
  await recordSeenChat(post.chat);

  const settings = await getMonitorSettings();
  const chatId = String(post.chat.id);
  if (!settings.enabled || !settings.channelChatId || settings.channelChatId !== chatId) return null;

  const publishedAt = new Date(Number(post.date) * 1000);
  if (Number.isNaN(publishedAt.getTime())) return null;
  if (settings.monitoringStartedAt && publishedAt < settings.monitoringStartedAt) return null;

  const caption: string | null = typeof post.caption === "string" ? post.caption : typeof post.text === "string" ? post.text : null;
  const entities = post.caption_entities ?? post.entities ?? [];
  const hashtags = caption ? extractHashtags(caption, entities) : [];
  const username = settings.channelUsername || (typeof post.chat.username === "string" ? post.chat.username : null);
  const postUrl = username ? `https://t.me/${username}/${post.message_id}` : null;
  const messageId = Number(post.message_id);

  const [existing] = await db
    .select()
    .from(telegramChannelPostsTable)
    .where(and(eq(telegramChannelPostsTable.chatId, chatId), eq(telegramChannelPostsTable.messageId, messageId)))
    .limit(1);

  if (!existing) {
    const inserted = await db.insert(telegramChannelPostsTable).values({
      chatId,
      messageId,
      publishedAt,
      editedAt: edited && post.edit_date ? new Date(Number(post.edit_date) * 1000) : null,
      caption,
      hashtags,
      postUrl,
    }).onConflictDoNothing().returning({ id: telegramChannelPostsTable.id });
    if (inserted.length > 0) return inserted[0].id;
    const [again] = await db.select({ id: telegramChannelPostsTable.id }).from(telegramChannelPostsTable)
      .where(and(eq(telegramChannelPostsTable.chatId, chatId), eq(telegramChannelPostsTable.messageId, messageId))).limit(1);
    return again?.id ?? null;
  }

  if (!edited) return existing.id; // إعادة إرسال لنفس المنشور — لا شيء جديد

  // تعديل منشور: الجانب الموثَّق نهائي (يُحفظ النص الجديد مع علامة)، وغير النهائي يُعاد معالجته.
  const anyDocumented = existing.telegramStatus === "documented" || existing.appStatus === "documented";
  await db.update(telegramChannelPostsTable).set({
    caption,
    hashtags,
    editedAt: post.edit_date ? new Date(Number(post.edit_date) * 1000) : new Date(),
    editedAfterDocumented: existing.editedAfterDocumented || anyDocumented,
    kind: "pending",
    telegramStatus: FINAL_SIDE_STATUSES.has(existing.telegramStatus) && existing.telegramStatus !== "not_applicable" ? existing.telegramStatus : "pending",
    appStatus: FINAL_SIDE_STATUSES.has(existing.appStatus) && existing.appStatus !== "not_applicable" ? existing.appStatus : "pending",
  }).where(eq(telegramChannelPostsTable.id, existing.id));
  return existing.id;
}

// ── التصنيف والاستخراج ─────────────────────────────────────────────────────────────────────
function normalizeArabicText(text: string) {
  return normalizeDigits(text)
    .normalize("NFKC")
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, "") // تشكيل (ومنه التنوين) + تطويل
    .replace(/[أإآٱ]/g, "ا");
}

const SITE_URL_REGEX = /(?:https?:\/\/)?(?:www\.)?tilawatalharamain\.com\/p\/[A-Za-z0-9_-]+/i;

export function classifyCaption(caption: string | null): { kind: "recitation"; siteUrl: string } | { kind: "other"; reason: string } {
  if (!caption || !caption.trim()) return { kind: "other", reason: "منشور بلا نص" };
  const normalized = normalizeArabicText(caption);
  const firstLine = normalized.split(/\r\n|\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const lead = firstLine.replace(/^[^\p{L}]+/u, "");
  if (/مقتطف/.test(lead)) return { kind: "other", reason: "مقتطف — لا يُوثَّق" };
  if (!lead.startsWith("تلاوة للشيخ")) return { kind: "other", reason: "ليس منشور تلاوة («تلاوةٌ للشيخ …») — لا يُوثَّق" };
  const url = caption.match(SITE_URL_REGEX)?.[0];
  if (!url) return { kind: "other", reason: "منشور تلاوة بلا رابط tilawatalharamain.com/p/ — لا يُوثَّق" };
  return { kind: "recitation", siteUrl: /^https?:\/\//i.test(url) ? url : `https://${url}` };
}

const PRAYER_AFTER_SALAH: Record<string, PrayerCode> = { "فجر": "fajr", "مغرب": "maghrib", "عشاء": "isha", "جمعة": "jumuah" };

export function extractPrayerAndDate(caption: string, hashtags: string[]):
  { ok: true; prayer: PrayerCode; hijriDay: number; hijriMonth: number; hijriYear: number } | { ok: false; reason: string } {
  let text = normalizeArabicText(caption);
  // نزيل الهاشتاقات وروابط الموقع قبل البحث عن الصلاة والتاريخ (لا تحمل أيًّا منهما).
  for (const tag of hashtags) text = text.split(normalizeArabicText(tag)).join(" ");
  text = text.replace(/https?:\/\/\S+/g, " ").replace(/tilawatalharamain\.com\/\S*/gi, " ");

  const dates = findHijriDates(text, "flexible");
  const distinct = [...new Map(dates.map((d) => [`${d.day}-${d.month}-${d.year}`, d])).values()];
  if (distinct.length === 0) return { ok: false, reason: "لا يوجد تاريخ هجري بصيغة يوم-شهر-سنة في النص" };
  if (distinct.length > 1) return { ok: false, reason: "أكثر من تاريخ هجري في النص — التباس" };
  const date = distinct[0];
  if (!isPlausibleHijriDayMonth(date.day, date.month)) return { ok: false, reason: "رقم اليوم أو الشهر في التاريخ غير منطقي" };

  // «صلاة الفجر/المغرب/العشاء/الجمعة» أولًا، ثم الكلمات العارية (فجر/مغرب/عشاء) غير الملتصقة بـ«ال».
  const found = new Set<PrayerCode>();
  for (const match of text.matchAll(/صلاة\s+(?:ال)?(فجر|مغرب|عشاء|جمعة)/g)) found.add(PRAYER_AFTER_SALAH[match[1]]);
  if (found.size === 0) for (const code of findBarePrayers(text)) found.add(code);
  if (found.size === 0) return { ok: false, reason: "تعذّر تحديد نوع الصلاة من النص" };
  if (found.size > 1) return { ok: false, reason: `أكثر من صلاة في النص (${[...found].join("، ")})` };
  return { ok: true, prayer: [...found][0], hijriDay: date.day, hijriMonth: date.month, hijriYear: date.year };
}

async function resolveReciterFromHashtags(hashtags: string[]): Promise<{ ok: true; reciterId: number; mosque: string } | { ok: false; reason: string }> {
  if (hashtags.length === 0) return { ok: false, reason: "لا يوجد هاشتاق باسم الشيخ" };
  const normalizedTags = [...new Set(hashtags.map((tag) => normalizeName(normalizeForNameCheck(tag))).filter(Boolean))];
  const reciters = await db.select({ id: recitersTable.id, name: recitersTable.name, mosque: recitersTable.mosque }).from(recitersTable);
  const aliases = normalizedTags.length > 0
    ? await db.select().from(telegramHashtagAliasesTable).where(inArray(telegramHashtagAliasesTable.hashtag, normalizedTags))
    : [];
  const aliasByTag = new Map(aliases.map((a) => [a.hashtag, a.reciterId]));
  const matched = new Set<number>();
  for (const tag of normalizedTags) {
    const alias = aliasByTag.get(tag);
    if (alias) { matched.add(alias); continue; }
    const exact = reciters.filter((r) => normalizeName(r.name) === tag);
    if (exact.length === 1) matched.add(exact[0].id);
  }
  if (matched.size === 0) return { ok: false, reason: `لم يُتعرّف على اسم الشيخ من الهاشتاق (${hashtags.join(" ")}) — اربطه بقارئ من صفحة المراقبة` };
  if (matched.size > 1) return { ok: false, reason: "الهاشتاقات تشير لأكثر من شيخ — التباس" };
  const reciterId = [...matched][0];
  const reciter = reciters.find((r) => r.id === reciterId)!;
  return { ok: true, reciterId, mosque: reciter.mosque };
}

// ── المعالجة ────────────────────────────────────────────────────────────────────────────────
type Ctx = { trialMode: boolean; telegramPlatformId: number | null; appPlatformId: number | null; channelTitle: string | null };

function sideColumns(side: Side) {
  return side === "telegram"
    ? { status: "telegramStatus", reason: "telegramReason", task: "telegramTaskId", proof: "telegramProofId" } as const
    : { status: "appStatus", reason: "appReason", task: "appTaskId", proof: "appProofId" } as const;
}

async function setSide(postId: number, side: Side, values: { status: string; reason?: string | null; taskId?: number | null; proofId?: number | null }, extra: Record<string, unknown> = {}) {
  const c = sideColumns(side);
  const patch: Record<string, unknown> = { [c.status]: values.status, ...extra };
  if (values.reason !== undefined) patch[c.reason] = values.reason;
  if (values.taskId !== undefined) patch[c.task] = values.taskId;
  if (values.proofId !== undefined) patch[c.proof] = values.proofId;
  await db.update(telegramChannelPostsTable).set(patch).where(eq(telegramChannelPostsTable.id, postId));
}

// يحجز الجانب للمعالجة ذرّيًا (pending ⇐ processing) فلا يعالجه مساران معًا (webhook + الفحص الدوري).
async function claimSide(postId: number, side: Side) {
  const column = side === "telegram" ? telegramChannelPostsTable.telegramStatus : telegramChannelPostsTable.appStatus;
  const claimed = await db.update(telegramChannelPostsTable)
    .set(side === "telegram" ? { telegramStatus: "processing", processedAt: new Date() } : { appStatus: "processing", processedAt: new Date() })
    .where(and(eq(telegramChannelPostsTable.id, postId), eq(column, "pending")))
    .returning({ id: telegramChannelPostsTable.id });
  return claimed.length === 1;
}

async function processSide(post: typeof telegramChannelPostsTable.$inferSelect, side: Side, ctx: Ctx) {
  if (!(await claimSide(post.id, side))) return;
  const platformId = side === "telegram" ? ctx.telegramPlatformId : ctx.appPlatformId;
  if (!platformId) {
    await setSide(post.id, side, { status: "needs_review", reason: side === "telegram" ? "لم تُحدَّد منصة تلقرام في إعدادات المراقبة" : "لم تُحدَّد منصة التطبيق في إعدادات المراقبة" });
    return;
  }
  if (side === "telegram" && post.mosque !== "haram" && post.mosque !== "nabawi") {
    await setSide(post.id, side, { status: "needs_review", reason: "مسجد الشيخ غير معروف" });
    return;
  }

  const match = await matchRecitationToTask({
    platformId,
    target: side === "telegram" ? { kind: "mosque", mosque: post.mosque as "haram" | "nabawi" } : { kind: "reciter", reciterId: post.reciterId! },
    prayer: post.extractedPrayer as PrayerCode,
    hijriDay: post.hijriDay!,
    hijriMonth: post.hijriMonth!,
    hijriYear: post.hijriYear,
    dayNameInTitle: null,
    publishedAt: post.publishedAt,
    window: { hours: PUBLISH_WINDOW_HOURS },
    noDateMatchAs: "no_task",
    noTaskReason: side === "telegram"
      ? `لا توجد مهمة تلقرام عامة معلّقة لهذا المسجد وهذه الصلاة.`
      : "لا توجد مهمة تطبيق معلّقة لهذا القارئ وهذه الصلاة.",
  });

  if (ctx.trialMode) {
    if (match.kind === "match") await setSide(post.id, side, { status: "trial_would_document", reason: match.reason, taskId: match.taskId });
    else if (match.kind === "review") await setSide(post.id, side, { status: "trial_would_review", reason: match.reason, taskId: match.candidateTaskIds[0] ?? null });
    else await setSide(post.id, side, { status: "trial_no_task", reason: match.reason, taskId: null });
    return;
  }

  if (match.kind === "match") {
    const result = await documentTaskAutomatically({
      taskId: match.taskId,
      proofUrl: post.siteUrl!,
      publishedAt: post.publishedAt,
      note: `وثّقه النظام تلقائيًا من منشور قناة تلقرام${ctx.channelTitle ? ` «${ctx.channelTitle}»` : ""} (${side === "telegram" ? "مهمة تلقرام" : "مهمة التطبيق"}) — نُشر بتاريخ ${post.publishedAt.toISOString()}`,
      activityUserName: "مراقبة تلقرام (تلقائي)",
      activityAction: "telegram_post_documented",
      meta: { side, postId: post.id, siteUrl: post.siteUrl, postUrl: post.postUrl },
    });
    if (result.documented) {
      await setSide(post.id, side, { status: "documented", reason: match.reason, taskId: match.taskId, proofId: result.createdProofId });
    } else {
      await setSide(post.id, side, { status: "needs_review", reason: result.reason ?? "تعذّر التوثيق التلقائي", taskId: match.taskId });
    }
    return;
  }
  if (match.kind === "review") {
    await setSide(post.id, side, { status: "needs_review", reason: match.reason, taskId: match.candidateTaskIds[0] ?? null });
    return;
  }
  await setSide(post.id, side, { status: "no_task", reason: match.reason, taskId: null });
}

export async function processTelegramPost(postId: number) {
  const settings = await getMonitorSettings();
  const ctx: Ctx = {
    trialMode: settings.trialMode,
    telegramPlatformId: settings.telegramPlatformId ?? null,
    appPlatformId: settings.appPlatformId ?? null,
    channelTitle: settings.channelTitle ?? null,
  };
  let [post] = await db.select().from(telegramChannelPostsTable).where(eq(telegramChannelPostsTable.id, postId)).limit(1);
  if (!post) return;

  if (post.kind === "pending") {
    const classified = classifyCaption(post.caption);
    if (classified.kind === "other") {
      // تُتجاهل بصمت: لا توثيق ولا مراجعة.
      await db.update(telegramChannelPostsTable).set({
        kind: "other",
        ignoreReason: classified.reason,
        telegramStatus: post.telegramStatus === "pending" ? "not_applicable" : post.telegramStatus,
        appStatus: post.appStatus === "pending" ? "not_applicable" : post.appStatus,
        processedAt: new Date(),
      }).where(eq(telegramChannelPostsTable.id, post.id));
      return;
    }
    const hashtags = Array.isArray(post.hashtags) ? (post.hashtags as string[]) : [];
    const reciter = await resolveReciterFromHashtags(hashtags);
    const parsed = extractPrayerAndDate(post.caption ?? "", hashtags);
    const parseError = !reciter.ok ? reciter.reason : !parsed.ok ? parsed.reason : null;
    await db.update(telegramChannelPostsTable).set({
      kind: "recitation",
      ignoreReason: null,
      siteUrl: classified.siteUrl,
      reciterId: reciter.ok ? reciter.reciterId : null,
      mosque: reciter.ok ? reciter.mosque : null,
      extractedPrayer: parsed.ok ? parsed.prayer : null,
      hijriDay: parsed.ok ? parsed.hijriDay : null,
      hijriMonth: parsed.ok ? parsed.hijriMonth : null,
      hijriYear: parsed.ok ? parsed.hijriYear : null,
      parseError,
      processedAt: new Date(),
      // تعذّر الاستخراج ⇐ الجانبان (غير النهائيين) للمراجعة بالسبب.
      ...(parseError ? {
        telegramStatus: post.telegramStatus === "pending" ? "needs_review" : post.telegramStatus,
        telegramReason: post.telegramStatus === "pending" ? parseError : post.telegramReason,
        appStatus: post.appStatus === "pending" ? "needs_review" : post.appStatus,
        appReason: post.appStatus === "pending" ? parseError : post.appReason,
      } : {}),
    }).where(eq(telegramChannelPostsTable.id, post.id));
    if (parseError) return;
    [post] = await db.select().from(telegramChannelPostsTable).where(eq(telegramChannelPostsTable.id, postId)).limit(1);
  }

  if (post.kind !== "recitation" || !post.reciterId || !post.extractedPrayer || !post.hijriDay || !post.hijriMonth || !post.siteUrl) return;
  // كل جانب مستقل: خطأ أحدهما لا يوقف الآخر.
  for (const side of ["telegram", "app"] as const) {
    try {
      await processSide(post, side, ctx);
    } catch (error) {
      await setSide(post.id, side, { status: "needs_review", reason: `خطأ أثناء المعالجة: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
    }
  }
}

// ── الفحص الدوري ────────────────────────────────────────────────────────────────────────────
let tickRunning = false;

export async function runTelegramMonitorTick(): Promise<{ processed: number }> {
  if (tickRunning) return { processed: 0 };
  tickRunning = true;
  try {
    await ensureTelegramMonitorSchema();
    const settings = await getMonitorSettings();
    if (!settings.enabled || !settings.channelChatId) return { processed: 0 };

    // جانب عالق في «processing» (انقطاع أثناء المعالجة) ⇐ يعود معلّقًا بعد 10 دقائق.
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await db.update(telegramChannelPostsTable).set({ telegramStatus: "pending" })
      .where(and(eq(telegramChannelPostsTable.telegramStatus, "processing"), lt(telegramChannelPostsTable.processedAt, stale)));
    await db.update(telegramChannelPostsTable).set({ appStatus: "pending" })
      .where(and(eq(telegramChannelPostsTable.appStatus, "processing"), lt(telegramChannelPostsTable.processedAt, stale)));

    // إعادة فحص ضمن نافذة النشر: «مراجعة/بلا مهمة» لمنشورات تلاوة خلال آخر 72 ساعة.
    const windowStart = new Date(Date.now() - PUBLISH_WINDOW_HOURS * 60 * 60 * 1000);
    await db.update(telegramChannelPostsTable).set({ telegramStatus: "pending" })
      .where(and(eq(telegramChannelPostsTable.kind, "recitation"), gte(telegramChannelPostsTable.publishedAt, windowStart), inArray(telegramChannelPostsTable.telegramStatus, RECHECK_SIDE_STATUSES)));
    await db.update(telegramChannelPostsTable).set({ appStatus: "pending" })
      .where(and(eq(telegramChannelPostsTable.kind, "recitation"), gte(telegramChannelPostsTable.publishedAt, windowStart), inArray(telegramChannelPostsTable.appStatus, RECHECK_SIDE_STATUSES)));
    // منشورات بلا شيخ/صلاة/تاريخ مستخرَج تُعاد قراءتها (قد يكون هاشتاقها رُبط بقارئ للتو).
    await db.update(telegramChannelPostsTable).set({ kind: "pending" })
      .where(and(eq(telegramChannelPostsTable.kind, "recitation"), gte(telegramChannelPostsTable.publishedAt, windowStart), sql`${telegramChannelPostsTable.parseError} IS NOT NULL`));

    const due = await db
      .select({ id: telegramChannelPostsTable.id })
      .from(telegramChannelPostsTable)
      .where(or(
        eq(telegramChannelPostsTable.kind, "pending"),
        eq(telegramChannelPostsTable.telegramStatus, "pending"),
        eq(telegramChannelPostsTable.appStatus, "pending"),
      ))
      .orderBy(telegramChannelPostsTable.id)
      .limit(200);
    for (const row of due) await processTelegramPost(row.id).catch(() => {});
    return { processed: due.length };
  } finally {
    tickRunning = false;
  }
}

export function startTelegramMonitorScheduler(logger: { info: (...args: any[]) => void; error: (...args: any[]) => void }) {
  const run = () => runTelegramMonitorTick().catch((err) => logger.error({ err }, "telegram monitor tick failed"));
  setTimeout(run, 30_000).unref?.();
  setInterval(run, 10 * 60 * 1000).unref?.();
  logger.info("telegram channel monitor scheduler started");
}

// ── إجراءات يدوية ───────────────────────────────────────────────────────────────────────────
async function loadPost(postId: number) {
  const [post] = await db.select().from(telegramChannelPostsTable).where(eq(telegramChannelPostsTable.id, postId)).limit(1);
  if (!post) throw new TelegramMonitorError(404, "المنشور غير موجود");
  return post;
}

function sideState(post: typeof telegramChannelPostsTable.$inferSelect, side: Side) {
  return side === "telegram"
    ? { status: post.telegramStatus, taskId: post.telegramTaskId, proofId: post.telegramProofId }
    : { status: post.appStatus, taskId: post.appTaskId, proofId: post.appProofId };
}

export function parseSide(value: unknown): Side {
  if (value === "telegram" || value === "app") return value;
  throw new TelegramMonitorError(400, "جانب غير صالح");
}

// المهام المسموح ربطها يدويًا لجانب: منصته فقط، معلّقة، غير محذوفة؛ وجانب تلقرام: مهام عامة بلا قارئ.
async function assertLinkableTask(side: Side, taskId: number) {
  const settings = await getMonitorSettings();
  const platformId = side === "telegram" ? settings.telegramPlatformId : settings.appPlatformId;
  if (!platformId) throw new TelegramMonitorError(400, "منصة هذا الجانب غير محددة في الإعدادات");
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task || task.deletedAt) throw new TelegramMonitorError(404, "المهمة غير موجودة");
  if (task.platformId !== platformId) throw new TelegramMonitorError(400, "المهمة ليست على منصة هذا الجانب");
  if (side === "telegram" && task.reciterId) throw new TelegramMonitorError(400, "جانب تلقرام يقبل المهام العامة (بلا قارئ) فقط");
  if (task.status !== "pending") throw new TelegramMonitorError(409, "المهمة ليست معلّقة");
  return { task, settings };
}

export async function linkSideManually(postId: number, side: Side, taskId: number, userId: number | null) {
  const post = await loadPost(postId);
  const state = sideState(post, side);
  if (state.status === "documented") throw new TelegramMonitorError(409, "هذا الجانب موثَّق مسبقًا — تراجع عنه أولًا");
  const proofUrl = post.siteUrl ?? post.postUrl;
  if (!proofUrl) throw new TelegramMonitorError(400, "لا يوجد رابط للمنشور يصلح شاهدًا");
  const { settings } = await assertLinkableTask(side, taskId);
  const result = await documentTaskAutomatically({
    taskId,
    proofUrl,
    publishedAt: post.publishedAt,
    note: `رُبط يدويًا من صفحة مراقبة تلقرام${settings.channelTitle ? ` («${settings.channelTitle}»)` : ""} — نُشر بتاريخ ${post.publishedAt.toISOString()}`,
    activityUserName: "مراقبة تلقرام (ربط يدوي)",
    activityAction: "telegram_post_linked_manually",
    meta: { side, postId, siteUrl: post.siteUrl, postUrl: post.postUrl, userId },
  });
  if (!result.documented) throw new TelegramMonitorError(409, result.reason ?? "تعذّر التوثيق");
  await setSide(postId, side, { status: "documented", reason: "رُبط يدويًا من صفحة الإدارة", taskId, proofId: result.createdProofId }, { reviewedByUserId: userId, reviewedAt: new Date() });
  return loadPost(postId);
}

export async function ignoreSide(postId: number, side: Side, userId: number | null) {
  const post = await loadPost(postId);
  if (sideState(post, side).status === "documented") throw new TelegramMonitorError(409, "هذا الجانب موثَّق — تراجع عنه أولًا");
  await setSide(postId, side, { status: "ignored_manual", reason: "تجاهله المدير يدويًا" }, { reviewedByUserId: userId, reviewedAt: new Date() });
  return loadPost(postId);
}

// تراجع دقيق: يحذف حذفًا ناعمًا الشاهد الذي أنشأه هذا الجانب بعينه فقط، ويعيد المهمة معلّقة إن لم يبقَ
// لها شاهد فعّال (ويمسح رابط التسليم إن كان هو نفس الشاهد المُتراجَع عنه). لا يمسّ الجانب الآخر.
export async function revertSide(postId: number, side: Side, userId: number | null) {
  const post = await loadPost(postId);
  const state = sideState(post, side);
  if (state.status !== "documented" || !state.taskId) throw new TelegramMonitorError(400, "لا يوجد توثيق في هذا الجانب للتراجع عنه");
  await db.transaction(async (tx: any) => {
    let revertedUrl: string | null = null;
    if (state.proofId) {
      const [proof] = await tx.update(taskProofsTable).set({ deletedAt: new Date() }).where(eq(taskProofsTable.id, state.proofId)).returning({ url: taskProofsTable.url });
      revertedUrl = proof?.url ?? null;
    }
    const [remaining] = await tx.select({ id: taskProofsTable.id }).from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, state.taskId!), isNull(taskProofsTable.deletedAt))).limit(1);
    if (!remaining) {
      await tx.update(tasksTable).set({
        status: "pending",
        completedAt: null,
        ...(revertedUrl ? { submissionUrl: sql`CASE WHEN ${tasksTable.submissionUrl} = ${revertedUrl} THEN NULL ELSE ${tasksTable.submissionUrl} END` } : {}),
      }).where(eq(tasksTable.id, state.taskId!));
    }
  });
  await setSide(postId, side, { status: "reverted", reason: "تراجع عنه المدير — الإشعارات المُرسَلة سابقًا لم تُسحَب" }, { reviewedByUserId: userId, reviewedAt: new Date() });
  return loadPost(postId);
}

export async function reprocessPost(postId: number) {
  const post = await loadPost(postId);
  await db.update(telegramChannelPostsTable).set({
    kind: "pending",
    telegramStatus: FINAL_SIDE_STATUSES.has(post.telegramStatus) && post.telegramStatus !== "not_applicable" ? post.telegramStatus : "pending",
    appStatus: FINAL_SIDE_STATUSES.has(post.appStatus) && post.appStatus !== "not_applicable" ? post.appStatus : "pending",
  }).where(eq(telegramChannelPostsTable.id, postId));
  await processTelegramPost(postId);
  return loadPost(postId);
}

export async function addHashtagAlias(hashtag: string, reciterId: number) {
  const normalized = normalizeName(normalizeForNameCheck(hashtag));
  if (!normalized) throw new TelegramMonitorError(400, "هاشتاق غير صالح");
  const [reciter] = await db.select({ id: recitersTable.id }).from(recitersTable).where(eq(recitersTable.id, reciterId)).limit(1);
  if (!reciter) throw new TelegramMonitorError(404, "القارئ غير موجود");
  await db.insert(telegramHashtagAliasesTable).values({ hashtag: normalized, reciterId })
    .onConflictDoUpdate({ target: telegramHashtagAliasesTable.hashtag, set: { reciterId } });
  // إعادة معالجة منشورات التلاوة التي تعذّر فيها التعرّف على الشيخ.
  const affected = await db.select({ id: telegramChannelPostsTable.id }).from(telegramChannelPostsTable)
    .where(and(eq(telegramChannelPostsTable.kind, "recitation"), isNull(telegramChannelPostsTable.reciterId)));
  for (const row of affected) await reprocessPost(row.id).catch(() => {});
  return { hashtag: normalized, reciterId, reprocessed: affected.length };
}

// ── القوائم للصفحة ──────────────────────────────────────────────────────────────────────────
export async function listPosts(filter: { status?: string; side?: Side | "any"; kind?: string; limit?: number }) {
  const conditions = [];
  if (filter.kind) conditions.push(eq(telegramChannelPostsTable.kind, filter.kind));
  if (filter.status) {
    if (filter.side === "telegram") conditions.push(eq(telegramChannelPostsTable.telegramStatus, filter.status));
    else if (filter.side === "app") conditions.push(eq(telegramChannelPostsTable.appStatus, filter.status));
    else conditions.push(or(eq(telegramChannelPostsTable.telegramStatus, filter.status), eq(telegramChannelPostsTable.appStatus, filter.status))!);
  }
  const rows = await db
    .select({ post: telegramChannelPostsTable, reciterName: recitersTable.name })
    .from(telegramChannelPostsTable)
    .leftJoin(recitersTable, eq(telegramChannelPostsTable.reciterId, recitersTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(telegramChannelPostsTable.publishedAt))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 300));
  const taskIds = [...new Set(rows.flatMap((r) => [r.post.telegramTaskId, r.post.appTaskId]).filter((x): x is number => Boolean(x)))];
  const tasks = taskIds.length ? await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable).where(inArray(tasksTable.id, taskIds)) : [];
  const titleById = new Map(tasks.map((t) => [t.id, t.title]));
  return rows.map((r) => ({
    ...r.post,
    reciterName: r.reciterName ?? null,
    telegramTaskTitle: r.post.telegramTaskId ? titleById.get(r.post.telegramTaskId) ?? null : null,
    appTaskTitle: r.post.appTaskId ? titleById.get(r.post.appTaskId) ?? null : null,
  }));
}

// مرشّحو الربط اليدوي لجانب: مهام منصته المعلّقة القريبة من تاريخ المنشور (±4 أيام).
export async function linkCandidates(postId: number, side: Side) {
  const post = await loadPost(postId);
  const settings = await getMonitorSettings();
  const platformId = side === "telegram" ? settings.telegramPlatformId : settings.appPlatformId;
  if (!platformId) return [];
  const from = new Date(post.publishedAt.getTime() - 4 * 24 * 60 * 60 * 1000);
  const to = new Date(post.publishedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
  const conditions = [
    eq(tasksTable.platformId, platformId),
    eq(tasksTable.status, "pending"),
    isNull(tasksTable.deletedAt),
    gte(tasksTable.dueDate, from),
    lt(tasksTable.dueDate, to),
  ];
  if (side === "telegram") conditions.push(isNull(tasksTable.reciterId));
  return db
    .select({ id: tasksTable.id, title: tasksTable.title, prayer: tasksTable.prayer, mosque: tasksTable.mosque, dueDate: sql<string>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')` })
    .from(tasksTable)
    .where(and(...conditions))
    .orderBy(tasksTable.dueDate)
    .limit(100);
}

// مهام بلا منشور: مهام الجانبين المعلّقة التي انتهت نافذتها (72 ساعة) خلال آخر 14 يومًا.
export async function tasksWithoutPost() {
  const settings = await getMonitorSettings();
  const ids = [settings.telegramPlatformId, settings.appPlatformId].filter((x): x is number => Boolean(x));
  if (ids.length === 0) return [];
  const windowEnded = new Date(Date.now() - PUBLISH_WINDOW_HOURS * 60 * 60 * 1000);
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      platformId: tasksTable.platformId,
      reciterId: tasksTable.reciterId,
      mosque: tasksTable.mosque,
      prayer: tasksTable.prayer,
      dueDate: sql<string>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')`,
    })
    .from(tasksTable)
    .where(and(
      inArray(tasksTable.platformId, ids),
      eq(tasksTable.status, "pending"),
      isNull(tasksTable.deletedAt),
      lt(tasksTable.dueDate, windowEnded),
      gte(tasksTable.dueDate, since),
    ))
    .orderBy(desc(tasksTable.dueDate))
    .limit(200);
  // جانب تلقرام: المهام العامة فقط (بلا قارئ).
  return rows.filter((r) => r.platformId !== settings.telegramPlatformId || r.reciterId === null)
    .map((r) => ({ ...r, side: r.platformId === settings.telegramPlatformId ? "telegram" : "app" }));
}

export async function listSeenChats() {
  return db.select().from(telegramSeenChatsTable).orderBy(desc(telegramSeenChatsTable.lastSeenAt)).limit(50);
}

export async function listAliases() {
  return db
    .select({ id: telegramHashtagAliasesTable.id, hashtag: telegramHashtagAliasesTable.hashtag, reciterId: telegramHashtagAliasesTable.reciterId, reciterName: recitersTable.name })
    .from(telegramHashtagAliasesTable)
    .innerJoin(recitersTable, eq(telegramHashtagAliasesTable.reciterId, recitersTable.id))
    .orderBy(telegramHashtagAliasesTable.hashtag);
}

export async function updateMonitorSettings(body: any) {
  const settings = await getMonitorSettings();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body?.trialMode === "boolean") patch.trialMode = body.trialMode;
  if ("telegramPlatformId" in (body ?? {})) {
    const id = body.telegramPlatformId ? Number(body.telegramPlatformId) : null;
    if (id) {
      const [p] = await db.select().from(platformsTable).where(eq(platformsTable.id, id)).limit(1);
      if (!p) throw new TelegramMonitorError(400, "منصة تلقرام غير موجودة");
      if (p.coversAllReciters) throw new TelegramMonitorError(400, "منصة تلقرام لا يمكن أن تكون منصة «تشمل كل القرّاء»");
    }
    patch.telegramPlatformId = id;
  }
  if ("appPlatformId" in (body ?? {})) {
    const id = body.appPlatformId ? Number(body.appPlatformId) : null;
    if (id) {
      const [p] = await db.select().from(platformsTable).where(eq(platformsTable.id, id)).limit(1);
      if (!p) throw new TelegramMonitorError(400, "منصة التطبيق غير موجودة");
      if (!p.coversAllReciters) throw new TelegramMonitorError(400, "منصة التطبيق يجب أن تكون المنصة المعلَّمة «تشمل كل القرّاء»");
    }
    patch.appPlatformId = id;
  }
  if ("channelChatId" in (body ?? {})) {
    const chatId = body.channelChatId ? String(body.channelChatId) : null;
    if (chatId && chatId !== settings.channelChatId) {
      const [seen] = await db.select().from(telegramSeenChatsTable).where(eq(telegramSeenChatsTable.chatId, chatId)).limit(1);
      if (!seen) throw new TelegramMonitorError(400, "القناة غير موجودة ضمن المحادثات التي رآها البوت");
      if (seen.type && seen.type !== "channel") throw new TelegramMonitorError(400, "المحادثة المختارة ليست قناة");
      patch.channelChatId = chatId;
      patch.channelTitle = seen.title;
      patch.channelUsername = seen.username;
      // المنشورات قبل لحظة التسجيل لا تُعالَج.
      patch.monitoringStartedAt = new Date();
    } else if (!chatId) {
      patch.channelChatId = null;
    }
  }
  const [updated] = await db.update(telegramMonitorSettingsTable).set(patch).where(eq(telegramMonitorSettingsTable.id, settings.id)).returning();
  return updated;
}
