// نشر مقطع واحد في عدة صفحات فيسبوك (الإصدار 83، قرار المدير 2026-11-24):
// المدير يرسل المقطع (مع نصه) إلى البوت «رفع فيسبوك» في محادثته المربوطة، فيعرض البوت قائمة الصفحات المربوطة
// ليختار منها (أو «كل الصفحات»)، ثم يُنشر في المختارة واحدة بعد الأخرى بفاصل 3 دقائق، ويصل تقرير ✅/❌ في النهاية.
//
// القرار هنا في الخادم (قاعدة المشروع): لا يُقبل المقطع إلا من محادثة الاسترجاع المربوطة برمز من الموقع.
// خدمة tg-bridge تنفّذ فقط: ترسل المقطع والضغطات، وتطلب «البند التالي» وتمرّر الملف.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { getFacebookConfig } from "./facebook-client";
import { uploadFacebookVideo } from "./facebook-video-upload";
import { decryptToken } from "../lib/instagram-token-crypto";
import { startTracking } from "./tg-views";
import { broadcastChatIds, ensureTgCrosspostSchema, facebookTitleOf } from "./tg-crosspost";

const GAP_MINUTES = 3; // فاصل بين كل صفحة والتي بعدها (يقلّل اعتبار فيسبوك له تكرارًا مزعجًا)
// الإصدار 87: الصور أيضًا (صورة واحدة في المنشور، فاصل دقيقة، بلا متابعة أرقام — قرار المدير 2026-11-24).
type Kind = "video" | "photo";
const gapOf = (k: Kind) => (k === "photo" ? 1 : GAP_MINUTES);
const nounOf = (k: Kind) => (k === "photo" ? "الصورة" : "المقطع");
const GRAPH = "https://graph.facebook.com/v25.0";
const MAX_ITEM_ATTEMPTS = 2;
const STALE_MINUTES = 70;
const CHOOSE_HOURS = 24; // قائمة الاختيار تنتهي بعد يوم

type Page = { id: string; name: string };
type Button = { text: string; callback_data: string };
export type BroadcastView = { text: string; keyboard: Button[][] | null };

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let ready: Promise<void> | null = null;
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await ensureTgCrosspostSchema();
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_broadcasts (
          id serial PRIMARY KEY,
          chat_id text NOT NULL,
          message_id bigint NOT NULL,
          file_id text NOT NULL,
          caption text NOT NULL,
          width integer, height integer, duration integer, file_size bigint,
          pages jsonb NOT NULL,
          selected jsonb NOT NULL DEFAULT '[]'::jsonb,
          status text NOT NULL DEFAULT 'choosing',
          next_at timestamp,
          reported boolean NOT NULL DEFAULT false,
          created_at timestamp NOT NULL DEFAULT now(),
          finished_at timestamp,
          UNIQUE (chat_id, message_id)
        )`);
      await db.execute(sql`ALTER TABLE tg_fb_broadcasts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'video'`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_broadcast_items (
          id serial PRIMARY KEY,
          broadcast_id integer NOT NULL REFERENCES tg_fb_broadcasts(id) ON DELETE CASCADE,
          fb_page_id text NOT NULL,
          fb_page_name text,
          position integer NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          reason text,
          fb_video_id text,
          attempts integer NOT NULL DEFAULT 0,
          started_at timestamp,
          uploaded_at timestamp
        )`);
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

async function connectedPages(): Promise<Page[]> {
  await ensureInstagramSchema();
  const rows = rowsOf(await db.execute(sql`SELECT fb_page_id, name FROM facebook_pages WHERE status = 'connected' ORDER BY name`));
  return rows.map((r) => ({ id: String(r.fb_page_id), name: String(r.name ?? r.fb_page_id) }));
}

function chooseView(id: number, caption: string, pages: Page[], selected: number[], kind: Kind = "video"): BroadcastView {
  const sel = new Set(selected);
  const all = pages.length > 0 && sel.size === pages.length;
  const keyboard: Button[][] = pages.map((p, i) => [{ text: `${sel.has(i) ? "☑️" : "⬜"} ${p.name}`.slice(0, 60), callback_data: `fb:${id}:t${i}` }]);
  keyboard.push([{ text: all ? "☑️ كل الصفحات (إلغاء التحديد)" : "⬜ كل الصفحات", callback_data: `fb:${id}:${all ? "none" : "all"}` }]);
  keyboard.push([
    { text: `🚀 انشر في المختارة (${sel.size})`, callback_data: `fb:${id}:go` },
    { text: "✖ إلغاء", callback_data: `fb:${id}:x` },
  ]);
  const gap = gapOf(kind);
  const minutes = Math.max(0, sel.size - 1) * gap;
  return {
    text: [
      kind === "photo" ? "🖼 نشر هذه الصورة في صفحات فيسبوك" : "📤 نشر هذا المقطع في صفحات فيسبوك",
      kind === "photo" ? `النص: ${caption ? facebookTitleOf(caption) : "(بلا نص)"}` : `العنوان: ${facebookTitleOf(caption)}`,
      "",
      "اختر الصفحات ثم اضغط «انشر».",
      ...(sel.size > 1 ? [`سيُنشر في صفحة بعد صفحة بفاصل ${gap === 1 ? "دقيقة" : `${gap} دقائق`} (قرابة ${minutes} دقيقة للكل).`] : []),
    ].join("\n"),
    keyboard,
  };
}

