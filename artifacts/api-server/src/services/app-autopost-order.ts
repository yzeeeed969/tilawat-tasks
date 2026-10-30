// ترتيب النشر التلقائي في قناة «تطبيق تلاوات الحرمين» خلال اليوم (الإصدار 73، قرار المدير 30-10-2026):
//   الفجر (المكي ثم النبوي)
//   ← يوم الجمعة: الخطبة (المكي ثم النبوي) ← صلاة الجمعة (المكي ثم النبوي)
//   ← المغرب (المكي ثم النبوي)
//   ← العشاء (المكي ثم النبوي)
// لا تُنشر مرحلة قبل أن تُنشر المرحلة السابقة للمسجدين معًا (تلقائيًا أو يدويًا في القناة).
// الانتظار مفتوح، وبعد ساعة يصل المدير تنبيه واحد بما ينقص.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

const PRAYER_CODE: Record<string, string> = { "فجر": "fajr", "مغرب": "maghrib", "عشاء": "isha", "جمعة": "jumuah" };
export const STAGE_LABEL: Record<string, string> = { "فجر": "الفجر", "خطبة": "خطبة الجمعة", "جمعة": "صلاة الجمعة", "مغرب": "المغرب", "عشاء": "العشاء" };

// المرحلة السابقة لكل مرحلة. isFriday: هل اليوم جمعة.
export function previousStage(stage: string, isFriday: boolean): string | null {
  if (stage === "فجر") return null;
  if (stage === "خطبة") return "فجر";
  if (stage === "جمعة") return "خطبة";
  if (stage === "مغرب") return isFriday ? "جمعة" : "فجر";
  if (stage === "عشاء") return "مغرب";
  return null;
}

// هل نُشرت صلاة معيّنة للمسجدين في القناة لهذا اليوم الهجري؟
async function prayerPostedBoth(prayer: string, day: number, month: number): Promise<boolean> {
  const code = PRAYER_CODE[prayer] ?? prayer;
  const rows = rowsOf(await db.execute(sql`
    SELECT DISTINCT mosque FROM telegram_channel_posts WHERE kind = 'recitation' AND extracted_prayer = ${code}
      AND hijri_day = ${day} AND hijri_month = ${month} AND mosque IN ('haram','nabawi') AND published_at > now() - interval '3 days'`));
  const mosques = new Set(rows.map((r) => String(r.mosque)));
  if (mosques.has("haram") && mosques.has("nabawi")) return true;
  // أو نشرها النظام نفسه (احتياط إن تأخر توثيق المنشور).
  const own = rowsOf(await db.execute(sql`
    SELECT DISTINCT mosque FROM app_tg_autopost WHERE status = 'posted' AND prayer = ${prayer} AND hijri_key LIKE ${`${day}-${month}-%`}
      AND posted_at > now() - interval '3 days'`).catch(() => [] as any));
  for (const r of own) mosques.add(r.mosque === "makkah" ? "haram" : r.mosque === "madinah" ? "nabawi" : String(r.mosque));
  return mosques.has("haram") && mosques.has("nabawi");
}

// هل نُشرت خطبتا الجمعة (المكي والنبوي) لهذا التاريخ الميلادي؟
async function khutbahsPostedBoth(gregorianKey: string): Promise<boolean> {
  const own = rowsOf(await db.execute(sql`
    SELECT DISTINCT mosque FROM app_tg_khutbah_autopost WHERE status IN ('posted') AND date_key = ${gregorianKey}`).catch(() => [] as any));
  const mosques = new Set(own.map((r) => String(r.mosque)));
  if (mosques.has("makkah") && mosques.has("madinah")) return true;
  // أو نُشرتا يدويًا في القناة (صيغة الفريق «خطبة الجمعة للشيخ …» وفيها التاريخ الميلادي).
  const manual = rowsOf(await db.execute(sql`
    SELECT count(*)::int AS n FROM telegram_channel_posts WHERE caption LIKE 'خطبة الجمعة%' AND caption LIKE ${`%${gregorianKey}%`}
      AND published_at > now() - interval '3 days'`));
  return Number(manual[0]?.n ?? 0) >= 2;
}

// اليوم الهجري (أم القرى) لتاريخ ميلادي «يوم-شهر-سنة».
const UMM_AL_QURA = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { timeZone: "Asia/Riyadh", day: "numeric", month: "numeric", year: "numeric" });
export function hijriOfGregorian(gregorianKey: string): { day: number; month: number } | null {
  const m = gregorianKey.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 9)); // ظهرًا بتوقيت الرياض
  const p = Object.fromEntries(UMM_AL_QURA.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: Number(p.month) };
}
export function isFridayGregorian(gregorianKey: string): boolean {
  const m = gregorianKey.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return false;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).getUTCDay() === 5;
}

// هل اكتملت المرحلة السابقة؟ يُرجع اسم المرحلة الناقصة أو null إن لا مانع.
export async function missingPreviousStage(stage: string, ctx: { hijriDay: number; hijriMonth: number; gregorianKey: string | null; isFriday: boolean }): Promise<string | null> {
  const prev = previousStage(stage, ctx.isFriday);
  if (!prev) return null;
  if (prev === "خطبة") {
    if (!ctx.gregorianKey) return null; // لا نستطيع التحقق ⇐ لا نعطّل النشر
    return (await khutbahsPostedBoth(ctx.gregorianKey)) ? null : prev;
  }
  return (await prayerPostedBoth(prev, ctx.hijriDay, ctx.hijriMonth)) ? null : prev;
}
