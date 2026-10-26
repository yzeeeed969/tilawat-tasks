// أداء مقاطع يوتيوب (الإصدار 70): يجلب مقاطع آخر N يومًا لقنوات المشايخ المراقَبة من واجهة يوتيوب الرسمية
// (بمفتاح الموقع)، ويقيس انتشار كل مقطع نسبةً إلى المقطع المعتاد في قناته نفسها، حتى لا يبدو المقطع
// منتشرًا لمجرد أن قناة شيخه كبيرة. لا علاقة له بإنترنت البيت ولا بأي حساب يوتيوب؛ القراءة فقط.
// ويحفظ لقطة يومية للمشاهدات لكل مقطع لنعرف لاحقًا سرعة الانتشار (بعد يومين، بعد أسبوع).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { callYoutubeApi } from "./youtube-client";

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS youtube_video_stats (
          video_id text NOT NULL,
          captured_on date NOT NULL,
          views bigint NOT NULL,
          likes integer,
          comments integer,
          captured_at timestamp NOT NULL DEFAULT now(),
          PRIMARY KEY (video_id, captured_on)
        )`);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

export type PerfVideo = {
  videoId: string; title: string; channel: string; type: string; publishedAt: string; ageDays: number; hourRiyadh: number;
  durationSec: number; views: number; likes: number; comments: number; viewsPerDay: number; score: number | null;
  praise: boolean; exclamation: boolean;
};

const PRAYER_WORDS = /فجر|عشاء|مغرب|ظهر|عصر|الجمعة/;

function parseDuration(iso: string): number {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}

// نوع المقطع — هو أقوى عامل في الانتشار حسب التحليل الأول (أكتوبر 2026).
export function classifyVideo(title: string, durationSec: number, wasLive: boolean): string {
  if (wasLive) return "بث مباشر";
  if (/محاضرة|قبس|درس/.test(title)) return "محاضرة";
  if (/المصحف المرتل/.test(title)) return "مصحف مرتل";
  if (/خطبة/.test(title)) return "خطبة";
  if (/روائع|الإصدار|فجريات|عشائيات|مغربيات|تراتيل|تلاوات شهر|سلسلة|فروض \d|تهجد/.test(title)) return "إصدار مجمّع";
  if (durationSec > 0 && durationSec <= 180 && !PRAYER_WORDS.test(title)) return "مقطع قصير";
  if (/كاملة/.test(title) && !PRAYER_WORDS.test(title)) return "سورة كاملة";
  return "مقطع صلاة";
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function channelVideoIds(uploadsPlaylistId: string, cutoff: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 6; page++) {
    const data = await callYoutubeApi<{ nextPageToken?: string; items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }> }>(
      "playlistItems",
      { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) },
    );
    let reachedOld = false;
    for (const item of data.items ?? []) {
      const id = item.contentDetails?.videoId;
      const at = Date.parse(item.contentDetails?.videoPublishedAt ?? "");
      if (!id) continue;
      if (Number.isFinite(at) && at < cutoff) { reachedOld = true; continue; }
      ids.push(id);
    }
    if (reachedOld || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return ids;
}

type Cache = { at: number; days: number; value: Awaited<ReturnType<typeof buildPerformance>> };
let cache: Cache | null = null;

async function buildPerformance(days: number) {
  await ensureSchema();
  const channels = rowsOf<{ display_name: string; reciter_name_constant: string; uploads_playlist_id: string | null }>(
    await db.execute(sql`SELECT display_name, reciter_name_constant, uploads_playlist_id FROM youtube_channels WHERE enabled = true ORDER BY id`),
  );
  const now = Date.now();
  const cutoff = now - days * 86_400_000;
  const videos: PerfVideo[] = [];
  const errors: string[] = [];

  for (const ch of channels) {
    if (!ch.uploads_playlist_id) { errors.push(`${ch.reciter_name_constant}: لم تُربط قناته بعد`); continue; }
    try {
      const ids = await channelVideoIds(ch.uploads_playlist_id, cutoff);
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const data = await callYoutubeApi<{ items?: any[] }>("videos", { part: "snippet,statistics,contentDetails,liveStreamingDetails", id: chunk.join(","), maxResults: "50" });
        for (const v of data.items ?? []) {
          if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== "none") continue; // بث جارٍ أو مجدول
          const title = String(v.snippet?.title ?? "");
          const published = Date.parse(v.snippet?.publishedAt ?? "");
          const durationSec = parseDuration(String(v.contentDetails?.duration ?? ""));
          const ageDays = Math.max((now - published) / 86_400_000, 0.01);
          const views = Number(v.statistics?.viewCount ?? 0);
          videos.push({
            videoId: v.id, title, channel: ch.reciter_name_constant,
            type: classifyVideo(title, durationSec, Boolean(v.liveStreamingDetails)),
            publishedAt: new Date(published).toISOString(), ageDays: Math.round(ageDays * 10) / 10,
            hourRiyadh: (new Date(published).getUTCHours() + 3) % 24,
            durationSec, views, likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0),
            viewsPerDay: Math.round(views / Math.max(ageDays, 1)), score: null,
            praise: /بديع|إبداع|يفوق الوصف|لا توصف|تحبير|ماتع|آسر|العبقري|البلبل|العندليب|المتميز|يا الله|ليتها|أخّاذ|أخَّاذ|خاشع|شجي/.test(title),
            exclamation: /!/.test(title),
          });
        }
      }
    } catch (err) {
      errors.push(`${ch.reciter_name_constant}: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  // خط الأساس لكل قناة: وسيط مشاهدات «مقطع صلاة» عمره 4 أيام فأكثر (المقاطع الأحدث لم تكتمل مشاهداتها).
  const baselines: Record<string, number> = {};
  for (const name of new Set(videos.map((v) => v.channel))) {
    const mine = videos.filter((v) => v.channel === name && v.ageDays >= 4);
    const regular = mine.filter((v) => v.type === "مقطع صلاة").map((v) => v.views);
    baselines[name] = median(regular.length >= 3 ? regular : mine.filter((v) => v.type !== "بث مباشر").map((v) => v.views));
  }
  for (const v of videos) v.score = baselines[v.channel] ? Math.round((v.views / baselines[v.channel]) * 100) / 100 : null;

  const mature = videos.filter((v) => v.ageDays >= 4 && v.score != null);
  const types = [...new Set(videos.map((v) => v.type))].map((type) => {
    const all = videos.filter((v) => v.type === type);
    const scored = mature.filter((v) => v.type === type).map((v) => v.score as number);
    return { type, count: all.length, totalViews: all.reduce((s, v) => s + v.views, 0), medianScore: scored.length ? Math.round(median(scored) * 100) / 100 : null };
  }).sort((a, b) => (b.medianScore ?? -1) - (a.medianScore ?? -1));

  const regular = mature.filter((v) => v.type === "مقطع صلاة");
  const feature = (label: string, test: (v: PerfVideo) => boolean) => {
    const yes = regular.filter(test).map((v) => v.score as number);
    const no = regular.filter((v) => !test(v)).map((v) => v.score as number);
    return { label, withCount: yes.length, withMedian: yes.length ? Math.round(median(yes) * 100) / 100 : null, withoutCount: no.length, withoutMedian: no.length ? Math.round(median(no) * 100) / 100 : null };
  };
  const features = [
    feature("كلمات مدح في العنوان (بديعة، تحبير، خاشعة…)", (v) => v.praise),
    feature("علامة تعجب في العنوان", (v) => v.exclamation),
    feature("النشر بين 6 صباحًا و12 ظهرًا", (v) => v.hourRiyadh >= 6 && v.hourRiyadh < 12),
    feature("النشر بين 6 مساءً و12 ليلًا", (v) => v.hourRiyadh >= 18),
  ];

  // لقطة اليوم (مرة في اليوم لكل مقطع، والأحدث يستبدل الأقدم في اليوم نفسه).
  for (const v of videos) {
    await db.execute(sql`
      INSERT INTO youtube_video_stats (video_id, captured_on, views, likes, comments)
      VALUES (${v.videoId}, (now() AT TIME ZONE 'Asia/Riyadh')::date, ${v.views}, ${v.likes}, ${v.comments})
      ON CONFLICT (video_id, captured_on) DO UPDATE SET views = EXCLUDED.views, likes = EXCLUDED.likes, comments = EXCLUDED.comments, captured_at = now()`).catch(() => {});
  }

  const channelSummary = Object.entries(baselines).map(([name, baseline]) => {
    const mine = videos.filter((v) => v.channel === name);
    return { channel: name, baseline: Math.round(baseline), videos: mine.length, totalViews: mine.reduce((s, v) => s + v.views, 0) };
  }).sort((a, b) => b.totalViews - a.totalViews);

  return { generatedAt: new Date().toISOString(), days, channels: channelSummary, types, features, videos: videos.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)), errors };
}

export async function youtubePerformance(days = 30, refresh = false) {
  const d = Math.min(Math.max(Math.round(days) || 30, 7), 90);
  if (!refresh && cache && cache.days === d && Date.now() - cache.at < 30 * 60_000) return cache.value;
  const value = await buildPerformance(d);
  cache = { at: Date.now(), days: d, value };
  return value;
}

// لقطة تلقائية كل 6 ساعات (نحو 30 وحدة من حصة يوتيوب اليومية البالغة 10,000).
export function startYoutubePerformanceScheduler(logger?: { warn: (...a: any[]) => void }) {
  const run = () => youtubePerformance(30, true).catch((err) => logger?.warn?.({ err }, "youtube performance snapshot failed"));
  setTimeout(run, 2 * 60_000);
  setInterval(run, 6 * 60 * 60_000);
}
