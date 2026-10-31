// النشر التلقائي لخطب الجمعة (الإصدار 72، اعتماد المدير 30-10-2026):
// كل خطبة جمعة جديدة تُضاف في التطبيق (منوعات ← خطب الحرم المكي / خطب الحرم النبوي ← قسم السنة الحالية)
// تُرسل ملفًا صوتيًا إلى قناة تيليجرام «تطبيق تلاوات الحرمين» بنفس صيغة الفريق:
//
//   خطبة الجمعة للشيخ #اسم_الخطيب
//
//   <عنوان الخطبة>
//
//   https://tilawatalharamain.com/m/<الرقم>
//
//   تمت المشاركة من 📱| #تطبيق_تلاوات_الحرمين
//   https://tilawatalharamain.com
//
// الضمانات:
//  • الحديث فقط: تاريخ الخطبة الميلادي في العنوان (مثل 30-10-2026) هو اليوم أو الأمس بتوقيت الرياض.
//  • لا تكرار: سجل app_tg_khutbah_autopost بمفتاح فريد، وإن نُشرت الخطبة يدويًا في القناة (رابطها /m/<الرقم>)
//    لا تُنشر مرة ثانية.
//  • الترتيب (الإصدار 74): خطبة المكي ← صلاة جمعة المكي ← خطبة النبوي ← صلاة جمعة النبوي، وبعد ساعة انتظار تنبيه واحد للمدير.
//  • لا نشر ناقص: إن تعذّر تحديد الخطيب أو الملف ⇐ لا نشر + تنبيه للمدير.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { sendTelegramAudioUpload } from "./telegram";
import { compressAudioForTelegram } from "./audio-compress";
import { processTelegramPost, storeChannelUpdate } from "./telegram-channel-monitor";
import { notifyTelegramAdminsGeneric } from "./telegram-notification-engine";
import { hijriOfGregorian, missingPreviousStage, prayerPostedFor } from "./app-autopost-order";

const SITE = "https://tilawatalharamain.com";
// القسمان الرئيسيان في «منوعات»؛ تحت كل منهما قسم لكل سنة هجرية (يُختار الأحدث تلقائيًا).
export const PARENTS: Record<Mosque, number> = { makkah: 37, madinah: 38 };
const MAX_ATTEMPTS = 3;
const MAX_BYTES = 49 * 1024 * 1024;

export type Mosque = "makkah" | "madinah";
type Entry = { id: number; title: string; reciter: string; mosque: Mosque; dateKey: string };

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_tg_khutbah_autopost (
          misc_id integer PRIMARY KEY,
          status text NOT NULL,
          reason text,
          title text,
          reciter text,
          mosque text,
          date_key text,
          message_id bigint,
          attempts integer NOT NULL DEFAULT 1,
          created_at timestamp NOT NULL DEFAULT now(),
          posted_at timestamp
        )`);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "TilawatTasksBot/1.0" } });
    return res.status === 200 ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

// تاريخ اليوم بتوقيت الرياض بصيغة «يوم-شهر-سنة» بلا أصفار بادئة (مثل 30-10-2026).
function riyadhDateKey(date: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "numeric", month: "numeric", year: "numeric" }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${Number(p.day)}-${Number(p.month)}-${Number(p.year)}`;
}
function isRecent(dateKey: string): boolean {
  const now = Date.now();
  return [0, -1].some((d) => riyadhDateKey(new Date(now + d * 86_400_000)) === dateKey);
}
// التاريخ الميلادي في آخر العنوان: «… | Khutbah Jumu’ah 30-10-2026».
function gregorianKeyOf(title: string): string | null {
  const m = title.match(/(\d{1,2})-(\d{1,2})-(20\d\d)\s*$/);
  return m ? `${Number(m[1])}-${Number(m[2])}-${m[3]}` : null;
}

