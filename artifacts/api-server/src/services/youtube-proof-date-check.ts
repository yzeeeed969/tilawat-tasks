import { eq, sql } from "drizzle-orm";
import { db, platformsTable, tasksTable, youtubeChannelsTable, youtubeVideosTable } from "@workspace/db";
import { type PrayerCode } from "../lib/prayer";
import { arabicWeekdayOf, hijriPartsOf, safeAnchorFromDateKey } from "../lib/hijri";
import { ARABIC_WEEKDAYS, findBarePrayers, findHijriDates, isPlausibleHijriDayMonth, normalizeDigits } from "../lib/recitation-text";
import { fetchVideosDetails } from "./youtube-client";

// تحذير وقائي (لا منع) عند الإكمال/الربط اليدوي لمهمة يوتيوب برابط فيديو: نقرأ الصلاة والتاريخ الهجري
// واسم اليوم من عنوان الفيديو ونقارنها بالمهمة. تعذّر أي خطوة ⇐ بلا تحذير، فلا يتعطّل الإكمال أبدًا.
// لا يمسّ المطابقة التلقائية ولا تلقرام ولا التصاميم.

export type ProofDateDifference = "prayer" | "hijri_date" | "weekday";

export type ProofDateWarning = {
  differences: ProofDateDifference[];
  videoLabel: string;
  taskLabel: string;
  message: string;
};

const PRAYER_WORDS: Record<PrayerCode, string> = { fajr: "فجر", maghrib: "مغرب", isha: "عشاء", jumuah: "جمعة" };
const DIFFERENCE_LABELS: Record<ProofDateDifference, string> = { prayer: "الصلاة", hijri_date: "التاريخ الهجري", weekday: "اليوم" };

// youtu.be/ID، watch?v=ID، shorts/ID، live/ID، embed/ID (مع www. أو m. أو بدونهما). غير ذلك ⇐ ليس رابط فيديو يوتيوب.
export function extractYoutubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  const valid = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (host === "youtu.be") return valid(url.pathname.split("/")[1]);
  if (host !== "youtube.com") return null;
  if (url.pathname === "/watch") return valid(url.searchParams.get("v"));
  const [, kind, id] = url.pathname.split("/");
  return ["shorts", "live", "embed"].includes(kind) ? valid(id) : null;
}

export type TitleFacts = { prayer: PrayerCode | null; day: number; month: number; year: number; dayName: string | null };

// نفس قراءة عناوين يوتيوب (المحلّل المشترك + نافذة ما بين آخر "|" والتاريخ)، لكن بلا شرط اسم الشيخ:
// يكفي هنا وجود تاريخ هجري واحد واضح. الصلاة/اليوم اختياريان — غيابهما لا يمنع مقارنة التاريخ.
export function readTitleFacts(rawTitle: string): TitleFacts | null {
  const title = normalizeDigits(rawTitle ?? "").trim();
  const dates = findHijriDates(title, "dash");
  if (dates.length !== 1) return null;
  const { day, month, year, index } = dates[0];
  if (!isPlausibleHijriDayMonth(day, month)) return null;

  const lastPipe = title.lastIndexOf("|", index);
  const window = title.slice(lastPipe >= 0 ? lastPipe + 1 : 0, index);
  const prayers = findBarePrayers(window);
  let prayer: PrayerCode | null = null;
  if (prayers.size === 1) prayer = [...prayers][0];
  else if (prayers.size === 0 && /جمعة/.test(window)) prayer = "jumuah";

  const dayName = ARABIC_WEEKDAYS.find((name) => window.includes(name)) ?? null;
  return { prayer, day, month, year, dayName };
}

function label(prayer: PrayerCode | null, dayName: string | null, date: { day: number; month: number; year: number }) {
  const prayerWord = prayer ? PRAYER_WORDS[prayer] : null;
  // «جمعة الجمعة» تكرار — نكتفي بالكلمة مرة واحدة.
  const dayWord = prayer === "jumuah" && dayName === "الجمعة" ? null : dayName;
  return [prayerWord, dayWord, `${date.day}-${date.month}-${date.year}`].filter(Boolean).join(" ");
}

