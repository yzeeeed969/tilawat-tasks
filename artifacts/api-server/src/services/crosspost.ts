import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureCrosspostSchema } from "./crosspost-schema";
import { ensureYoutubeMonitorSchema } from "./youtube-monitor-schema";
import { ensureInstagramSchema } from "./instagram-schema";
import { ensureShowcaseSchema } from "./showcase-schema";
import { callYoutubeApi } from "./youtube-client";
import { getFacebookConfig } from "./facebook-client";
import { uploadFacebookVideo } from "./facebook-video-upload";
import { decryptToken } from "../lib/instagram-token-crypto";
import { addSupplementaryProof } from "./auto-documentation";

// الرفع التلقائي للتلاوات يوتيوب ← فيسبوك (ناتيف). القرارات:
// - الجديد فقط: عند كل تفعيل يُسجَّل أحدث فيديو حالي لكل قناة كـ«خط أساس»، ولا يُرفع ما قبله أبدًا.
// - نشر مباشر published=true بنفس عنوان يوتيوب (يُقرأ من يوتيوب على الخادم، لا من جهاز التنزيل).
// - رمز الصفحة يُفكّ ويُستخدم على الخادم فقط.
// - جهاز التنزيل (الماك ميني) يتعامل بمفتاح سري CROSSPOST_API_KEY في متغيّر بيئة (لا جلسة مدير).

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];
const MAX_ATTEMPTS = 3;
const STALE_UPLOAD_MINUTES = 30;
const PLAYLIST_CACHE_MS = 3 * 60 * 1000;

// ── المفتاح السري لجهاز التنزيل ─────────────────────────────────────────────────────────────
export function machineKeyConfigured() {
  return (process.env.CROSSPOST_API_KEY ?? "").trim().length >= 32;
}

