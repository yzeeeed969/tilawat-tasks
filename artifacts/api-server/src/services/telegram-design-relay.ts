// تحويل تصاميم قناة «تصاميم الحرمين» تلقائيًا إلى قنوات القرّاء الخاصة (الإصدار 64، قرار المدير).
//
// • كل منشور فيديو في قناة من نوع designs يُقرأ نصه، ومن اسم القارئ فيه (هاشتاق أو نص) يُعرف القارئ.
// • القناة الهدف = صفحة القارئ على منصة تلقرام في «المنصات والصفحات» (رابط t.me/<username>).
// • الإرسال بـ copyMessage: يظهر كمنشور أصلي (بلا «محوّل من»)، والنص كما هو + سطر مستقل عريض
//   «قناة تصاميم الحرمين» مضمَّن فيه رابط المنشور الأصلي.
// • منع التكرار: سجل telegram_design_relays بمفتاح فريد (المنشور، القناة الهدف) — لا يُرسل منشور مرتين أبدًا.
// • الجديد فقط: ما نُشر بعد لحظة التفعيل. ودفعة واحدة لمرة واحدة: آخر 14 يومًا لقنوات أربعة قرّاء
//   محددين (ماهر المعيقلي، عبدالله الجهني، عبدالله القرافي، بندر بليلة) — ثم لا تتكرر.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { callTelegramApi } from "./telegram";
import { ensureTelegramMonitorSchema } from "./telegram-monitor-schema";
import { normalizeName } from "./weekly-schedule-template";
import { normalizeForNameCheck } from "../lib/recitation-text";

