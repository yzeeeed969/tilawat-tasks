import { type PrayerCode } from "../lib/prayer";
import { matchRecitationToTask, type MatchResult } from "./recitation-matcher";

export type { MatchResult } from "./recitation-matcher";

export type MatchInput = {
  platformId: number;
  reciterId: number;
  prayer: PrayerCode;
  hijriDay: number;
  hijriMonth: number;
  hijriYear?: number | null;
  dayNameInTitle: string | null;
  publishedAt: Date;
  // نوع التصوير المستفاد من علامة الوصف: affairs (*توثيق*) أو tv (*TV*).
  filmingMarker?: "affairs" | "tv";
};

// مطابقة مقطع يوتيوب بمهمة معلّقة — غلاف رفيع فوق المطابِق العام (recitation-matcher) بسلوك يوتيوب
// القائم كما هو: الهدف «بقارئ»، نافذة يوم المهمة أو اليوم التالي، وتصفية نوع التصوير
// (*TV* ⇐ تلفزيون فقط، وغير ذلك ⇐ الشؤون أو بلا نوع)، و«مراجعة» حين لا يطابق التاريخ.
export async function matchVideoToTask(input: MatchInput): Promise<MatchResult> {
  const marker = input.filmingMarker ?? "affairs";
  return matchRecitationToTask({
    platformId: input.platformId,
    target: { kind: "reciter", reciterId: input.reciterId },
    prayer: input.prayer,
    hijriDay: input.hijriDay,
    hijriMonth: input.hijriMonth,
    hijriYear: input.hijriYear ?? null,
    dayNameInTitle: input.dayNameInTitle,
    publishedAt: input.publishedAt,
    window: "same_or_next_day",
    filmingMarker: marker,
    noDateMatchAs: "review",
    noTaskReason: marker === "tv"
      ? "لا توجد مهمة يوتيوب «تصوير التلفزيون» معلّقة لهذا القارئ بهذه الصلاة (العلامة *TV*)."
      : "لا توجد مهمة يوتيوب «تصوير الشؤون» (أو بلا نوع) معلّقة لهذا القارئ بهذه الصلاة (العلامة *توثيق*).",
  });
}