export function checkMachineKey(header: string | undefined): boolean {
  const expected = (process.env.CROSSPOST_API_KEY ?? "").trim();
  if (expected.length < 32 || !header) return false;
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── الإعدادات ───────────────────────────────────────────────────────────────────────────────
export async function getCrosspostSettings() {
  await ensureCrosspostSchema();
  const [row] = rowsOf(await db.execute(sql`SELECT enabled, enabled_at, last_machine_poll_at FROM yt_fb_settings WHERE id = 1`));
  return { enabled: row?.enabled === true, enabledAt: row?.enabled_at ?? null, lastMachinePollAt: row?.last_machine_poll_at ?? null };
}

// ── الربط قناة ↔ صفحة: عبر القارئ (قناة يوتيوب ← حساب إنستقرام القارئ ← صفحة فيسبوك مربوطة) ──
// القنوات = صفحات يوتيوب المسجّلة في «المنصات والصفحات» (نفس قنوات الصفحة العامة) + قنوات «مراقبة يوتيوب».
// بلا تخمين: قارئ واحد وصفحة فيسبوك واحدة بالضبط ⇐ مربوطة؛ غير ذلك ⇐ القناة معطّلة مع السبب.
export type ChannelMapping = {
  channelId: string; youtubeChannelRowId: number | null; displayName: string; reciterId: number | null; reciterName: string | null;
  fbPageId: string | null; fbPageName: string | null; status: "mapped" | "disabled"; reason: string | null;
};

const YOUTUBE_PLATFORM = /يوتيوب|youtube/i;

export async function computeMappings(): Promise<ChannelMapping[]> {
  await ensureYoutubeMonitorSchema();
  await ensureInstagramSchema();
  await ensureShowcaseSchema(); // عمود hide_from_showcase
  type Source = { channelId: string; youtubeChannelRowId: number | null; displayName: string; reciterIds: Set<number>; reciterNames: Map<number, string>; hiddenOnly: boolean };
  const merged = new Map<string, Source>();
  const add = (channelId: string, fields: { rowId?: number | null; name: string; reciterId: number | null; reciterName: string | null; hidden: boolean }) => {
    const current = merged.get(channelId) ?? { channelId, youtubeChannelRowId: null, displayName: fields.name, reciterIds: new Set<number>(), reciterNames: new Map<number, string>(), hiddenOnly: true };
    if (fields.rowId != null) { current.youtubeChannelRowId = fields.rowId; current.displayName = fields.name; }
    if (fields.reciterId != null) { current.reciterIds.add(fields.reciterId); if (fields.reciterName) current.reciterNames.set(fields.reciterId, fields.reciterName); }
    if (!fields.hidden) current.hiddenOnly = false;
    merged.set(channelId, current);
  };

  // (أ) صفحات يوتيوب المسجّلة (تُحلّ إلى معرّف القناة بنفس طريقة الصفحة العامة).
  const ytPages = rowsOf(await db.execute(sql`
    SELECT pp.id, pp.name, pp.page_url, pp.reciter_id, coalesce(pp.hide_from_showcase, false) AS hidden, p.name AS platform_name, r.name AS reciter_name
    FROM platform_pages pp JOIN platforms p ON p.id = pp.platform_id LEFT JOIN reciters r ON r.id = pp.reciter_id`))
    .filter((row) => YOUTUBE_PLATFORM.test(String(row.platform_name)));
  if (ytPages.length > 0) {
    const { resolveYoutubeTargets } = await import("./showcase");
    const { resolved } = await resolveYoutubeTargets(ytPages.map((row) => ({ pageId: Number(row.id), pageName: String(row.name), pageUrl: row.page_url ? String(row.page_url) : null, reciterName: row.reciter_name ? String(row.reciter_name) : null })));
    for (const target of resolved) {
      const row = ytPages.find((page) => Number(page.id) === target.pageId)!;
      add(target.channelId, { name: String(row.name), reciterId: row.reciter_id != null ? Number(row.reciter_id) : null, reciterName: row.reciter_name ? String(row.reciter_name) : null, hidden: row.hidden === true });
    }
  }
  // (ب) قنوات «مراقبة يوتيوب».
  for (const row of rowsOf(await db.execute(sql`
    SELECT yc.id, yc.channel_id, yc.display_name, yc.reciter_id, r.name AS reciter_name
    FROM youtube_channels yc LEFT JOIN reciters r ON r.id = yc.reciter_id WHERE yc.channel_id IS NOT NULL`))) {
    add(String(row.channel_id), { rowId: Number(row.id), name: String(row.display_name), reciterId: row.reciter_id != null ? Number(row.reciter_id) : null, reciterName: row.reciter_name ? String(row.reciter_name) : null, hidden: false });
  }

  const pages = rowsOf(await db.execute(sql`
    SELECT DISTINCT a.reciter_id, fp.fb_page_id, fp.name AS page_name, fp.status
    FROM instagram_accounts a JOIN facebook_pages fp ON fp.fb_page_id = a.fb_page_id
    WHERE a.fb_page_id IS NOT NULL`));
  return [...merged.values()].map((source) => {
    const reciterId = source.reciterIds.size === 1 ? [...source.reciterIds][0] : null;
    const base = { channelId: source.channelId, youtubeChannelRowId: source.youtubeChannelRowId, displayName: source.displayName, reciterId, reciterName: reciterId != null ? source.reciterNames.get(reciterId) ?? null : null };
    const disabled = (reason: string): ChannelMapping => ({ ...base, fbPageId: null, fbPageName: null, status: "disabled", reason });
    if (source.hiddenOnly) return disabled("القناة مخفية من الصفحة العامة بقرار المدير — لا رفع لها");
    if (source.reciterIds.size === 0) return disabled("القناة غير مربوطة بقارئ في «المنصات والصفحات»");
    if (source.reciterIds.size > 1) return disabled(`القناة مسجّلة لأكثر من قارئ (${[...source.reciterNames.values()].join("، ")}) — لا تخمين`);
    const candidates = pages.filter((p) => Number(p.reciter_id) === reciterId);
    const unique = [...new Map(candidates.map((p) => [String(p.fb_page_id), p])).values()];
    if (unique.length === 0) return disabled("لا توجد صفحة فيسبوك مربوطة لهذا القارئ في «مراقبة إنستقرام»");
    if (unique.length > 1) return disabled(`أكثر من صفحة فيسبوك لهذا القارئ (${unique.map((p) => p.page_name).join("، ")}) — لا تخمين`);
    const page = unique[0];
    if (page.status !== "connected") return { ...disabled(`صفحة فيسبوك «${page.page_name}» تحتاج إعادة ربط`), fbPageId: String(page.fb_page_id), fbPageName: String(page.page_name) };
    return { ...base, fbPageId: String(page.fb_page_id), fbPageName: String(page.page_name), status: "mapped", reason: null };
  });
}

// يحفظ الربط الحالي في yt_fb_channels (مع إبقاء خط الأساس كما هو).
export async function syncMappings(): Promise<ChannelMapping[]> {
  await ensureCrosspostSchema();
  const mappings = await computeMappings();
  for (const m of mappings) {
    await db.execute(sql`
      INSERT INTO yt_fb_channels (channel_id, youtube_channel_row_id, display_name, reciter_id, reciter_name, fb_page_id, fb_page_name, status, reason, updated_at)
      VALUES (${m.channelId}, ${m.youtubeChannelRowId}, ${m.displayName}, ${m.reciterId}, ${m.reciterName}, ${m.fbPageId}, ${m.fbPageName}, ${m.status}, ${m.reason}, now())
      ON CONFLICT (channel_id) DO UPDATE SET youtube_channel_row_id = EXCLUDED.youtube_channel_row_id, display_name = EXCLUDED.display_name,
        reciter_id = EXCLUDED.reciter_id, reciter_name = EXCLUDED.reciter_name, fb_page_id = EXCLUDED.fb_page_id, fb_page_name = EXCLUDED.fb_page_name,
        status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = now()`);
  }
  const keep = mappings.map((m) => m.channelId);
  if (keep.length > 0) await db.execute(sql`UPDATE yt_fb_channels SET status = 'disabled', reason = 'لم تعد ضمن قنوات «مراقبة يوتيوب»' WHERE channel_id NOT IN (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`);
  else await db.execute(sql`UPDATE yt_fb_channels SET status = 'disabled', reason = 'لم تعد ضمن قنوات «مراقبة يوتيوب»'`);
  return mappings;
}

// ── يوتيوب: أحدث مقاطع القناة (قائمة الرفع) مع التفاصيل ───────────────────────────────────────
type YtVideo = { videoId: string; title: string; publishedAt: string; channelId: string; live: string };
const playlistCache = new Map<string, { at: number; videos: YtVideo[] }>();
export function clearCrosspostCaches() {
  playlistCache.clear();
}

async function latestVideos(channelId: string, max = 10): Promise<YtVideo[]> {
  const hit = playlistCache.get(channelId);
  if (hit && Date.now() - hit.at < PLAYLIST_CACHE_MS) return hit.videos;
  const playlist = await callYoutubeApi<{ items?: any[] }>("playlistItems", { part: "contentDetails", playlistId: `UU${channelId.slice(2)}`, maxResults: String(max) });
  const ids = (playlist.items ?? []).map((item) => String(item?.contentDetails?.videoId ?? "")).filter(Boolean);
  const videos = ids.length === 0 ? [] : await videoDetails(ids);
  videos.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  playlistCache.set(channelId, { at: Date.now(), videos });
  return videos;
}

async function videoDetails(ids: string[]): Promise<YtVideo[]> {
  const data = await callYoutubeApi<{ items?: any[] }>("videos", { part: "snippet", id: ids.join(",") });
  return (data.items ?? []).map((v) => ({
    videoId: String(v.id), title: String(v.snippet?.title ?? ""), publishedAt: new Date(v.snippet?.publishedAt ?? 0).toISOString(),
    channelId: String(v.snippet?.channelId ?? ""), live: String(v.snippet?.liveBroadcastContent ?? "none"),
  }));
}

// ── خط الأساس: أحدث فيديو حالي لكل قناة مربوطة ─────────────────────────────────────────────────
async function setBaseline(channelId: string): Promise<{ ok: boolean; detail: string }> {
  playlistCache.delete(channelId);
  const videos = await latestVideos(channelId, 5);
  const latest = videos[0];
  await db.execute(sql`UPDATE yt_fb_channels SET baseline_video_id = ${latest?.videoId ?? null},
    baseline_published_at = ${latest ? new Date(latest.publishedAt) : new Date()}, baseline_set_at = now() WHERE channel_id = ${channelId}`);
  return { ok: true, detail: latest ? `${latest.videoId} (${latest.publishedAt})` : "لا مقاطع بعد — الأساس الآن" };
}

// التشغيل/الإيقاف. كل تفعيل يعيد ضبط خط الأساس (لا يُرفع ما نُشر أثناء الإيقاف).
export async function setCrosspostEnabled(enabled: boolean) {
  await ensureCrosspostSchema();
  if (enabled) {
    const mappings = await syncMappings();
    const baselines: Array<{ channelId: string; ok: boolean; detail: string }> = [];
    for (const m of mappings.filter((x) => x.status === "mapped")) {
      try { baselines.push({ channelId: m.channelId, ...(await setBaseline(m.channelId)) }); }
      catch (err) { baselines.push({ channelId: m.channelId, ok: false, detail: (err as Error).message }); }
    }
    if (baselines.some((b) => !b.ok)) return { ok: false as const, message: "تعذّر ضبط خط الأساس لبعض القنوات — لم يُفعَّل", baselines };
    await db.execute(sql`UPDATE yt_fb_settings SET enabled = true, enabled_at = now(), updated_at = now() WHERE id = 1`);
    return { ok: true as const, baselines };
  }
  await db.execute(sql`UPDATE yt_fb_settings SET enabled = false, updated_at = now() WHERE id = 1`);
  return { ok: true as const, baselines: [] };
}

// ── الجديد غير المرفوع (لجهاز التنزيل) ──────────────────────────────────────────────────────────
export type PendingVideo = { videoId: string; channelId: string; pageId: string; title: string; youtubeUrl: string; publishedAt: string };

export async function listPendingVideos(): Promise<{ enabled: boolean; videos: PendingVideo[]; problems: Array<{ channelId: string; message: string }> }> {
  const settings = await getCrosspostSettings();
  await db.execute(sql`UPDATE yt_fb_settings SET last_machine_poll_at = now() WHERE id = 1`);
  if (!settings.enabled) return { enabled: false, videos: [], problems: [] };
  await syncMappings();
  const channels = rowsOf(await db.execute(sql`SELECT channel_id, fb_page_id, baseline_video_id, baseline_published_at FROM yt_fb_channels WHERE status = 'mapped'`));
  const done = rowsOf(await db.execute(sql`
    SELECT video_id FROM yt_fb_uploads
    WHERE status = 'uploaded' OR (status = 'failed' AND attempts >= ${MAX_ATTEMPTS})
      OR (status = 'uploading' AND started_at > now() - make_interval(mins => ${STALE_UPLOAD_MINUTES}))`));
  const skip = new Set(done.map((r) => String(r.video_id)));
  const videos: PendingVideo[] = [];
  const problems: Array<{ channelId: string; message: string }> = [];
  for (const channel of channels) {
    // قناة صارت مربوطة بعد التفعيل: خط أساس الآن، ولا شيء قديم.
    if (!channel.baseline_published_at) {
      try { await setBaseline(String(channel.channel_id)); } catch (err) { problems.push({ channelId: String(channel.channel_id), message: (err as Error).message }); }
      continue;
    }
    try {
      const baselineAt = new Date(channel.baseline_published_at).getTime();
      for (const video of await latestVideos(String(channel.channel_id))) {
        if (video.videoId === channel.baseline_video_id || new Date(video.publishedAt).getTime() <= baselineAt) continue;
        if (video.live !== "none" || skip.has(video.videoId)) continue;
        videos.push({ videoId: video.videoId, channelId: String(channel.channel_id), pageId: String(channel.fb_page_id), title: video.title, youtubeUrl: `https://www.youtube.com/watch?v=${video.videoId}`, publishedAt: video.publishedAt });
      }
    } catch (err) {
      problems.push({ channelId: String(channel.channel_id), message: (err as Error).message });
    }
  }
  videos.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return { enabled: true, videos, problems };
}

// ── الرفع (من جهاز التنزيل): تحقّق كامل على الخادم، حجز ذري ضد التكرار، ثم الرفع والتسجيل ───────────
export type ClaimResult =
  | { ok: true; uploadId: number; channelId: string; pageId: string; pageName: string; title: string }
  | { ok: false; status: number; message: string };

export async function claimUpload(videoId: string): Promise<ClaimResult> {
  const settings = await getCrosspostSettings();
  if (!settings.enabled) return { ok: false, status: 423, message: "الرفع التلقائي معطّل (مفتاح التشغيل)" };
  if (!/^[\w-]{11}$/.test(videoId)) return { ok: false, status: 400, message: "videoId غير صالح" };
  const [details] = await videoDetails([videoId]).catch(() => []);
  if (!details) return { ok: false, status: 404, message: "لم يُعثر على الفيديو في يوتيوب" };
  if (details.live !== "none") return { ok: false, status: 409, message: "بث مباشر/مجدول — لا يُرفع" };
  const [channel] = rowsOf(await db.execute(sql`SELECT channel_id, fb_page_id, fb_page_name, status, baseline_video_id, baseline_published_at FROM yt_fb_channels WHERE channel_id = ${details.channelId}`));
  if (!channel || channel.status !== "mapped") return { ok: false, status: 409, message: "قناة الفيديو غير مربوطة بصفحة فيسبوك" };
  if (!channel.baseline_published_at || details.videoId === channel.baseline_video_id || new Date(details.publishedAt).getTime() <= new Date(channel.baseline_published_at).getTime()) {
    return { ok: false, status: 409, message: "الفيديو أقدم من خط الأساس — الجديد فقط" };
  }
  const [claimed] = rowsOf(await db.execute(sql`
    INSERT INTO yt_fb_uploads (video_id, channel_id, fb_page_id, title, status, attempts, started_at)
    VALUES (${videoId}, ${details.channelId}, ${channel.fb_page_id}, ${details.title}, 'uploading', 1, now())
    ON CONFLICT (video_id) DO UPDATE SET status = 'uploading', attempts = yt_fb_uploads.attempts + 1, started_at = now(), error = NULL,
      title = EXCLUDED.title, fb_page_id = EXCLUDED.fb_page_id
    WHERE (yt_fb_uploads.status = 'failed' AND yt_fb_uploads.attempts < ${MAX_ATTEMPTS})
      OR (yt_fb_uploads.status = 'uploading' AND yt_fb_uploads.started_at < now() - make_interval(mins => ${STALE_UPLOAD_MINUTES}))
    RETURNING id`));
  if (!claimed) return { ok: false, status: 409, message: "رُفع هذا الفيديو من قبل (أو يُرفع الآن، أو استنفد المحاولات)" };
  return { ok: true, uploadId: Number(claimed.id), channelId: details.channelId, pageId: String(channel.fb_page_id), pageName: String(channel.fb_page_name), title: details.title };
}

export async function performUpload(claim: Extract<ClaimResult, { ok: true }>, filePath: string, fileSize: number) {
  const fail = async (message: string) => {
    await db.execute(sql`UPDATE yt_fb_uploads SET status = 'failed', error = ${message}, file_size = ${fileSize} WHERE id = ${claim.uploadId}`);
    return { ok: false as const, message };
  };
  if (fileSize < 1024) return fail("لم يصل ملف الفيديو");
  const config = getFacebookConfig();
  if (!config) return fail("متغيرات فيسبوك غير مضبوطة على الخادم");
  const [page] = rowsOf(await db.execute(sql`SELECT access_token_encrypted, status FROM facebook_pages WHERE fb_page_id = ${claim.pageId}`));
  const token = decryptToken(page?.access_token_encrypted, config.appSecret);
  if (!token || page?.status !== "connected") return fail("رمز صفحة فيسبوك غير متاح — أعد «ربط فيسبوك»");
  const result = await uploadFacebookVideo({ pageId: claim.pageId, token, filePath, fileSize, title: claim.title, published: true });
  if (!result.ok) return fail(`[${result.stage}] ${result.message}${result.metaError ? ` — ${JSON.stringify(result.metaError)}` : ""}`);
  await db.execute(sql`UPDATE yt_fb_uploads SET status = 'uploaded', fb_video_id = ${result.videoId}, uploaded_at = now(), error = NULL, file_size = ${fileSize} WHERE id = ${claim.uploadId}`);
  return { ok: true as const, fbVideoId: result.videoId };
}

// ── لوحة المدير ─────────────────────────────────────────────────────────────────────────────────
export async function crosspostOverview() {
  const settings = await getCrosspostSettings();
  const mappings = await syncMappings();
  const channels = rowsOf(await db.execute(sql`SELECT channel_id, baseline_video_id, baseline_published_at, baseline_set_at FROM yt_fb_channels`));
  const byId = new Map(channels.map((c) => [String(c.channel_id), c]));
  const recent = rowsOf(await db.execute(sql`
    SELECT u.video_id, u.channel_id, u.fb_page_id, u.title, u.status, u.fb_video_id, u.error, u.attempts, u.file_size, u.started_at, u.uploaded_at, c.display_name, c.fb_page_name
    FROM yt_fb_uploads u LEFT JOIN yt_fb_channels c ON c.channel_id = u.channel_id
    ORDER BY u.started_at DESC LIMIT 50`));
  return {
    enabled: settings.enabled,
    enabledAt: settings.enabledAt,
    lastMachinePollAt: settings.lastMachinePollAt,
    machineKeyConfigured: machineKeyConfigured(),
    channels: mappings.map((m) => ({
      ...m,
      baselineVideoId: byId.get(m.channelId)?.baseline_video_id ?? null,
      baselinePublishedAt: byId.get(m.channelId)?.baseline_published_at ?? null,
      baselineSetAt: byId.get(m.channelId)?.baseline_set_at ?? null,
    })),
    uploads: recent.map((r) => ({
      videoId: String(r.video_id), channelName: r.display_name ?? r.channel_id, pageName: r.fb_page_name ?? r.fb_page_id, title: String(r.title),
      status: String(r.status), fbVideoId: r.fb_video_id ?? null, error: r.error ?? null, attempts: Number(r.attempts), fileSize: r.file_size != null ? Number(r.file_size) : null,
      startedAt: r.started_at, uploadedAt: r.uploaded_at ?? null,
    })),
  };
}

// ── شاهد فيسبوك التكميلي (الخيار «ب») ────────────────────────────────────────────────────────
// كل فيديو رُفع إلى فيسبوك يُرفق رابطه «شاهدًا تكميليًا» على مهمة يوتيوب التي وثّقها نفس الفيديو
// (youtube_videos.matched_task_id). لا يغيّر الحالة ولا العدّاد. ترتيب الحدثين غير مضمون (التوثيق قد
// يسبق الرفع أو يتأخر عنه)، فتُستدعى بعد كل رفع ومع كل استعلام من جهاز التنزيل (~كل 10 دقائق).
export async function attachFacebookProofsToYoutubeTasks(): Promise<number> {
  await ensureCrosspostSchema();
  await ensureYoutubeMonitorSchema();
  const rows = rowsOf(await db.execute(sql`
    SELECT u.id, u.video_id, u.fb_video_id, y.matched_task_id
    FROM yt_fb_uploads u
    JOIN youtube_videos y ON y.video_id = u.video_id
    WHERE u.status = 'uploaded' AND u.fb_video_id IS NOT NULL AND u.proof_attached_at IS NULL
      AND y.status = 'documented' AND y.matched_task_id IS NOT NULL
      AND u.uploaded_at > now() - interval '14 days'
    LIMIT 50`));
  let attached = 0;
  for (const row of rows) {
    const fbUrl = `https://www.facebook.com/${row.fb_video_id}`;
    const taskId = Number(row.matched_task_id);
    // حجز قبل الإرفاق: لا يُرفق نفس الرابط مرتين حتى لو تزامن استدعاءان.
    const claimed = rowsOf(await db.execute(sql`UPDATE yt_fb_uploads SET proof_attached_at = now(), proof_task_id = ${taskId}
      WHERE id = ${row.id} AND proof_attached_at IS NULL RETURNING id`));
    if (claimed.length === 0) continue;
    const added = await addSupplementaryProof({
      taskId,
      proofUrl: fbUrl,
      note: `نسخة فيسبوك لفيديو يوتيوب https://youtu.be/${row.video_id} — رفعها النظام تلقائيًا (شاهد تكميلي لا يغيّر الحالة)`,
      activityUserName: "الرفع التلقائي يوتيوب ← فيسبوك",
      activityAction: "youtube_facebook_proof_linked",
      meta: { videoId: row.video_id, fbVideoId: row.fb_video_id, fbUrl },
    }).catch(() => ({ added: false, createdProofId: null }));
    if (added.added) {
      attached += 1;
      await db.execute(sql`UPDATE yt_fb_uploads SET proof_id = ${added.createdProofId} WHERE id = ${row.id}`);
    } else {
      await db.execute(sql`UPDATE yt_fb_uploads SET proof_attached_at = NULL, proof_task_id = NULL WHERE id = ${row.id}`);
    }
  }
  return attached;
}
