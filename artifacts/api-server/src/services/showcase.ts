import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureShowcaseSchema } from "./showcase-schema";
import { ensureInstagramSchema } from "./instagram-schema";
import { callYoutubeApi } from "./youtube-client";
import { getInstagramConfig } from "./instagram-client";
import { getFacebookConfig } from "./facebook-client";
import { callTelegramApi } from "./telegram";
import { riyadhWeekStart } from "./instagram-monitor";
import { decryptToken } from "../lib/instagram-token-crypto";
import { INSTAGRAM_PLATFORM_NAME } from "../lib/instagram-platform";

// صفحة «منصات مشروع تطبيق تلاوات الحرمين» (/achievements) — بيانات حيّة من ثلاثة مصادر:
// 1) قاعدة البيانات: الحسابات (صفحات المنصات)، التطبيقات، وعدد المنشورات الموثّقة لكل حساب.
// 2) YouTube Data API: المشتركون والمشاهدات وآخر المقاطع لكل قناة.
// 3) Meta Graph API (Quran Views): متابعو إنستقرام/فيسبوك وأحدث المقاطع.
// كل مصدر مستقل: تعذّره يُفرغ قسمه فقط. النتيجة مخزّنة مؤقتًا 30 دقيقة، وتُقدَّم آخر نسخة سليمة عند الخطأ.
// لا يُرسل أي مفتاح أو رمز إلى الواجهة أبدًا.

// المصدر الوحيد للقنوات والحسابات: صفحة إدارة المنصات. هذه القائمة القديمة (كانت ثابتة في الكود حتى
// الإصدار 30) لا تُعرض إطلاقًا — تُستخدم فقط في تقرير التشخيص للمدير لبيان ما كان يظهر واختفى.
const LEGACY_FIXED_YOUTUBE_CHANNELS = [
  "UCeLuU2J219WqFPZYJJquhRA", "UCM7ZXt5QOxh-8ScBOyPg2sw", "UCCoB7Hf8gjQzpAyzhvx7Ktg", "UCfbqZ0LoOdE6WB_u38y3cnQ", "UCqe5E-6-HxFrWGyBOdWOz8Q",
];

const CACHE_MS = 30 * 60 * 1000;
const FACEBOOK_PLATFORM_NAME = /فيسبوك|فيس بوك|facebook/i;
const TELEGRAM_PLATFORM_NAME = /تلقرام|تيليجرام|تليجرام|تلغرام|telegram/i;
const TWITTER_PLATFORM_NAME = /تويتر|twitter|^x$|\bx\b|إكس/i;
const APP_PLATFORM_NAME = /^تطبيق/;
const YOUTUBE_PLATFORM_NAME = /يوتيوب|youtube/i;

