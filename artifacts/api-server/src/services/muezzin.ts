import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { db } from "@workspace/db";
import { riyadhDayKey } from "../lib/hijri";
import { ensureMuezzinSchema } from "./muezzin-schema";
import { sendTelegramMessage } from "./telegram";

// «جدول المؤذنين»: قراءة صورة الجدول الأسبوعي الرسمي ← معاينة المدير ← إنشاء ← إرسال يومي لكل مؤذن
// بمهامه فقط عبر واجهة واتساب الرسمية (Cloud API). وضع التجربة مفعّل افتراضيًا: كل الرسائل إلى رقم المدير.

export const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;
export const SLOTS = ["fajr1", "fajr2", "dhuhr", "asr", "maghrib", "isha"] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_LABELS: Record<Slot, string> = {
  fajr1: "الفجر 1",
  fajr2: "الفجر 2",
  dhuhr: "الظهر",
  asr: "العصر",
  maghrib: "المغرب",
  isha: "العشاء",
};
const SLOT_MESSAGE: Record<Slot, string> = {
  fajr1: "الأذان الأول للفجر",
  fajr2: "الأذان الثاني للفجر",
  dhuhr: "أذان الظهر",
  asr: "أذان العصر",
  maghrib: "أذان المغرب",
  isha: "أذان العشاء",
};

export class MuezzinError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

/* ───────────────────────── الأسماء ───────────────────────── */

/** توحيد الاسم للمقارنة: حذف الألقاب والتشكيل، وتوحيد الهمزات والتاء المربوطة و«ال» التعريف. */
export function normalizeName(input: string): string {
  return String(input ?? "")
    .replace(/[ً-ْـ]/g, "")
    .replace(/الشيخ|فضيلة/g, "")
    .replace(/أ\s*\.\s*د\s*\./g, "")
    .replace(/(^|\s)د\s*\./g, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/عبد\s+ال/g, "عبدال")
    .replace(/[^؀-ۿ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length > 4 && w.startsWith("ال") && w !== "الله" ? w.slice(2) : w))
    .join(" ");
}

export type Muezzin = { id: number; name: string; phone: string | null; isActive: boolean };

export async function listMuezzins(): Promise<Muezzin[]> {
  await ensureMuezzinSchema();
  return rowsOf(await db.execute(sql`SELECT id, name, phone, is_active FROM muezzins ORDER BY name`)).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    phone: r.phone ? String(r.phone) : null,
    isActive: Boolean(r.is_active),
  }));
}

function cleanPhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  let p = digits;
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("05") && p.length === 10) p = "966" + p.slice(1);
  if (!/^9665\d{8}$/.test(p)) throw new MuezzinError(400, "رقم الجوال غير صحيح. الصيغة: 9665XXXXXXXX");
  return p;
}

export async function createMuezzin(input: { name: string; phone?: string | null }) {
  await ensureMuezzinSchema();
  const name = String(input.name ?? "").trim();
  if (!name) throw new MuezzinError(400, "الاسم مطلوب");
  const all = await listMuezzins();
  if (all.some((m) => normalizeName(m.name) === normalizeName(name))) throw new MuezzinError(409, "هذا الاسم موجود مسبقًا");
  const phone = cleanPhone(input.phone);
  await db.execute(sql`INSERT INTO muezzins (name, phone) VALUES (${name}, ${phone})`);
}

export async function updateMuezzin(id: number, input: { name?: string; phone?: string | null; isActive?: boolean }) {
  await ensureMuezzinSchema();
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new MuezzinError(400, "الاسم مطلوب");
    const all = await listMuezzins();
    if (all.some((m) => m.id !== id && normalizeName(m.name) === normalizeName(name))) throw new MuezzinError(409, "هذا الاسم موجود مسبقًا");
    await db.execute(sql`UPDATE muezzins SET name = ${name}, updated_at = now() WHERE id = ${id}`);
  }
  if (input.phone !== undefined) {
    const phone = cleanPhone(input.phone);
    await db.execute(sql`UPDATE muezzins SET phone = ${phone}, updated_at = now() WHERE id = ${id}`);
  }
  if (input.isActive !== undefined) {
    await db.execute(sql`UPDATE muezzins SET is_active = ${Boolean(input.isActive)}, updated_at = now() WHERE id = ${id}`);
  }
}

