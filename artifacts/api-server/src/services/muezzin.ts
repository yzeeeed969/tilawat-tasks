import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { db } from "@workspace/db";
import { hijriPartsOf, riyadhDayKey } from "../lib/hijri";
import { ensureMuezzinSchema } from "./muezzin-schema";
import { sendTelegramMessage } from "./telegram";

// «جدول المؤذنين»: قراءة صورة الجدول الأسبوعي الرسمي ← معاينة المدير ← إنشاء ← إرسال يومي لكل مؤذن
// بمهامه فقط عبر واجهة واتساب الرسمية (Cloud API). وضع التجربة مفعّل افتراضيًا: كل الرسائل إلى رقم المدير.

export const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;
export const SLOTS = ["fajr1", "fajr2", "dhuhr", "asr", "maghrib", "isha"] as const;
// أذانا الجمعة — يوم الجمعة فقط، بلا ملازم.
export const JUMUAH_SLOTS = ["jumuah1", "jumuah2"] as const;
export const ALL_SLOTS = [...SLOTS, ...JUMUAH_SLOTS] as const;
export type Slot = (typeof ALL_SLOTS)[number];
export const ROLES = ["muezzin", "mulazim"] as const;
export type Role = (typeof ROLES)[number];
const FRIDAY_INDEX = 5;
export const SLOT_LABELS: Record<Slot, string> = {
  fajr1: "الفجر 1",
  fajr2: "الفجر 2",
  dhuhr: "الظهر",
  asr: "العصر",
  maghrib: "المغرب",
  isha: "العشاء",
  jumuah1: "الجمعة — الأذان الأول",
  jumuah2: "الجمعة — الأذان الثاني",
};
const SLOT_MESSAGE: Record<Slot, string> = {
  fajr1: "الأذان الأول للفجر",
  fajr2: "الأذان الثاني للفجر",
  dhuhr: "أذان الظهر",
  asr: "أذان العصر",
  maghrib: "أذان المغرب",
  isha: "أذان العشاء",
  jumuah1: "الأذان الأول للجمعة",
  jumuah2: "الأذان الثاني للجمعة",
};
const ROLE_LABEL: Record<Role, string> = { muezzin: "مؤذن", mulazim: "ملازم" };
// ترتيب زمني: الجمعة مكان الظهر.
const ALL_SLOT_ORDER: Record<Slot, number> = { fajr1: 0, fajr2: 1, jumuah1: 2, jumuah2: 3, dhuhr: 4, asr: 5, maghrib: 6, isha: 7 };

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
    .replace(/\([^)]*\)/g, " ") // مثل «(ط)»
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
export type PreviewSlot = { muezzin: PreviewCell; mulazim: PreviewCell };
export type PreviewDay = { day: string; date: string; slots: Record<Slot, PreviewSlot> };
export type ReadResult = { title: string; days: PreviewDay[]; hasMulazim: boolean; suggestedWeekStart: string | null };

export function isVisionConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * يطابق اسمًا مقروءًا (كاملًا أو مختصرًا مثل «خوجة» أو «د. العباس») بمؤذن واحد فقط.
 * إن احتمل أكثر من مؤذن أو لم يطابق أحدًا ← null (تظهر الخانة حمراء ويختار المدير بنفسه — لا تخمين).
 */
export function matchMuezzin(raw: string, muezzins: Array<{ id: number; name: string }>): number | null {
  const n = normalizeName(raw);
  if (!n) return null;
  const exact = muezzins.filter((m) => normalizeName(m.name) === n);
  if (exact.length) return exact.length === 1 ? exact[0].id : null;
  const words = n.split(" ");
  const partial = muezzins.filter((m) => {
    const tokens = normalizeName(m.name).split(" ");
    return words.every((w) => tokens.includes(w));
  });
  return partial.length === 1 ? partial[0].id : null;
}

