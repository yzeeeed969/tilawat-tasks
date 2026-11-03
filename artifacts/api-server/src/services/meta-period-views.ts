// مشاهدات فيسبوك وإنستقرام لمدة يختارها المدير (الإصدار 77) — للتقارير الشهرية والسنوية.
// قراءة فقط من حسابات Meta المربوطة بالموقع أصلًا (نفس المفاتيح وصلاحيات القراءة المستخدمة في صفحة المنصات):
// إنستقرام: insights views (total_value) بنوافذ 30 يومًا. فيسبوك: page_video_views اليومية بنوافذ 30 يومًا.
// لا نشر ولا تعديل على أي حساب. أي نافذة ترفضها Meta تُذكر في problems ولا يُخترع رقم بدلها.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { getInstagramConfig } from "./instagram-client";
import { getFacebookConfig } from "./facebook-client";
import { decryptToken } from "../lib/instagram-token-crypto";

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

const DAY = 24 * 60 * 60;
const WINDOW_DAYS = 30;

async function getJson(url: string) {
  const res = await fetch(url);
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(String(body?.error?.message ?? body?.error_message ?? `HTTP ${res.status}`));
  return body;
}
const igGet = (path: string, params: Record<string, string>) => getJson(`https://graph.instagram.com/v25.0/${path}?${new URLSearchParams(params).toString()}`);
const fbGet = (path: string, params: Record<string, string>) =>
  getJson(path.startsWith("https://") ? path : `https://graph.facebook.com/v25.0/${path}?${new URLSearchParams(params).toString()}`);