/* ───────────────────────── قراءة الصورة ───────────────────────── */

export type PreviewCell = { raw: string; muezzinId: number | null };
export type PreviewDay = { day: string; date: string; slots: Record<Slot, PreviewCell> };

export function isVisionConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

const READ_PROMPT = [
  'هذه صورة "الجدول الأسبوعي لرفع الأذان بالمسجد الحرام".',
  "استخرج الجدول بدقة تامة حرفًا بحرف، دون أي تخمين.",
  "أعد JSON فقط بلا أي نص آخر، بهذا الشكل:",
  '{"title":"نص سطر التاريخ أعلى الجدول","days":[{"day":"الأحد","date":"23/4","slots":{"fajr1":"...","fajr2":"...","dhuhr":"...","asr":"...","maghrib":"...","isha":"..."}}]}',
  "القواعد:",
  "- الأيام السبعة بالترتيب: الأحد، الاثنين، الثلاثاء، الأربعاء، الخميس، الجمعة، السبت.",
  '- fajr1 = "الفجر ١"، fajr2 = "الفجر ٢".',
  '- اكتب الاسم بدون كلمة "الشيخ"، واحتفظ بـ "د." أو "أ.د." إن وُجدت.',
  '- يوم الجمعة: خانة "الجمعة" مكان الظهر؛ إن لم يكن فيها اسم مؤذن فاكتب null في dhuhr.',
  "- أي خانة غير واضحة أو بلا اسم اكتب فيها null.",
].join("\n");

export async function readScheduleImage(image: Buffer, mime: string): Promise<{ title: string; days: PreviewDay[] }> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new MuezzinError(503, "قراءة الصور غير مفعّلة: أضف ANTHROPIC_API_KEY في إعدادات Railway.");
  if (!image?.length) throw new MuezzinError(400, "لم تصل صورة");
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new MuezzinError(400, "نوع الصورة غير مدعوم");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.MUEZZIN_VISION_MODEL?.trim() || "claude-sonnet-5-5",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: image.toString("base64") } },
            { type: "text", text: READ_PROMPT },
          ],
        }],
      }),
    });
  } catch {
    throw new MuezzinError(504, "تعذّر الاتصال بخدمة قراءة الصور. حاول مرة أخرى.");
  } finally {
    clearTimeout(timeout);
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new MuezzinError(502, `فشلت قراءة الصورة: ${body?.error?.message ?? res.status}`);

  const text = (body?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new MuezzinError(422, "لم أستطع فهم الجدول من الصورة. جرّب صورة أوضح.");
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new MuezzinError(422, "لم أستطع فهم الجدول من الصورة. جرّب صورة أوضح.");
  }

  const muezzins = await listMuezzins();
  const byNorm = new Map(muezzins.map((m) => [normalizeName(m.name), m.id]));
  const srcDays: any[] = Array.isArray(parsed?.days) ? parsed.days : [];
  const days: PreviewDay[] = DAYS.map((day, i) => {
    const src = srcDays.find((d) => String(d?.day ?? "").trim() === day) ?? srcDays[i] ?? {};
    const slots = {} as Record<Slot, PreviewCell>;
    for (const slot of SLOTS) {
      const raw = src?.slots?.[slot] ? String(src.slots[slot]).trim() : "";
      slots[slot] = { raw, muezzinId: raw ? byNorm.get(normalizeName(raw)) ?? null : null };
    }
    return { day, date: String(src?.date ?? ""), slots };
  });
  return { title: String(parsed?.title ?? ""), days };
}

/* ───────────────────────── الإنشاء ───────────────────────── */