const READ_PROMPT = [
  'هذا "الجدول الأسبوعي لرفع الأذان بالمسجد الحرام" (صورة أو ملف PDF). قد يأتي بأحد شكلين:',
  "(أ) لكل صلاة اسم واحد فقط، أو (ب) لكل يوم صفّان: «مؤذن» و«ملازم».",
  "استخرج الجدول بدقة تامة حرفًا بحرف كما هو مكتوب، دون أي تخمين، ودون إكمال الأسماء المختصرة.",
  "أعد JSON فقط بلا أي نص آخر، بهذا الشكل:",
  '{"title":"عنوان الجدول كما هو","sundayHijri":{"day":21,"month":5,"year":1448},"days":[{"day":"الأحد","date":"21/5","slots":{"fajr1":{"muezzin":"...","mulazim":"..."},"fajr2":{...},"dhuhr":{...},"asr":{...},"maghrib":{...},"isha":{...}}}],"jumuah":{"first":"...","second":"..."}}',
  "القواعد:",
  "- الأيام السبعة بالترتيب: الأحد، الاثنين، الثلاثاء، الأربعاء، الخميس، الجمعة، السبت.",
  '- fajr1 = "الفجر الأول" أو "الفجر ١"، fajr2 = "الفجر الثاني" أو "الفجر ٢".',
  '- في الشكل (أ) ضع الاسم في muezzin واكتب mulazim = null.',
  '- اكتب الاسم بدون كلمة "الشيخ"، واحتفظ بـ "د." أو "أ.د." إن وُجدت.',
  "- ظهر الجمعة: إن كانت خانته فارغة أو مكتوب فيها «الجمعة» فاكتب null.",
  '- jumuah: اسما الأذان الأول والثاني لصلاة الجمعة لهذا الأسبوع إن ذُكرا صراحة (مثل مربع "الأذان الأول فضيلة الشيخ"). تجاهل أي جدول دوري لأسابيع أخرى. إن لم يُذكرا فاكتب null.',
  "- sundayHijri: التاريخ الهجري ليوم الأحد كما يظهر في الجدول (اليوم/الشهر/السنة) أرقامًا، أو null إن لم يتضح.",
  "- لا تعتمد على لون الخط. أي خانة غير واضحة أو بلا اسم اكتب فيها null.",
].join("\n");

/** يحوّل تاريخًا هجريًا (أم القرى) ليوم أحد إلى مفتاح ميلادي، بالبحث في نافذة حول اليوم. */
function gregorianSundayFromHijri(h: any): string | null {
  const day = Number(h?.day), month = Number(h?.month), year = Number(h?.year);
  if (!day || !month || !year) return null;
  const today = new Date(`${riyadhDayKey(new Date())}T12:00:00Z`);
  for (let offset = -120; offset <= 120; offset++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + offset);
    if (d.getUTCDay() !== 0) continue;
    const p = hijriPartsOf(d);
    if (p.day === day && p.month === month && p.year === year) return d.toISOString().slice(0, 10);
  }
  return null;
}

export async function readScheduleImage(file: Buffer, mime: string): Promise<ReadResult> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new MuezzinError(503, "قراءة الجداول غير مفعّلة: أضف ANTHROPIC_API_KEY في إعدادات Railway.");
  if (!file?.length) throw new MuezzinError(400, "لم يصل الملف");
  const isPdf = mime === "application/pdf";
  if (!isPdf && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new MuezzinError(400, "نوع الملف غير مدعوم — ارفع صورة أو PDF");

  const source = { type: "base64", media_type: mime, data: file.toString("base64") };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.MUEZZIN_VISION_MODEL?.trim() || "claude-sonnet-5-5",
        max_tokens: 6000,
        messages: [{
          role: "user",
          content: [
            isPdf ? { type: "document", source } : { type: "image", source },
            { type: "text", text: READ_PROMPT },
          ],
        }],
      }),
    });
  } catch {
    throw new MuezzinError(504, "تعذّر الاتصال بخدمة القراءة. حاول مرة أخرى.");
  } finally {
    clearTimeout(timeout);
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new MuezzinError(502, `فشلت القراءة: ${body?.error?.message ?? res.status}`);

  const text = (body?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new MuezzinError(422, "لم أستطع فهم الجدول. جرّب ملفًا أوضح.");
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new MuezzinError(422, "لم أستطع فهم الجدول. جرّب ملفًا أوضح.");
  }

  const muezzins = await listMuezzins();
  const cell = (v: unknown): PreviewCell => {
    const raw = v == null ? "" : String(v).trim();
    return { raw, muezzinId: raw ? matchMuezzin(raw, muezzins) : null };
  };
  const srcDays: any[] = Array.isArray(parsed?.days) ? parsed.days : [];
  let hasMulazim = false;
  const days: PreviewDay[] = DAYS.map((day, i) => {
    const src = srcDays.find((d) => String(d?.day ?? "").trim() === day) ?? srcDays[i] ?? {};
    const slots = {} as Record<Slot, PreviewSlot>;
    for (const slot of SLOTS) {
      const v = src?.slots?.[slot];
      // يقبل أيضًا الشكل القديم: اسم مباشر بدل كائن.
      const m = v && typeof v === "object" ? v.muezzin : v;
      const z = v && typeof v === "object" ? v.mulazim : null;
      slots[slot] = { muezzin: cell(m), mulazim: cell(z) };
      if (slots[slot].mulazim.raw) hasMulazim = true;
    }
    const empty = { muezzin: cell(null), mulazim: cell(null) };
    slots.jumuah1 = i === FRIDAY_INDEX ? { muezzin: cell(parsed?.jumuah?.first), mulazim: cell(null) } : empty;
    slots.jumuah2 = i === FRIDAY_INDEX ? { muezzin: cell(parsed?.jumuah?.second), mulazim: cell(null) } : empty;
    return { day, date: String(src?.date ?? ""), slots };
  });
  return {
    title: String(parsed?.title ?? ""),
    days,
    hasMulazim,
    suggestedWeekStart: gregorianSundayFromHijri(parsed?.sundayHijri),
  };
}