// بداية اليوم بتوقيت الرياض (UTC+3) بالثواني.
function riyadhDayStart(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00+03:00`) / 1000);
}

function windowsOf(since: number, until: number) {
  const list: Array<{ since: number; until: number }> = [];
  for (let s = since; s < until; s += WINDOW_DAYS * DAY) list.push({ since: s, until: Math.min(s + WINDOW_DAYS * DAY, until) });
  return list;
}

function totalValue(body: any): number | null {
  const metric = Array.isArray(body?.data) ? body.data[0] : null;
  const raw = metric?.total_value?.value ?? (Array.isArray(metric?.values) ? metric.values.reduce((s: number, v: any) => s + (Number(v?.value) || 0), 0) : null);
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export type MetaAccountViews = {
  name: string; id: string; views: number | null; windowsOk: number; windowsTotal: number;
  posts: number | null; problems: string[];
};

async function instagramAccounts(since: number, until: number): Promise<MetaAccountViews[]> {
  const config = getInstagramConfig();
  if (!config) return [];
  await ensureInstagramSchema();
  const accounts = rowsOf(await db.execute(sql`
    SELECT a.username, a.access_token_encrypted, r.name AS reciter_name
    FROM instagram_accounts a JOIN reciters r ON r.id = a.reciter_id
    WHERE a.enabled AND a.status = 'connected' AND a.access_token_encrypted IS NOT NULL ORDER BY a.id`));
  return Promise.all(accounts.map(async (account): Promise<MetaAccountViews> => {
    const out: MetaAccountViews = { name: String(account.reciter_name), id: String(account.username ?? ""), views: null, windowsOk: 0, windowsTotal: 0, posts: null, problems: [] };
    const token = decryptToken(account.access_token_encrypted, config.appSecret);
    if (!token) { out.problems.push("تعذّر قراءة مفتاح الحساب"); return out; }
    const windows = windowsOf(since, until);
    out.windowsTotal = windows.length;
    let sum = 0;
    for (const w of windows) {
      try {
        const v = totalValue(await igGet("me/insights", { metric: "views", period: "day", metric_type: "total_value", since: String(w.since), until: String(w.until), access_token: token }));
        if (v == null) { out.problems.push(`نافذة ${new Date(w.since * 1000).toISOString().slice(0, 10)}: بلا رقم`); continue; }
        sum += v; out.windowsOk += 1;
      } catch (err) {
        out.problems.push(`نافذة ${new Date(w.since * 1000).toISOString().slice(0, 10)}: ${(err as Error).message.slice(0, 140)}`);
      }
    }
    if (out.windowsOk > 0) out.views = sum;
    // عدد منشورات المدة (الريلز والمنشورات، بلا القصص).
    try {
      let count = 0;
      let body = await igGet("me/media", { fields: "id,timestamp,media_product_type", limit: "100", access_token: token });
      for (let guard = 0; guard < 40; guard += 1) {
        let reachedOld = false;
        for (const item of Array.isArray(body?.data) ? body.data : []) {
          const at = Date.parse(item?.timestamp ?? "") / 1000;
          if (!Number.isFinite(at)) continue;
          if (at < since) { reachedOld = true; continue; }
          if (at >= until || String(item.media_product_type ?? "").toUpperCase() === "STORY") continue;
          count += 1;
        }
        const next = body?.paging?.next;
        if (reachedOld || !next) break;
        body = await getJson(String(next));
      }
      out.posts = count;
    } catch (err) {
      out.problems.push(`عدد المنشورات: ${(err as Error).message.slice(0, 140)}`);
    }
    return out;
  }));
}

const FB_VIEW_METRICS = ["page_video_views", "page_media_view"];

async function facebookPages(since: number, until: number): Promise<MetaAccountViews[]> {
  const config = getFacebookConfig();
  if (!config) return [];
  await ensureInstagramSchema();
  // صفحات المشايخ فقط: المربوطة بحساب إنستقرام أو بالرفع التلقائي من يوتيوب.
  const pages = rowsOf(await db.execute(sql`
    SELECT DISTINCT ON (fp.fb_page_id) fp.fb_page_id, fp.name, fp.access_token_encrypted
    FROM facebook_pages fp
    WHERE fp.status = 'connected' AND fp.access_token_encrypted IS NOT NULL AND (
      fp.fb_page_id IN (SELECT fb_page_id FROM instagram_accounts WHERE fb_page_id IS NOT NULL)
      OR fp.fb_page_id IN (SELECT fb_page_id FROM yt_fb_manual_links)
    )
    ORDER BY fp.fb_page_id`).catch(async () => db.execute(sql`
    SELECT DISTINCT ON (fp.fb_page_id) fp.fb_page_id, fp.name, fp.access_token_encrypted
    FROM facebook_pages fp
    WHERE fp.status = 'connected' AND fp.access_token_encrypted IS NOT NULL
      AND fp.fb_page_id IN (SELECT fb_page_id FROM instagram_accounts WHERE fb_page_id IS NOT NULL)
    ORDER BY fp.fb_page_id`)));
  return Promise.all(pages.map(async (page): Promise<MetaAccountViews> => {
    const out: MetaAccountViews = { name: String(page.name), id: String(page.fb_page_id), views: null, windowsOk: 0, windowsTotal: 0, posts: null, problems: [] };
    const token = decryptToken(page.access_token_encrypted, config.appSecret);
    if (!token) { out.problems.push("تعذّر قراءة مفتاح الصفحة"); return out; }
    const windows = windowsOf(since, until);
    out.windowsTotal = windows.length;
    let sum = 0;
    for (const w of windows) {
      let done = false;
      for (const metric of FB_VIEW_METRICS) {
        try {
          const body = await fbGet(`${page.fb_page_id}/insights`, { metric, period: "day", since: String(w.since), until: String(w.until), access_token: token });
          const row = Array.isArray(body?.data) ? body.data.find((r: any) => r?.name === metric) : null;
          if (!row) continue;
          const values = Array.isArray(row.values) ? row.values : [];
          sum += values.reduce((s: number, v: any) => s + (Number(v?.value) || 0), 0);
          out.windowsOk += 1; done = true;
          break;
        } catch (err) {
          if (metric === FB_VIEW_METRICS[FB_VIEW_METRICS.length - 1]) out.problems.push(`نافذة ${new Date(w.since * 1000).toISOString().slice(0, 10)}: ${(err as Error).message.slice(0, 140)}`);
        }
      }
      if (!done && !out.problems.some((p) => p.includes(new Date(w.since * 1000).toISOString().slice(0, 10)))) {
        out.problems.push(`نافذة ${new Date(w.since * 1000).toISOString().slice(0, 10)}: لم تُرجع Meta مقياس المشاهدات`);
      }
    }
    if (out.windowsOk > 0) out.views = sum;
    // عدد الريلز المنشورة في المدة.
    try {
      let count = 0;
      let body = await fbGet(`${page.fb_page_id}/video_reels`, { fields: "id,created_time", limit: "100", since: String(since), until: String(until), access_token: token });
      for (let guard = 0; guard < 40; guard += 1) {
        for (const row of Array.isArray(body?.data) ? body.data : []) {
          const at = Date.parse(row?.created_time ?? "") / 1000;
          if (Number.isFinite(at) && at >= since && at < until) count += 1;
        }
        const next = body?.paging?.next;
        if (!next) break;
        body = await fbGet(String(next), {});
      }
      out.posts = count;
    } catch (err) {
      out.problems.push(`عدد الريلز: ${(err as Error).message.slice(0, 140)}`);
    }
    return out;
  }));
}

const cache = new Map<string, { at: number; value: any }>();

export async function metaPeriodViews(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("التاريخ بصيغة YYYY-MM-DD");
  const since = riyadhDayStart(from);
  const until = riyadhDayStart(to) + DAY;
  if (!(until > since) || until - since > 400 * DAY) throw new Error("المدة غير صالحة (حتى 400 يوم)");
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  const [instagram, facebook] = await Promise.all([instagramAccounts(since, until), facebookPages(since, until)]);
  const sum = (list: MetaAccountViews[], field: "views" | "posts") => list.reduce((s, a) => s + (a[field] ?? 0), 0);
  const value = {
    from, to, generatedAt: new Date().toISOString(),
    instagram: { totalViews: sum(instagram, "views"), totalPosts: sum(instagram, "posts"), accounts: instagram },
    facebook: { totalViews: sum(facebook, "views"), totalPosts: sum(facebook, "posts"), pages: facebook },
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