// قسم السنة الأحدث تحت القسم الرئيسي (أكبر رقم «عام 14xx»).
export async function currentYearCategory(parentId: number): Promise<number | null> {
  const html = await fetchText(`${SITE}/miscellanies/c/${parentId}`);
  if (!html) return null;
  let best: { id: number; year: number } | null = null;
  for (const m of html.matchAll(/miscellanies\/c\/(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/g)) {
    const year = Number(m[2].match(/عام\s*(14\d\d)/)?.[1] ?? 0);
    if (year && (!best || year > best.year)) best = { id: Number(m[1]), year };
  }
  return best?.id ?? null;
}

// قائمة القسم: لكل خطبة رابطها ثم عنوانها ثم اسم الخطيب.
async function listEntries(mosque: Mosque): Promise<Entry[]> {
  const categoryId = await currentYearCategory(PARENTS[mosque]);
  if (!categoryId) return [];
  const html = await fetchText(`${SITE}/miscellanies/c/${categoryId}`);
  if (!html) return [];
  const entries = new Map<number, Entry>();
  for (const m of html.matchAll(/\/miscellanies\/(\d+)"/g)) {
    const id = Number(m[1]);
    if (entries.has(id)) continue;
    const chunk = html.slice(m.index ?? 0, (m.index ?? 0) + 2000).replace(/<[^>]*>/g, "\n");
    const texts = chunk.split("\n").map((t) => decodeHtml(t).replace(/\s+/g, " ").trim()).filter((t) => t && !t.startsWith("/miscellanies/") && !t.startsWith('"'));
    const title = texts[0] ?? "";
    const reciter = (texts[1] ?? "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
    if (!/^خطبة\s+الجمعة/.test(title)) continue;
    const dateKey = gregorianKeyOf(title);
    if (!dateKey) continue;
    entries.set(id, { id, title, reciter: reciter.length <= 40 ? reciter : "", mosque, dateKey });
  }
  return [...entries.values()];
}

async function recitationsChannel() {
  const [row] = rowsOf(await db.execute(sql`SELECT id, chat_id FROM telegram_channels WHERE kind = 'recitations' AND enabled = true ORDER BY id LIMIT 1`));
  return row ? { id: Number(row.id), chatId: String(row.chat_id) } : null;
}

// هل نُشرت هذه الخطبة في القناة (يدويًا أو منّا)؟ رابطها في المنشور: /m/<الرقم>.
async function postedInChannel(id: number): Promise<boolean> {
  const [row] = rowsOf(await db.execute(sql`
    SELECT 1 FROM telegram_channel_posts WHERE published_at > now() - interval '4 days'
      AND (caption ~ ${`tilawatalharamain\\.com/m/${id}([^0-9]|$)`} OR site_url ~ ${`/m/${id}([^0-9]|$)`}) LIMIT 1`).catch(() => [] as any));
  return Boolean(row);
}

async function claim(id: number): Promise<boolean> {
  const rows = rowsOf(await db.execute(sql`
    INSERT INTO app_tg_khutbah_autopost (misc_id, status, attempts) VALUES (${id}, 'posting', 1)
    ON CONFLICT (misc_id) DO UPDATE SET status = 'posting', reason = NULL,
      attempts = CASE WHEN app_tg_khutbah_autopost.status = 'waiting' THEN app_tg_khutbah_autopost.attempts ELSE app_tg_khutbah_autopost.attempts + 1 END
    WHERE app_tg_khutbah_autopost.status = 'waiting'
      OR app_tg_khutbah_autopost.status = 'failed' AND app_tg_khutbah_autopost.attempts < ${MAX_ATTEMPTS}
      OR (app_tg_khutbah_autopost.status = 'posting' AND app_tg_khutbah_autopost.created_at < now() - interval '20 minutes')
    RETURNING misc_id`));
  return rows.length > 0;
}

async function finish(e: Entry, status: string, reason: string | null = null, messageId: number | null = null) {
  await db.execute(sql`UPDATE app_tg_khutbah_autopost SET status = ${status}, reason = ${reason}, title = ${e.title}, reciter = ${e.reciter || null},
    mosque = ${e.mosque}, date_key = ${e.dateKey}, message_id = ${messageId}, posted_at = ${status === "posted" ? new Date() : null} WHERE misc_id = ${e.id}`);
}

async function alertAdmin(e: Entry, reason: string) {
  await notifyTelegramAdminsGeneric({
    title: "خطبة لم تُنشر تلقائيًا في قناة التطبيق",
    lines: [`الخطبة: ${e.title}`, `الرابط: ${SITE}/m/${e.id}`, `السبب: ${reason}`, "", "انشرها يدويًا في القناة."],
    alertKey: `app_khutbah_autopost:${e.id}`,
  }).catch(() => {});
}

async function handle(e: Entry, channel: { chatId: string }) {
  if (!(await claim(e.id))) return;
  if (await postedInChannel(e.id)) return finish(e, "skipped", "نُشرت في القناة يدويًا");
  const fail = async (reason: string, final = true) => { await finish(e, "failed", reason); if (final) await alertAdmin(e, reason); };
  if (!e.reciter) return fail("تعذّر تحديد اسم الخطيب من قائمة الخطب");

  // ترتيب اليوم (الإصدار 73): الخطبتان بعد نشر الفجر للمسجدين.
  const h = hijriOfGregorian(e.dateKey);
  if (h && (await missingPreviousStage("خطبة", { hijriDay: h.day, hijriMonth: h.month, gregorianKey: e.dateKey, isFriday: true }))) {
    await db.execute(sql`UPDATE app_tg_khutbah_autopost SET status = 'waiting', reason = 'بانتظار نشر الفجر للمسجدين', title = ${e.title}, reciter = ${e.reciter},
      mosque = ${e.mosque}, date_key = ${e.dateKey} WHERE misc_id = ${e.id}`);
    return;
  }
  // خطبة النبوي بعد صلاة جمعة المسجد الحرام (الإصدار 74: خطبة المكي ← صلاته ← خطبة النبوي ← صلاته).
  if (e.mosque === "madinah" && h && !(await prayerPostedFor("جمعة", "haram", h.day, h.month))) {
    await db.execute(sql`UPDATE app_tg_khutbah_autopost SET status = 'waiting', reason = 'بانتظار صلاة الجمعة في المسجد الحرام', title = ${e.title}, reciter = ${e.reciter},
      mosque = ${e.mosque}, date_key = ${e.dateKey} WHERE misc_id = ${e.id}`);
    const [row] = rowsOf(await db.execute(sql`SELECT created_at < now() - interval '60 minutes' AS late FROM app_tg_khutbah_autopost WHERE misc_id = ${e.id}`));
    if (row?.late) {
      await notifyTelegramAdminsGeneric({
        title: "خطبة المسجد النبوي تنتظر صلاة الجمعة في المسجد الحرام",
        lines: [`الخطبة: ${e.title}`, `الرابط: ${SITE}/m/${e.id}`, "مضت ساعة ولم تُنشر صلاة الجمعة في المسجد الحرام.", "", "ستُنشر تلقائيًا فور نشرها (تلقائيًا أو يدويًا في القناة)."],
        alertKey: `app_khutbah_order:${e.id}`,
      }).catch(() => {});
    }
    return;
  }

  const page = await fetchText(`${SITE}/miscellanies/${e.id}`);
  if (!page) return fail("تعذّرت قراءة صفحة الخطبة", false);
  const audioUrl = decodeHtml(page.match(/(?:href|src)="(https?:\/\/[^"]+\.(?:mp3|m4a))(?:\?[^"]*)?"/i)?.[1] ?? "");
  if (!audioUrl) return fail("لا يوجد رابط ملف صوتي في صفحة الخطبة");
  const ext = /\.m4a$/i.test(audioUrl) ? "m4a" : "mp3";

  const audio = await fetch(audioUrl).catch(() => null);
  if (!audio || !audio.ok) return fail(`تعذّر تنزيل الملف الصوتي (${audio?.status ?? "خطأ اتصال"})`, false);
  let blob = await audio.blob();
  if (blob.size < 10_000) return fail("الملف الصوتي فارغ أو تالف", false);
  // الملف أكبر من حد تيليجرام ⇐ يُضغط ثم يُرسل (الإصدار 75، اعتماد المدير).
  let compressed = false;
  if (blob.size > MAX_BYTES) {
    try { blob = await compressAudioForTelegram(blob, MAX_BYTES); compressed = true; }
    catch (err) { return fail((err as Error).message); }
  }

  const caption = [`خطبة الجمعة للشيخ #${e.reciter.replace(/\s+/g, "_")}`, "", e.title, "", `${SITE}/m/${e.id}`, "", "تمت المشاركة من 📱| #تطبيق_تلاوات_الحرمين", SITE].join("\n");
  const fileName = `خطبة الجمعة ${e.reciter} ${e.dateKey}.${compressed ? "mp3" : ext}`;
  const sent = await sendTelegramAudioUpload({ chatId: channel.chatId, file: blob, fileName, caption });
  if (!sent.ok) return fail(`رفض تيليجرام النشر: ${sent.error}`, false);
  await finish(e, "posted", null, Number(sent.result?.message_id ?? 0) || null);
  try {
    const stored = await storeChannelUpdate({ channel_post: sent.result });
    if (stored) await processTelegramPost(stored);
  } catch { /* يُعاد في الفحص الدوري لمراقبة تلقرام */ }
}

let running = false;
export async function runKhutbahAutopost(): Promise<{ posted: number }> {
  if (running) return { posted: 0 };
  running = true;
  try {
    await ensureSchema();
    const [s] = rowsOf(await db.execute(sql`SELECT enabled FROM app_tg_autopost_settings WHERE id = 1`).catch(() => [] as any));
    if (s && s.enabled === false) return { posted: 0 }; // نفس مفتاح تشغيل/إيقاف النشر التلقائي للتلاوات
    const channel = await recitationsChannel();
    if (!channel) return { posted: 0 };
    const makkah = await listEntries("makkah");
    const madinah = await listEntries("madinah");
    const handled = new Set(rowsOf(await db.execute(sql`SELECT misc_id FROM app_tg_khutbah_autopost WHERE status IN ('posted','skipped') OR (status = 'failed' AND attempts >= ${MAX_ATTEMPTS})`)).map((r) => Number(r.misc_id)));
    let posted = 0;
    for (const e of [...makkah, ...madinah]) {
      if (handled.has(e.id) || !isRecent(e.dateKey)) continue;
      await handle(e, channel).catch(() => {});
      const [row] = rowsOf(await db.execute(sql`SELECT status FROM app_tg_khutbah_autopost WHERE misc_id = ${e.id}`));
      if (row?.status === "posted") posted += 1;
    }
    return { posted };
  } finally {
    running = false;
  }
}

export async function khutbahAutopostOverview() {
  await ensureSchema();
  return rowsOf(await db.execute(sql`SELECT misc_id, status, reason, title, reciter, mosque, attempts, created_at, posted_at FROM app_tg_khutbah_autopost ORDER BY misc_id DESC LIMIT 20`));
}
