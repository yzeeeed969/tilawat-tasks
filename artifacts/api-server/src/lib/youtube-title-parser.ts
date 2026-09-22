import { type PrayerCode } from "./prayer";

// استخراج الثوابت (الاسم + الصلاة + التاريخ الهجري) من عنوان مقطع يوتيوب.
// وحدة نقية بلا اتصال بقاعدة بيانات — مبنية على تحليل عيّنة عناوين حقيقية (المرحلة صفر).

export type TitleParseResult =
  | {
      ok: true;
      prayer: PrayerCode;
      hijriDay: number;
      hijriMonth: number;
      hijriYear: number;
      // اسم اليوم المذكور في العنوان قرب التاريخ (إن وُجد) — للتحقق المتقاطع مع تاريخ المهمة.
      dayNameInTitle: string | null;
    }
  | { ok: false; reason: string };

const EASTERN_ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => EASTERN_ARABIC_DIGITS[d] ?? d);
}

// كلمات الصلاة الصريحة (فجر/مغرب/عشاء). نستبعد أي ظهور مسبوق مباشرة بـ"ال" بلا مسافة
// (اسم سورة مثل "الفجر"/"المغرب" لا يوجد لكن للاطراد؛ الحالة الحقيقية المرصودة: "الفجر" كسورة
// ضمن "سورتي الفجر والبلد") — القناة تكتب علامة الصلاة نفسها بصيغة "عارية" دائمًا.
const BARE_PRAYER_WORDS: Record<string, PrayerCode> = {
  "فجر": "fajr",
  "مغرب": "maghrib",
  "عشاء": "isha",
};

const ARABIC_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// يوم-شهر-1448[هـ]. السنة 1448 ثابتة حاليًا بحسب عيّنة عناوين هذا الموسم.
const DATE_REGEX = /(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*1448\s*(?:هـ)?/g;

export function parseYoutubeTitle(rawTitle: string, shaikhConstant: string): TitleParseResult {
  const title = normalizeDigits(rawTitle ?? "").trim();

  if (!shaikhConstant || !title.includes(shaikhConstant)) {
    return { ok: false, reason: `العنوان لا يحتوي الاسم الثابت "${shaikhConstant}"` };
  }

  const dateMatches = [...title.matchAll(DATE_REGEX)];
  if (dateMatches.length === 0) {
    return { ok: false, reason: "لا يوجد تاريخ هجري بصيغة يوم-شهر-1448 في العنوان" };
  }
  if (dateMatches.length > 1) {
    return { ok: false, reason: "أكثر من تاريخ هجري في العنوان — التباس" };
  }

  const dateMatch = dateMatches[0];
  const hijriDay = Number(dateMatch[1]);
  const hijriMonth = Number(dateMatch[2]);
  if (hijriDay < 1 || hijriDay > 30 || hijriMonth < 1 || hijriMonth > 12) {
    return { ok: false, reason: "رقم اليوم أو الشهر في التاريخ غير منطقي" };
  }

  // نطاق البحث عن الصلاة: من آخر "|" قبل التاريخ (أو بداية العنوان) وحتى التاريخ نفسه.
  // هذا يعزل غالبًا الجزء الوصفي (الذي قد يحمل اسم سورة) عن جزء "الصلاة + التاريخ".
  const dateIndex = dateMatch.index ?? 0;
  const lastPipeBeforeDate = title.lastIndexOf("|", dateIndex);
  const windowStart = lastPipeBeforeDate >= 0 ? lastPipeBeforeDate + 1 : 0;
  const window = title.slice(windowStart, dateIndex);

  const foundPrayers = new Set<PrayerCode>();
  for (const [word, code] of Object.entries(BARE_PRAYER_WORDS)) {
    // (?<!ال) تستبعد الظهور الملتصق بأداة التعريف (اسم سورة)، وتقبل فقط الكلمة "العارية".
    const re = new RegExp(`(?<!ال)${word}`);
    if (re.test(window)) foundPrayers.add(code);
  }

  let prayer: PrayerCode | null = null;
  if (foundPrayers.size === 1) {
    prayer = [...foundPrayers][0];
  } else if (foundPrayers.size > 1) {
    return { ok: false, reason: `أكثر من صلاة واضحة في العنوان (${[...foundPrayers].join("، ")})` };
  } else {
    // لا فجر/مغرب/عشاء صريحة — نبحث عن "جمعة"/"الجمعة" كنوع صلاة، فقط في غياب الثلاثة الأخرى
    // (لأن "الجمعة" قد تكون اسم يوم مصاحبًا لفجر/مغرب/عشاء، لا نوع صلاة بذاتها — كما في
    // "فجر الجمعة" ضمن عيّنة المرحلة صفر).
    if (/جمعة/.test(window)) {
      prayer = "jumuah";
    }
  }

  if (!prayer) {
    return { ok: false, reason: "تعذّر تحديد نوع الصلاة من العنوان" };
  }

  const dayNameInTitle = ARABIC_WEEKDAYS.find((day) => window.includes(day)) ?? null;

  return { ok: true, prayer, hijriDay, hijriMonth, hijriYear: 1448, dayNameInTitle };
}