function addDays(key: string, n: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function saveWeek(input: {
  weekStart: string;
  title?: string;
  days: Array<{ slots: Partial<Record<Slot, number | null>> }>;
  userId?: number | null;
}) {
  await ensureMuezzinSchema();
  const { weekStart } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new MuezzinError(400, "تاريخ بداية الأسبوع غير صحيح");
  if (new Date(`${weekStart}T12:00:00Z`).getUTCDay() !== 0) throw new MuezzinError(400, "بداية الأسبوع يجب أن تكون يوم أحد");
  if (!Array.isArray(input.days) || input.days.length !== 7) throw new MuezzinError(400, "الجدول يجب أن يحتوي ٧ أيام");

  const valid = new Set((await listMuezzins()).map((m) => m.id));
  const rows: Array<{ dateKey: string; slot: Slot; muezzinId: number }> = [];
  input.days.forEach((d, i) => {
    for (const slot of SLOTS) {
      const id = d?.slots?.[slot];
      if (id == null) continue;
      if (!valid.has(Number(id))) throw new MuezzinError(400, `مؤذن غير معروف في ${DAYS[i]} / ${SLOT_LABELS[slot]}`);
      rows.push({ dateKey: addDays(weekStart, i), slot, muezzinId: Number(id) });
    }
  });
  if (!rows.length) throw new MuezzinError(400, "الجدول فارغ");

  const dateKeys = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  await db.transaction(async (tx) => {
    const batch = rowsOf(await tx.execute(sql`
      INSERT INTO muezzin_schedule_batches (week_start, entries, source_title, created_by_user_id)
      VALUES (${weekStart}, ${rows.length}, ${input.title ?? null}, ${input.userId ?? null}) RETURNING id`))[0];
    // استبدال جدول الأسبوع نفسه إن أُنشئ سابقًا.
    for (const key of dateKeys) await tx.execute(sql`DELETE FROM muezzin_schedule WHERE date_key = ${key}`);
    for (const r of rows) {
      await tx.execute(sql`
        INSERT INTO muezzin_schedule (date_key, slot, muezzin_id, batch_id)
        VALUES (${r.dateKey}, ${r.slot}, ${r.muezzinId}, ${batch.id})`);
    }
  });
  return { entries: rows.length, weekStart, weekEnd: addDays(weekStart, 6) };
}

export async function getScheduleRange(fromKey: string, days: number) {
  await ensureMuezzinSchema();
  const toKey = addDays(fromKey, days - 1);
  return rowsOf(await db.execute(sql`
    SELECT s.date_key, s.slot, m.name
    FROM muezzin_schedule s JOIN muezzins m ON m.id = s.muezzin_id
    WHERE s.date_key BETWEEN ${fromKey} AND ${toKey}
    ORDER BY s.date_key`)).map((r) => ({ dateKey: String(r.date_key), slot: String(r.slot) as Slot, name: String(r.name) }));
}

/* ───────────────────────── الإعدادات ───────────────────────── */

export type MuezzinSettings = { sendHour: number; testMode: boolean; testPhone: string | null; autoSendEnabled: boolean; lastAutoRunDate: string | null };

export async function getSettings(): Promise<MuezzinSettings> {
  await ensureMuezzinSchema();
  const r = rowsOf(await db.execute(sql`SELECT * FROM muezzin_settings WHERE id = 1`))[0] ?? {};
  return {
    sendHour: Number(r.send_hour ?? 21),
    testMode: r.test_mode !== false,
    testPhone: r.test_phone ? String(r.test_phone) : null,
    autoSendEnabled: Boolean(r.auto_send_enabled),
    lastAutoRunDate: r.last_auto_run_date ? String(r.last_auto_run_date) : null,
  };
}

export async function updateSettings(input: Partial<Omit<MuezzinSettings, "lastAutoRunDate">>) {
  await ensureMuezzinSchema();
  if (input.sendHour !== undefined) {
    const h = Number(input.sendHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new MuezzinError(400, "ساعة الإرسال بين 0 و 23");
    await db.execute(sql`UPDATE muezzin_settings SET send_hour = ${h}, updated_at = now() WHERE id = 1`);
  }
  if (input.testPhone !== undefined) {
    await db.execute(sql`UPDATE muezzin_settings SET test_phone = ${cleanPhone(input.testPhone)}, updated_at = now() WHERE id = 1`);
  }
  if (input.testMode !== undefined) {
    if (input.testMode === false && !isWhatsAppConfigured()) throw new MuezzinError(400, "لا يمكن إيقاف وضع التجربة قبل ربط واتساب");
    await db.execute(sql`UPDATE muezzin_settings SET test_mode = ${Boolean(input.testMode)}, updated_at = now() WHERE id = 1`);
  }
  if (input.autoSendEnabled !== undefined) {
    await db.execute(sql`UPDATE muezzin_settings SET auto_send_enabled = ${Boolean(input.autoSendEnabled)}, updated_at = now() WHERE id = 1`);
  }
}

/* ───────────────────────── واتساب ───────────────────────── */

export function isWhatsAppConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN?.trim() && process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() && process.env.WHATSAPP_TEMPLATE?.trim());
}

