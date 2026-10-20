import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { callTelegramApi } from "./telegram";

// «من نشر هذا المقطع؟» — نسبة منشور إنستقرام إلى العضو الناشر.
// إنستقرام لا يُخبر من نشر، فالنسبة من جهتنا:
// - حساب له عضو واحد (أعضاء صفحة القارئ النشطون) ⇐ يُنسب إليه تلقائيًا بلا رسائل.
// - حساب له أكثر من عضو (مثل ماهر المعيقلي) ⇐ رسالة من البوت لكل عضو بزر «أنا نشرته»، ونسخة للمدير
//   بأزرار بأسماء الأعضاء. أول ضغطة صحيحة تُثبت النسبة وتُحدَّث كل الرسائل.
// - لم يضغط أحد خلال 24 ساعة ⇐ يُنسب للعضو الأول (العضو المسؤول عن الحساب) تلقائيًا.
// النسبة للمعرفة فقط: لا تغيّر المهمة ولا العدّاد ولا الحالة.

const TIMEOUT_HOURS = 24;
const CALLBACK_PREFIX = "iga:";
// أنواع التحديثات التي يحتاجها الـ webhook (تشمل أزرار الرسائل callback_query).
export const TELEGRAM_REQUIRED_UPDATES = ["message", "channel_post", "edited_channel_post", "my_chat_member", "callback_query"];

let schemaReady = false;
async function ensureAttributionSchema() {
  if (schemaReady) return;
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS posted_by_member_id integer`);
  // auto | member | admin | timeout | pending
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS attribution text`);
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS attribution_candidates integer[]`);
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS attribution_primary_member_id integer`);
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS attribution_asked_at timestamptz`);
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS attributed_at timestamptz`);
  await db.execute(sql`ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS attributed_by_user_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS instagram_attribution_messages (
      id serial PRIMARY KEY,
      media_id integer NOT NULL REFERENCES instagram_media(id) ON DELETE CASCADE,
      chat_id text NOT NULL,
      message_id bigint NOT NULL,
      base_text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ig_attr_msgs_media ON instagram_attribution_messages(media_id)`);
  schemaReady = true;
}

// مصفوفة أعداد صحيحة كمعامل واحد آمن (drizzle يفكّ المصفوفات إلى قائمة معاملات).
function intArray(ids: number[]) {
  const clean = ids.map(Number).filter((n) => Number.isInteger(n));
  return sql`${`{${clean.join(",")}}`}::int[]`;
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function memberNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf(await db.execute(sql`SELECT id, name FROM members WHERE id = ANY(${intArray(ids)})`));
  return new Map(rows.map((r) => [Number(r.id), String(r.name)]));
}

type Recipient = { chatId: string; userId: number; memberId: number | null; role: string };

async function recipientsForMembers(memberIds: number[]): Promise<Recipient[]> {
  if (memberIds.length === 0) return [];
  return rowsOf(await db.execute(sql`
    SELECT r.chat_id, u.id AS user_id, u.member_id, u.role
    FROM users u JOIN telegram_recipients r ON r.user_id = u.id
    WHERE u.is_approved = true AND r.is_enabled = true AND u.member_id = ANY(${intArray(memberIds)})`))
    .map((r) => ({ chatId: String(r.chat_id), userId: Number(r.user_id), memberId: r.member_id == null ? null : Number(r.member_id), role: String(r.role) }));
}

async function adminRecipients(): Promise<Recipient[]> {
  return rowsOf(await db.execute(sql`
    SELECT r.chat_id, u.id AS user_id, u.member_id, u.role
    FROM users u JOIN telegram_recipients r ON r.user_id = u.id
    WHERE u.role = 'admin' AND u.is_approved = true AND r.is_enabled = true`))
    .map((r) => ({ chatId: String(r.chat_id), userId: Number(r.user_id), memberId: r.member_id == null ? null : Number(r.member_id), role: String(r.role) }));
}