/* ───────────────────────── الإنشاء ───────────────────────── */

function addDays(key: string, n: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type SlotInput = { muezzin?: number | null; mulazim?: number | null } | number | null | undefined;

export async function saveWeek(input: {
  weekStart: string;
  title?: string;
  days: Array<{ slots: Partial<Record<Slot, SlotInput>> }>;
  userId?: number | null;
}) {
  await ensureMuezzinSchema();
  const { weekStart } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new MuezzinError(400, "تاريخ بداية الأسبوع غير صحيح");
  if (new Date(`${weekStart}T12:00:00Z`).getUTCDay() !== 0) throw new MuezzinError(400, "بداية الأسبوع يجب أن تكون يوم أحد");
  if (!Array.isArray(input.days) || input.days.length !== 7) throw new MuezzinError(400, "الجدول يجب أن يحتوي ٧ أيام");

  const valid = new Set((await listMuezzins()).map((m) => m.id));
  const rows: Array<{ dateKey: string; slot: Slot; role: Role; muezzinId: number }> = [];
  input.days.forEach((d, i) => {
    for (const slot of ALL_SLOTS) {
      const isJumuah = (JUMUAH_SLOTS as readonly string[]).includes(slot);
      const v = d?.slots?.[slot];
      const ids: Record<Role, number | null | undefined> =
        v && typeof v === "object" ? { muezzin: v.muezzin, mulazim: v.mulazim } : { muezzin: v as number | null | undefined, mulazim: null };
      for (const role of ROLES) {
        const id = ids[role];
        if (id == null) continue;
        if (isJumuah && (i !== FRIDAY_INDEX || role === "mulazim")) throw new MuezzinError(400, "أذانا الجمعة ليوم الجمعة فقط وبلا ملازم");
        if (!valid.has(Number(id))) throw new MuezzinError(400, `مؤذن غير معروف في ${DAYS[i]} / ${SLOT_LABELS[slot]} / ${ROLE_LABEL[role]}`);
        rows.push({ dateKey: addDays(weekStart, i), slot, role, muezzinId: Number(id) });
      }
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
        INSERT INTO muezzin_schedule (date_key, slot, role, muezzin_id, batch_id)
        VALUES (${r.dateKey}, ${r.slot}, ${r.role}, ${r.muezzinId}, ${batch.id})`);
    }
  });
  return { entries: rows.length, weekStart, weekEnd: addDays(weekStart, 6) };
}

export async function getScheduleRange(fromKey: string, days: number) {
  await ensureMuezzinSchema();
  const toKey = addDays(fromKey, days - 1);
  return rowsOf(await db.execute(sql`
    SELECT s.date_key, s.slot, s.role, m.name
    FROM muezzin_schedule s JOIN muezzins m ON m.id = s.muezzin_id
    WHERE s.date_key BETWEEN ${fromKey} AND ${toKey}
    ORDER BY s.date_key`)).map((r) => ({
    dateKey: String(r.date_key),
    slot: String(r.slot) as Slot,
    role: (String(r.role ?? "muezzin") as Role),
    name: String(r.name),
  }));
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
  const duties = new Map<string, Array<{ slot: Slot; role: Role }>>();
  for (const e of entries) duties.set(e.name, [...(duties.get(e.name) ?? []), { slot: e.slot, role: e.role }]);

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
    // ترتيب المهام حسب وقت الصلاة، مع بيان الدور (مؤذن/ملازم). أذانا الجمعة بلا وصف دور.
    const ordered = [...slots].sort((a, b) => ALL_SLOT_ORDER[a.slot] - ALL_SLOT_ORDER[b.slot] || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
    const dutyText = ordered
      .map((d) => ((JUMUAH_SLOTS as readonly string[]).includes(d.slot) ? SLOT_MESSAGE[d.slot] : `${SLOT_MESSAGE[d.slot]} (${ROLE_LABEL[d.role]})`))
      .join(" ، ");
    const result = await sendWhatsAppTemplate(to, [name, `${weekdayOf(dateKey)} ${dateKey}`, dutyText]);
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