async function sendWhatsAppTemplate(to: string, params: string[]): Promise<{ ok: boolean; detail: string }> {
  if (!isWhatsAppConfigured()) return { ok: false, detail: "واتساب غير مربوط" };
  const version = process.env.WHATSAPP_GRAPH_VERSION?.trim() || "v21.0";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID!.trim()}/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WHATSAPP_TOKEN!.trim()}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: process.env.WHATSAPP_TEMPLATE!.trim(),
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG?.trim() || "ar" },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
        },
      }),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) return { ok: false, detail: `${res.status} ${body?.error?.message ?? ""}`.trim().slice(0, 300) };
    return { ok: true, detail: String(body?.messages?.[0]?.id ?? "OK") };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "فشل الاتصال" };
  } finally {
    clearTimeout(timeout);
  }
}

/* ───────────────────────── الإرسال ───────────────────────── */

async function alertAdmins(text: string) {
  try {
    const admins = rowsOf(await db.execute(sql`
      SELECT r.chat_id FROM app_users u JOIN telegram_recipients r ON r.user_id = u.id
      WHERE u.role = 'admin' AND u.is_approved = true AND r.is_enabled = true`));
    for (const a of admins) await sendTelegramMessage(String(a.chat_id), text);
  } catch {
    // التنبيه اختياري — لا يوقف الإرسال.
  }
}

function weekdayOf(dateKey: string) {
  return DAYS[new Date(`${dateKey}T12:00:00Z`).getUTCDay()];
}