export type ShowcaseClip = { title: string; views: number | null; url: string; thumbnail: string | null; publishedAt: string | null };
export type ShowcaseAccount = { name: string; url: string | null; followers: number | null; posts: number };
export type ShowcaseReel = { account: string; url: string; thumbnail: string | null; publishedAt: string | null };
export type ShowcaseData = {
  generatedAt: string;
  hero: { youtubeViews: number; youtubeSubscribers: number; appsCount: number };
  featured: (ShowcaseClip & { channelTitle: string }) | null;
  youtube: Array<{ channelId: string; title: string; url: string; avatar: string | null; subscribers: number | null; views: number | null; clips: ShowcaseClip[] }>;
  apps: Array<{ name: string; iosUrl: string | null; androidUrl: string | null; avatar: string | null }>;
  platforms: {
    instagram: { accounts: ShowcaseAccount[]; reels: ShowcaseReel[] };
    facebook: { accounts: ShowcaseAccount[]; reels: ShowcaseReel[] };
    telegram: { accounts: ShowcaseAccount[] };
    twitter: { accounts: ShowcaseAccount[] };
  };
  designs: { items: Array<{ url: string; publishedAt: string }>; channel: { name: string; url: string | null; subscribers: number | null } | null };
  feed: Array<{ platform: "youtube" | "instagram" | "facebook" | "telegram" | "designs"; title: string; url: string; publishedAt: string }>;
  // للمدير فقط (يُحذف من الرد العام): ما ينقص القنوات المسجّلة، وما لم يعد يظهر ولماذا.
  diagnostics?: ShowcaseDiagnostics;
};
export type ShowcaseDiagnostics = {
  youtube: Array<{ pageId: number; pageName: string; pageUrl: string | null; status: "ok" | "missing"; channelId: string | null; problem: string | null }>;
  hidden: Array<{ what: string; why: string }>;
};

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];
const nameKey = (value: string) => value.replace(/\s+/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");

// ── يوتيوب (القنوات = صفحات منصة يوتيوب المسجّلة) ─────────────────────────────────────────────
type YoutubeChannelData = ShowcaseData["youtube"][number] & { reciterName: string | null; recent: ShowcaseClip[] };
type YoutubeTarget = { pageId: number; pageName: string; pageUrl: string | null; reciterName: string | null };

// معرّف القناة من رابط صفحة يوتيوب: /channel/UC… مباشرة، أو @handle و/user/ تُحلّ عبر الواجهة.
export function parseYoutubeChannelUrl(url: string | null): { kind: "id" | "handle" | "user"; value: string } | { kind: "invalid"; problem: string } {
  const raw = (url ?? "").trim();
  if (!raw) return { kind: "invalid", problem: "لا يوجد رابط للقناة في صفحة المنصات (أضف رابط القناة: youtube.com/@… أو youtube.com/channel/UC…)" };
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { kind: "invalid", problem: `الرابط غير صالح: ${raw}` }; }
  if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) return { kind: "invalid", problem: `الرابط ليس رابط قناة يوتيوب: ${raw}` };
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "channel" && /^UC[\w-]{22}$/.test(segments[1] ?? "")) return { kind: "id", value: segments[1] };
  if (segments[0]?.startsWith("@") && segments[0].length > 1) return { kind: "handle", value: decodeURIComponent(segments[0]) };
  if (segments[0] === "user" && segments[1]) return { kind: "user", value: segments[1] };
  if (segments[0] === "c") return { kind: "invalid", problem: `رابط بصيغة /c/ لا يحدّد القناة بدقة — استبدله برابط @الاسم أو /channel/UC…: ${raw}` };
  return { kind: "invalid", problem: `تعذّر استخراج معرّف القناة من الرابط — استخدم youtube.com/@… أو youtube.com/channel/UC…: ${raw}` };
}

const resolvedHandles = new Map<string, string | null>();
async function resolveYoutubeTargets(targets: YoutubeTarget[]) {
  const resolved: Array<YoutubeTarget & { channelId: string }> = [];
  const report: ShowcaseDiagnostics["youtube"] = [];
  for (const target of targets) {
    const parsed = parseYoutubeChannelUrl(target.pageUrl);
    let channelId: string | null = null;
    let problem: string | null = null;
    if (parsed.kind === "invalid") problem = parsed.problem;
    else if (parsed.kind === "id") channelId = parsed.value;
    else {
      const cacheKey = `${parsed.kind}:${parsed.value.toLowerCase()}`;
      if (!resolvedHandles.has(cacheKey)) {
        const data = await callYoutubeApi<{ items?: Array<{ id: string }> }>("channels", { part: "id", [parsed.kind === "handle" ? "forHandle" : "forUsername"]: parsed.value }).catch(() => null);
        if (data) resolvedHandles.set(cacheKey, data.items?.[0]?.id ?? null);
        else problem = "تعذّر الاتصال بيوتيوب لتحويل اسم القناة إلى معرّف — سيُعاد المحاولة";
      }
      channelId = resolvedHandles.get(cacheKey) ?? null;
      if (!channelId && !problem) problem = `لم يجد يوتيوب قناة بالاسم ${parsed.value} — تحقّق من الرابط`;
    }
    if (channelId) resolved.push({ ...target, channelId });
    report.push({ pageId: target.pageId, pageName: target.pageName, pageUrl: target.pageUrl, status: channelId ? "ok" : "missing", channelId, problem });
  }
  return { resolved, report };
}