// مقطع وصل البوت في محادثة خاصة/مجموعة.
export async function newBroadcast(input: { chatId: string; messageId: number; fileId: string; caption: string; width: number; height: number; duration: number; fileSize: number; kind?: Kind; album?: boolean }): Promise<BroadcastView | null> {
  const kind: Kind = input.kind === "photo" ? "photo" : "video";
  await ensureSchema();
  const allowed = await broadcastChatIds();
  if (!allowed.includes(input.chatId)) {
    // محادثة خاصة غير مربوطة: نوضّح السبب بدل الصمت (المجموعات غير المربوطة تُتجاهل).
    return input.chatId.startsWith("-") ? null : { text: "هذه المحادثة غير مربوطة بالنشر في عدة صفحات بعد. اطلب رمز الربط من Claude، ثم أرسل هنا: /start والرمز، ثم أعد الإرسال.", keyboard: null };
  }
  const caption = input.caption.trim();
  if (input.album) return { text: "أرسل صورة واحدة فقط في كل مرة (لا ألبوم)، واكتب النص تحتها — لم يُنشر شيء.", keyboard: null };
  if (!caption && kind === "video") return { text: "أرسل المقطع مرة أخرى واكتب العنوان في خانة الوصف تحت المقطع — هو الذي يُكتب في فيسبوك.", keyboard: null };
  const pages = await connectedPages();
  if (pages.length === 0) return { text: "لا توجد صفحات فيسبوك مربوطة بالموقع الآن — أعد «ربط فيسبوك برمز».", keyboard: null };
  const [row] = rowsOf(await db.execute(sql`
    INSERT INTO tg_fb_broadcasts (chat_id, message_id, file_id, caption, width, height, duration, file_size, pages, kind)
    VALUES (${input.chatId}, ${input.messageId}, ${input.fileId}, ${caption.slice(0, 5000)}, ${input.width}, ${input.height}, ${input.duration}, ${input.fileSize}, ${JSON.stringify(pages)}::jsonb, ${kind})
    ON CONFLICT (chat_id, message_id) DO NOTHING RETURNING id`));
  if (!row) return null;
  return chooseView(Number(row.id), caption, pages, [], kind);
}

