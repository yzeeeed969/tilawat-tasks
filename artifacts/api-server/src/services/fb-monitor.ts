// مراقبة فيسبوك (الإصدار 90 — المرحلة 1 من «توثيق كل ما يُنشر»، اعتمدها المدير 2026-11-25).
// كل 15 دقيقة: قراءة آخر منشورات كل صفحة فيسبوك مربوطة (قراءة فقط) وتسجيلها في «سجل النشر»:
// الصفحة، الوقت، الرابط، النوع، ومصدر النشر من حقل admin_creator:
//   • تطبيقنا (البوت) ← bot   • «Instagram» ← instagram (منقول تلقائيًا من إنستقرام)   • فارغ ← manual (نشره شخص بيده)
// فيسبوك لا يذكر اسم الشخص (جُرّب 2026-11-25)، فنسبة المنشور لعضو تأتي في المرحلة التالية (رسائل التأكيد).
// المطابقة: مهمة فيسبوك معلّقة لنفس القارئ ونفس اليوم (بتوقيت الرياض) — مهمة واحدة فقط، وإلا لا تخمين.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getFacebookConfig } from "./facebook-client";
import { decryptToken } from "../lib/instagram-token-crypto";
import { ensureInstagramSchema } from "./instagram-schema";
import { documentTaskAutomatically } from "./auto-documentation";

