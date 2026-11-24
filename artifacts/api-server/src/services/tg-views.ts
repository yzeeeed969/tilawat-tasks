// متابعة مشاهدات مقطع نُشر في عدة صفحات (الإصدار 86، قرار المدير 2026-11-24: «أ، أ — أعتمد»):
//  • زر «📊 تابع المشاهدات 7 أيام» تحت تقرير النشر الجماعي.
//  • كل يوم الساعة 9 مساءً بتوقيت الرياض: مشاهدات كل صفحة + الإجمالي + زيادة اليوم، ثم نص جاهز لتويتر.
//  • اليوم السابع: تقرير ختامي، وتنتهي المتابعة.
// القراءة فقط من واجهة ميتا الرسمية (video_insights) برمز الصفحة المحفوظ — لا نشر ولا تعديل.
// الرسائل تُرسل عبر البوت «رفع فيسبوك»: الخادم يضعها في صندوق صادر، وخدمة tg-bridge تأخذها كل دقيقة.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getFacebookConfig } from "./facebook-client";
import { decryptToken } from "../lib/instagram-token-crypto";
import { ensureTgCrosspostSchema } from "./tg-crosspost";

const GRAPH = "https://graph.facebook.com/v25.0";
const DAYS = 7;
const REPORT_HOUR = 21; // 9 مساءً بتوقيت الرياض
// ترتيب المقاييس: الريلز أولًا (فيسبوك يصنّف الفيديوهات الجديدة ريلز)، ثم مشاهدات الفيديو العادي.
const METRICS = ["fb_reels_total_plays", "blue_reels_play_count", "total_video_views"] as const;

