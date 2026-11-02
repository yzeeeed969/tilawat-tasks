// مسار تيليجرام ← فيسبوك (الإصدار 76، قرار المدير 2026-11-02): بديل التنزيل من يوتيوب (خطر 0% على يوتيوب).
// بوت جديد مشرف في قناة تيليجرام لكل شيخ (يعمل على «خادم البوتات المحلي» الرسمي في خدمة tg-bridge)،
// وكل فيديو **أفقي** يُنشر في القناة يُرسل هنا ثم يُنشر في صفحة فيسبوك لنفس الشيخ، **بنص منشور تيليجرام عنوانًا**.
//
// قرار «ما يُرفع وما لا يُرفع» هنا في الخادم (قاعدة المشروع)، وخدمة tg-bridge تنفّذ فقط:
//  • مفتاح تشغيل مستقل (معطّل افتراضيًا).
//  • القناة ← القارئ: من «المنصات والصفحات» (صفحة القارئ على تلقرام t.me/<username>) ← صفحة فيسبوك للقارئ.
//  • أفقي فقط (العرض أكبر من الارتفاع)؛ الشورت العمودي والمربع لا يُرفع.
//  • لا تكرار: (القناة، رقم الرسالة) فريد، وكذلك نفس العنوان لنفس الصفحة خلال 3 أيام.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { getFacebookConfig } from "./facebook-client";
import { uploadFacebookVideo } from "./facebook-video-upload";
import { decryptToken } from "../lib/instagram-token-crypto";
import { notifyTelegramAdminsGeneric } from "./telegram-notification-engine";

