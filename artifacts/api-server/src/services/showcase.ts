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
// كل أرقام المتابعين/المشتركين/المشاهدات آلية من مصدرها الرسمي فقط — لا إدخال يدوي ولا احتياط يدوي ولا
// تقدير. تعذّر الرقم ⇐ يُعرض الحساب بلا رقم، ويُذكر السبب للمدير في التشخيص.
// لا يُرسل أي مفتاح أو رمز إلى الواجهة أبدًا.

// المصدر الوحيد للقنوات والحسابات: صفحة إدارة المنصات (لا قائمة قنوات في الكود).
// قرار المدير (2026-10-15): إخفاء هاتين القناتين من الصفحة العامة فقط — يُطبَّق مرة واحدة على صفحاتهما
// (بمعرّف القناة بعد التحويل، ولو سُجّلت باسم @) عبر علامة hide_from_showcase، ويمكن إظهارهما من البطاقة.
const ONE_TIME_HIDE_CHANNELS = ["UCiBb4d9_Z5SqMVCpS5TW-MA", "UChDhl60fz0qmorOJlJNeEyg"];
const ONE_TIME_HIDE_MIGRATION = "showcase_hide_two_youtube_channels_v31";

const CACHE_MS = 30 * 60 * 1000;
const FACEBOOK_PLATFORM_NAME = /فيسبوك|فيس بوك|facebook/i;
const TELEGRAM_PLATFORM_NAME = /تلقرام|تيليجرام|تليجرام|تلغرام|telegram/i;
const TWITTER_PLATFORM_NAME = /تويتر|twitter|^x$|\bx\b|إكس/i;
const APP_PLATFORM_NAME = /^تطبيق/;
const YOUTUBE_PLATFORM_NAME = /يوتيوب|youtube/i;

export type ShowcaseClip = { title: string; views: number | null; url: string; thumbnail: string | null; publishedAt: string | null };
// posts = العدد الحقيقي الكلي من المنصة نفسها (إنستقرام: media_count)، وnull حيث يتعذّر (فلا يُعرض).
export type ShowcaseAccount = { name: string; url: string | null; followers: number | null; posts: number | null };
// views: مشاهدات الريل من ميتا (للريلز الظاهرة فقط)؛ null ⇐ تُعرض الأقدمية بدلها (قبل إعادة التفويض أو عند التعذّر).
export type ShowcaseReel = { account: string; url: string; thumbnail: string | null; publishedAt: string | null; views?: number | null };
// داخلي (لا يصل للرد): ما يلزم لجلب مشاهدات الريل بعد اختياره.
type InstagramReelSource = ShowcaseReel & { pageId: number; mediaId: string };
type FacebookReelSource = ShowcaseReel & { videoId: string; token: string };

// قيمة مقياس من رد insights (media: values[0].value، وأحيانًا total_value.value).
function metricValue(body: any): number | null {
  const metric = Array.isArray(body?.data) ? body.data[0] : null;
  const raw = metric?.total_value?.value ?? metric?.values?.[0]?.value;
  const value = typeof raw === "number" ? raw : raw != null ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
export type ShowcaseData = {
  generatedAt: string;
  dataVersion?: number;
  hero: { youtubeViews: number; youtubeSubscribers: number; appsCount: number };
  // «حصيلة المشروع» — كلها آلية: youtubeVideos = مجموع videoCount للقنوات الظاهرة؛ totalPosts = فيديوهات يوتيوب +
  // منشورات إنستقرام (media_count) للحسابات الظاهرة؛ accounts = حسابات يوتيوب+إنستقرام+فيسبوك+تلقرام الظاهرة؛
  // teamClips = الشواهد الموثّقة في نظام المهام (بلا الشواهد التكميلية/المحذوفة).
  // instagramViews90 = مجموع مشاهدات حسابات انستقرام الظاهرة لآخر 90 يومًا (insights: views/total_value)؛ null ⇐ لا رقم.
  // facebookViews90: مشاهدات فيديو صفحات فيسبوك لآخر 90 يومًا — يُعرض فقط إن رجع كاملًا لكل الصفحات الظاهرة، وإلا null.
  totals: { youtubeVideos: number; totalPosts: number; accounts: number; teamClips: number; instagramViews90: number | null; facebookViews90: number | null };
  featured: (ShowcaseClip & { channelTitle: string }) | null;
  youtube: Array<{ channelId: string; title: string; url: string; avatar: string | null; subscribers: number | null; views: number | null; videos: number | null; clips: ShowcaseClip[] }>;
  apps: Array<{ name: string; iosUrl: string | null; androidUrl: string | null; avatar: string | null }>;
  platforms: {
    instagram: { accounts: ShowcaseAccount[]; reels: ShowcaseReel[] };
    facebook: { accounts: ShowcaseAccount[]; reels: ShowcaseReel[] };
    telegram: { accounts: ShowcaseAccount[] };
    twitter: { accounts: ShowcaseAccount[] };
  };
  designs: { items: Array<{ url: string; publishedAt: string }>; channel: { name: string; url: string | null; subscribers: number | null } | null };
  // title = عنوان حقيقي من المحتوى (مقطع يوتيوب، نص منشور تلقرام) ويبقى كما هو. عند غيابه يُرسل kind (+ name)
  // وتكوّن الصفحة الجملة («مقطع جديد — {name}»…) بلغة الزائر من ملف الترجمات.
  feed: Array<{ platform: "youtube" | "instagram" | "facebook" | "telegram" | "designs"; title: string; kind?: "clip" | "recitation" | "design"; name?: string; url: string; publishedAt: string }>;
  // للمدير فقط (يُحذف من الرد العام): ما ينقص القنوات المسجّلة، وما لم يعد يظهر ولماذا.
  diagnostics?: ShowcaseDiagnostics;
};
export type ShowcaseDiagnostics = {
  youtube: Array<{ pageId: number; pageName: string; pageUrl: string | null; status: "ok" | "missing"; channelId: string | null; problem: string | null; hiddenByAdmin?: boolean }>;
  // صفحات مخفية من الصفحة العامة بقرار المدير (تبقى في النظام).
  hiddenPages: Array<{ pageId: number; platformName: string; name: string }>;
  hidden: Array<{ what: string; why: string }>;
  // لكل حساب معروض: هل رقم المتابعين آلي الآن؟ وإن لا، لماذا.
  followers: Array<{ platform: "instagram" | "facebook" | "telegram" | "twitter" | "designs"; account: string; automatic: boolean; reason: string | null }>;
  // تفصيل مجموع يوتيوب قناةً قناة (كل قناة مرة واحدة) + الصفحات المسجّلة التي تشير إليها.
  youtubeBreakdown: { channels: Array<{ channelId: string; title: string; subscribers: number | null; views: number | null; pages: string[] }>; totalViews: number; totalSubscribers: number };
  // التطبيقات المحسوبة في العدّاد (منصات اسمها يبدأ بـ«تطبيق»).
  apps: string[];
  // فيسبوك (للمدير): نتيجة مقياس مشاهدات الفيديو لكل صفحة ظاهرة — لماذا يُعرض المجموع أو لا يُعرض.
  facebookViews: { metric: string; shown: boolean; reason: string | null; pages: Array<{ account: string; value: number | null; problem: string | null }> };
};

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];
const URL_IN_TEXT = /https?:\/\/\S+/i;
const stripUrls = (value: string) => value.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
const urlInName = (value: string) => value.match(URL_IN_TEXT)?.[0] ?? null;
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

