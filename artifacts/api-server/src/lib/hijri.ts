// أدوات هجرية للخادم — تعتمد كليًا على Intl المدمجة في Node (تقويم islamic-umalqura بتوقيت
// الرياض)، وهي نفس الآلية المستخدمة في واجهة المتصفح (artifacts/tilawat-tasks/src/lib/hijri-date.ts).
// عمدًا لا نكتب أي حساب هجري يدوي جديد: نقارن أرقامًا فقط، فما يراه المدير في الواجهة هو
// بالضبط ما يقارنه مطابِق يوتيوب.

const RIYADH_TZ = "Asia/Riyadh";

const HIJRI_PARTS_FORMATTER = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
  timeZone: RIYADH_TZ,
  day: "numeric",
  month: "numeric",
  year: "numeric",
});

const ARABIC_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ar-SA", {
  timeZone: RIYADH_TZ,
  weekday: "long",
});

const RIYADH_DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: RIYADH_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function hijriPartsOf(date: Date): { day: number; month: number; year: number } {
  const parts = HIJRI_PARTS_FORMATTER.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { day: get("day"), month: get("month"), year: get("year") };
}

// اسم اليوم العربي (مثل "السبت") بتوقيت الرياض، لمقارنته باسم اليوم المذكور في عنوان المقطع.
export function arabicWeekdayOf(date: Date): string {
  return ARABIC_WEEKDAY_FORMATTER.format(date);
}

// مفتاح اليوم الميلادي (YYYY-MM-DD) بتوقيت الرياض — للمقارنة بين تاريخين بلا وقت.
export function riyadhDayKey(date: Date): string {
  return RIYADH_DAY_KEY_FORMATTER.format(date);
}

// هل وقع نشر المقطع (publishedAt) في نفس يوم استحقاق المهمة (dueDate) أو اليوم التالي له،
// بتوقيت الرياض؟ (شرط وقت النشر المتّفق عليه).
export function isPublishedWithinTaskWindow(publishedAt: Date, dueDate: Date): boolean {
  const dueDayKey = riyadhDayKey(dueDate);
  const nextDayKey = riyadhDayKey(new Date(dueDate.getTime() + 24 * 60 * 60 * 1000));
  const publishedDayKey = riyadhDayKey(publishedAt);
  return publishedDayKey === dueDayKey || publishedDayKey === nextDayKey;
}