const GRAPH = "https://graph.facebook.com/v25.0";
const BACKFILL_DAYS = 3;
const POLL_MINUTES = 15;

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let ready: Promise<void> | null = null;
export function ensureFbMonitorSchema() {
  if (!ready) {
    ready = (async () => {
      await ensureInstagramSchema();
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS fb_page_posts (
          id serial PRIMARY KEY,
          post_id text NOT NULL UNIQUE,
          fb_page_id text NOT NULL,
          page_name text,
          reciter_id integer,
          created_time timestamp NOT NULL,
          riyadh_day text NOT NULL,
          kind text,
          source text NOT NULL,
          source_app text,
          message text,
          permalink text,
          task_id integer,
          match_note text,
          claimed_member_id integer,
          discovered_at timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fb_page_posts_time ON fb_page_posts(created_time DESC)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS fb_monitor_state (fb_page_id text PRIMARY KEY, last_checked_at timestamp, last_error text)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const riyadhDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function kindOf(statusType: string | undefined): string {
  switch (statusType) {
    case "added_video": return "video";
    case "added_photos": return "photo";
    case "shared_story": return "link";
    case "mobile_status_update": case "created_note": return "text";
    default: return statusType ?? "other";
  }
}
function sourceOf(adminCreator: any, appId: string | undefined): { source: string; app: string | null } {
  if (!adminCreator) return { source: "manual", app: null };
  const name = String(adminCreator.name ?? "");
  if ((appId && String(adminCreator.id) === appId) || /quran views/i.test(name)) return { source: "bot", app: name };
  if (/instagram/i.test(name)) return { source: "instagram", app: name };
  return { source: "other", app: name || String(adminCreator.id ?? "") };
}

// القارئ المرتبط بصفحة فيسبوك (عكس ربط البوت): التخصيص اليدوي أولًا، ثم حساب إنستقرام المرتبط بالصفحة.
async function reciterOfPage(fbPageId: string): Promise<number | null> {
  const over = rowsOf(await db.execute(sql`SELECT reciter_id FROM tg_fb_page_overrides WHERE fb_page_id = ${fbPageId}`).catch(() => []));
  const viaIg = rowsOf(await db.execute(sql`SELECT DISTINCT reciter_id FROM instagram_accounts WHERE fb_page_id = ${fbPageId} AND reciter_id IS NOT NULL`));
  const ids = [...new Set([...over, ...viaIg].map((r) => Number(r.reciter_id)))];
  return ids.length === 1 ? ids[0] : null;
}

async function matchTask(reciterId: number | null, day: string): Promise<{ taskId: number | null; note: string }> {
  if (!reciterId) return { taskId: null, note: "الصفحة غير مرتبطة بقارئ" };
  const cands = rowsOf(await db.execute(sql`
    SELECT t.id FROM tasks t JOIN platforms p ON p.id = t.platform_id
    WHERE t.deleted_at IS NULL AND t.status = 'pending' AND t.reciter_id = ${reciterId}
      AND (p.name ILIKE '%فيسبوك%' OR p.name ILIKE '%facebook%')
      AND to_char(t.due_date, 'YYYY-MM-DD') = ${day}
      AND t.weekly_quota_required IS NULL`));
  if (cands.length === 0) return { taskId: null, note: "بلا مهمة" };
  if (cands.length > 1) return { taskId: null, note: `أكثر من مهمة مطابقة (${cands.length}) — لا تخمين` };
  return { taskId: Number(cands[0].id), note: "مطابقة" };
}

export async function pollFacebookPages(opts: { backfillDays?: number } = {}) {
  await ensureFbMonitorSchema();
  const config = getFacebookConfig();
  if (!config) return { ok: false, message: "متغيرات فيسبوك غير مضبوطة" };
  const pages = rowsOf(await db.execute(sql`SELECT fb_page_id, name, access_token_encrypted FROM facebook_pages WHERE status = 'connected'`));
  const summary: Array<{ page: string; fetched: number; added: number; documented: number; error?: string }> = [];
  for (const p of pages) {
    const pageId = String(p.fb_page_id);
    const token = decryptToken(p.access_token_encrypted, config.appSecret);
    if (!token) { summary.push({ page: p.name, fetched: 0, added: 0, documented: 0, error: "لا رمز" }); continue; }
    const [state] = rowsOf(await db.execute(sql`SELECT last_checked_at FROM fb_monitor_state WHERE fb_page_id = ${pageId}`));
    // من آخر فحص ناقص ساعتين (هامش)، أو أيام البداية في أول مرة.
    const sinceMs = state?.last_checked_at && !opts.backfillDays
      ? new Date(state.last_checked_at).getTime() - 2 * 3600_000
      : Date.now() - (opts.backfillDays ?? BACKFILL_DAYS) * 86400_000;
    const reciterId = await reciterOfPage(pageId);
    let fetched = 0, added = 0, documented = 0;
    try {
      let url: string | null = `${GRAPH}/${pageId}/posts?fields=id,created_time,admin_creator,status_type,permalink_url,message&limit=50&since=${Math.floor(sinceMs / 1000)}&access_token=${encodeURIComponent(token)}`;
      for (let guard = 0; url && guard < 10; guard++) {
        const res: Response = await fetch(url);
        const body: any = await res.json().catch(() => ({}));
        if (body?.error) throw new Error(String(body.error.message ?? body.error.code));
        for (const post of body?.data ?? []) {
          fetched++;
          const created = new Date(post.created_time);
          const day = riyadhDay(created);
          const src = sourceOf(post.admin_creator, config.appId);
          const exists = rowsOf(await db.execute(sql`SELECT id FROM fb_page_posts WHERE post_id = ${String(post.id)}`));
          if (exists.length) continue;
          const m = await matchTask(reciterId, day);
          const [row] = rowsOf(await db.execute(sql`
            INSERT INTO fb_page_posts (post_id, fb_page_id, page_name, reciter_id, created_time, riyadh_day, kind, source, source_app, message, permalink, task_id, match_note)
            VALUES (${String(post.id)}, ${pageId}, ${p.name}, ${reciterId}, ${created.toISOString()}, ${day}, ${kindOf(post.status_type)}, ${src.source}, ${src.app},
                    ${post.message ? String(post.message).slice(0, 2000) : null}, ${post.permalink_url ?? null}, ${m.taskId}, ${m.note})
            ON CONFLICT (post_id) DO NOTHING RETURNING id`));
          if (!row) continue;
          added++;
          if (m.taskId && post.permalink_url) {
            const r = await documentTaskAutomatically({
              taskId: m.taskId, proofUrl: String(post.permalink_url), publishedAt: created,
              note: "توثيق تلقائي من مراقبة فيسبوك", activityUserName: "مراقبة فيسبوك", activityAction: "توثيق تلقائي (فيسبوك)",
              meta: { fbPostId: String(post.id), source: src.source },
            }).catch((e) => ({ documented: false, reason: (e as Error).message }));
            if (r.documented) documented++;
            else await db.execute(sql`UPDATE fb_page_posts SET match_note = ${`لم يُوثَّق: ${String((r as any).reason ?? "")}`.slice(0, 300)} WHERE id = ${row.id}`);
          }
        }
        url = body?.paging?.next ?? null;
      }
      await db.execute(sql`INSERT INTO fb_monitor_state (fb_page_id, last_checked_at, last_error) VALUES (${pageId}, now(), NULL)
        ON CONFLICT (fb_page_id) DO UPDATE SET last_checked_at = now(), last_error = NULL`);
      summary.push({ page: p.name, fetched, added, documented });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await db.execute(sql`INSERT INTO fb_monitor_state (fb_page_id, last_error) VALUES (${pageId}, ${msg})
        ON CONFLICT (fb_page_id) DO UPDATE SET last_error = ${msg}`);
      summary.push({ page: p.name, fetched, added, documented, error: msg });
    }
  }
  return { ok: true, summary };
}

export function startFbMonitorScheduler(logger?: { warn: (...a: any[]) => void }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollFacebookPages(); } catch (err) { logger?.warn({ err }, "FB monitor tick failed"); } finally { running = false; }
  };
  setTimeout(tick, 90_000).unref();
  setInterval(tick, POLL_MINUTES * 60_000).unref();
}

// ── للمدير: سجل النشر ──
export async function fbPostsLog(filter: { source?: string; unmatched?: boolean; days?: number }) {
  await ensureFbMonitorSchema();
  const days = Math.min(60, Math.max(1, filter.days ?? 7));
  const rows = rowsOf(await db.execute(sql`
    SELECT f.id, f.post_id, f.page_name, f.created_time, f.riyadh_day, f.kind, f.source, f.source_app, left(f.message, 200) AS message,
           f.permalink, f.task_id, f.match_note, t.title AS task_title
    FROM fb_page_posts f LEFT JOIN tasks t ON t.id = f.task_id
    WHERE f.created_time > now() - make_interval(days => ${days})
      AND (${filter.source ?? null}::text IS NULL OR f.source = ${filter.source ?? null})
      AND (${filter.unmatched ? 1 : 0} = 0 OR f.task_id IS NULL)
    ORDER BY f.created_time DESC LIMIT 500`));
  const state = rowsOf(await db.execute(sql`
    SELECT s.fb_page_id, fp.name, s.last_checked_at, s.last_error FROM fb_monitor_state s LEFT JOIN facebook_pages fp ON fp.fb_page_id = s.fb_page_id ORDER BY fp.name`));
  return { posts: rows, pages: state };
}
