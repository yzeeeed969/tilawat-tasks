// رموز الصلاة الداخلية المخزَّنة في tasks.prayer. تُستخدم للتخزين والمطابقة فقط؛
// العناوين والواجهة تبقى بالعربية. الصلوات المدعومة: الفجر والمغرب والعشاء والجمعة.
export const PRAYER_CODES = ["fajr", "maghrib", "isha", "jumuah"] as const;

export type PrayerCode = (typeof PRAYER_CODES)[number];

export class InvalidPrayerError extends Error {
  constructor() {
    super("Invalid prayer");
    this.name = "InvalidPrayerError";
  }
}

// undefined / null / "" → null (لا صلاة). أي قيمة أخرى غير معروفة ترمي InvalidPrayerError.
export function parsePrayerCode(value: unknown): PrayerCode | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && (PRAYER_CODES as readonly string[]).includes(value)) {
    return value as PrayerCode;
  }
  throw new InvalidPrayerError();
}