const LINK_LABEL = "قناة تصاميم الحرمين";
const CAPTION_LIMIT = 1024;
const MAX_ATTEMPTS = 3;
const BACKFILL_DAYS = 14;
const BACKFILL_MARKER = "telegram_design_relay_backfill_v64";
const ACTIVATION_MARKER = "telegram_design_relay_activation_v64";
// الدفعة القديمة لهؤلاء فقط (كما طلب المدير) — بالاسم المطبَّع.
const BACKFILL_RECITERS = ["ماهر المعيقلي", "عبدالله الجهني", "عبدالله القرافي", "بندر بليلة"].map((n) => normalizeName(n));

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let schemaReady: Promise<void> | null = null;
export function ensureDesignRelaySchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureTelegramMonitorSchema();
      await db.execute(sql`ALTER TABLE telegram_channel_posts ADD COLUMN IF NOT EXISTS caption_entities jsonb`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS telegram_design_relays (
          id serial PRIMARY KEY,
          post_id integer NOT NULL REFERENCES telegram_channel_posts(id) ON DELETE CASCADE,
          reciter_id integer,
          target_chat text NOT NULL,
          target_name text,
          status text NOT NULL DEFAULT 'sending',
          attempts integer NOT NULL DEFAULT 1,
          error text,
          target_message_id bigint,
          backfill boolean NOT NULL DEFAULT false,
          created_at timestamp NOT NULL DEFAULT now(),
          sent_at timestamp
        )
      `);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_design_relays_post_target ON telegram_design_relays(post_id, target_chat)`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_one_time_migrations (name text PRIMARY KEY, ran_at timestamp NOT NULL DEFAULT now(), details jsonb)
      `);
      // لحظة التفعيل: تُسجَّل مرة واحدة؛ ما نُشر قبلها لا يُحوَّل إلا عبر الدفعة القديمة.
      await db.execute(sql`INSERT INTO app_one_time_migrations (name) VALUES (${ACTIVATION_MARKER}) ON CONFLICT (name) DO NOTHING`);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function activationAt(): Promise<Date> {
  const [row] = rowsOf(await db.execute(sql`SELECT ran_at FROM app_one_time_migrations WHERE name = ${ACTIVATION_MARKER}`));
  return row?.ran_at ? new Date(row.ran_at) : new Date();
}

// ── القرّاء والقنوات الهدف ───────────────────────────────────────────────────────────────────
type Target = { reciterId: number; reciterName: string; chat: string; pageName: string };

function telegramHandle(url: unknown): string | null {
  const m = String(url ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
  return m ? `@${m[1]}` : null;
}

async function loadTargets(telegramPlatformId: number | null): Promise<Map<number, Target>> {
  const rows = rowsOf(await db.execute(sql`
    SELECT pp.reciter_id, pp.page_url, pp.name AS page_name, r.name AS reciter_name
    FROM platform_pages pp JOIN reciters r ON r.id = pp.reciter_id
    JOIN platforms p ON p.id = pp.platform_id
    WHERE pp.reciter_id IS NOT NULL
      AND (${telegramPlatformId}::int IS NULL AND (p.name ILIKE '%تلقرام%' OR p.name ILIKE '%تيليجرام%' OR p.name ILIKE '%telegram%')
           OR pp.platform_id = ${telegramPlatformId}::int)`));
  const map = new Map<number, Target>();
  for (const r of rows) {
    const chat = telegramHandle(r.page_url);
    if (!chat || map.has(Number(r.reciter_id))) continue;
    map.set(Number(r.reciter_id), { reciterId: Number(r.reciter_id), reciterName: String(r.reciter_name), chat, pageName: String(r.page_name) });
  }
  return map;
}

// اسم القارئ في النص (هاشتاق أو كلام): الاسم الكامل أولًا، ثم اسم العائلة إن كان فريدًا. التباس ⇐ لا إرسال.
async function resolveReciter(caption: string): Promise<number | null> {
  const text = normalizeName(normalizeForNameCheck(caption));
  if (!text) return null;
  const reciters = rowsOf(await db.execute(sql`SELECT id, name FROM reciters`)).map((r) => ({ id: Number(r.id), name: String(r.name) }));
  const aliases = rowsOf(await db.execute(sql`SELECT hashtag, reciter_id FROM telegram_hashtag_aliases`));
  const full = new Set<number>();
  for (const r of reciters) {
    const n = normalizeName(r.name);
    if (n.length >= 4 && text.includes(n)) full.add(r.id);
  }
  for (const a of aliases) {
    const n = normalizeName(normalizeForNameCheck(String(a.hashtag)));
    if (n.length >= 4 && text.includes(n)) full.add(Number(a.reciter_id));
  }
  if (full.size === 1) return [...full][0];
  if (full.size > 1) return null;
  const byLast = new Map<string, number[]>();
  for (const r of reciters) {
    const parts = r.name.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const last = normalizeName(parts[parts.length - 1]);
    if (last.length < 5) continue;
    byLast.set(last, [...(byLast.get(last) ?? []), r.id]);
  }
  const hits = new Set<number>();
  for (const [last, ids] of byLast) if (ids.length === 1 && text.includes(last)) hits.add(ids[0]);
  return hits.size === 1 ? [...hits][0] : null;
}

// ── النص: الأصلي كما هو + سطر عريض مضمَّن فيه رابط المنشور الأصلي ──────────────────────────
function buildCaption(caption: string | null, entities: any[] | null, postUrl: string) {
  const suffix = `\n\n${LINK_LABEL}`;
  let base = (caption ?? "").replace(/\s+$/u, "");
  const room = CAPTION_LIMIT - suffix.length;
  if (base.length > room) base = base.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
  const kept = (Array.isArray(entities) ? entities : [])
    .filter((e) => Number.isInteger(e?.offset) && Number.isInteger(e?.length) && e.offset + e.length <= base.length)
    .map((e) => ({ ...e }));
  const text = base ? `${base}${suffix}` : LINK_LABEL;
  const offset = text.length - LINK_LABEL.length; // إزاحات تلقرام بوحدات UTF-16 = فهرسة JavaScript
  kept.push({ type: "bold", offset, length: LINK_LABEL.length });
  kept.push({ type: "text_link", offset, length: LINK_LABEL.length, url: postUrl });
  return { caption: text, caption_entities: kept };
}

function postLink(post: any): string | null {
  if (post.post_url) return String(post.post_url);
  const internal = String(post.chat_id).match(/^-100(\d+)$/)?.[1];
  return internal ? `https://t.me/c/${internal}/${post.message_id}` : null;
}

// ── الإرسال ─────────────────────────────────────────────────────────────────────────────────
async function claim(postId: number, target: Target, backfill: boolean): Promise<boolean> {
  const rows = rowsOf(await db.execute(sql`
    INSERT INTO telegram_design_relays (post_id, reciter_id, target_chat, target_name, status, attempts, backfill)
    VALUES (${postId}, ${target.reciterId}, ${target.chat}, ${target.pageName}, 'sending', 1, ${backfill})
    ON CONFLICT (post_id, target_chat) DO UPDATE SET status = 'sending', attempts = telegram_design_relays.attempts + 1, error = NULL
    WHERE telegram_design_relays.status = 'failed' AND telegram_design_relays.attempts < ${MAX_ATTEMPTS}
      OR (telegram_design_relays.status = 'sending' AND telegram_design_relays.created_at < now() - interval '15 minutes')
    RETURNING id`));
  return rows.length > 0;
}