// الأكثر مشاهدة في القناة (كل الأوقات): search بترتيب المشاهدات يكلّف 100 وحدة، فيُخزَّن 24 ساعة لكل قناة.
const POPULAR_CACHE_MS = 24 * 60 * 60 * 1000;
const popularByChannel = new Map<string, { ids: string[]; at: number }>();
async function popularVideoIds(channelId: string): Promise<string[] | null> {
  const cachedPopular = popularByChannel.get(channelId);
  if (cachedPopular && Date.now() - cachedPopular.at < POPULAR_CACHE_MS) return cachedPopular.ids;
  const data = await callYoutubeApi<{ items?: any[] }>("search", { part: "id", channelId, order: "viewCount", type: "video", maxResults: "5" }).catch(() => null);
  if (!data) return cachedPopular?.ids ?? null;
  const ids = (data.items ?? []).map((item) => String(item?.id?.videoId ?? "")).filter(Boolean);
  popularByChannel.set(channelId, { ids, at: Date.now() });
  return ids;
}

// 3 مقاطع بلا تكرار: الأحدث، ثم أكثر مقطعين مشاهدة (إن كان الأحدث ضمنهما يُضاف التالي).
export function mixClips(recent: ShowcaseClip[], popular: ShowcaseClip[]): ShowcaseClip[] {
  const latest = recent[0];
  const byViews = (list: ShowcaseClip[]) => [...list].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const picked: ShowcaseClip[] = latest ? [latest] : [];
  for (const clip of [...byViews(popular), ...byViews(recent)]) {
    if (picked.length >= 3) break;
    if (!picked.some((p) => p.url === clip.url)) picked.push(clip);
  }
  return picked;
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
  const popularIds = new Map<string, string[]>();
  await Promise.all(ids.map(async (id) => {
    const popular = await popularVideoIds(id);
    if (popular) popularIds.set(id, popular);
  }));
  const allVideoIds = [...new Set([...[...uploadsByChannel.values()].flat(), ...[...popularIds.values()].flat()])];
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
      // عدد الفيديوهات من نفس الطلب (statistics) — بلا طلب إضافي.
      videos: stats.videoCount != null ? Number(stats.videoCount) : null,
      // الأحدث + أكثر مقطعين مشاهدة في القناة (احتياطًا: الأكثر مشاهدة بين المقاطع الحديثة).
      clips: mixClips(recent, (popularIds.get(target.channelId) ?? []).map(toClip).filter((clip): clip is ShowcaseClip => Boolean(clip))),
      recent,
    }];
  });
}

// ── قاعدة البيانات: المنصات والصفحات وعدد المنشورات ───────────────────────────────────────────────
type PageRow = { id: number; platformId: number; platformName: string; name: string; reciterId: number | null; reciterName: string | null; pageUrl: string | null; posts: number; hidden: boolean };

async function loadPages(): Promise<PageRow[]> {
  // المنشورات = الشواهد الموثّقة الفعّالة على مهام الصفحة غير المحذوفة (بلا الشواهد التكميلية).
  return rowsOf(await db.execute(sql`
    SELECT pp.id, pp.platform_id, p.name AS platform_name, pp.name, pp.reciter_id, r.name AS reciter_name, pp.page_url, pp.hide_from_showcase,
      (SELECT count(*)::int FROM task_proofs tp JOIN tasks t ON t.id = tp.task_id
        WHERE t.page_id = pp.id AND t.deleted_at IS NULL AND tp.deleted_at IS NULL AND NOT tp.is_supplementary) AS posts
    FROM platform_pages pp
    JOIN platforms p ON p.id = pp.platform_id
    LEFT JOIN reciters r ON r.id = pp.reciter_id
    ORDER BY pp.id`)).map((row) => ({
    id: Number(row.id), platformId: Number(row.platform_id), platformName: String(row.platform_name), name: String(row.name),
    reciterId: row.reciter_id == null ? null : Number(row.reciter_id), reciterName: row.reciter_name ? String(row.reciter_name) : null,
    pageUrl: row.page_url ? String(row.page_url) : null, posts: Number(row.posts ?? 0), hidden: row.hide_from_showcase === true,
  }));
}