async function loadYoutube(targets: Array<YoutubeTarget & { channelId: string }>, report: ShowcaseDiagnostics["youtube"]): Promise<YoutubeChannelData[]> {
  const ids = [...new Set(targets.map((t) => t.channelId))];
  if (ids.length === 0) return [];
  const channels = await callYoutubeApi<{ items?: any[] }>("channels", { part: "snippet,statistics,contentDetails", id: ids.join(","), maxResults: "50" });
  const byId = new Map((channels.items ?? []).map((item) => [String(item.id), item]));
  const uploadsByChannel = new Map<string, string[]>();
  await Promise.all(ids.map(async (id) => {
    const playlist = byId.get(id)?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlist) return;
    const items = await callYoutubeApi<{ items?: any[] }>("playlistItems", { part: "contentDetails", playlistId: playlist, maxResults: "12" }).catch(() => ({ items: [] }));
    uploadsByChannel.set(id, (items.items ?? []).map((row) => String(row?.contentDetails?.videoId ?? "")).filter(Boolean));
  }));
  const allVideoIds = [...uploadsByChannel.values()].flat();
  const videos = new Map<string, any>();
  for (let i = 0; i < allVideoIds.length; i += 50) {
    const batch = await callYoutubeApi<{ items?: any[] }>("videos", { part: "snippet,statistics", id: allVideoIds.slice(i, i + 50).join(",") });
    for (const item of batch.items ?? []) videos.set(String(item.id), item);
  }
  const toClip = (videoId: string): ShowcaseClip | null => {
    const video = videos.get(videoId);
    if (!video) return null;
    const thumbs = video.snippet?.thumbnails ?? {};
    return {
      title: String(video.snippet?.title ?? ""),
      views: video.statistics?.viewCount != null ? Number(video.statistics.viewCount) : null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: (thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
      publishedAt: video.snippet?.publishedAt ?? null,
    };
  };
  const seen = new Set<string>();
  return targets.flatMap((target) => {
    const channel = byId.get(target.channelId);
    if (!channel) {
      // المعرّف موجود لكن يوتيوب لا يعرفه (قناة محذوفة/خاطئة) — لا يُخفى بصمت.
      const row = report.find((r) => r.pageId === target.pageId);
      if (row) { row.status = "missing"; row.problem = `معرّف القناة ${target.channelId} غير موجود على يوتيوب — تحقّق من الرابط`; }
      return [];
    }
    if (seen.has(target.channelId)) return []; // نفس القناة مسجّلة في صفحتين ⇐ تُعرض مرة واحدة
    seen.add(target.channelId);
    const recent = (uploadsByChannel.get(target.channelId) ?? []).map(toClip).filter((clip): clip is ShowcaseClip => Boolean(clip));
    const thumbs = channel.snippet?.thumbnails ?? {};
    const stats = channel.statistics ?? {};
    return [{
      channelId: target.channelId,
      reciterName: target.reciterName,
      title: String(channel.snippet?.title ?? target.pageName),
      url: `https://www.youtube.com/channel/${target.channelId}`,
      avatar: (thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
      subscribers: stats.hiddenSubscriberCount ? null : stats.subscriberCount != null ? Number(stats.subscriberCount) : null,
      views: stats.viewCount != null ? Number(stats.viewCount) : null,
      // آخر 3 مقاطع، مرتّبة من الأكثر مشاهدة.
      clips: recent.slice(0, 3).sort((a, b) => (b.views ?? 0) - (a.views ?? 0)),
      recent,
    }];
  });
}

// ── قاعدة البيانات: المنصات والصفحات وعدد المنشورات ───────────────────────────────────────────────
type PageRow = { id: number; platformId: number; platformName: string; name: string; reciterId: number | null; reciterName: string | null; pageUrl: string | null; manualFollowers: number | null; posts: number };

async function loadPages(): Promise<PageRow[]> {
  // المنشورات = الشواهد الموثّقة الفعّالة على مهام الصفحة غير المحذوفة (بلا الشواهد التكميلية).
  return rowsOf(await db.execute(sql`
    SELECT pp.id, pp.platform_id, p.name AS platform_name, pp.name, pp.reciter_id, r.name AS reciter_name, pp.page_url, pp.manual_followers,
      (SELECT count(*)::int FROM task_proofs tp JOIN tasks t ON t.id = tp.task_id
        WHERE t.page_id = pp.id AND t.deleted_at IS NULL AND tp.deleted_at IS NULL AND NOT tp.is_supplementary) AS posts
    FROM platform_pages pp
    JOIN platforms p ON p.id = pp.platform_id
    LEFT JOIN reciters r ON r.id = pp.reciter_id
    ORDER BY pp.id`)).map((row) => ({
    id: Number(row.id), platformId: Number(row.platform_id), platformName: String(row.platform_name), name: String(row.name),
    reciterId: row.reciter_id == null ? null : Number(row.reciter_id), reciterName: row.reciter_name ? String(row.reciter_name) : null,
    pageUrl: row.page_url ? String(row.page_url) : null, manualFollowers: row.manual_followers == null ? null : Number(row.manual_followers), posts: Number(row.posts ?? 0),
  }));
}

async function loadApps() {
  return rowsOf(await db.execute(sql`SELECT id, name, ios_url, android_url, covers_all_reciters FROM platforms ORDER BY covers_all_reciters DESC, id`))
    .filter((row) => APP_PLATFORM_NAME.test(String(row.name).trim()) || row.covers_all_reciters)
    .map((row) => ({ id: Number(row.id), name: String(row.name), iosUrl: row.ios_url ? String(row.ios_url) : null, androidUrl: row.android_url ? String(row.android_url) : null }));
}

// ── إنستقرام ──────────────────────────────────────────────────────────────────────────────────
async function igGet(path: string, params: Record<string, string>) {
  const res = await fetch(`https://graph.instagram.com/v25.0/${path}?${new URLSearchParams(params).toString()}`);
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  return body;
}

async function loadInstagram(): Promise<{ followersByPage: Map<number, number>; reels: Array<ShowcaseReel & { pageId: number }> }> {
  const followersByPage = new Map<number, number>();
  const reels: Array<ShowcaseReel & { pageId: number }> = [];
  const config = getInstagramConfig();
  if (!config) return { followersByPage, reels };
  await ensureInstagramSchema();
  const accounts = rowsOf(await db.execute(sql`
    SELECT a.id, a.page_id, a.access_token_encrypted, a.username, r.name AS reciter_name
    FROM instagram_accounts a JOIN reciters r ON r.id = a.reciter_id
    WHERE a.enabled AND a.status = 'connected' AND a.access_token_encrypted IS NOT NULL`));
  await Promise.all(accounts.map(async (account) => {
    const token = decryptToken(account.access_token_encrypted, config.appSecret);
    if (!token) return;
    const name = String(account.reciter_name);
    try {
      const me = await igGet("me", { fields: "followers_count,media_count", access_token: token });
      if (me?.followers_count != null) followersByPage.set(Number(account.page_id), Number(me.followers_count));
    } catch { /* الحساب يُعرض بلا رقم */ }
    try {
      const media = await igGet("me/media", { fields: "id,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp", limit: "10", access_token: token });
      for (const item of Array.isArray(media?.data) ? media.data : []) {
        if (!item?.permalink || String(item.media_product_type ?? "").toUpperCase() === "STORY") continue;
        if (String(item.media_type) !== "VIDEO" && String(item.media_product_type ?? "").toUpperCase() !== "REELS") continue;
        reels.push({ pageId: Number(account.page_id), account: name, url: String(item.permalink), thumbnail: item.thumbnail_url ?? null, publishedAt: item.timestamp ? new Date(item.timestamp).toISOString() : null });
      }
    } catch { /* بلا مقاطع لهذا الحساب */ }
  }));
  return { followersByPage, reels };
}

// صف إنستقرام: 3 مقاطع حديثة من حسابات مختلفة (حساب واحد لكل مقطع)، باختيار عشوائي بين الحسابات.
function pickInstagramRow(reels: Array<ShowcaseReel & { pageId: number }>, random = Math.random): ShowcaseReel[] {
  const latestByAccount = new Map<number, ShowcaseReel & { pageId: number }>();
  for (const reel of [...reels].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))) {
    if (!latestByAccount.has(reel.pageId)) latestByAccount.set(reel.pageId, reel);
  }
  const pool = [...latestByAccount.values()];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3).map(({ pageId: _p, ...reel }) => reel);
}