// تُستدعى بعد توثيق منشور جديد (شاهد حقيقي، لا وضع التجربة).
export async function attributeNewInstagramMedia(input: {
  mediaRowId: number;
  reciterName: string;
  username: string | null;
  permalink: string;
  candidates: number[]; // أعضاء صفحة القارئ النشطون
  primary: number; // العضو المسؤول (أو أولهم)
}): Promise<void> {
  await ensureAttributionSchema();
  const candidates = [...new Set(input.candidates)];
  if (candidates.length <= 1) {
    await db.execute(sql`UPDATE instagram_media SET posted_by_member_id = ${input.primary}, attribution = 'auto', attributed_at = now() WHERE id = ${input.mediaRowId}`);
    return;
  }
  await db.execute(sql`UPDATE instagram_media SET attribution = 'pending', attribution_candidates = ${intArray(candidates)},
    attribution_primary_member_id = ${input.primary}, attribution_asked_at = now() WHERE id = ${input.mediaRowId}`);

  const names = await memberNames(candidates);
  const account = `${escapeHtml(input.reciterName)}${input.username ? ` (@${escapeHtml(input.username)})` : ""}`;
  const baseText = [
    `📸 <b>منشور جديد على إنستقرام ${account}</b>`,
    `<a href="${escapeHtml(input.permalink)}">فتح المقطع</a>`,
    "",
    "من نشر هذا المقطع؟",
  ].join("\n");

  const admins = await adminRecipients();
  const adminChats = new Set(admins.map((a) => a.chatId));
  const sent = new Set<string>();
  // نسخة المدير: أزرار بأسماء الأعضاء.
  for (const admin of admins) {
    if (sent.has(admin.chatId)) continue;
    sent.add(admin.chatId);
    const keyboard = candidates.map((id) => [{ text: names.get(id) ?? `عضو ${id}`, callback_data: `${CALLBACK_PREFIX}${input.mediaRowId}:m${id}` }]);
    await sendAndStore(input.mediaRowId, admin.chatId, `${baseText}\n<i>(نسخة المدير — اختر الناشر إن لم يحدّده الأعضاء خلال ${TIMEOUT_HOURS} ساعة يُنسب للعضو الأول تلقائيًا)</i>`, keyboard);
  }
  // الأعضاء: زر «أنا نشرته».
  for (const member of await recipientsForMembers(candidates)) {
    if (sent.has(member.chatId) || adminChats.has(member.chatId)) continue;
    sent.add(member.chatId);
    await sendAndStore(input.mediaRowId, member.chatId, baseText, [[{ text: "✋ أنا نشرته", callback_data: `${CALLBACK_PREFIX}${input.mediaRowId}:me` }]]);
  }
}

async function sendAndStore(mediaId: number, chatId: string, text: string, keyboard: unknown[][]) {
  const result = await callTelegramApi<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
  if (result.ok && result.result?.message_id) {
    await db.execute(sql`INSERT INTO instagram_attribution_messages (media_id, chat_id, message_id, base_text)
      VALUES (${mediaId}, ${chatId}, ${result.result.message_id}, ${text})`);
  }
}