const cleanName = (value: unknown) => String(value ?? "").replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u0640]/g, "").trim();

async function loadTeamClips(): Promise<number> {
  const [row] = rowsOf(await db.execute(sql`
    SELECT
      (SELECT count(*) FROM task_proofs tp JOIN tasks t ON t.id = tp.task_id
        WHERE t.deleted_at IS NULL AND tp.deleted_at IS NULL AND NOT tp.is_supplementary)
      + (SELECT count(*) FROM tasks t
        WHERE t.deleted_at IS NULL AND t.submission_url IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM task_proofs tp WHERE tp.task_id = t.id AND tp.deleted_at IS NULL)) AS n`));
  return Number(row?.n ?? 0);
}

// التطبيقات = منصات اسمها يبدأ بـ«تطبيق» أو معلّمة «تشمل كل القرّاء» — نفس القائمة للصفحة العامة ولبطاقة المدير.
export async function loadShowcaseApps() {
  return loadApps();
}

async function loadApps() {
  return rowsOf(await db.execute(sql`SELECT id, name, ios_url, android_url, covers_all_reciters FROM platforms ORDER BY covers_all_reciters DESC, id`))
    .filter((row) => APP_PLATFORM_NAME.test(cleanName(row.name)) || row.covers_all_reciters)
    .map((row) => ({ id: Number(row.id), name: String(row.name), iosUrl: row.ios_url ? String(row.ios_url) : null, androidUrl: row.android_url ? String(row.android_url) : null }));
}

// ── إنستقرام ──────────────────────────────────────────────────────────────────────────────────
async function igGet(path: string, params: Record<string, string>) {
  const res = await fetch(`https://graph.instagram.com/v25.0/${path}?${new URLSearchParams(params).toString()}`);
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  return body;
}

// مشاهدات حساب انستقرام لآخر 90 يومًا: insights views (total_value) بنوافذ 30 يومًا (حدّ الواجهة) ثم الجمع.
// أي نافذة تتعذّر ⇐ null للحساب كله (لا رقم ناقص). صلاحية instagram_business_manage_insights.
const DAY_SECONDS = 24 * 60 * 60;
async function instagramViews90(token: string, now = new Date()): Promise<number | null> {
  const until = Math.floor(now.getTime() / 1000);
  const windows = [0, 1, 2].map((i) => ({ since: until - (i + 1) * 30 * DAY_SECONDS, until: until - i * 30 * DAY_SECONDS }));
  try {
    const values = await Promise.all(windows.map(async (window) => metricValue(await igGet("me/insights", {
      metric: "views", period: "day", metric_type: "total_value", since: String(window.since), until: String(window.until), access_token: token,
    }))));
    if (values.some((value) => value == null)) return null;
    return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  } catch {
    return null;
  }
}

async function loadInstagram(): Promise<{ followersByPage: Map<number, number>; mediaCountByPage: Map<number, number>; views90ByPage: Map<number, number>; reels: InstagramReelSource[]; tokensByPage: Map<number, string>; problems: Map<number, string>; configured: boolean }> {
  const followersByPage = new Map<number, number>();
  const views90ByPage = new Map<number, number>();
  const mediaCountByPage = new Map<number, number>();
  const problems = new Map<number, string>();
  const reels: InstagramReelSource[] = [];
  const tokensByPage = new Map<number, string>();
  const config = getInstagramConfig();
  if (!config) return { followersByPage, mediaCountByPage, views90ByPage, reels, tokensByPage, problems, configured: false };
  await ensureInstagramSchema();
  const accounts = rowsOf(await db.execute(sql`
    SELECT a.id, a.page_id, a.access_token_encrypted, a.username, r.name AS reciter_name
    FROM instagram_accounts a JOIN reciters r ON r.id = a.reciter_id
    WHERE a.enabled AND a.status = 'connected' AND a.access_token_encrypted IS NOT NULL`));
  await Promise.all(accounts.map(async (account) => {
    const token = decryptToken(account.access_token_encrypted, config.appSecret);
    if (!token) { problems.set(Number(account.page_id), "تعذّر قراءة مفتاح الحساب — أعد ربطه من «مراقبة إنستقرام»"); return; }
    const name = String(account.reciter_name);
    tokensByPage.set(Number(account.page_id), token);
    try {
      const me = await igGet("me", { fields: "followers_count,media_count", access_token: token });
      if (me?.followers_count != null) followersByPage.set(Number(account.page_id), Number(me.followers_count));
      else problems.set(Number(account.page_id), "لم تُرجع ميتا عدد المتابعين لهذا الحساب");
      // العدد الحقيقي الكلي لمنشورات الحساب (نفس الطلب — بلا طلب إضافي).
      if (me?.media_count != null && Number.isFinite(Number(me.media_count))) mediaCountByPage.set(Number(account.page_id), Number(me.media_count));
    } catch (err) { problems.set(Number(account.page_id), `رفضت ميتا الطلب: ${(err as Error).message}`); }
    const views90 = await instagramViews90(token);
    if (views90 != null) views90ByPage.set(Number(account.page_id), views90);
    try {
      const media = await igGet("me/media", { fields: "id,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp", limit: "10", access_token: token });
      for (const item of Array.isArray(media?.data) ? media.data : []) {
        if (!item?.permalink || String(item.media_product_type ?? "").toUpperCase() === "STORY") continue;
        if (String(item.media_type) !== "VIDEO" && String(item.media_product_type ?? "").toUpperCase() !== "REELS") continue;
        reels.push({ pageId: Number(account.page_id), mediaId: String(item.id), account: name, url: String(item.permalink), thumbnail: item.thumbnail_url ?? null, publishedAt: item.timestamp ? new Date(item.timestamp).toISOString() : null });
      }
    } catch { /* بلا مقاطع لهذا الحساب */ }
  }));
  return { followersByPage, mediaCountByPage, views90ByPage, reels, tokensByPage, problems, configured: true };
}

