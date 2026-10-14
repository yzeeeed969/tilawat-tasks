import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  facebookConnectionTable,
  facebookPagesTable,
  instagramAccountsTable,
  instagramFacebookLinksTable,
  instagramMediaTable,
  recitersTable,
  taskProofsTable,
} from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { getInstagramSettings, InstagramError } from "./instagram-accounts";
import { getFacebookConnection } from "./facebook-accounts";
import { FacebookApiError, fetchPageItems, getFacebookConfig, type FacebookItem } from "./facebook-client";
import { addSupplementaryProof } from "./auto-documentation";
import { notifyTelegramAdminsFacebookReconnect } from "./telegram-notification-engine";
import { decryptToken } from "../lib/instagram-token-crypto";

// نسخة فيسبوك لمنشور إنستقرام — الاتجاه إنستقرام ← فيسبوك فقط:
// نبدأ دائمًا من منشور إنستقرام (له شاهد على مهمة)، ونبحث عن نسخته التلقائية في صفحة فيسبوك المقابلة
// بالنص (تطابق تام أو تشابه ≥ 0.9) + التوقيت (± نافذة). تطابق واحد ⇐ رابط فيسبوك شاهد تكميلي على نفس
// المهمة (لا يغيّر الحالة ولا العدّاد ولا يُرسل إشعارًا). لا تطابق ⇐ إعادة المحاولة حتى 48 ساعة ثم
// «لم يُعثر على نسخة فيسبوك». أكثر من تطابق ⇐ اختيار يدوي. منشور فيسبوك بلا أصل إنستقرام لا يُمس أبدًا.

const REAL_MEDIA_STATUSES = ["documented", "proof_counted", "extra_proof"];
const TRIAL_MEDIA_STATUSES = ["trial_would_create", "trial_would_add"];
const RETRY_HOURS = 48;
const LOOKBACK_DAYS = 7;
const SIMILARITY_THRESHOLD = 0.9;

export function normalizeCaption(text: string | null | undefined): string {
  return (text ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

// تشابه نصّي 0..1 = 1 − (مسافة ليفنشتاين ÷ طول الأطول).
export function captionSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const longer = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) / longer > 1 - SIMILARITY_THRESHOLD) return 0; // لا يمكن بلوغ العتبة
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return 1 - prev[b.length] / longer;
}

export type MatchOutcome =
  | { kind: "match"; item: FacebookItem; similarity: number }
  | { kind: "ambiguous"; candidates: FacebookItem[] }
  | { kind: "none"; reason: string };

// المطابقة نفسها (نقية): كابشن إنستقرام ضد نص عناصر صفحة فيسبوك، ضمن نافذة التوقيت. الريلز أولًا.
export function matchCrosspost(input: { caption: string | null; publishedAt: Date; items: FacebookItem[]; windowHours: number; excludedFbIds?: Set<string> }): MatchOutcome {
  const caption = normalizeCaption(input.caption);
  if (!caption) return { kind: "none", reason: "منشور إنستقرام بلا كابشن — لا تُمكن المطابقة النصّية (أضف الرابط يدويًا)" };
  const windowMs = input.windowHours * 3600 * 1000;
  const scored = input.items
    .filter((item) => !input.excludedFbIds?.has(item.id))
    .filter((item) => Math.abs(item.createdAt.getTime() - input.publishedAt.getTime()) <= windowMs)
    .map((item) => ({ item, similarity: captionSimilarity(caption, normalizeCaption(item.text)) }))
    .filter((row) => row.similarity >= SIMILARITY_THRESHOLD);
  // الريل نفسه قد يظهر في المنشورات أيضًا — الريلز تُفضَّل، والمنشورات لا تُعتبر إلا عند غيابها.
  const reels = scored.filter((row) => row.item.kind === "reel");
  const pool = reels.length > 0 ? reels : scored.filter((row) => row.item.kind === "post");
  if (pool.length === 1) return { kind: "match", item: pool[0].item, similarity: pool[0].similarity };
  if (pool.length > 1) return { kind: "ambiguous", candidates: pool.map((row) => row.item) };
  return { kind: "none", reason: `لا يوجد منشور فيسبوك بنفس النص ضمن ±${input.windowHours} ساعات` };
}