function friendlyError(error: string) {
  if (/chat not found/i.test(error)) return "لم يُعثر على القناة — تأكد من رابطها في «المنصات والصفحات»";
  if (/not enough rights|need administrator|member list is inaccessible|not a member|bot is not a member|CHAT_WRITE_FORBIDDEN|have no rights/i.test(error)) return "البوت ليس مشرفًا في القناة (أضفه مشرفًا بصلاحية النشر)";
  return error;
}

async function sendOne(post: any, target: Target, backfill: boolean): Promise<"sent" | "failed" | "skipped"> {
  if (!(await claim(Number(post.id), target, backfill))) return "skipped";
  const url = postLink(post);
  if (!url) {
    await db.execute(sql`UPDATE telegram_design_relays SET status = 'failed', attempts = ${MAX_ATTEMPTS}, error = 'تعذّر بناء رابط المنشور الأصلي' WHERE post_id = ${post.id} AND target_chat = ${target.chat}`);
    return "failed";
  }
  const { caption, caption_entities } = buildCaption(post.caption ?? null, post.caption_entities ?? null, url);
  let result = await callTelegramApi<{ message_id: number }>("copyMessage", {
    chat_id: target.chat, from_chat_id: String(post.chat_id), message_id: Number(post.message_id), caption, caption_entities,
  });
  const wait = result.error?.match(/retry after (\d+)/i)?.[1];
  if (!result.ok && wait) {
    await sleep((Number(wait) + 1) * 1000);
    result = await callTelegramApi<{ message_id: number }>("copyMessage", {
      chat_id: target.chat, from_chat_id: String(post.chat_id), message_id: Number(post.message_id), caption, caption_entities,
    });
  }
  if (result.ok) {
    await db.execute(sql`UPDATE telegram_design_relays SET status = 'sent', sent_at = now(), error = NULL, target_message_id = ${result.result?.message_id ?? null} WHERE post_id = ${post.id} AND target_chat = ${target.chat}`);
    return "sent";
  }
  await db.execute(sql`UPDATE telegram_design_relays SET status = 'failed', error = ${friendlyError(result.error ?? "خطأ غير معروف")} WHERE post_id = ${post.id} AND target_chat = ${target.chat}`);
  return "failed";
}

async function designChannels() {
  return rowsOf(await db.execute(sql`SELECT id, telegram_platform_id FROM telegram_channels WHERE kind = 'designs' AND enabled = true`));
}

let running = false;

// يُستدعى فور تخزين منشور جديد ومع الفحص الدوري (إعادة المحاولة + الدفعة القديمة لمرة واحدة).
export async function runDesignRelay(onlyPostId?: number): Promise<{ sent: number; failed: number }> {
  if (running) return { sent: 0, failed: 0 };
  running = true;
  let sent = 0, failed = 0;
  try {
    await ensureDesignRelaySchema();
    const channels = await designChannels();
    if (channels.length === 0) return { sent, failed };
    const since = await activationAt();

    for (const ch of channels) {
      const targets = await loadTargets(ch.telegram_platform_id != null ? Number(ch.telegram_platform_id) : null);
      if (targets.size === 0) continue;

      // (1) دفعة آخر 14 يومًا — مرة واحدة فقط، لقنوات القرّاء الأربعة المحددين.
      const marker = rowsOf(await db.execute(sql`INSERT INTO app_one_time_migrations (name) VALUES (${BACKFILL_MARKER}) ON CONFLICT (name) DO NOTHING RETURNING name`));
      if (marker.length > 0) {
        const old = rowsOf(await db.execute(sql`
          SELECT id, chat_id, message_id, caption, caption_entities, post_url FROM telegram_channel_posts
          WHERE channel_id = ${ch.id} AND has_video = true AND published_at < ${since}
            AND published_at >= ${since}::timestamp - make_interval(days => ${BACKFILL_DAYS})
          ORDER BY published_at, message_id`));
        let count = 0;
        for (const post of old) {
          const reciterId = await resolveReciter(String(post.caption ?? ""));
          const target = reciterId != null ? targets.get(reciterId) : undefined;
          if (!target || !BACKFILL_RECITERS.includes(normalizeName(target.reciterName))) continue;
          const r = await sendOne(post, target, true);
          if (r === "sent") { sent++; count++; } else if (r === "failed") failed++;
          await sleep(1500);
        }
        await db.execute(sql`UPDATE app_one_time_migrations SET details = ${JSON.stringify({ sent: count, at: new Date().toISOString() })}::jsonb WHERE name = ${BACKFILL_MARKER}`);
      }

      // (2) الجديد: كل فيديو نُشر بعد التفعيل ولم يُحوَّل (أو فشل وما زالت له محاولات).
      const fresh = rowsOf(await db.execute(sql`
        SELECT p.id, p.chat_id, p.message_id, p.caption, p.caption_entities, p.post_url FROM telegram_channel_posts p
        WHERE p.channel_id = ${ch.id} AND p.has_video = true AND p.published_at >= ${since}
          AND (${onlyPostId ?? null}::int IS NULL OR p.id = ${onlyPostId ?? null}::int)
          AND p.published_at > now() - interval '3 days'
          AND NOT EXISTS (SELECT 1 FROM telegram_design_relays d WHERE d.post_id = p.id
                          AND (d.status = 'sent' OR (d.status = 'failed' AND d.attempts >= ${MAX_ATTEMPTS}) OR d.status = 'unmatched'))
        ORDER BY p.published_at, p.message_id LIMIT 50`));
      for (const post of fresh) {
        const reciterId = await resolveReciter(String(post.caption ?? ""));
        const target = reciterId != null ? targets.get(reciterId) : undefined;
        if (!target) continue; // قارئ غير معروف أو بلا قناة خاصة ⇐ لا إرسال
        const r = await sendOne(post, target, false);
        if (r === "sent") sent++; else if (r === "failed") failed++;
        await sleep(1000);
      }
    }
    return { sent, failed };
  } finally {
    running = false;
  }
}