// ضغطة زر في قائمة الاختيار: fb:<id>:<t3|all|none|go|x>
export async function broadcastCallback(chatId: string, data: string): Promise<{ view: BroadcastView | null; answer: string }> {
  await ensureSchema();
  const m = data.match(/^fb:(\d+):(t\d+|all|none|go|x|track)$/);
  if (!m) return { view: null, answer: "" };
  const id = Number(m[1]);
  const action = m[2];
  if (action === "track") {
    // الإصدار 86: زر «تابع المشاهدات 7 أيام» تحت تقرير النشر.
    const r = await startTracking(id, chatId);
    return { view: null, answer: r.ok ? "✅ بدأت المتابعة — أول تقرير الساعة 9 مساءً" : String(r.message) };
  }
  const [b] = rowsOf(await db.execute(sql`SELECT id, chat_id, caption, pages, selected, status, created_at, kind FROM tg_fb_broadcasts WHERE id = ${id}`));
  if (!b || String(b.chat_id) !== chatId) return { view: null, answer: "غير مسموح" };
  if (b.status !== "choosing") return { view: null, answer: "تم التعامل مع هذا المقطع سابقًا" };
  if (Date.now() - new Date(b.created_at).getTime() > CHOOSE_HOURS * 3600_000) {
    await db.execute(sql`UPDATE tg_fb_broadcasts SET status = 'expired' WHERE id = ${id}`);
    return { view: { text: "⌛ انتهت مهلة هذه القائمة — أرسل المقطع مرة أخرى.", keyboard: null }, answer: "انتهت المهلة" };
  }
  const pages = b.pages as Page[];
  const kind: Kind = b.kind === "photo" ? "photo" : "video";
  let selected = new Set<number>((b.selected as number[]) ?? []);
  if (action === "x") {
    await db.execute(sql`UPDATE tg_fb_broadcasts SET status = 'cancelled', finished_at = now() WHERE id = ${id} AND status = 'choosing'`);
    return { view: { text: `✖ أُلغي نشر ${kind === "photo" ? "هذه الصورة" : "هذا المقطع"}.`, keyboard: null }, answer: "أُلغي" };
  }
  if (action === "go") {
    if (selected.size === 0) return { view: null, answer: "اختر صفحة واحدة على الأقل" };
    const chosen = [...selected].sort((a, b2) => a - b2).map((i) => pages[i]).filter(Boolean);
    const [claimed] = rowsOf(await db.execute(sql`UPDATE tg_fb_broadcasts SET status = 'running', next_at = now() WHERE id = ${id} AND status = 'choosing' RETURNING id`));
    if (!claimed) return { view: null, answer: "تم التعامل مع هذا المقطع سابقًا" };
    for (const [pos, p] of chosen.entries()) {
      await db.execute(sql`INSERT INTO tg_fb_broadcast_items (broadcast_id, fb_page_id, fb_page_name, position) VALUES (${id}, ${p.id}, ${p.name}, ${pos})`);
    }
    const gap = gapOf(kind);
    const minutes = Math.max(0, chosen.length - 1) * gap;
    return {
      view: {
        text: [
          `🚀 بدأ النشر — عدد الصفحات: ${chosen.length}`,
          ...chosen.map((p) => `• ${p.name}`),
          "",
          chosen.length > 1 ? `بفاصل ${gap === 1 ? "دقيقة" : `${gap} دقائق`} بين كل صفحة (قرابة ${minutes} دقيقة${kind === "video" ? " + وقت الرفع" : ""}).` : "",
          "يصلك التقرير هنا عند الانتهاء.",
        ].filter(Boolean).join("\n"),
        keyboard: null,
      },
      answer: "بدأ النشر",
    };
  }
  if (action === "all") selected = new Set(pages.map((_, i) => i));
  else if (action === "none") selected = new Set();
  else {
    const i = Number(action.slice(1));
    if (i >= 0 && i < pages.length) selected.has(i) ? selected.delete(i) : selected.add(i);
  }
  await db.execute(sql`UPDATE tg_fb_broadcasts SET selected = ${JSON.stringify([...selected])}::jsonb WHERE id = ${id}`);
  return { view: chooseView(id, String(b.caption), pages, [...selected], kind), answer: "" };
}

// العامل يسأل: هل هناك صفحة حان دورها؟ (بند واحد في كل مرة، وبالفاصل المحدد)
export async function nextBroadcastItem() {
  await ensureSchema();
  // بند عالق (انقطع العامل أثناء الرفع): يعود «منتظرًا».
  await db.execute(sql`UPDATE tg_fb_broadcast_items SET status = 'pending' WHERE status = 'uploading' AND started_at < now() - make_interval(mins => ${STALE_MINUTES})`);
  const [item] = rowsOf(await db.execute(sql`
    UPDATE tg_fb_broadcast_items SET status = 'uploading', attempts = attempts + 1, started_at = now()
    WHERE id = (
      SELECT i.id FROM tg_fb_broadcast_items i JOIN tg_fb_broadcasts b ON b.id = i.broadcast_id
      WHERE b.status = 'running' AND (b.next_at IS NULL OR b.next_at <= now()) AND i.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM tg_fb_broadcast_items u WHERE u.broadcast_id = b.id AND u.status = 'uploading')
      ORDER BY b.id, i.position LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, broadcast_id, fb_page_name`));
  if (!item) return { item: null };
  const [b] = rowsOf(await db.execute(sql`SELECT file_id, file_size FROM tg_fb_broadcasts WHERE id = ${item.broadcast_id}`));
  return { item: { itemId: Number(item.id), broadcastId: Number(item.broadcast_id), pageName: String(item.fb_page_name ?? ""), fileId: String(b.file_id), fileSize: Number(b.file_size ?? 0) } };
}