export function compareTitleWithTask(
  title: string,
  task: { dueDateKey: string; prayer: string | null },
): ProofDateWarning | null {
  const facts = readTitleFacts(title);
  if (!facts) return null;

  const anchor = safeAnchorFromDateKey(task.dueDateKey);
  const taskHijri = hijriPartsOf(anchor);
  const taskDayName = arabicWeekdayOf(anchor);
  const taskPrayer = (task.prayer && task.prayer in PRAYER_WORDS ? task.prayer : null) as PrayerCode | null;

  const differences: ProofDateDifference[] = [];
  if (facts.prayer && taskPrayer && facts.prayer !== taskPrayer) differences.push("prayer");
  if (facts.day !== taskHijri.day || facts.month !== taskHijri.month || facts.year !== taskHijri.year) differences.push("hijri_date");
  if (facts.dayName && facts.dayName !== taskDayName) differences.push("weekday");
  if (differences.length === 0) return null;

  const videoLabel = label(facts.prayer, facts.dayName, facts);
  const taskLabel = label(taskPrayer, taskDayName, taskHijri);
  const what = differences.map((d) => DIFFERENCE_LABELS[d]).join(" و");
  return {
    differences,
    videoLabel,
    taskLabel,
    message: `هذا الفيديو (${videoLabel}) يختلف عن المهمة (${taskLabel}) في: ${what}. هل أنت متأكد من الربط؟`,
  };
}

// مهمة يوتيوب = منصتها مربوطة بقناة في مراقبة يوتيوب، أو اسم منصتها يحوي «يوتيوب/YouTube».
async function isYoutubePlatform(platformId: number): Promise<boolean> {
  const [platform] = await db.select({ name: platformsTable.name }).from(platformsTable).where(eq(platformsTable.id, platformId)).limit(1);
  if (platform && /يوتيوب|youtube/i.test(platform.name)) return true;
  try {
    const [channel] = await db.select({ id: youtubeChannelsTable.id }).from(youtubeChannelsTable).where(eq(youtubeChannelsTable.platformId, platformId)).limit(1);
    return Boolean(channel);
  } catch {
    return false;
  }
}

// العنوان: من المقاطع المخزَّنة في مراقبة يوتيوب أولًا (بلا أي اتصال)، وإلا استدعاء واحد لواجهة يوتيوب.
async function lookupVideoTitle(videoId: string): Promise<string | null> {
  try {
    const [stored] = await db.select({ title: youtubeVideosTable.title }).from(youtubeVideosTable).where(eq(youtubeVideosTable.videoId, videoId)).limit(1);
    if (stored?.title) return stored.title;
  } catch {
    // جدول المقاطع غير متاح — نكمل للواجهة.
  }
  try {
    const [details] = await fetchVideosDetails([videoId]);
    return details?.title || null;
  } catch {
    return null; // لا مفتاح، أو فشل الاتصال ⇐ بلا تحذير.
  }
}

export async function checkYoutubeProofDate(taskId: number, url: string): Promise<ProofDateWarning | null> {
  try {
    const videoId = extractYoutubeVideoId(url);
    if (!videoId) return null;
    const [task] = await db
      .select({
        platformId: tasksTable.platformId,
        prayer: tasksTable.prayer,
        dueDateKey: sql<string | null>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')`,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    if (!task?.dueDateKey || !task.platformId) return null;
    if (!(await isYoutubePlatform(task.platformId))) return null;
    const title = await lookupVideoTitle(videoId);
    if (!title) return null;
    return compareTitleWithTask(title, { dueDateKey: task.dueDateKey, prayer: task.prayer });
  } catch {
    return null;
  }
}