// صف إنستقرام: 3 مقاطع حديثة من حسابات مختلفة (حساب واحد لكل مقطع)، باختيار عشوائي بين الحسابات.
function pickInstagramRow<T extends ShowcaseReel & { pageId: number }>(reels: T[], random = Math.random): T[] {
  const latestByAccount = new Map<number, T>();
  for (const reel of [...reels].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))) {
    if (!latestByAccount.has(reel.pageId)) latestByAccount.set(reel.pageId, reel);
  }
  const pool = [...latestByAccount.values()];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

// مشاهدات ريل إنستقرام (instagram_business_manage_insights). أي تعذّر ⇐ null بلا خطأ.
async function instagramReelViews(mediaId: string, token: string | undefined): Promise<number | null> {
  if (!token) return null;
  try { return metricValue(await igGet(`${mediaId}/insights`, { metric: "views", access_token: token })); } catch { return null; }
}

// مشاهدات ريل فيسبوك (read_insights). أي تعذّر ⇐ null بلا خطأ.
async function facebookReelViews(videoId: string, token: string): Promise<number | null> {
  try { return metricValue(await fbGet(`${videoId}/video_insights`, { metric: "blue_reels_play_count", access_token: token })); } catch { return null; }
}

// ── فيسبوك ─────────────────────────────────────────────────────────────────────────────────────
async function fbGet(path: string, params: Record<string, string>) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${path}?${new URLSearchParams(params).toString()}`);
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  return body;
}

// مشاهدات فيديو صفحة فيسبوك لآخر 90 يومًا (Page Insights: page_video_views، period=day، read_insights).
// ثلاث نوافذ 30 يومًا؛ الدقة شرط: كل نافذة يجب أن تُرجع قيمًا يومية (≥ 28 يومًا) وإلا تُعدّ الصفحة ناقصة.
const FACEBOOK_VIEWS_METRIC = "page_video_views";
async function facebookViews90(pageId: string, token: string, now = new Date()): Promise<{ value: number | null; problem: string | null }> {
  const until = Math.floor(now.getTime() / 1000);
  const windows = [0, 1, 2].map((i) => ({ since: until - (i + 1) * 30 * DAY_SECONDS, until: until - i * 30 * DAY_SECONDS }));
  let total = 0;
  for (const window of windows) {
    let body: any;
    try {
      body = await fbGet(`${pageId}/insights`, { metric: FACEBOOK_VIEWS_METRIC, period: "day", since: String(window.since), until: String(window.until), access_token: token });
    } catch (err) {
      return { value: null, problem: `رفضت ميتا ${FACEBOOK_VIEWS_METRIC}: ${(err as Error).message}` };
    }
    const metric = Array.isArray(body?.data) ? body.data.find((row: any) => row?.name === FACEBOOK_VIEWS_METRIC) : null;
    const values = Array.isArray(metric?.values) ? metric.values : [];
    const numbers = values.map((row: any) => Number(row?.value)).filter((value: number) => Number.isFinite(value) && value >= 0);
    if (!metric) return { value: null, problem: `لم تُرجع ميتا المقياس ${FACEBOOK_VIEWS_METRIC} (قد يكون ملغى أو غير متاح لهذه الصفحة)` };
    if (numbers.length < 28) return { value: null, problem: `بيانات ناقصة: ${numbers.length} يومًا فقط في نافذة 30 يومًا` };
    total += numbers.reduce((sum: number, value: number) => sum + value, 0);
  }
  return { value: total, problem: null };
}

async function loadFacebook(registeredReciterIds: Set<number>, hidden: ShowcaseDiagnostics["hidden"]): Promise<{ followersByReciter: Map<number, number>; viewsByReciter: Map<number, { value: number | null; problem: string | null }>; reels: FacebookReelSource[]; problems: Map<number, string>; configured: boolean }> {
  const followersByReciter = new Map<number, number>();
  const viewsByReciter = new Map<number, { value: number | null; problem: string | null }>();
  const problems = new Map<number, string>();
  const reels: FacebookReelSource[] = [];
  const config = getFacebookConfig();
  if (!config) return { followersByReciter, viewsByReciter, reels, problems, configured: false };
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
    if (!token) { problems.set(Number(page.reciter_id), "تعذّر قراءة مفتاح صفحة فيسبوك — أعد «ربط فيسبوك»"); return; }
    const name = String(page.reciter_name);
    try {
      const info = await fbGet(String(page.fb_page_id), { fields: "followers_count,fan_count", access_token: token });
      const followers = info?.followers_count ?? info?.fan_count;
      if (followers != null) followersByReciter.set(Number(page.reciter_id), Number(followers));
      else problems.set(Number(page.reciter_id), "لم تُرجع ميتا عدد متابعي الصفحة");
    } catch (err) { problems.set(Number(page.reciter_id), `رفضت ميتا الطلب: ${(err as Error).message}`); }
    viewsByReciter.set(Number(page.reciter_id), await facebookViews90(String(page.fb_page_id), token));
    try {
      const data = await fbGet(`${page.fb_page_id}/video_reels`, { fields: "id,created_time,picture", limit: "5", access_token: token });
      for (const row of Array.isArray(data?.data) ? data.data : []) {
        if (!row?.id) continue;
        reels.push({ videoId: String(row.id), token, account: name, url: `https://www.facebook.com/reel/${row.id}/`, thumbnail: row.picture ?? null, publishedAt: row.created_time ? new Date(row.created_time).toISOString() : null });
      }
    } catch { /* بلا مقاطع */ }
  }));
  return { followersByReciter, viewsByReciter, reels, problems, configured: true };
}