type Button = { text: string; callback_data: string };

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let ready: Promise<void> | null = null;
export function ensureViewsSchema() {
  if (!ready) {
    ready = (async () => {
      await ensureTgCrosspostSchema();
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_tracks (
          id serial PRIMARY KEY,
          broadcast_id integer NOT NULL UNIQUE,
          chat_id text NOT NULL,
          name text NOT NULL,
          status text NOT NULL DEFAULT 'active',
          reports_sent integer NOT NULL DEFAULT 0,
          last_report_date text,
          last_total bigint NOT NULL DEFAULT 0,
          last_views jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_track_snapshots (
          id serial PRIMARY KEY,
          track_id integer NOT NULL,
          day_no integer NOT NULL,
          fb_video_id text NOT NULL,
          page_name text,
          views bigint,
          metric text,
          error text,
          taken_at timestamp NOT NULL DEFAULT now(),
          UNIQUE (track_id, day_no, fb_video_id)
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_outbox (
          id serial PRIMARY KEY,
          chat_id text NOT NULL,
          text text NOT NULL,
          keyboard jsonb,
          created_at timestamp NOT NULL DEFAULT now(),
          sent_at timestamp
        )`);
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

// ── صندوق الرسائل الصادرة (تأخذه خدمة tg-bridge) ─────────────────────────────────────────────
export async function queueMessage(chatId: string, text: string, keyboard: Button[][] | null = null) {
  await ensureViewsSchema();
  await db.execute(sql`INSERT INTO tg_fb_outbox (chat_id, text, keyboard) VALUES (${chatId}, ${text}, ${keyboard ? JSON.stringify(keyboard) : null}::jsonb)`);
}
export async function takeOutbox() {
  await ensureViewsSchema();
  const rows = rowsOf(await db.execute(sql`
    UPDATE tg_fb_outbox SET sent_at = now() WHERE id IN (SELECT id FROM tg_fb_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
    RETURNING id, chat_id, text, keyboard`));
  return { messages: rows.sort((a, b) => a.id - b.id).map((r) => ({ chatId: String(r.chat_id), text: String(r.text), keyboard: r.keyboard ?? null })) };
}

// ── اسم الإصدار: أول سطر، ويُضم إليه السطر الثاني إن بدأ بـ«من» (مثل «… من اختيارات السمّيعة») ─────
export function releaseNameOf(caption: string): string {
  const clean = (l: string) => l.replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s+/g, " ").trim();
  const lines = caption.split(/\r?\n/).map(clean).filter(Boolean);
  if (lines.length === 0) return "المقطع";
  const name = lines[1]?.startsWith("من ") ? `${lines[0]} ${lines[1]}` : lines[0];
  return name.length > 120 ? name.slice(0, 120).trim() + "…" : name;
}

// ── قراءة مشاهدات فيديو واحد ────────────────────────────────────────────────────────────────
export async function pageToken(fbPageId: string): Promise<string | null> {
  const config = getFacebookConfig();
  if (!config) return null;
  const [p] = rowsOf(await db.execute(sql`SELECT access_token_encrypted, status FROM facebook_pages WHERE fb_page_id = ${fbPageId}`));
  if (!p || p.status !== "connected") return null;
  return decryptToken(p.access_token_encrypted, config.appSecret) || null;
}

// كل مقياس في طلب مستقل: المقياس الملغى عند ميتا لا يُفشل البقية.
export async function rawVideoMetrics(videoId: string, token: string) {
  const out: Record<string, number | string> = {};
  for (const m of METRICS) {
    try {
      const res = await fetch(`${GRAPH}/${encodeURIComponent(videoId)}/video_insights?metric=${m}&access_token=${encodeURIComponent(token)}`);
      const body: any = await res.json().catch(() => ({}));
      if (body?.error) { out[m] = `خطأ: ${String(body.error.message ?? body.error.code).slice(0, 150)}`; continue; }
      const v = body?.data?.[0]?.values?.[0]?.value;
      out[m] = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : "لا قيمة";
    } catch (e) {
      out[m] = `خطأ: ${(e as Error).message}`;
    }
  }
  return out;
}

async function videoViews(videoId: string, fbPageId: string): Promise<{ views: number; metric: string } | { error: string }> {
  const token = await pageToken(fbPageId);
  if (!token) return { error: "رمز الصفحة غير متاح — أعد «ربط فيسبوك»" };
  const raw = await rawVideoMetrics(videoId, token);
  for (const m of METRICS) if (typeof raw[m] === "number") return { views: raw[m] as number, metric: m };
  return { error: String(Object.values(raw)[0] ?? "تعذّرت القراءة").slice(0, 200) };
}

// ── بدء المتابعة ────────────────────────────────────────────────────────────────────────────
export async function startTracking(broadcastId: number, chatId: string | null, name?: string | null) {
  await ensureViewsSchema();
  const [b] = rowsOf(await db.execute(sql`SELECT id, chat_id, caption FROM tg_fb_broadcasts WHERE id = ${broadcastId}`));
  if (!b) return { ok: false, message: "لا يوجد نشر بهذا الرقم" };
  if (chatId && String(b.chat_id) !== chatId) return { ok: false, message: "غير مسموح" };
  const [{ n }] = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM tg_fb_broadcast_items WHERE broadcast_id = ${broadcastId} AND status = 'uploaded' AND fb_video_id IS NOT NULL`));
  if (!n) return { ok: false, message: "لم يُنشر المقطع في أي صفحة بعد" };
  const finalName = (name ?? "").trim() || releaseNameOf(String(b.caption));
  const [row] = rowsOf(await db.execute(sql`
    INSERT INTO tg_fb_tracks (broadcast_id, chat_id, name) VALUES (${broadcastId}, ${String(b.chat_id)}, ${finalName})
    ON CONFLICT (broadcast_id) DO NOTHING RETURNING id`));
  if (!row) return { ok: false, message: "هذا المقطع تحت المتابعة سابقًا" };
  await queueMessage(String(b.chat_id), [
    "📊 بدأت متابعة المشاهدات لمدة 7 أيام",
    `الإصدار: ${finalName}`,
    `عدد الصفحات: ${n}`,
    "يصلك التقرير كل يوم الساعة 9 مساءً بتوقيت الرياض، ومعه نص جاهز لتويتر.",
  ].join("\n"));
  return { ok: true, trackId: Number(row.id), name: finalName, pages: n };
}

export async function renameTrack(trackId: number, name: string) {
  await ensureViewsSchema();
  const rows = rowsOf(await db.execute(sql`UPDATE tg_fb_tracks SET name = ${name.trim()} WHERE id = ${trackId} RETURNING id`));
  return { ok: rows.length > 0 };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const plus = (n: number) => (n >= 0 ? `+${fmt(n)}` : fmt(n));

// يبني تقرير يوم (ويحفظه إن save=true). يُستخدم أيضًا للمعاينة دون حفظ.
export async function buildDailyReport(trackId: number, save: boolean) {
  await ensureViewsSchema();
  const [t] = rowsOf(await db.execute(sql`SELECT * FROM tg_fb_tracks WHERE id = ${trackId}`));
  if (!t) return { ok: false as const, message: "لا توجد متابعة بهذا الرقم" };
  const dayNo = Number(t.reports_sent) + 1;
  const items = rowsOf(await db.execute(sql`
    SELECT fb_page_id, fb_page_name, fb_video_id FROM tg_fb_broadcast_items
    WHERE broadcast_id = ${t.broadcast_id} AND status = 'uploaded' AND fb_video_id IS NOT NULL ORDER BY position`));
  const lastViews: Record<string, number> = t.last_views ?? {};
  const lines: string[] = [];
  const errors: string[] = [];
  const nowViews: Record<string, number> = {};
  let total = 0;
  let best: { name: string; views: number } | null = null;
  for (const it of items) {
    const vid = String(it.fb_video_id);
    const r = await videoViews(vid, String(it.fb_page_id));
    if ("error" in r) {
      errors.push(`⚠️ ${it.fb_page_name}: تعذّرت القراءة (${r.error})`);
      // نحتفظ بآخر رقم معروف حتى لا يظهر نقص وهمي في الإجمالي.
      if (typeof lastViews[vid] === "number") { nowViews[vid] = lastViews[vid]; total += lastViews[vid]; }
    } else {
      nowViews[vid] = r.views;
      total += r.views;
      const inc = r.views - (lastViews[vid] ?? 0);
      lines.push(`• ${it.fb_page_name}: ${fmt(r.views)} (${plus(inc)})`);
      if (!best || r.views > best.views) best = { name: String(it.fb_page_name), views: r.views };
    }
    if (save) {
      await db.execute(sql`
        INSERT INTO tg_fb_track_snapshots (track_id, day_no, fb_video_id, page_name, views, metric, error)
        VALUES (${trackId}, ${dayNo}, ${vid}, ${it.fb_page_name}, ${"error" in r ? null : r.views}, ${"error" in r ? null : r.metric}, ${"error" in r ? r.error : null})
        ON CONFLICT (track_id, day_no, fb_video_id) DO NOTHING`);
    }
  }
  if (save && items.length > 0 && lines.length === 0) {
    // كل الصفحات تعذّرت قراءتها: لا يُحسب يومًا من السبعة، ويُعاد غدًا.
    await queueMessage(String(t.chat_id), [`⚠️ تعذّرت قراءة مشاهدات «${t.name}» اليوم من كل الصفحات، فلم يُحسب يومًا من السبعة وسأعيد المحاولة غدًا.`, ...errors].join("\n"));
    return { ok: false as const, message: "تعذّرت القراءة من كل الصفحات" };
  }
  const increase = total - Number(t.last_total ?? 0);
  const final = dayNo >= DAYS;
  const text = [
    final ? `🏁 التقرير الختامي — اليوم ${dayNo} من ${DAYS}` : `📊 متابعة المشاهدات — اليوم ${dayNo} من ${DAYS}`,
    `الإصدار: ${t.name}`,
    "",
    ...lines,
    ...errors,
    "",
    `👁 الإجمالي: ${fmt(total)}`,
    `📈 زيادة اليوم: ${plus(increase)}`,
    ...(final ? ["", `انتهت المتابعة. المجموع بعد ${DAYS} أيام: ${fmt(total)}${best ? `، وأعلى صفحة: ${best.name} (${fmt(best.views)})` : ""}.`] : []),
    "",
    "— نص جاهز لتويتر —",
  ].join("\n");
  const tweet = [
    `📊 تقرير اليوم ${dayNo} من ${DAYS}`,
    `إصدار «${t.name}»`,
    "",
    `👁 المشاهدات: ${fmt(total)}`,
    `📈 زيادة اليوم: ${fmt(Math.max(0, increase))}`,
    "",
    "جزاكم الله خيرًا يا كرام 🤍",
  ].join("\n");
  if (save) {
    await db.execute(sql`
      UPDATE tg_fb_tracks SET reports_sent = ${dayNo}, last_report_date = ${riyadhDate()}, last_total = ${total}, last_views = ${JSON.stringify(nowViews)}::jsonb,
        status = ${final ? "done" : "active"} WHERE id = ${trackId}`);
    await queueMessage(String(t.chat_id), text);
    await queueMessage(String(t.chat_id), tweet); // رسالة مستقلة لسهولة النسخ
  }
  return { ok: true as const, dayNo, total, increase, text, tweet };
}

function riyadhParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const riyadhDate = () => riyadhParts().date;

// كل دقيقة: إن جاءت الساعة 9 مساءً ولم يُرسل تقرير اليوم لمتابعة نشطة ← يُرسل.
export async function viewsTick() {
  await ensureViewsSchema();
  const { date, hour } = riyadhParts();
  if (hour < REPORT_HOUR) return;
  const due = rowsOf(await db.execute(sql`SELECT id FROM tg_fb_tracks WHERE status = 'active' AND (last_report_date IS NULL OR last_report_date <> ${date}) ORDER BY id`));
  for (const t of due) {
    // حجز اليوم أولًا حتى لا يُرسل التقرير مرتين.
    const claimed = rowsOf(await db.execute(sql`UPDATE tg_fb_tracks SET last_report_date = ${date} WHERE id = ${t.id} AND (last_report_date IS NULL OR last_report_date <> ${date}) RETURNING id`));
    if (claimed.length) await buildDailyReport(Number(t.id), true);
  }
}

export function startViewsScheduler(logger?: { warn: (...a: any[]) => void }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await viewsTick(); } catch (err) { logger?.warn({ err }, "FB views tracking tick failed"); } finally { running = false; }
  };
  setTimeout(tick, 45_000).unref();
  setInterval(tick, 60_000).unref();
}

// ── للمدير: قائمة النشر الجماعي والمتابعات + اختبار قراءة المشاهدات ─────────────────────────────
export async function broadcastsOverview() {
  await ensureViewsSchema();
  const broadcasts = rowsOf(await db.execute(sql`SELECT id, chat_id, left(caption, 200) AS caption, status, created_at, finished_at FROM tg_fb_broadcasts ORDER BY id DESC LIMIT 20`));
  const items = rowsOf(await db.execute(sql`SELECT broadcast_id, fb_page_name, status, reason, fb_video_id, attempts FROM tg_fb_broadcast_items WHERE broadcast_id IN (SELECT id FROM tg_fb_broadcasts ORDER BY id DESC LIMIT 20) ORDER BY broadcast_id, position`));
  const tracks = rowsOf(await db.execute(sql`SELECT id, broadcast_id, name, status, reports_sent, last_report_date, last_total FROM tg_fb_tracks ORDER BY id DESC`));
  return { broadcasts: broadcasts.map((b) => ({ ...b, items: items.filter((i) => i.broadcast_id === b.id) })), tracks };
}

export async function testBroadcastViews(broadcastId: number) {
  await ensureViewsSchema();
  const items = rowsOf(await db.execute(sql`SELECT fb_page_id, fb_page_name, fb_video_id FROM tg_fb_broadcast_items WHERE broadcast_id = ${broadcastId} AND fb_video_id IS NOT NULL ORDER BY position`));
  const out = [];
  for (const it of items) {
    const token = await pageToken(String(it.fb_page_id));
    out.push({ page: it.fb_page_name, videoId: it.fb_video_id, metrics: token ? await rawVideoMetrics(String(it.fb_video_id), token) : "لا رمز" });
  }
  return out;
}

export async function uploadVideoRef(uploadId: number): Promise<{ fb_page_id: string; fb_video_id: string } | null> {
  const [row] = rowsOf(await db.execute(sql`SELECT fb_page_id, fb_video_id FROM tg_fb_uploads WHERE id = ${uploadId} AND fb_video_id IS NOT NULL`));
  return row ? { fb_page_id: String(row.fb_page_id), fb_video_id: String(row.fb_video_id) } : null;
}