// ── فيسبوك ─────────────────────────────────────────────────────────────────────────────────────
async function fbGet(path: string, params: Record<string, string>) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${path}?${new URLSearchParams(params).toString()}`);
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  return body;
}

async function loadFacebook(registeredReciterIds: Set<number>, hidden: ShowcaseDiagnostics["hidden"]): Promise<{ followersByReciter: Map<number, number>; reels: ShowcaseReel[] }> {
  const followersByReciter = new Map<number, number>();
  const reels: ShowcaseReel[] = [];
  const config = getFacebookConfig();
  if (!config) return { followersByReciter, reels };
  await ensureInstagramSchema();
  // صفحة فيسبوك لكل قارئ: الربط المحفوظ في مراقبة إنستقرام (حساب القارئ ← صفحة فيسبوك).
  const pages = rowsOf(await db.execute(sql`
    SELECT DISTINCT ON (fp.fb_page_id) fp.fb_page_id, fp.access_token_encrypted, a.reciter_id, r.name AS reciter_name
    FROM instagram_accounts a
    JOIN facebook_pages fp ON fp.fb_page_id = a.fb_page_id AND fp.status = 'connected'
    JOIN reciters r ON r.id = a.reciter_id
    WHERE a.fb_page_id IS NOT NULL`));
  await Promise.all(pages.map(async (page) => {
    // صفحة فيسبوك مربوطة في المراقبة لكن القارئ بلا صفحة فيسبوك في صفحة المنصات ⇐ لا تُعرض.
    if (!registeredReciterIds.has(Number(page.reciter_id))) {
      hidden.push({ what: `فيسبوك — ${page.reciter_name} (صفحة ${page.fb_page_id})`, why: "صفحة فيسبوك مربوطة في «مراقبة إنستقرام» لكن لا توجد صفحة فيسبوك لهذا القارئ في صفحة المنصات" });
      return;
    }
    const token = decryptToken(page.access_token_encrypted, config.appSecret);
    if (!token) return;
    const name = String(page.reciter_name);
    try {
      const info = await fbGet(String(page.fb_page_id), { fields: "followers_count,fan_count", access_token: token });
      const followers = info?.followers_count ?? info?.fan_count;
      if (followers != null) followersByReciter.set(Number(page.reciter_id), Number(followers));
    } catch { /* بلا رقم */ }
    try {
      const data = await fbGet(`${page.fb_page_id}/video_reels`, { fields: "id,created_time,picture", limit: "5", access_token: token });
      for (const row of Array.isArray(data?.data) ? data.data : []) {
        if (!row?.id) continue;
        reels.push({ account: name, url: `https://www.facebook.com/reel/${row.id}/`, thumbnail: row.picture ?? null, publishedAt: row.created_time ? new Date(row.created_time).toISOString() : null });
      }
    } catch { /* بلا مقاطع */ }
  }));
  return { followersByReciter, reels };
}