// ── تلقرام (Bot API: getChatMemberCount — مجاني، للعامة باسمها وللخاصة التي البوت عضو/مشرف فيها) ─────
function telegramUsername(url: string | null): string | null {
  const match = String(url ?? "").match(/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})(?:[/?#\s]|$)/i);
  return match && match[1].toLowerCase() !== "c" && match[1].toLowerCase() !== "joinchat" ? match[1] : null;
}

// رابط رسالة قناة خاصة: t.me/c/<المعرّف الداخلي>/… ⇐ chat_id = -100<المعرّف>.
function telegramPrivateChatId(url: string | null): string | null {
  const match = String(url ?? "").match(/(?:t\.me|telegram\.me)\/c\/(\d{5,})/i);
  return match ? `-100${match[1]}` : null;
}

async function telegramMembers(chatId: string | null): Promise<{ count: number | null; error: string | null }> {
  if (!chatId) return { count: null, error: null };
  const result: any = await callTelegramApi<number>("getChatMemberCount", { chat_id: chatId }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
  if (result?.ok && typeof result.result === "number") return { count: result.result, error: null };
  return { count: null, error: String(result?.error ?? "فشل الطلب") };
}

type TelegramChatRef = { chatId: string | null; reason: string | null };
type SeenChat = { chatId: string; title: string; botStatus: string | null };

// تحديد قناة الصفحة آليًا: (1) اسم مستخدم عام من الرابط، (2) رابط t.me/c/…، (3) قناة مراقَبة مربوطة بالصفحة،
// (4) قناة دخلها البوت (عضو/مشرف) بعنوان يطابق اسم الصفحة أو اسم القارئ — مطابقة واحدة فقط، لا تخمين.
function resolveTelegramChat(page: PageRow, linkedChats: Map<number, string>, seenChats: SeenChat[]): TelegramChatRef {
  const username = telegramUsername(page.pageUrl) ?? telegramUsername(page.name);
  if (username) return { chatId: `@${username}`, reason: null };
  const privateId = telegramPrivateChatId(page.pageUrl) ?? telegramPrivateChatId(page.name);
  if (privateId) return { chatId: privateId, reason: null };
  const linked = linkedChats.get(page.id);
  if (linked) return { chatId: linked, reason: null };
  const candidates = [page.name, page.reciterName].filter(Boolean).map((value) => nameKey(String(value)));
  const matches = seenChats.filter((chat) => {
    const title = nameKey(chat.title);
    return candidates.some((candidate) => candidate && (title === candidate || (page.reciterName && title.includes(nameKey(page.reciterName)))));
  });
  if (matches.length === 1) return { chatId: matches[0].chatId, reason: null };
  if (matches.length > 1) return { chatId: null, reason: `أكثر من قناة دخلها البوت تطابق «${page.name}» — ضع رابط القناة (t.me/الاسم أو رابط رسالة t.me/c/…) في صفحة المنصات` };
  return { chatId: null, reason: page.pageUrl && /\/(\+|joinchat)/i.test(page.pageUrl)
    ? "قناة خاصة برابط دعوة، والبوت ليس عضوًا فيها — أضف البوت @Tilawatalharamain_bot عضوًا/مشرفًا في القناة"
    : "لا رابط عام للقناة والبوت ليس عضوًا فيها — أضف رابط t.me/الاسم في صفحة المنصات، أو أضف البوت @Tilawatalharamain_bot للقناة" };
}

// قرار إخفاء لمرة واحدة (انظر ONE_TIME_HIDE_CHANNELS): يُعلَّم في القاعدة ولا يُعاد بعد ذلك — فإظهار المدير
// لها لاحقًا يبقى نافذًا. إن لم تُسجَّل القناتان بعد، يُعاد الفحص لاحقًا بلا أثر.
async function applyOneTimeHide(resolved: Array<YoutubeTarget & { channelId: string }>, pages: PageRow[]) {
  const done = rowsOf(await db.execute(sql`SELECT name FROM app_one_time_migrations WHERE name = ${ONE_TIME_HIDE_MIGRATION}`).catch(() => ({ rows: [{ name: "skip" }] })));
  if (done.length > 0) return;
  const pageIds = resolved.filter((target) => ONE_TIME_HIDE_CHANNELS.includes(target.channelId)).map((target) => target.pageId);
  if (pageIds.length === 0) return;
  await db.execute(sql`UPDATE platform_pages SET hide_from_showcase = true WHERE id IN (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})`);
  await db.execute(sql`INSERT INTO app_one_time_migrations (name, details) VALUES (${ONE_TIME_HIDE_MIGRATION}, ${JSON.stringify({ pageIds })}::jsonb) ON CONFLICT (name) DO NOTHING`);
  for (const page of pages) if (pageIds.includes(page.id)) page.hidden = true;
}

// ── التجميع ───────────────────────────────────────────────────────────────────────────────────
export async function buildShowcase(now = new Date()): Promise<ShowcaseData> {
  await ensureShowcaseSchema();
  const allPages = await loadPages();
  // اسم الحساب: اسم القارئ، وإلا اسم الصفحة بلا أي رابط وُضع فيه خطأً.
  const accountName = (page: PageRow) => page.reciterName ?? (stripUrls(page.name) || page.name);
  // رابط الحساب: خانة الرابط، وإلا رابط وُضع في خانة الاسم.
  // (أول رابط فقط: خانة الرابط قد تحمل الرابط متبوعًا بالاسم.)
  const accountUrl = (page: PageRow) => urlInName(page.pageUrl ?? "") ?? urlInName(page.name);
  const hidden: ShowcaseDiagnostics["hidden"] = [];

  // يوتيوب: كل الصفحات المسجّلة تُحلّ (حتى المخفية، لتطبيق قرار الإخفاء ولعرض حالتها للمدير).
  const allYoutubeTargets = allPages.filter((page) => YOUTUBE_PLATFORM_NAME.test(page.platformName)).map((page) => ({ pageId: page.id, pageName: page.name, pageUrl: page.pageUrl, reciterName: page.reciterName }));
  const { resolved: allYoutubeResolved, report: youtubeReport } = await resolveYoutubeTargets(allYoutubeTargets).catch(() => ({ resolved: [] as Array<YoutubeTarget & { channelId: string }>, report: [] as ShowcaseDiagnostics["youtube"] }));
  await applyOneTimeHide(allYoutubeResolved, allPages);
  const pages = allPages.filter((page) => !page.hidden);
  const pagesOf = (pattern: RegExp) => pages.filter((page) => pattern.test(page.platformName));
  const hiddenPageIds = new Set(allPages.filter((page) => page.hidden).map((page) => page.id));
  for (const row of youtubeReport) row.hiddenByAdmin = hiddenPageIds.has(row.pageId);
  const youtubeResolved = allYoutubeResolved.filter((target) => !hiddenPageIds.has(target.pageId));
  const facebookReciters = new Set(pagesOf(FACEBOOK_PLATFORM_NAME).map((page) => page.reciterId).filter((id): id is number => id != null));
  const [youtubeAll, apps, instagram, facebook, teamClips] = await Promise.all([
    loadYoutube(youtubeResolved, youtubeReport).catch(() => [] as YoutubeChannelData[]),
    loadApps(),
    loadInstagram().catch(() => ({ followersByPage: new Map<number, number>(), mediaCountByPage: new Map<number, number>(), views90ByPage: new Map<number, number>(), reels: [] as InstagramReelSource[], tokensByPage: new Map<number, string>(), problems: new Map<number, string>(), configured: true })),
    loadFacebook(facebookReciters, hidden).catch(() => ({ followersByReciter: new Map<number, number>(), viewsByReciter: new Map<number, { value: number | null; problem: string | null }>(), reels: [] as FacebookReelSource[], problems: new Map<number, string>(), configured: true })),
    loadTeamClips().catch(() => 0),
  ]);
  const youtube = youtubeAll.filter((channel) => {
    if (channel.subscribers != null || channel.views != null) return true;
    hidden.push({ what: `قناة يوتيوب «${channel.title}» (${channel.channelId})`, why: "مخفية لأن يوتيوب لم يُرجع لها أي رقم (مشتركين أو مشاهدات)" });
    return false;
  });
  for (const page of allPages.filter((p) => p.hidden)) hidden.push({ what: `${page.platformName} — ${page.name}`, why: "مخفية من الصفحة العامة بقرار المدير (باقية في النظام وصفحة المنصات)" });
  const followerReport: ShowcaseDiagnostics["followers"] = [];
  const report = (platform: ShowcaseDiagnostics["followers"][number]["platform"], account: string, value: number | null, reason: string | null) =>
    followerReport.push({ platform, account, automatic: value != null, reason: value != null ? null : reason ?? "تعذّر الجلب" });

  // إنستقرام: Graph API لكل حساب مربوط في «مراقبة إنستقرام».
  const igLinked = new Set(rowsOf(await db.execute(sql`SELECT page_id FROM instagram_accounts WHERE enabled AND status = 'connected'`).catch(() => ({ rows: [] }))).map((row) => Number(row.page_id)));
  const instagramAccounts: ShowcaseAccount[] = pagesOf(INSTAGRAM_PLATFORM_NAME).map((page) => {
    const followers = instagram.followersByPage.get(page.id) ?? null;
    report("instagram", accountName(page), followers, !instagram.configured ? "متغيرات إنستقرام غير مضبوطة في Railway" : !igLinked.has(page.id) ? "الحساب غير مربوط (أو انقطع ربطه) في «مراقبة إنستقرام» — اربطه هناك" : instagram.problems.get(page.id) ?? null);
    // المنشورات: العدد الحقيقي من إنستقرام (media_count)؛ تعذّره ⇐ لا رقم (لا عدد الشواهد).
    return { name: accountName(page), url: accountUrl(page), followers, posts: instagram.mediaCountByPage.get(page.id) ?? null };
  });
  // فيسبوك: Graph API لصفحة القارئ المربوطة في «مراقبة إنستقرام» (حساب القارئ ← صفحة فيسبوك).
  const fbMapped = new Set(rowsOf(await db.execute(sql`SELECT a.reciter_id FROM instagram_accounts a JOIN facebook_pages fp ON fp.fb_page_id = a.fb_page_id AND fp.status = 'connected'`).catch(() => ({ rows: [] }))).map((row) => Number(row.reciter_id)));
  const facebookAccounts: ShowcaseAccount[] = pagesOf(FACEBOOK_PLATFORM_NAME).map((page) => {
    const followers = page.reciterId != null ? facebook.followersByReciter.get(page.reciterId) ?? null : null;
    report("facebook", accountName(page), followers, !facebook.configured ? "متغيرات فيسبوك غير مضبوطة في Railway"
      : page.reciterId == null ? "الصفحة غير مربوطة بقارئ في صفحة المنصات"
      : !fbMapped.has(page.reciterId) ? "صفحة فيسبوك هذا القارئ غير مربوطة في «مراقبة إنستقرام» (أو تحتاج إعادة ربط فيسبوك) — اربطها هناك"
      : facebook.problems.get(page.reciterId) ?? null);
    // فيسبوك لا يوفّر عددًا دقيقًا لمنشورات الصفحة (عدّ published_posts يأتي ناقصًا) ⇐ لا رقم منشورات.
    return { name: accountName(page), url: accountUrl(page), followers, posts: null };
  });
  // تلقرام: Bot API (getChatMemberCount) للقنوات العامة، وللخاصة التي البوت عضو/مشرف فيها.
  const telegramPages = pagesOf(TELEGRAM_PLATFORM_NAME);
  const linkedChats = new Map<number, string>(rowsOf(await db.execute(sql`SELECT page_id, chat_id FROM telegram_channels WHERE page_id IS NOT NULL`).catch(() => ({ rows: [] }))).map((row) => [Number(row.page_id), String(row.chat_id)]));
  const seenChats: SeenChat[] = rowsOf(await db.execute(sql`SELECT chat_id, title, bot_status FROM telegram_seen_chats WHERE type = 'channel' AND (bot_status IS NULL OR bot_status IN ('member', 'administrator', 'creator'))`).catch(() => ({ rows: [] })))
    .filter((row) => row.title).map((row) => ({ chatId: String(row.chat_id), title: String(row.title), botStatus: row.bot_status ? String(row.bot_status) : null }));
  const telegramAccounts: ShowcaseAccount[] = await Promise.all(telegramPages.map(async (page) => {
    const ref = resolveTelegramChat(page, linkedChats, seenChats);
    const result = await telegramMembers(ref.chatId);
    report("telegram", accountName(page), result.count, ref.reason ?? (result.error ? `رفض تلقرام الطلب (${result.error}) — إن كانت القناة خاصة فأضف البوت @Tilawatalharamain_bot عضوًا/مشرفًا فيها` : null));
    // تلقرام: البوت لا يستطيع معرفة عدد منشورات القناة ⇐ لا رقم منشورات.
    return { name: accountName(page), url: accountUrl(page), followers: result.count, posts: null };
  }));
  // تويتر/X: لا يوجد مصدر رسمي مجاني ⇐ الحساب بلا رقم دائمًا (لا رقم يدوي ولا تقديري).
  const twitterAccounts: ShowcaseAccount[] = pagesOf(TWITTER_PLATFORM_NAME).map((page) => {
    report("twitter", accountName(page), null, "واجهة X الرسمية لقراءة عدد المتابعين تتطلب اشتراكًا مدفوعًا (X API Basic أو أعلى) — يُعرض الحساب بلا رقم");
    return { name: accountName(page), url: accountUrl(page), followers: null, posts: null };
  });

  // لا رقم آلي ⇐ لا يُعرض الحساب (يظهر من نفسه متى توفّر رقمه). السبب يبقى في التشخيص.
  const withNumber = (accounts: ShowcaseAccount[], platform: string) => accounts.filter((account) => {
    if (account.followers != null) return true;
    hidden.push({ what: `${platform} — ${account.name}`, why: "مخفي لأنه بلا رقم متابعين آلي (يظهر تلقائيًا متى توفّر الرقم — انظر «أرقام المتابعين لكل حساب»)" });
    return false;
  });

  // التطبيقات: صورة الشيخ من صورة قناته على يوتيوب (مطابقة اسم القارئ في اسم التطبيق).
  const avatarFor = (appName: string) => youtube.find((channel) => channel.reciterName && nameKey(appName).includes(nameKey(channel.reciterName)))?.avatar ?? null;
  // قنوات تلقرام المسجّلة (باسم المستخدم من رابط الصفحة) — لا تُعرض منشورات قناة غير مسجّلة.
  const registeredTelegram = new Set(telegramPages.map((page) => (telegramUsername(page.pageUrl) ?? telegramUsername(page.name))?.toLowerCase()).filter(Boolean) as string[]);
  const registeredTelegramPageIds = new Set(telegramPages.map((page) => page.id));
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
  // مشتركو قناة التصاميم: بمعرّفها مباشرة (يعمل للخاصة ما دام البوت فيها — وهو مشرفها لأنه يراقبها).
  const designMembers = designChannel ? await telegramMembers(String(designChannel.chat_id)) : { count: null, error: null };
  if (designChannel) report("designs", String(designChannel.title ?? "قناة التصاميم"), designMembers.count, designMembers.error ? `رفض تلقرام الطلب (${designMembers.error})` : null);

  // أحدث ما نشرنا: دمج كل المنصّات، الأحدث أولًا.
  const recitationChannels = rowsOf(await db.execute(sql`SELECT chat_id, title, username, page_id FROM telegram_channels WHERE kind = 'recitations'`).catch(() => ({ rows: [] })));
  const feedChatIds: string[] = [];
  for (const channel of recitationChannels) {
    const registered = (channel.page_id != null && (registeredPageIds.has(Number(channel.page_id)) || registeredTelegramPageIds.has(Number(channel.page_id)))) || (channel.username && registeredTelegram.has(String(channel.username).toLowerCase()));
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
    ...instagram.reels.filter((reel) => reel.publishedAt).map((reel) => ({ platform: "instagram" as const, title: "", kind: "clip" as const, name: reel.account, url: reel.url, publishedAt: reel.publishedAt! })),
    ...facebook.reels.filter((reel) => reel.publishedAt).map((reel) => ({ platform: "facebook" as const, title: "", kind: "clip" as const, name: reel.account, url: reel.url, publishedAt: reel.publishedAt! })),
    ...recitationPosts.map((row) => {
      const caption = String(row.caption ?? "").split("\n")[0].replace(/#\S+/g, "").trim();
      const reciter = row.reciter_name ? String(row.reciter_name) : null;
      return {
        platform: "telegram" as const,
        // بلا نص ⇐ «تلاوة جديدة» تُترجم في الصفحة، واسم القارئ (إن وُجد) يُلحق كما هو.
        ...(caption ? { title: [caption, reciter].filter(Boolean).join(" — ") } : { title: "", kind: "recitation" as const, ...(reciter ? { name: reciter } : {}) }),
        url: String(row.post_url), publishedAt: new Date(row.published_at).toISOString(),
      };
    }),
    ...designItems.slice(0, 3).map((item) => ({ platform: "designs" as const, title: "", kind: "design" as const, url: item.url, publishedAt: item.publishedAt })),
  ].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8);

  const shown = {
    instagram: withNumber(instagramAccounts, "انستقرام"),
    facebook: withNumber(facebookAccounts, "فيسبوك"),
    telegram: withNumber(telegramAccounts, "تيليجرام"),
    twitter: withNumber(twitterAccounts, "تويتر / X"),
  };
  const youtubeVideos = youtube.reduce((sum, channel) => sum + (channel.videos ?? 0), 0);
  // مشاهدات انستقرام (90 يومًا) للحسابات الظاهرة فقط؛ الحساب بلا رقم يُتخطّى، ولا رقم إطلاقًا ⇐ null.
  const shownInstagramPages = pagesOf(INSTAGRAM_PLATFORM_NAME).filter((page) => instagram.followersByPage.has(page.id));
  const instagramViewsList = shownInstagramPages.map((page) => instagram.views90ByPage.get(page.id)).filter((value): value is number => value != null);
  const instagramViews90 = instagramViewsList.length > 0 ? instagramViewsList.reduce((sum, value) => sum + value, 0) : null;
  // فيسبوك: شرط الدقة — يُعرض المجموع فقط إن رجع المقياس كاملًا لكل صفحة ظاهرة؛ وإلا لا يُعرض إطلاقًا.
  const shownFacebookPages = pagesOf(FACEBOOK_PLATFORM_NAME).filter((page) => page.reciterId != null && facebook.followersByReciter.has(page.reciterId));
  const facebookViewRows = shownFacebookPages.map((page) => {
    const result = facebook.viewsByReciter.get(page.reciterId!);
    return { account: accountName(page), value: result?.value ?? null, problem: result ? result.problem : "لم يُجلب (الصفحة غير مربوطة بمفتاح فيسبوك)" };
  });
  const facebookComplete = facebookViewRows.length > 0 && facebookViewRows.every((row) => row.value != null);
  const facebookViews90 = facebookComplete ? facebookViewRows.reduce((sum, row) => sum + (row.value ?? 0), 0) : null;
  const [instagramRow, facebookRow] = await Promise.all([
    Promise.all(pickInstagramRow(instagram.reels).map(async ({ pageId, mediaId, ...reel }) => ({ ...reel, views: await instagramReelViews(mediaId, instagram.tokensByPage.get(pageId)) }))),
    Promise.all([...facebook.reels].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, 3)
      .map(async ({ videoId, token, ...reel }) => ({ ...reel, views: await facebookReelViews(videoId, token) }))),
  ]);

  return {
    generatedAt: now.toISOString(),
    dataVersion: 4,
    hero: {
      youtubeViews: youtube.reduce((sum, channel) => sum + (channel.views ?? 0), 0),
      youtubeSubscribers: youtube.reduce((sum, channel) => sum + (channel.subscribers ?? 0), 0),
      appsCount: apps.length,
    },
    totals: {
      youtubeVideos,
      totalPosts: youtubeVideos + shown.instagram.reduce((sum, account) => sum + (account.posts ?? 0), 0),
      accounts: youtube.length + shown.instagram.length + shown.facebook.length + shown.telegram.length,
      teamClips,
      instagramViews90,
      facebookViews90,
    },
    featured,
    youtube: youtube.map(({ reciterName: _r, recent: _recent, ...channel }) => channel),
    apps: apps.map((app) => ({ name: app.name, iosUrl: app.iosUrl, androidUrl: app.androidUrl, avatar: avatarFor(app.name) })),
    platforms: {
      instagram: { accounts: shown.instagram, reels: instagramRow },
      facebook: { accounts: shown.facebook, reels: facebookRow },
      telegram: { accounts: shown.telegram },
      twitter: { accounts: shown.twitter },
    },
    designs: {
      items: designItems,
      // بطاقة القناة تُعرض فقط برقم مشتركين آلي.
      channel: designChannel && designMembers.count != null ? { name: String(designChannel.title ?? "قناة التصاميم"), url: designUsername ? `https://t.me/${designUsername}` : null, subscribers: designMembers.count } : null,
    },
    feed,
    diagnostics: {
      youtube: youtubeReport,
      hiddenPages: allPages.filter((page) => page.hidden).map((page) => ({ pageId: page.id, platformName: page.platformName, name: page.name })),
      hidden,
      followers: followerReport,
      youtubeBreakdown: {
        channels: youtube.map((channel) => ({
          channelId: channel.channelId,
          title: channel.title,
          subscribers: channel.subscribers,
          views: channel.views,
          pages: youtubeReport.filter((row) => row.channelId === channel.channelId).map((row) => row.pageName),
        })),
        totalViews: youtube.reduce((sum, channel) => sum + (channel.views ?? 0), 0),
        totalSubscribers: youtube.reduce((sum, channel) => sum + (channel.subscribers ?? 0), 0),
      },
      apps: apps.map((app) => app.name),
      facebookViews: {
        metric: FACEBOOK_VIEWS_METRIC,
        shown: facebookComplete,
        reason: facebookComplete ? null : facebookViewRows.length === 0 ? "لا توجد صفحات فيسبوك ظاهرة" : `لا يُعرض: ${facebookViewRows.filter((row) => row.value == null).length} من ${facebookViewRows.length} صفحات بلا رقم كامل`,
        pages: facebookViewRows,
      },
    },
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