export async function sendForDate(dateKey: string) {
  await ensureMuezzinSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new MuezzinError(400, "تاريخ غير صحيح");
  const settings = await getSettings();
  const testMode = settings.testMode;
  if (testMode && !settings.testPhone) throw new MuezzinError(400, "أضف رقم التجربة أولًا (وضع التجربة مفعّل)");

  const entries = await getScheduleRange(dateKey, 1);
  if (!entries.length) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nلا يوجد جدول ليوم ${weekdayOf(dateKey)} ${dateKey} — لم تُرسل أي رسالة. ارفع جدول الأسبوع.`);
    return { sent: 0, failed: 0, skipped: 0, testMode, noSchedule: true };
  }

  const muezzins = await listMuezzins();
  const duties = new Map<string, Slot[]>();
  for (const e of entries) duties.set(e.name, [...(duties.get(e.name) ?? []), e.slot]);

  const already = new Set(rowsOf(await db.execute(sql`
    SELECT muezzin_name FROM muezzin_send_log WHERE date_key = ${dateKey} AND ok = true AND test_mode = ${testMode}`))
    .map((r) => String(r.muezzin_name)));

  let sent = 0, failed = 0, skipped = 0;
  const failures: string[] = [];
  for (const [name, slots] of duties) {
    const m = muezzins.find((x) => x.name === name);
    if (!m || !m.isActive || already.has(name)) { skipped++; continue; }
    const to = testMode ? settings.testPhone : m.phone;
    if (!to) {
      failed++;
      failures.push(`${name}: لا يوجد رقم`);
      await db.execute(sql`INSERT INTO muezzin_send_log (date_key, muezzin_id, muezzin_name, phone, test_mode, ok, detail)
        VALUES (${dateKey}, ${m.id}, ${name}, NULL, ${testMode}, false, 'لا يوجد رقم')`);
      continue;
    }
    const order = SLOTS.filter((s) => slots.includes(s));
    const result = await sendWhatsAppTemplate(to, [name, `${weekdayOf(dateKey)} ${dateKey}`, order.map((s) => SLOT_MESSAGE[s]).join(" ، ")]);
    await db.execute(sql`INSERT INTO muezzin_send_log (date_key, muezzin_id, muezzin_name, phone, test_mode, ok, detail)
      VALUES (${dateKey}, ${m.id}, ${name}, ${to}, ${testMode}, ${result.ok}, ${result.detail})`);
    if (result.ok) sent++;
    else { failed++; failures.push(`${name}: ${result.detail}`); }
  }

  if (failures.length) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b> — فشل ${failures.length} رسالة ليوم ${dateKey}${testMode ? " (تجربة)" : ""}:\n${failures.slice(0, 15).join("\n")}`);
  }
  return { sent, failed, skipped, testMode, noSchedule: false };
}

export async function recentLog(limit = 60) {
  await ensureMuezzinSchema();
  return rowsOf(await db.execute(sql`
    SELECT id, date_key, muezzin_name, phone, test_mode, ok, detail, created_at
    FROM muezzin_send_log ORDER BY id DESC LIMIT ${limit}`)).map((r) => ({
    id: Number(r.id),
    dateKey: String(r.date_key),
    name: String(r.muezzin_name),
    phone: r.phone ? String(r.phone) : null,
    testMode: Boolean(r.test_mode),
    ok: Boolean(r.ok),
    detail: r.detail ? String(r.detail) : "",
    createdAt: r.created_at,
  }));
}

/* ───────────────────────── المجدول اليومي ───────────────────────── */

function riyadhHour(now: Date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", hourCycle: "h23" }).format(now));
}

let schedulerStarted = false;
let tickRunning = false;

export async function runMuezzinTick(now = new Date()) {
  const settings = await getSettings();
  if (!settings.autoSendEnabled) return { ran: false };
  const today = riyadhDayKey(now);
  if (settings.lastAutoRunDate === today) return { ran: false };
  if (riyadhHour(now) < settings.sendHour) return { ran: false };
  // نحجز يوم اليوم أولًا (ذرّيًا) كي لا يتكرر الإرسال حتى لو تعددت النسخ أو أُعيد التشغيل.
  const claimed = rowsOf(await db.execute(sql`
    UPDATE muezzin_settings SET last_auto_run_date = ${today}
    WHERE id = 1 AND (last_auto_run_date IS DISTINCT FROM ${today}) RETURNING id`));
  if (!claimed.length) return { ran: false };
  const tomorrow = addDays(today, 1);
  try {
    const result = await sendForDate(tomorrow);
    return { ran: true, date: tomorrow, ...result };
  } catch (err) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nتعذّر الإرسال اليومي ليوم ${tomorrow}: ${err instanceof Error ? err.message : "خطأ غير معروف"}`);
    throw err;
  }
}

export function startMuezzinScheduler(logger?: Logger) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const r = await runMuezzinTick();
      if (r.ran) logger?.info({ result: r }, "Muezzin schedule daily send completed");
    } catch (err) {
      logger?.warn({ err }, "Muezzin schedule tick failed");
    } finally {
      tickRunning = false;
    }
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
