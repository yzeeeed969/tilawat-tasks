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

export const SHOWCASE_YOUTUBE_CHANNELS: Array<{ channelId: string; reciterName: string | null }> = [
  { channelId: "UCeLuU2J219WqFPZYJJquhRA", reciterName: "عبدالله الجهني" },
  { channelId: "UCM7ZXt5QOxh-8ScBOyPg2sw", reciterName: "ياسر الدوسري" },
  { channelId: "UCCoB7Hf8gjQzpAyzhvx7Ktg", reciterName: null }, // مزامير الفرقان (قناة ياسر الدوسري الثانية)
  { channelId: "UCfbqZ0LoOdE6WB_u38y3cnQ", reciterName: "ماهر المعيقلي" },
  { channelId: "UCqe5E-6-HxFrWGyBOdWOz8Q", reciterName: "بندر بليلة" },
];

const CACHE_MS = 30 * 60 * 1000;
const FACEBOOK_PLATFORM_NAME = /فيسبوك|فيس بوك|facebook/i;
const TELEGRAM_PLATFORM_NAME = /تلقرام|تيليجرام|تليجرام|تلغرام|telegram/i;
const TWITTER_PLATFORM_NAME = /تويتر|twitter|^x$|\bx\b|إكس/i;
const APP_PLATFORM_NAME = /^تطبيق/;

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
};

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];
const nameKey = (value: string) => value.replace(/\s+/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");

// ── يوتيوب ───────────────────────────────────────────────────────────────────────────────────
type YoutubeChannelData = ShowcaseData["youtube"][number] & { reciterName: string | null; recent: ShowcaseClip[] };

async function loadYoutube(): Promise<YoutubeChannelData[]> {
  const ids = SHOWCASE_YOUTUBE_CHANNELS.map((c) => c.channelId);
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
  return SHOWCASE_YOUTUBE_CHANNELS.flatMap((config) => {
    const channel = byId.get(config.channelId);
    if (!channel) return [];
    const recent = (uploadsByChannel.get(config.channelId) ?? []).map(toClip).filter((clip): clip is ShowcaseClip => Boolean(clip));
    const thumbs = channel.snippet?.thumbnails ?? {};
    const stats = channel.statistics ?? {};
    return [{
      channelId: config.channelId,
      reciterName: config.reciterName,
      title: String(channel.snippet?.title ?? ""),
      url: `https://www.youtube.com/channel/${config.channelId}`,
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

async function loadFacebook(): Promise<{ followersByReciter: Map<number, number>; reels: ShowcaseReel[] }> {
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
  const [youtube, pages, apps, instagram, facebook] = await Promise.all([
    loadYoutube().catch(() => [] as YoutubeChannelData[]),
    loadPages(),
    loadApps(),
    loadInstagram().catch(() => ({ followersByPage: new Map<number, number>(), reels: [] as Array<ShowcaseReel & { pageId: number }> })),
    loadFacebook().catch(() => ({ followersByReciter: new Map<number, number>(), reels: [] as ShowcaseReel[] })),
  ]);

  const accountName = (page: PageRow) => page.reciterName ?? page.name;
  const pagesOf = (pattern: RegExp) => pages.filter((page) => pattern.test(page.platformName));

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

  // الأكثر مشاهدة هذا الأسبوع: أعلى مشاهدات بين مقاطع يوتيوب المنشورة هذا الأسبوع (الأحد→السبت، الرياض).
  const weekStart = riyadhWeekStart(now);
  const thisWeek = youtube.flatMap((channel) => channel.recent.map((clip) => ({ ...clip, channelTitle: channel.title })))
    .filter((clip) => clip.publishedAt && riyadhWeekStart(new Date(clip.publishedAt)) === weekStart);
  const featured = thisWeek.sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0] ?? null;

  // تصاميم الحرمين: أحدث منشورات قناة التصاميم.
  const designChannel = rowsOf(await db.execute(sql`SELECT chat_id, title, username FROM telegram_channels WHERE kind = 'designs' ORDER BY id LIMIT 1`).catch(() => ({ rows: [] })))[0];
  const designItems = designChannel ? rowsOf(await db.execute(sql`
    SELECT post_url, published_at FROM telegram_channel_posts
    WHERE chat_id = ${String(designChannel.chat_id)} AND kind = 'design' AND post_url IS NOT NULL
    ORDER BY published_at DESC LIMIT 8`)).map((row) => ({ url: String(row.post_url), publishedAt: new Date(row.published_at).toISOString() })) : [];
  const designUsername = designChannel?.username ? String(designChannel.username) : null;

  // أحدث ما نشرنا: دمج كل المنصّات، الأحدث أولًا.
  const recitationPosts = rowsOf(await db.execute(sql`
    SELECT p.caption, p.post_url, p.published_at, r.name AS reciter_name FROM telegram_channel_posts p
    LEFT JOIN reciters r ON r.id = p.reciter_id
    WHERE p.kind = 'recitation' AND p.post_url IS NOT NULL
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

export { pickInstagramRow, telegramUsername };