async function finishIfDone(broadcastId: number): Promise<{ done: boolean; chatId?: string; report?: string; keyboard?: Button[][] }> {
  const items = rowsOf(await db.execute(sql`SELECT fb_page_name, status, reason, fb_video_id FROM tg_fb_broadcast_items WHERE broadcast_id = ${broadcastId} ORDER BY position`));
  if (items.some((i) => i.status === "pending" || i.status === "uploading")) return { done: false };
  const [b] = rowsOf(await db.execute(sql`UPDATE tg_fb_broadcasts SET status = 'done', finished_at = now(), reported = true WHERE id = ${broadcastId} AND NOT reported RETURNING chat_id, caption, kind`));
  if (!b) return { done: true };
  const kind: Kind = b.kind === "photo" ? "photo" : "video";
  const ok = items.filter((i) => i.status === "uploaded").length;
  const lines = [
    `📋 تقرير نشر ${nounOf(kind)}: ${facebookTitleOf(String(b.caption)) || "(بلا نص)"}`,
    `نجح: ${ok} من ${items.length}`,
    "",
    ...items.map((i) => i.status === "uploaded"
      ? `✅ ${i.fb_page_name}${i.fb_video_id ? `\nhttps://www.facebook.com/${i.fb_video_id}` : ""}`
      : `❌ ${i.fb_page_name} — ${String(i.reason ?? "").slice(0, 200)}`),
  ];
  const keyboard = ok > 0 && kind === "video" ? [[{ text: "📊 تابع المشاهدات 7 أيام", callback_data: `fb:${broadcastId}:track` }]] : undefined;
  return { done: true, chatId: String(b.chat_id), report: lines.join("\n"), keyboard };
}

// الملف وصل من العامل: يُنشر في صفحة هذا البند.
export async function performBroadcastUpload(itemId: number, filePath: string, fileSize: number) {
  await ensureSchema();
  const [it] = rowsOf(await db.execute(sql`
    SELECT i.id, i.broadcast_id, i.fb_page_id, i.fb_page_name, i.status, i.attempts, b.caption, b.kind
    FROM tg_fb_broadcast_items i JOIN tg_fb_broadcasts b ON b.id = i.broadcast_id WHERE i.id = ${itemId}`));
  if (!it || it.status !== "uploading") return { ok: false, message: "بند غير صالح أو منتهٍ", done: false };
  const broadcastId = Number(it.broadcast_id);
  const kind: Kind = it.kind === "photo" ? "photo" : "video";
  const settle = async (ok: boolean, message?: string, videoId?: string) => {
    if (ok) {
      await db.execute(sql`UPDATE tg_fb_broadcast_items SET status = 'uploaded', fb_video_id = ${videoId ?? null}, uploaded_at = now(), reason = NULL WHERE id = ${itemId}`);
    } else {
      const final = Number(it.attempts) >= MAX_ITEM_ATTEMPTS;
      await db.execute(sql`UPDATE tg_fb_broadcast_items SET status = ${final ? "failed" : "pending"}, reason = ${String(message ?? "").slice(0, 500)} WHERE id = ${itemId}`);
    }
    // الفاصل يبدأ من نهاية هذا الرفع.
    await db.execute(sql`UPDATE tg_fb_broadcasts SET next_at = now() + make_interval(mins => ${gapOf(kind)}) WHERE id = ${broadcastId}`);
    const fin = await finishIfDone(broadcastId);
    return { ok, message, fbVideoId: videoId, ...fin };
  };
  if (fileSize < 1024) return settle(false, `لم يصل ملف ${nounOf(kind)}`);
  const config = getFacebookConfig();
  if (!config) return settle(false, "متغيرات فيسبوك غير مضبوطة على الخادم");
  const [page] = rowsOf(await db.execute(sql`SELECT access_token_encrypted, status FROM facebook_pages WHERE fb_page_id = ${it.fb_page_id}`));
  const token = decryptToken(page?.access_token_encrypted, config.appSecret);
  if (!token || page?.status !== "connected") return settle(false, "رمز الصفحة غير متاح — أعد «ربط فيسبوك»");
  const caption = String(it.caption ?? "").trim();
  if (kind === "photo") {
    const r = await uploadFacebookPhoto(String(it.fb_page_id), token, filePath, caption);
    return r.ok ? settle(true, undefined, r.postId) : settle(false, r.message);
  }
  const title = facebookTitleOf(caption) || String(it.fb_page_name ?? "");
  const result = await uploadFacebookVideo({ pageId: String(it.fb_page_id), token, filePath, fileSize, title, description: caption || title, published: true });
  if (!result.ok) return settle(false, `[${result.stage}] ${result.message}`);
  return settle(true, undefined, result.videoId);
}

// صورة واحدة في منشور: POST /{page}/photos (source + message). يُعاد رقم المنشور (post_id) للرابط.
async function uploadFacebookPhoto(pageId: string, token: string, filePath: string, caption: string): Promise<{ ok: true; postId: string } | { ok: false; message: string }> {
  try {
    const fs = await import("node:fs");
    const form = new FormData();
    form.set("source", await fs.openAsBlob(filePath, { type: "image/jpeg" }), "photo.jpg");
    if (caption) form.set("message", caption.slice(0, 60000));
    form.set("published", "true");
    form.set("access_token", token);
    const res = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, { method: "POST", body: form });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) return { ok: false, message: String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
    return { ok: true, postId: String(body.post_id ?? body.id) };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
