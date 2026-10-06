import { type PrayerCode } from "./prayer";
import {
  ARABIC_WEEKDAYS,
  findBarePrayers,
  findHijriDates,
  isPlausibleHijriDayMonth,
  normalizeDigits,
  normalizeForNameCheck,
} from "./recitation-text";

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

// ملاحظة: الأدوات النصية (الأرقام، تطبيع الاسم، التاريخ، كلمات الصلاة) مشتركة في lib/recitation-text.ts
// مع توثيق تلقرام. السنة الهجرية صارت عامة (1440–1499) بدل 1448 المثبّتة؛ بقية السلوك كما هو حرفيًا.

export function parseYoutubeTitle(rawTitle: string, shaikhConstant: string): TitleParseResult {
  const title = normalizeDigits(rawTitle ?? "").trim();

  const titleForNameCheck = normalizeForNameCheck(title);
  const shaikhConstantForNameCheck = normalizeForNameCheck(shaikhConstant);
  if (!shaikhConstantForNameCheck || !titleForNameCheck.includes(shaikhConstantForNameCheck)) {
    return { ok: false, reason: `العنوان لا يحتوي الاسم الثابت "${shaikhConstant}"` };
  }

  const dateMatches = findHijriDates(title, "dash");
  if (dateMatches.length === 0) {
    return { ok: false, reason: "لا يوجد تاريخ هجري بصيغة يوم-شهر-سنة (مثل 16-4-1448) في العنوان" };
  }
  if (dateMatches.length > 1) {
    return { ok: false, reason: "أكثر من تاريخ هجري في العنوان — التباس" };
  }

  const dateMatch = dateMatches[0];
  const hijriDay = dateMatch.day;
  const hijriMonth = dateMatch.month;
  const hijriYear = dateMatch.year;
  if (!isPlausibleHijriDayMonth(hijriDay, hijriMonth)) {
    return { ok: false, reason: "رقم اليوم أو الشهر في التاريخ غير منطقي" };
  }

  // نطاق البحث عن الصلاة: من آخر "|" قبل التاريخ (أو بداية العنوان) وحتى التاريخ نفسه.
  // هذا يعزل غالبًا الجزء الوصفي (الذي قد يحمل اسم سورة) عن جزء "الصلاة + التاريخ".
  const dateIndex = dateMatch.index;
  const lastPipeBeforeDate = title.lastIndexOf("|", dateIndex);
  const windowStart = lastPipeBeforeDate >= 0 ? lastPipeBeforeDate + 1 : 0;
  const window = title.slice(windowStart, dateIndex);

  const foundPrayers = findBarePrayers(window);

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

  return { ok: true, prayer, hijriDay, hijriMonth, hijriYear, dayNameInTitle };
}