export async function listDesignRelays(limit = 40) {
  await ensureDesignRelaySchema();
  const rows = rowsOf(await db.execute(sql`
    SELECT d.id, d.status, d.error, d.attempts, d.backfill, d.target_name, d.target_chat, d.created_at, d.sent_at,
           p.post_url, p.published_at, left(coalesce(p.caption, ''), 120) AS caption
    FROM telegram_design_relays d JOIN telegram_channel_posts p ON p.id = d.post_id
    ORDER BY d.created_at DESC LIMIT ${limit}`));
  return rows.map((r) => ({
    id: Number(r.id), status: String(r.status), error: r.error ?? null, attempts: Number(r.attempts), backfill: Boolean(r.backfill),
    targetName: r.target_name ?? r.target_chat, targetChat: String(r.target_chat), createdAt: r.created_at, sentAt: r.sent_at ?? null,
    postUrl: r.post_url ?? null, publishedAt: r.published_at, caption: String(r.caption ?? ""),
  }));
}

// يحفظ تنسيق النص الأصلي (caption_entities) ليُنقل كما هو — يُستدعى من الـ webhook بعد تخزين المنشور.
export async function captureDesignEntities(postId: number, update: any) {
  const post = update?.channel_post ?? update?.edited_channel_post;
  const entities = post?.caption_entities ?? post?.entities;
  if (!Array.isArray(entities) || entities.length === 0) return;
  await ensureDesignRelaySchema();
  await db.execute(sql`UPDATE telegram_channel_posts SET caption_entities = ${JSON.stringify(entities)}::jsonb WHERE id = ${postId}`);
}

// قنوات القرّاء الهدف وحالة البوت في كل منها (مشرف بصلاحية النشر أم لا) — لعرضها في صفحة المراقبة.
export async function listRelayTargets() {
  await ensureDesignRelaySchema();
  const [ch] = await designChannels();
  if (!ch) return [];
  const targets = [...(await loadTargets(ch.telegram_platform_id != null ? Number(ch.telegram_platform_id) : null)).values()];
  const me = await callTelegramApi<{ id: number }>("getMe");
  const out: Array<{ reciterName: string; pageName: string; chat: string; ready: boolean; note: string }> = [];
  for (const t of targets) {
    let ready = false, note = "";
    if (!me.ok || !me.result) note = "تعذّر الاتصال بالبوت";
    else {
      const m = await callTelegramApi<{ status: string; can_post_messages?: boolean }>("getChatMember", { chat_id: t.chat, user_id: me.result.id });
      if (!m.ok) note = friendlyError(m.error ?? "");
      else if (m.result?.status === "creator" || (m.result?.status === "administrator" && m.result?.can_post_messages !== false)) { ready = true; note = "جاهزة"; }
      else note = "البوت ليس مشرفًا في القناة (أضفه مشرفًا بصلاحية النشر)";
    }
    out.push({ reciterName: t.reciterName, pageName: t.pageName, chat: t.chat, ready, note });
  }
  return out;
}