async function markFacebookNeedsReconnect(reason: string, fbPageId?: string) {
  if (fbPageId) {
    await db.update(facebookPagesTable).set({ status: "needs_reconnect", lastError: reason, updatedAt: new Date() }).where(eq(facebookPagesTable.fbPageId, fbPageId));
  }
  const connection = await getFacebookConnection();
  const firstAlert = !connection.reconnectAlertSentAt;
  await db.update(facebookConnectionTable).set({
    status: "needs_reconnect",
    lastError: reason,
    ...(firstAlert ? { reconnectAlertSentAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(eq(facebookConnectionTable.id, connection.id));
  if (firstAlert) await notifyTelegramAdminsFacebookReconnect({ reason, alertKey: String(Date.now()) }).catch(() => {});
}

// صفوف ربط «معلّقة» لكل منشور إنستقرام مؤهَّل (آخر 7 أيام) في حساب له صفحة فيسبوك — بلا تكرار.
async function seedPendingLinks(trialMode: boolean, now: Date) {
  const statuses = trialMode ? [...REAL_MEDIA_STATUSES, ...TRIAL_MEDIA_STATUSES] : REAL_MEDIA_STATUSES;
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000);
  const rows = await db
    .select({ mediaId: instagramMediaTable.id, accountId: instagramMediaTable.accountId, fbPageId: instagramAccountsTable.fbPageId, taskId: instagramMediaTable.taskId })
    .from(instagramMediaTable)
    .innerJoin(instagramAccountsTable, eq(instagramAccountsTable.id, instagramMediaTable.accountId))
    .leftJoin(instagramFacebookLinksTable, eq(instagramFacebookLinksTable.mediaId, instagramMediaTable.id))
    .where(and(
      inArray(instagramMediaTable.status, statuses),
      gte(instagramMediaTable.publishedAt, since),
      sql`${instagramAccountsTable.fbPageId} IS NOT NULL`,
      isNull(instagramFacebookLinksTable.id),
    ));
  for (const row of rows) {
    await db.insert(instagramFacebookLinksTable).values({ mediaId: row.mediaId, accountId: row.accountId, fbPageId: row.fbPageId!, taskId: row.taskId, status: "pending" }).onConflictDoNothing();
  }
}

export async function runFacebookCrosspostTick(now = new Date()): Promise<{ processed: number; linked: number; skipped?: "no_config" | "not_connected" | "disabled" }> {
  await ensureInstagramSchema();
  const settings = await getInstagramSettings();
  if (!settings.enabled) return { processed: 0, linked: 0, skipped: "disabled" };
  const config = getFacebookConfig();
  if (!config) return { processed: 0, linked: 0, skipped: "no_config" };
  const connection = await getFacebookConnection();
  if (connection.status !== "connected") return { processed: 0, linked: 0, skipped: "not_connected" };
  const trialMode = settings.fbTrialMode;
  await seedPendingLinks(trialMode, now);

  // الصفوف المطلوب معالجتها: المعلّقة، و(عند إطفاء التجربة) ما سجّلته التجربة لتُكتب فعليًا الآن.
  const pending = await db
    .select({
      link: instagramFacebookLinksTable,
      caption: instagramMediaTable.caption,
      publishedAt: instagramMediaTable.publishedAt,
      mediaStatus: instagramMediaTable.status,
      mediaTaskId: instagramMediaTable.taskId,
      permalink: instagramMediaTable.permalink,
    })
    .from(instagramFacebookLinksTable)
    .innerJoin(instagramMediaTable, eq(instagramMediaTable.id, instagramFacebookLinksTable.mediaId))
    .where(inArray(instagramFacebookLinksTable.status, trialMode ? ["pending"] : ["pending", "trial_would_link"]))
    .orderBy(instagramMediaTable.publishedAt);
  if (pending.length === 0) return { processed: 0, linked: 0 };

  // روابط فيسبوك المستخدمة فعليًا (لا يُربط منشور فيسبوك بمنشورَي إنستقرام).
  const used = new Set((await db.select({ id: instagramFacebookLinksTable.fbPostId }).from(instagramFacebookLinksTable)
    .where(inArray(instagramFacebookLinksTable.status, ["linked", "manual"]))).map((row) => row.id).filter(Boolean) as string[]);

  // عناصر كل صفحة تُجلب مرة واحدة في الدورة (احترامًا لحدود الاستخدام).
  const itemsByPage = new Map<string, FacebookItem[] | null>();
  const since = new Date(now.getTime() - (LOOKBACK_DAYS + 1) * 86400000);
  const pageItems = async (fbPageId: string): Promise<FacebookItem[] | null> => {
    if (itemsByPage.has(fbPageId)) return itemsByPage.get(fbPageId)!;
    const [page] = await db.select().from(facebookPagesTable).where(eq(facebookPagesTable.fbPageId, fbPageId)).limit(1);
    const token = page ? decryptToken(page.accessTokenEncrypted, config.appSecret) : null;
    if (!page || !token || page.status !== "connected") {
      itemsByPage.set(fbPageId, null);
      return null;
    }
    try {
      const items = await fetchPageItems(fbPageId, token, since);
      itemsByPage.set(fbPageId, items);
      return items;
    } catch (err) {
      if (err instanceof FacebookApiError && err.isAuthError) await markFacebookNeedsReconnect(`رفض فيسبوك مفتاح الصفحة «${page.name}»: ${err.message}`, fbPageId);
      else await db.update(facebookPagesTable).set({ lastError: `تعذّر الجلب مؤقتًا: ${(err as Error).message}`, updatedAt: new Date() }).where(eq(facebookPagesTable.fbPageId, fbPageId));
      itemsByPage.set(fbPageId, null);
      return null;
    }
  };

  let processed = 0;
  let linked = 0;
  for (const row of pending) {
    const link = row.link;
    const realProof = REAL_MEDIA_STATUSES.includes(row.mediaStatus) && row.mediaTaskId;
    if (!realProof && !(trialMode && TRIAL_MEDIA_STATUSES.includes(row.mediaStatus))) {
      await db.update(instagramFacebookLinksTable).set({ status: "skipped", reason: "منشور إنستقرام لم يعد موثَّقًا (تراجع؟)", lastAttemptAt: now }).where(eq(instagramFacebookLinksTable.id, link.id));
      continue;
    }
    const items = await pageItems(link.fbPageId);
    if (!items) continue; // الصفحة غير متاحة الآن — يبقى معلّقًا
    processed += 1;
    const outcome = matchCrosspost({ caption: row.caption, publishedAt: row.publishedAt, items, windowHours: settings.fbMatchWindowHours, excludedFbIds: used });
    const attempt = { attempts: link.attempts + 1, lastAttemptAt: now };

    if (outcome.kind === "none") {
      const ageHours = (now.getTime() - row.publishedAt.getTime()) / 3600000;
      const giveUp = ageHours >= RETRY_HOURS || !normalizeCaption(row.caption);
      await db.update(instagramFacebookLinksTable).set({
        ...attempt,
        status: giveUp ? "not_found" : "pending",
        reason: giveUp ? `لم يُعثر على نسخة فيسبوك — ${outcome.reason}` : `لم تظهر نسخة فيسبوك بعد (إعادة المحاولة حتى ${RETRY_HOURS} ساعة) — ${outcome.reason}`,
      }).where(eq(instagramFacebookLinksTable.id, link.id));
      continue;
    }
    if (outcome.kind === "ambiguous") {
      await db.update(instagramFacebookLinksTable).set({
        ...attempt,
        status: "ambiguous",
        reason: `أكثر من منشور فيسبوك يطابق (${outcome.candidates.length}) — اختر يدويًا`,
        candidates: outcome.candidates.map((item) => ({ id: item.id, kind: item.kind, url: item.url, createdAt: item.createdAt.toISOString(), text: item.text.slice(0, 200) })),
      }).where(eq(instagramFacebookLinksTable.id, link.id));
      continue;
    }

    const match = outcome.item;
    if (trialMode || !realProof) {
      await db.update(instagramFacebookLinksTable).set({
        ...attempt, status: "trial_would_link", fbPostId: match.id, fbUrl: match.url,
        reason: `وضع التجربة: كان سيُرفق ${match.kind === "reel" ? "الريل" : "المنشور"} (تشابه ${Math.round(outcome.similarity * 100)}٪)`,
      }).where(eq(instagramFacebookLinksTable.id, link.id));
      continue;
    }
    const added = await addSupplementaryProof({
      taskId: row.mediaTaskId!,
      proofUrl: match.url,
      note: `نسخة فيسبوك لمنشور إنستقرام ${row.permalink ?? ""} — أُرفقت تلقائيًا (شاهد تكميلي لا يُحتسب في العدّاد)`.trim(),
      activityUserName: "نسخة فيسبوك (تلقائي)",
      activityAction: "facebook_crosspost_linked",
      meta: { mediaId: link.mediaId, fbPostId: match.id, fbUrl: match.url },
    });
    if (!added.added) {
      await db.update(instagramFacebookLinksTable).set({ ...attempt, status: "skipped", reason: added.reason ?? "تعذّر إرفاق الشاهد" }).where(eq(instagramFacebookLinksTable.id, link.id));
      continue;
    }
    used.add(match.id);
    linked += 1;
    await db.update(instagramFacebookLinksTable).set({
      ...attempt, status: "linked", fbPostId: match.id, fbUrl: match.url, taskId: row.mediaTaskId, proofId: added.createdProofId,
      reason: `أُرفقت نسخة فيسبوك (${match.kind === "reel" ? "ريل" : "منشور"}، تشابه ${Math.round(outcome.similarity * 100)}٪)`,
    }).where(eq(instagramFacebookLinksTable.id, link.id));
  }
  return { processed, linked };
}

// ── الإدارة: السجل، الإرفاق اليدوي، والتراجع ─────────────────────────────────────────────────
export async function listFacebookLinks(limit = 100) {
  await ensureInstagramSchema();
  return db
    .select({
      id: instagramFacebookLinksTable.id,
      mediaId: instagramFacebookLinksTable.mediaId,
      status: instagramFacebookLinksTable.status,
      fbUrl: instagramFacebookLinksTable.fbUrl,
      fbPageId: instagramFacebookLinksTable.fbPageId,
      taskId: instagramFacebookLinksTable.taskId,
      candidates: instagramFacebookLinksTable.candidates,
      reason: instagramFacebookLinksTable.reason,
      attempts: instagramFacebookLinksTable.attempts,
      lastAttemptAt: instagramFacebookLinksTable.lastAttemptAt,
      igPermalink: instagramMediaTable.permalink,
      igCaption: instagramMediaTable.caption,
      igPublishedAt: instagramMediaTable.publishedAt,
      reciterName: recitersTable.name,
    })
    .from(instagramFacebookLinksTable)
    .innerJoin(instagramMediaTable, eq(instagramMediaTable.id, instagramFacebookLinksTable.mediaId))
    .innerJoin(instagramAccountsTable, eq(instagramAccountsTable.id, instagramFacebookLinksTable.accountId))
    .innerJoin(recitersTable, eq(recitersTable.id, instagramAccountsTable.reciterId))
    .orderBy(desc(instagramMediaTable.publishedAt))
    .limit(Math.min(Math.max(limit, 1), 300));
}

const FACEBOOK_URL = /^https:\/\/(www\.|m\.|web\.)?(facebook\.com|fb\.watch)\//i;

// إرفاق يدوي لرابط فيسبوك — دائمًا على صف ربط له أصل إنستقرام موثَّق (لا رابط فيسبوك بلا أصل).
export async function setManualFacebookLink(linkId: number, url: unknown, userId: number | null) {
  await ensureInstagramSchema();
  const value = typeof url === "string" ? url.trim() : "";
  if (!FACEBOOK_URL.test(value)) throw new InstagramError(400, "أدخل رابط فيسبوك صحيحًا (facebook.com/…)");
  const [row] = await db
    .select({ link: instagramFacebookLinksTable, mediaStatus: instagramMediaTable.status, mediaTaskId: instagramMediaTable.taskId })
    .from(instagramFacebookLinksTable)
    .innerJoin(instagramMediaTable, eq(instagramMediaTable.id, instagramFacebookLinksTable.mediaId))
    .where(eq(instagramFacebookLinksTable.id, linkId))
    .limit(1);
  if (!row) throw new InstagramError(404, "الصف غير موجود");
  if (row.link.status === "linked" || row.link.status === "manual") throw new InstagramError(409, "مُرفقة مسبقًا — تراجع عنها أولًا");
  if (!REAL_MEDIA_STATUSES.includes(row.mediaStatus) || !row.mediaTaskId) throw new InstagramError(400, "منشور إنستقرام ليس له شاهد على مهمة بعد (وضع التجربة؟)");
  const added = await addSupplementaryProof({
    taskId: row.mediaTaskId,
    proofUrl: value,
    note: "نسخة فيسبوك لمنشور إنستقرام — أُرفقت يدويًا (شاهد تكميلي لا يُحتسب في العدّاد)",
    activityUserName: "نسخة فيسبوك (يدوي)",
    activityAction: "facebook_crosspost_manual",
    createdByUserId: userId,
    meta: { mediaId: row.link.mediaId, fbUrl: value },
  });
  if (!added.added) throw new InstagramError(409, added.reason ?? "تعذّر الإرفاق");
  await db.update(instagramFacebookLinksTable).set({
    status: "manual", fbUrl: value, fbPostId: null, taskId: row.mediaTaskId, proofId: added.createdProofId,
    reason: "أُرفق يدويًا من صفحة الإدارة", reviewedByUserId: userId, reviewedAt: new Date(),
  }).where(eq(instagramFacebookLinksTable.id, linkId));
}

// تراجع عن نسخة فيسبوك: حذف ناعم للشاهد التكميلي فقط (العدّاد والحالة لا يتأثران أصلًا).
export async function revertFacebookLink(linkId: number, userId: number | null) {
  await ensureInstagramSchema();
  const [link] = await db.select().from(instagramFacebookLinksTable).where(eq(instagramFacebookLinksTable.id, linkId)).limit(1);
  if (!link) throw new InstagramError(404, "الصف غير موجود");
  if (link.status !== "linked" && link.status !== "manual") throw new InstagramError(400, "لا يوجد رابط فيسبوك مُرفق للتراجع عنه");
  if (link.proofId) await db.update(taskProofsTable).set({ deletedAt: new Date() }).where(and(eq(taskProofsTable.id, link.proofId), eq(taskProofsTable.isSupplementary, true)));
  await db.update(instagramFacebookLinksTable).set({ status: "reverted", reason: "تراجع عنه المدير", reviewedByUserId: userId, reviewedAt: new Date() }).where(eq(instagramFacebookLinksTable.id, linkId));
}

