import { type PrayerCode } from "./prayer";

// أدوات نصية مشتركة لاستخراج ثوابت التلاوة (الصلاة + التاريخ الهجري) من نصوص المنصات
// (عناوين يوتيوب، ونصوص منشورات تلقرام). وحدة نقية بلا قاعدة بيانات.

const EASTERN_ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => EASTERN_ARABIC_DIGITS[d] ?? d);
}

// نسخة مطبَّعة لفحص اسم الشيخ فقط: نزيل #، ونحوّل _ إلى مسافة، ونوحّد المسافات — فيُقرأ الاسم سواء كُتب
// عاديًا ("ماهر المعيقلي") أو وسمًا مركّبًا ("#ماهر_المعيقلي").
export function normalizeForNameCheck(text: string): string {
  return text
    .replace(/#/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// السنوات الهجرية المقبولة: عامة (1448، 1449، وما بعدها) ضمن نطاق منطقي يمنع التقاط أرقام عشوائية.
export const MIN_HIJRI_YEAR = 1440;
export const MAX_HIJRI_YEAR = 1499;

export type HijriDateMatch = { day: number; month: number; year: number; index: number; length: number };

// كل أنواع الشرطات اليونيكودية ⇐ شرطة عادية "-" (مثل «26—4—1448» أو «26–4–1448»).
// كلٌّ منها وحدة UTF-16 واحدة، فلا تتغيّر مواضع النص بعد الاستبدال. التطويل العربي «ـ» ليس فاصلًا فلا يُمس.
// ‐ ‑ ‒ – — ― − ﹘ ﹣ －
const DASH_VARIANTS = /[‐‑‒–—―−﹘﹣－]/g;

export function normalizeDashes(text: string): string {
  return text.replace(DASH_VARIANTS, "-");
}

// يوم-شهر-سنة. "dash" = الفاصل "-" فقط (صيغة عناوين يوتيوب كما هي). "flexible" = "-" أو "/" أو "." .
export function findHijriDates(text: string, separators: "dash" | "flexible" = "dash"): HijriDateMatch[] {
  const sep = separators === "dash" ? "-" : "[-/.]";
  const regex = new RegExp(`(\\d{1,2})\\s*${sep}\\s*(\\d{1,2})\\s*${sep}\\s*(14\\d{2})\\s*(?:هـ)?`, "g");
  const results: HijriDateMatch[] = [];
  for (const match of normalizeDashes(text).matchAll(regex)) {
    const year = Number(match[3]);
    if (year < MIN_HIJRI_YEAR || year > MAX_HIJRI_YEAR) continue;
    results.push({ day: Number(match[1]), month: Number(match[2]), year, index: match.index ?? 0, length: match[0].length });
  }
  return results;
}

export function isPlausibleHijriDayMonth(day: number, month: number) {
  return day >= 1 && day <= 30 && month >= 1 && month <= 12;
}

// كلمات الصلاة «العارية» (فجر/مغرب/عشاء) غير الملتصقة بأداة التعريف — صيغة عناوين يوتيوب.
const BARE_PRAYER_WORDS: Record<string, PrayerCode> = {
  "فجر": "fajr",
  "مغرب": "maghrib",
  "عشاء": "isha",
};

export function findBarePrayers(window: string): Set<PrayerCode> {
  const found = new Set<PrayerCode>();
  for (const [word, code] of Object.entries(BARE_PRAYER_WORDS)) {
    // (?<!ال) تستبعد الظهور الملتصق بأداة التعريف (اسم سورة مثل «الفجر»)، وتقبل الكلمة العارية فقط.
    if (new RegExp(`(?<!ال)${word}`).test(window)) found.add(code);
  }
  return found;
}

export const ARABIC_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