async function finalizeMessages(mediaId: number, footer: string) {
  const messages = rowsOf(await db.execute(sql`SELECT chat_id, message_id, base_text FROM instagram_attribution_messages WHERE media_id = ${mediaId}`));
  for (const m of messages) {
    await callTelegramApi("editMessageText", {
      chat_id: String(m.chat_id),
      message_id: Number(m.message_id),
      text: `${String(m.base_text)}\n\n${footer}`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

// ضغطة زر في تلقرام. ترجع true إن كانت ضغطة نسبة (عولجت هنا).
export async function handleInstagramAttributionCallback(callback: any): Promise<boolean> {
  const data = typeof callback?.data === "string" ? callback.data : "";
  if (!data.startsWith(CALLBACK_PREFIX)) return false;
  await ensureAttributionSchema();
  const answer = (text: string) => callTelegramApi("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: false });

  const match = /^iga:(\d+):(me|m(\d+))$/.exec(data);
  const chatId = callback?.message?.chat?.id != null ? String(callback.message.chat.id) : "";
  if (!match || !chatId) { await answer("طلب غير صالح"); return true; }
  const mediaId = Number(match[1]);

  const [user] = rowsOf(await db.execute(sql`
    SELECT u.id, u.member_id, u.role FROM telegram_recipients r JOIN users u ON u.id = r.user_id
    WHERE r.chat_id = ${chatId} AND r.is_enabled = true AND u.is_approved = true LIMIT 1`));
  if (!user) { await answer("حسابك غير مربوط بالموقع"); return true; }

  const [media] = rowsOf(await db.execute(sql`SELECT attribution, attribution_candidates, posted_by_member_id FROM instagram_media WHERE id = ${mediaId}`));
  if (!media) { await answer("المنشور غير موجود"); return true; }
  const candidates: number[] = (media.attribution_candidates ?? []).map(Number);

  let memberId: number;
  let kind: "member" | "admin";
  if (match[2] === "me") {
    memberId = Number(user.member_id);
    kind = "member";
    if (!user.member_id || !candidates.includes(memberId)) { await answer("لست من أعضاء هذا الحساب"); return true; }
  } else {
    memberId = Number(match[3]);
    kind = "admin";
    if (user.role !== "admin") { await answer("هذا الاختيار للمدير فقط"); return true; }
    if (!candidates.includes(memberId)) { await answer("العضو ليس من أعضاء هذا الحساب"); return true; }
  }

  const updated = rowsOf(await db.execute(sql`UPDATE instagram_media SET posted_by_member_id = ${memberId}, attribution = ${kind},
    attributed_at = now(), attributed_by_user_id = ${Number(user.id)} WHERE id = ${mediaId} AND attribution = 'pending' RETURNING id`));
  const names = await memberNames([memberId, Number(media.posted_by_member_id ?? 0)].filter(Boolean));
  if (updated.length === 0) {
    await answer(`سبق تحديده: ${names.get(Number(media.posted_by_member_id)) ?? "—"}`);
    return true;
  }
  const name = names.get(memberId) ?? `عضو ${memberId}`;
  await finalizeMessages(mediaId, `✅ <b>نُسب إلى: ${escapeHtml(name)}</b>${kind === "admin" ? " (حدّده المدير)" : ""}`);
  await answer(`تم — نُسب إلى ${name}`);
  return true;
}

// بعد 24 ساعة بلا اختيار ⇐ العضو الأول (المسؤول). تُستدعى مع فحص إنستقرام الدوري.
export async function processInstagramAttributionTimeouts(): Promise<number> {
  await ensureAttributionSchema();
  const rows = rowsOf(await db.execute(sql`UPDATE instagram_media SET posted_by_member_id = attribution_primary_member_id,
    attribution = 'timeout', attributed_at = now()
    WHERE attribution = 'pending' AND attribution_asked_at < now() - make_interval(hours => ${TIMEOUT_HOURS})
    RETURNING id, posted_by_member_id`));
  if (rows.length === 0) return 0;
  const names = await memberNames(rows.map((r) => Number(r.posted_by_member_id)));
  for (const row of rows) {
    const name = names.get(Number(row.posted_by_member_id)) ?? "العضو الأول";
    await finalizeMessages(Number(row.id), `⏱ <b>لم يُحدَّد خلال ${TIMEOUT_HOURS} ساعة — نُسب تلقائيًا إلى: ${escapeHtml(name)}</b>`);
  }
  return rows.length;
}

// اسم الناشر وطريقة النسبة لكل منشور (لسجل المنشورات في الموقع).
export async function attributionByMedia(mediaIds: number[]): Promise<Map<number, { postedBy: string | null; attribution: string | null }>> {
  await ensureAttributionSchema();
  if (mediaIds.length === 0) return new Map();
  const rows = rowsOf(await db.execute(sql`SELECT m.id, m.attribution, mem.name FROM instagram_media m
    LEFT JOIN members mem ON mem.id = m.posted_by_member_id WHERE m.id = ANY(${intArray(mediaIds)})`));
  return new Map(rows.map((r) => [Number(r.id), { postedBy: r.name == null ? null : String(r.name), attribution: r.attribution == null ? null : String(r.attribution) }]));
}

// يضمن أن الـ webhook المسجّل يستقبل ضغطات الأزرار (callback_query) — يعيد تسجيل نفس العنوان فقط.
export async function ensureTelegramWebhookAllowsCallbacks(): Promise<void> {
  const info = await callTelegramApi<{ url?: string; allowed_updates?: string[] }>("getWebhookInfo");
  if (!info.ok || !info.result?.url) return;
  const allowed = info.result.allowed_updates ?? [];
  if (allowed.length === 0 || allowed.includes("callback_query")) return; // الافتراضي يشمل callback_query
  await callTelegramApi("setWebhook", { url: info.result.url, allowed_updates: TELEGRAM_REQUIRED_UPDATES, drop_pending_updates: false });
}