// ── تلقرام (مشتركو القنوات العامة عبر البوت — مجاني) ─────────────────────────────────────────────
function telegramUsername(url: string | null): string | null {
  const match = String(url ?? "").match(/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})/i);
  return match ? match[1] : null;
}

async function telegramMembers(username: string | null): Promise<number | null> {
  if (!username) return null;
  const result = await callTelegramApi<number>("getChatMemberCount", { chat_id: `@${username}` }).catch(() => ({ ok: false } as any));
  return result?.ok && typeof result.result === "number" ? result.result : null;
}

// ── التجميع ───────────────────────────────────────────────────────────────────────────────────
export async function buildShowcase(now = new Date()): Promise<ShowcaseData> {
  await ensureShowcaseSchema();
  const pages = await loadPages();
  const accountName = (page: PageRow) => page.reciterName ?? page.name;
  const pagesOf = (pattern: RegExp) => pages.filter((page) => pattern.test(page.platformName));
  const hidden: ShowcaseDiagnostics["hidden"] = [];

  const youtubeTargets = pagesOf(YOUTUBE_PLATFORM_NAME).map((page) => ({ pageId: page.id, pageName: page.name, pageUrl: page.pageUrl, reciterName: page.reciterName }));
  const { resolved: youtubeResolved, report: youtubeReport } = await resolveYoutubeTargets(youtubeTargets).catch(() => ({ resolved: [] as Array<YoutubeTarget & { channelId: string }>, report: [] as ShowcaseDiagnostics["youtube"] }));
  const facebookReciters = new Set(pagesOf(FACEBOOK_PLATFORM_NAME).map((page) => page.reciterId).filter((id): id is number => id != null));
  const [youtube, apps, instagram, facebook] = await Promise.all([
    loadYoutube(youtubeResolved, youtubeReport).catch(() => [] as YoutubeChannelData[]),
    loadApps(),
    loadInstagram().catch(() => ({ followersByPage: new Map<number, number>(), reels: [] as Array<ShowcaseReel & { pageId: number }> })),
    loadFacebook(facebookReciters, hidden).catch(() => ({ followersByReciter: new Map<number, number>(), reels: [] as ShowcaseReel[] })),
  ]);
  // ما كان يظهر من القائمة الثابتة القديمة ولم يعد مسجّلًا في صفحة المنصات.
  const shownIds = new Set(youtube.map((channel) => channel.channelId));
  const legacyMissing = LEGACY_FIXED_YOUTUBE_CHANNELS.filter((id) => !shownIds.has(id));
  if (legacyMissing.length > 0) {
    const titles = await callYoutubeApi<{ items?: any[] }>("channels", { part: "snippet", id: legacyMissing.join(",") }).catch(() => ({ items: [] as any[] }));
    const titleOf = new Map((titles.items ?? []).map((item) => [String(item.id), String(item.snippet?.title ?? "")]));
    for (const id of legacyMissing) {
      const registeredButBroken = youtubeReport.some((row) => row.channelId === id && row.status === "missing");
      hidden.push({
        what: `قناة يوتيوب «${titleOf.get(id) || id}» (${id})`,
        why: registeredButBroken ? "مسجّلة لكن تنقصها بيانات (انظر قائمة قنوات يوتيوب)" : "كانت في القائمة الثابتة القديمة، وغير مسجّلة في صفحة المنصات (لا صفحة يوتيوب برابطها)",
      });
    }
  }

  const instagramAccounts: ShowcaseAccount[] = pagesOf(INSTAGRAM_PLATFORM_NAME).map((page) => ({
    name: accountName(page), url: page.pageUrl, followers: instagram.followersByPage.get(page.id) ?? page.manualFollowers, posts: page.posts,
  }));
  const facebookAccounts: ShowcaseAccount[] = pagesOf(FACEBOOK_PLATFORM_NAME).map((page) => ({
    name: accountName(page), url: page.pageUrl, followers: (page.reciterId != null ? facebook.followersByReciter.get(page.reciterId) : undefined) ?? page.manualFollowers, posts: page.posts,
  }));
  const telegramPages = pagesOf(TELEGRAM_PLATFORM_NAME);
  const telegramAccounts: ShowcaseAccount[] = await Promise.all(telegramPages.map(async (page) => ({
    name: accountName(page), url: page.pageUrl, followers: (await telegramMembers(telegramUsername(page.pageUrl))) ?? page.manualFollowers, posts: page.posts,
  })));
  // تويتر/X: لا واجهة مجانية — القيمة اليدوية فقط، وإلا بلا رقم.
  const twitterAccounts: ShowcaseAccount[] = pagesOf(TWITTER_PLATFORM_NAME).map((page) => ({
    name: accountName(page), url: page.pageUrl, followers: page.manualFollowers, posts: page.posts,
  }));

  // التطبيقات: صورة الشيخ من صورة قناته على يوتيوب (مطابقة اسم القارئ في اسم التطبيق).
  const avatarFor = (appName: string) => youtube.find((channel) => channel.reciterName && nameKey(appName).includes(nameKey(channel.reciterName)))?.avatar ?? null;
  // قنوات تلقرام المسجّلة (باسم المستخدم من رابط الصفحة) — لا تُعرض منشورات قناة غير مسجّلة.
  const registeredTelegram = new Set(telegramPages.map((page) => telegramUsername(page.pageUrl)?.toLowerCase()).filter(Boolean) as string[]);
  const registeredPageIds = new Set(pages.map((page) => page.id));

  // الأكثر مشاهدة هذا الأسبوع: أعلى مشاهدات بين مقاطع يوتيوب المنشورة هذا الأسبوع (الأحد→السبت، الرياض).
  const weekStart = riyadhWeekStart(now);
  const thisWeek = youtube.flatMap((channel) => channel.recent.map((clip) => ({ ...clip, channelTitle: channel.title })))
    .filter((clip) => clip.publishedAt && riyadhWeekStart(new Date(clip.publishedAt)) === weekStart);
  const featured = thisWeek.sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0] ?? null;

  // تصاميم الحرمين: أحدث منشورات قناة التصاميم.
  const designCandidate = rowsOf(await db.execute(sql`SELECT chat_id, title, username, page_id FROM telegram_channels WHERE kind = 'designs' ORDER BY id LIMIT 1`).catch(() => ({ rows: [] })))[0];
  const designRegistered = designCandidate && ((designCandidate.page_id != null && registeredPageIds.has(Number(designCandidate.page_id))) || (designCandidate.username && registeredTelegram.has(String(designCandidate.username).toLowerCase())));
  if (designCandidate && !designRegistered) hidden.push({ what: `قناة التصاميم «${designCandidate.title ?? designCandidate.chat_id}»`, why: "غير مربوطة بصفحة مسجّلة في صفحة المنصات" });
  const designChannel = designRegistered ? designCandidate : null;
  const designItems = designChannel ? rowsOf(await db.execute(sql`
    SELECT post_url, published_at FROM telegram_channel_posts
    WHERE chat_id = ${String(designChannel.chat_id)} AND kind = 'design' AND post_url IS NOT NULL
    ORDER BY published_at DESC LIMIT 8`)).map((row) => ({ url: String(row.post_url), publishedAt: new Date(row.published_at).toISOString() })) : [];
  const designUsername = designChannel?.username ? String(designChannel.username) : null;

  // أحدث ما نشرنا: دمج كل المنصّات، الأحدث أولًا.
  const recitationChannels = rowsOf(await db.execute(sql`SELECT chat_id, title, username, page_id FROM telegram_channels WHERE kind = 'recitations'`).catch(() => ({ rows: [] })));
  const feedChatIds: string[] = [];
  for (const channel of recitationChannels) {
    const registered = (channel.page_id != null && registeredPageIds.has(Number(channel.page_id))) || (channel.username && registeredTelegram.has(String(channel.username).toLowerCase()));
    if (registered) feedChatIds.push(String(channel.chat_id));
    else hidden.push({ what: `منشورات قناة تلقرام «${channel.title ?? channel.chat_id}» في «أحدث ما نشرنا»`, why: "القناة غير مسجّلة في صفحة المنصات (لا صفحة تلقرام برابطها)" });
  }
  const recitationPosts = feedChatIds.length === 0 ? [] : rowsOf(await db.execute(sql`
    SELECT p.caption, p.post_url, p.published_at, r.name AS reciter_name FROM telegram_channel_posts p
    LEFT JOIN reciters r ON r.id = p.reciter_id
    WHERE p.kind = 'recitation' AND p.post_url IS NOT NULL AND p.chat_id IN (${sql.join(feedChatIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY p.published_at DESC LIMIT 6`).catch(() => ({ rows: [] })));
  const feed: ShowcaseData["feed"] = [
    ...youtube.flatMap((channel) => channel.recent.slice(0, 3).filter((clip) => clip.publishedAt).map((clip) => ({ platform: "youtube" as const, title: clip.title, url: clip.url, publishedAt: clip.publishedAt! }))),
    ...instagram.reels.filter((reel) => reel.publishedAt).map((reel) => ({ platform: "instagram" as const, title: `مقطع جديد — ${reel.account}`, url: reel.url, publishedAt: reel.publishedAt! })),
    ...facebook.reels.filter((reel) => reel.publishedAt).map((reel) => ({ platform: "facebook" as const, title: `مقطع جديد — ${reel.account}`, url: reel.url, publishedAt: reel.publishedAt! })),
    ...recitationPosts.map((row) => ({
      platform: "telegram" as const,
      title: [String(row.caption ?? "").split("\n")[0].replace(/#\S+/g, "").trim() || "تلاوة جديدة", row.reciter_name ? String(row.reciter_name) : null].filter(Boolean).join(" — "),
      url: String(row.post_url), publishedAt: new Date(row.published_at).toISOString(),
    })),
    ...designItems.slice(0, 3).map((item) => ({ platform: "designs" as const, title: "تصميم جديد", url: item.url, publishedAt: item.publishedAt })),
  ].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8);

  return {
    generatedAt: now.toISOString(),
    hero: {
      youtubeViews: youtube.reduce((sum, channel) => sum + (channel.views ?? 0), 0),
      youtubeSubscribers: youtube.reduce((sum, channel) => sum + (channel.subscribers ?? 0), 0),
      appsCount: apps.length,
    },
    featured,
    youtube: youtube.map(({ reciterName: _r, recent: _recent, ...channel }) => channel),
    apps: apps.map((app) => ({ name: app.name, iosUrl: app.iosUrl, androidUrl: app.androidUrl, avatar: avatarFor(app.name) })),
    platforms: {
      instagram: { accounts: instagramAccounts, reels: pickInstagramRow(instagram.reels) },
      facebook: { accounts: facebookAccounts, reels: [...facebook.reels].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, 3) },
      telegram: { accounts: telegramAccounts },
      twitter: { accounts: twitterAccounts },
    },
    designs: {
      items: designItems,
      channel: designChannel ? { name: String(designChannel.title ?? "قناة التصاميم"), url: designUsername ? `https://t.me/${designUsername}` : null, subscribers: await telegramMembers(designUsername) } : null,
    },
    feed,
    diagnostics: { youtube: youtubeReport, hidden },
  };
}

let cached: { data: ShowcaseData; at: number } | null = null;
let building: Promise<ShowcaseData> | null = null;

// مخزّن مؤقتًا 30 دقيقة؛ طلب واحد يبني والبقية تنتظره؛ عند الخطأ تُقدَّم آخر نسخة سليمة.
export async function getShowcase(options: { force?: boolean } = {}): Promise<ShowcaseData> {
  if (!options.force && cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  if (!building) {
    building = buildShowcase()
      .then((data) => { cached = { data, at: Date.now() }; return data; })
      .finally(() => { building = null; });
  }
  try {
    return await building;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

export function clearShowcaseCache() {
  cached = null;
}

// الرد العام بلا تقرير التشخيص.
export function publicShowcase(data: ShowcaseData): ShowcaseData {
  const { diagnostics: _d, ...rest } = data;
  return rest;
}

export { pickInstagramRow, telegramUsername };