const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 70;

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let schemaReady: Promise<void> | null = null;
export function ensureTgCrosspostSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_settings (
          id integer PRIMARY KEY DEFAULT 1,
          enabled boolean NOT NULL DEFAULT false,
          enabled_at timestamp,
          last_bridge_at timestamp,
          updated_at timestamp NOT NULL DEFAULT now(),
          CONSTRAINT tg_fb_settings_single CHECK (id = 1)
        )`);
      await db.execute(sql`INSERT INTO tg_fb_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_channels (
          chat_id text PRIMARY KEY,
          title text,
          username text,
          bot_status text,
          seen_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now()
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS tg_fb_uploads (
          id serial PRIMARY KEY,
          chat_id text NOT NULL,
          message_id bigint NOT NULL,
          fb_page_id text,
          fb_page_name text,
          reciter_name text,
          title text,
          status text NOT NULL,
          reason text,
          fb_video_id text,
          attempts integer NOT NULL DEFAULT 1,
          file_size bigint,
          width integer,
          height integer,
          duration integer,
          started_at timestamp NOT NULL DEFAULT now(),
          uploaded_at timestamp,
          created_at timestamp NOT NULL DEFAULT now(),
          UNIQUE (chat_id, message_id)
        )`);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function settings() {
  await ensureTgCrosspostSchema();
  const [row] = rowsOf(await db.execute(sql`SELECT enabled, enabled_at, last_bridge_at FROM tg_fb_settings WHERE id = 1`));
  return { enabled: row?.enabled === true, enabledAt: row?.enabled_at ?? null, lastBridgeAt: row?.last_bridge_at ?? null };
}

export async function setTgCrosspostEnabled(enabled: boolean) {
  await ensureTgCrosspostSchema();
  await db.execute(sql`UPDATE tg_fb_settings SET enabled = ${enabled}, enabled_at = CASE WHEN ${enabled} THEN now() ELSE enabled_at END, updated_at = now() WHERE id = 1`);
  return { ok: true, enabled };
}

const handleOf = (url: unknown) => String(url ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i)?.[1]?.toLowerCase() ?? null;

// القناة ← القارئ ← صفحة فيسبوك. يُرجع السبب بالعربية إن تعذّر.
export async function resolveTarget(username: string | null): Promise<{ ok: true; reciterId: number; reciterName: string; pageId: string; pageName: string } | { ok: false; reason: string }> {
  const handle = (username ?? "").replace(/^@/, "").toLowerCase();
  if (!handle) return { ok: false, reason: "القناة بلا اسم مستخدم عام (@username) — لا يمكن ربطها بقارئ" };
  const pages = rowsOf(await db.execute(sql`
    SELECT pp.reciter_id, pp.page_url, r.name AS reciter_name
    FROM platform_pages pp JOIN reciters r ON r.id = pp.reciter_id JOIN platforms p ON p.id = pp.platform_id
    WHERE pp.reciter_id IS NOT NULL AND (p.name ILIKE '%تلقرام%' OR p.name ILIKE '%تيليجرام%' OR p.name ILIKE '%telegram%')`));
  const reciters = [...new Map(pages.filter((p) => handleOf(p.page_url) === handle).map((p) => [Number(p.reciter_id), String(p.reciter_name)])).entries()];
  if (reciters.length === 0) return { ok: false, reason: `القناة @${handle} غير مسجّلة لقارئ في «المنصات والصفحات» (منصة تلقرام)` };
  if (reciters.length > 1) return { ok: false, reason: `القناة @${handle} مسجّلة لأكثر من قارئ — لا تخمين` };
  const [reciterId, reciterName] = reciters[0];
  await ensureInstagramSchema();
  const fb = rowsOf(await db.execute(sql`
    SELECT DISTINCT fp.fb_page_id, fp.name, fp.status FROM instagram_accounts a JOIN facebook_pages fp ON fp.fb_page_id = a.fb_page_id
    WHERE a.reciter_id = ${reciterId} AND a.fb_page_id IS NOT NULL`));
  const unique = [...new Map(fb.map((p) => [String(p.fb_page_id), p])).values()];
  if (unique.length === 0) return { ok: false, reason: `لا توجد صفحة فيسبوك مربوطة للشيخ ${reciterName}` };
  if (unique.length > 1) return { ok: false, reason: `أكثر من صفحة فيسبوك للشيخ ${reciterName} — لا تخمين` };
  if (unique[0].status !== "connected") return { ok: false, reason: `صفحة فيسبوك «${unique[0].name}» تحتاج إعادة ربط` };
  return { ok: true, reciterId, reciterName, pageId: String(unique[0].fb_page_id), pageName: String(unique[0].name) };
}

// قنوات المشايخ المسجّلة في «المنصات والصفحات» (منصة تلقرام) — ليتحقق العامل من وجود البوت فيها.
export async function reciterTelegramHandles(): Promise<string[]> {
  const rows = rowsOf(await db.execute(sql`
    SELECT pp.page_url FROM platform_pages pp JOIN platforms p ON p.id = pp.platform_id
    WHERE pp.reciter_id IS NOT NULL AND (p.name ILIKE '%تلقرام%' OR p.name ILIKE '%تيليجرام%' OR p.name ILIKE '%telegram%')`));
  return [...new Set(rows.map((r) => handleOf(r.page_url)).filter((h): h is string => Boolean(h)))];
}

export async function bridgeHeartbeat() {
  await ensureTgCrosspostSchema();
  await db.execute(sql`UPDATE tg_fb_settings SET last_bridge_at = now() WHERE id = 1`);
}

// ── من خدمة tg-bridge ─────────────────────────────────────────────────────────────────────────
export async function registerChannel(input: { chatId: string; title?: string | null; username?: string | null; botStatus?: string | null }) {
  await ensureTgCrosspostSchema();
  await db.execute(sql`
    INSERT INTO tg_fb_channels (chat_id, title, username, bot_status) VALUES (${input.chatId}, ${input.title ?? null}, ${input.username ?? null}, ${input.botStatus ?? null})
    ON CONFLICT (chat_id) DO UPDATE SET title = coalesce(EXCLUDED.title, tg_fb_channels.title), username = coalesce(EXCLUDED.username, tg_fb_channels.username),
      bot_status = coalesce(EXCLUDED.bot_status, tg_fb_channels.bot_status), seen_at = now(), updated_at = now()`);
  await db.execute(sql`UPDATE tg_fb_settings SET last_bridge_at = now() WHERE id = 1`);
}

export type TgCheckInput = { chatId: string; messageId: number; username: string | null; chatTitle: string | null; caption: string; width: number; height: number; duration: number; fileSize: number };
export type TgCheckResult = { upload: true; uploadId: number; pageName: string } | { upload: false; reason: string };

export async function checkTgVideo(input: TgCheckInput): Promise<TgCheckResult> {
  await registerChannel({ chatId: input.chatId, title: input.chatTitle, username: input.username });
  const s = await settings();
  const record = async (status: string, reason: string, extra: { pageId?: string; pageName?: string; reciterName?: string } = {}) => {
    await db.execute(sql`
      INSERT INTO tg_fb_uploads (chat_id, message_id, fb_page_id, fb_page_name, reciter_name, title, status, reason, width, height, duration, file_size)
      VALUES (${input.chatId}, ${input.messageId}, ${extra.pageId ?? null}, ${extra.pageName ?? null}, ${extra.reciterName ?? null}, ${input.caption.slice(0, 500)},
        ${status}, ${reason}, ${input.width}, ${input.height}, ${input.duration}, ${input.fileSize})
      ON CONFLICT (chat_id, message_id) DO NOTHING`);
  };
  if (!s.enabled) return { upload: false, reason: "الرفع من تيليجرام معطّل (مفتاح التشغيل)" };
  // أفقي فقط (قرار المدير): مقاس فيديو يوتيوب، لا الشورت.
  if (!(input.width > 0 && input.height > 0 && input.width > input.height)) {
    await record("skipped", `ليس فيديو أفقيًا (${input.width}×${input.height}) — الشورت لا يُرفع`);
    return { upload: false, reason: "ليس فيديو أفقيًا" };
  }
  const target = await resolveTarget(input.username);
  if (!target.ok) {
    await record("skipped", target.reason);
    await notifyTelegramAdminsGeneric({ title: "فيديو في تيليجرام لم يُنشر في فيسبوك", lines: [`القناة: ${input.chatTitle ?? input.chatId}`, `السبب: ${target.reason}`], alertKey: `tg_fb_map:${input.chatId}` }).catch(() => {});
    return { upload: false, reason: target.reason };
  }
  const title = input.caption.trim();
  if (title) {
    const [dup] = rowsOf(await db.execute(sql`
      SELECT 1 FROM tg_fb_uploads WHERE fb_page_id = ${target.pageId} AND title = ${title.slice(0, 500)} AND status IN ('uploaded','uploading')
        AND NOT (chat_id = ${input.chatId} AND message_id = ${input.messageId}) AND created_at > now() - interval '3 days' LIMIT 1`));
    if (dup) {
      await record("skipped", "نفس العنوان نُشر في نفس الصفحة خلال 3 أيام — منع تكرار", { pageId: target.pageId, pageName: target.pageName, reciterName: target.reciterName });
      return { upload: false, reason: "مكرر بالعنوان" };
    }
  }
  const [claimed] = rowsOf(await db.execute(sql`
    INSERT INTO tg_fb_uploads (chat_id, message_id, fb_page_id, fb_page_name, reciter_name, title, status, width, height, duration, file_size)
    VALUES (${input.chatId}, ${input.messageId}, ${target.pageId}, ${target.pageName}, ${target.reciterName}, ${title.slice(0, 500)}, 'uploading',
      ${input.width}, ${input.height}, ${input.duration}, ${input.fileSize})
    ON CONFLICT (chat_id, message_id) DO UPDATE SET status = 'uploading', attempts = tg_fb_uploads.attempts + 1, started_at = now(), reason = NULL
    WHERE (tg_fb_uploads.status = 'failed' AND tg_fb_uploads.attempts < ${MAX_ATTEMPTS})
      OR (tg_fb_uploads.status = 'uploading' AND tg_fb_uploads.started_at < now() - make_interval(mins => ${STALE_MINUTES}))
    RETURNING id`));
  if (!claimed) return { upload: false, reason: "سبق التعامل مع هذا المنشور" };
  return { upload: true, uploadId: Number(claimed.id), pageName: target.pageName };
}

export async function performTgUpload(uploadId: number, filePath: string, fileSize: number): Promise<{ ok: boolean; message?: string; fbVideoId?: string }> {
  await ensureTgCrosspostSchema();
  const [row] = rowsOf(await db.execute(sql`SELECT id, fb_page_id, fb_page_name, title, status, chat_id, message_id FROM tg_fb_uploads WHERE id = ${uploadId}`));
  if (!row || row.status !== "uploading") return { ok: false, message: "طلب رفع غير صالح أو منتهٍ" };
  const fail = async (message: string) => {
    await db.execute(sql`UPDATE tg_fb_uploads SET status = 'failed', reason = ${message}, file_size = ${fileSize} WHERE id = ${uploadId}`);
    const [r] = rowsOf(await db.execute(sql`SELECT attempts FROM tg_fb_uploads WHERE id = ${uploadId}`));
    if (Number(r?.attempts ?? 0) >= MAX_ATTEMPTS) {
      await notifyTelegramAdminsGeneric({ title: "فشل نشر فيديو تيليجرام في فيسبوك", lines: [`الصفحة: ${row.fb_page_name}`, `العنوان: ${String(row.title ?? "").slice(0, 120)}`, `السبب: ${message}`], alertKey: `tg_fb_fail:${uploadId}` }).catch(() => {});
    }
    return { ok: false, message };
  };
  if (fileSize < 1024) return fail("لم يصل ملف الفيديو");
  const config = getFacebookConfig();
  if (!config) return fail("متغيرات فيسبوك غير مضبوطة على الخادم");
  const [page] = rowsOf(await db.execute(sql`SELECT access_token_encrypted, status FROM facebook_pages WHERE fb_page_id = ${row.fb_page_id}`));
  const token = decryptToken(page?.access_token_encrypted, config.appSecret);
  if (!token || page?.status !== "connected") return fail("رمز صفحة فيسبوك غير متاح — أعد «ربط فيسبوك»");
  const title = String(row.title ?? "").trim() || String(row.fb_page_name ?? "");
  const result = await uploadFacebookVideo({ pageId: String(row.fb_page_id), token, filePath, fileSize, title, published: true });
  if (!result.ok) return fail(`[${result.stage}] ${result.message}${result.metaError ? ` — ${JSON.stringify(result.metaError)}` : ""}`);
  await db.execute(sql`UPDATE tg_fb_uploads SET status = 'uploaded', fb_video_id = ${result.videoId}, uploaded_at = now(), reason = NULL, file_size = ${fileSize} WHERE id = ${uploadId}`);
  return { ok: true, fbVideoId: result.videoId };
}

// ── المدير ────────────────────────────────────────────────────────────────────────────────────
export async function tgCrosspostOverview() {
  const s = await settings();
  const channels = rowsOf(await db.execute(sql`SELECT chat_id, title, username, bot_status, seen_at FROM tg_fb_channels ORDER BY seen_at DESC`));
  const mapped = [];
  for (const c of channels) {
    const t = await resolveTarget(c.username ? String(c.username) : null);
    mapped.push({ chatId: String(c.chat_id), title: c.title, username: c.username, botStatus: c.bot_status, seenAt: c.seen_at, target: t });
  }
  const uploads = rowsOf(await db.execute(sql`SELECT id, chat_id, message_id, fb_page_name, reciter_name, title, status, reason, fb_video_id, attempts, file_size, width, height, created_at, uploaded_at FROM tg_fb_uploads ORDER BY id DESC LIMIT 40`));
  return { enabled: s.enabled, enabledAt: s.enabledAt, lastBridgeAt: s.lastBridgeAt, channels: mapped, uploads };
}
