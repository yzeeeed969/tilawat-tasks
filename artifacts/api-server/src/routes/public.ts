import { Router } from "express";
import { db, platformsTable, taskProofsTable, tasksTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

const router = Router();
const PROJECT_START_DATE = new Date(Date.UTC(2026, 4, 24, 0, 0, 0, 0));
const YOUTUBE_PUBLIC_STATS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/12ZWU7I0wZGuCjrED8dEZMMU32vrzqAD7BuPtwos7Z7c/gviz/tq?tqx=out:csv&sheet=public_stats&range=A1:B2";
const YOUTUBE_STATS_CACHE_TTL_MS = 30 * 60 * 1000;
const YOUTUBE_STATS_ERROR_CACHE_TTL_MS = 5 * 60 * 1000;

const periodOptions = {
  "7d": { days: 7, label: "آخر 7 أيام" },
  "30d": { days: 30, label: "آخر 30 يومًا" },
  "90d": { days: 90, label: "آخر 90 يومًا" },
  all: { days: null, label: "منذ البداية" },
} as const;

type PeriodKey = keyof typeof periodOptions;

type YoutubeViewsStats = {
  totalViews: number | null;
  updatedAt: string | null;
  fetchedAt: string;
};

type PublicTask = {
  id: number;
  status: string;
  platformId: number;
  completedAt: Date | null;
  dueDate: Date | null;
  createdAt: Date;
  submissionUrl: string | null;
};

function taskActivityDate(task: PublicTask) {
  return task.completedAt ?? task.dueDate ?? task.createdAt;
}

function publicationCount(task: PublicTask, proofCount: number) {
  if (proofCount > 0) return proofCount;
  if (task.submissionUrl) return 1;
  return task.status === "completed" ? 1 : 0;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function parseCsvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === "\"" && inQuotes && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeDigits(value: string) {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
  return value
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)));
}

function parseViewsNumber(value: unknown) {
  const normalized = normalizeDigits(String(value ?? ""));
  const digits = normalized.replace(/[^\d]/g, "");
  if (!digits) return null;
  const total = Number(digits);
  return Number.isSafeInteger(total) ? total : null;
}

let youtubeViewsCache: { value: YoutubeViewsStats; expiresAt: number } | null = null;
let youtubeViewsRequest: Promise<YoutubeViewsStats> | null = null;

async function fetchYoutubeViewsStats(): Promise<YoutubeViewsStats> {
  const response = await fetch(YOUTUBE_PUBLIC_STATS_CSV_URL);
  if (!response.ok) throw new Error(`Google Sheets CSV failed: ${response.status}`);

  const rows = parseCsvRows(await response.text());
  const totalRow = rows.find((row) => row[0] === "youtube_total_views");
  const updatedAtRow = rows.find((row) => row[0] === "updated_at");
  const totalViews = parseViewsNumber(totalRow?.[1]);

  if (totalViews === null) {
    throw new Error("Google Sheets CSV did not include a valid youtube_total_views number");
  }

  return {
    totalViews,
    updatedAt: updatedAtRow?.[1] || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getYoutubeViewsStats(): Promise<YoutubeViewsStats> {
  const now = Date.now();
  if (youtubeViewsCache && youtubeViewsCache.expiresAt > now) return youtubeViewsCache.value;
  if (youtubeViewsRequest) return youtubeViewsRequest;

  const previousValue = youtubeViewsCache?.value;
  youtubeViewsRequest = fetchYoutubeViewsStats()
    .then((value) => {
      youtubeViewsCache = { value, expiresAt: Date.now() + YOUTUBE_STATS_CACHE_TTL_MS };
      return value;
    })
    .catch(() => {
      if (previousValue?.totalViews !== null && previousValue?.totalViews !== undefined) {
        youtubeViewsCache = { value: previousValue, expiresAt: Date.now() + YOUTUBE_STATS_ERROR_CACHE_TTL_MS };
        return previousValue;
      }

      const unavailable: YoutubeViewsStats = {
        totalViews: null,
        updatedAt: null,
        fetchedAt: new Date().toISOString(),
      };
      youtubeViewsCache = { value: unavailable, expiresAt: Date.now() + YOUTUBE_STATS_ERROR_CACHE_TTL_MS };
      return unavailable;
    })
    .finally(() => {
      youtubeViewsRequest = null;
    });

  return youtubeViewsRequest;
}

function resolvePeriod(raw: unknown, now = new Date()) {
  const requested = typeof raw === "string" ? raw : "30d";
  const period: PeriodKey = requested === "7d" || requested === "30d" || requested === "90d" || requested === "all"
    ? requested
    : "30d";
  const option = periodOptions[period];
  const start = option.days === null
    ? PROJECT_START_DATE
    : new Date(now.getTime() - option.days * 24 * 60 * 60 * 1000);
  return {
    key: period,
    label: option.label,
    start: start < PROJECT_START_DATE ? PROJECT_START_DATE : start,
    end: now,
    averageDays: option.days ?? Math.max(1, Math.ceil((now.getTime() - PROJECT_START_DATE.getTime()) / (24 * 60 * 60 * 1000))),
  };
}

router.get("/public/achievements", async (req, res) => {
  const now = new Date();
  const period = resolvePeriod(req.query.period, now);
  const youtubeViews = await getYoutubeViewsStats();
  const platforms = await db.select().from(platformsTable).orderBy(platformsTable.id);
  const completedTasks = await db
    .select({
      id: tasksTable.id,
      status: tasksTable.status,
      platformId: tasksTable.platformId,
      completedAt: tasksTable.completedAt,
      dueDate: tasksTable.dueDate,
      createdAt: tasksTable.createdAt,
      submissionUrl: tasksTable.submissionUrl,
    })
    .from(tasksTable)
    .where(and(eq(tasksTable.status, "completed"), isNull(tasksTable.deletedAt)));

  const taskIds = completedTasks.map((task) => task.id);
  const proofRows = taskIds.length > 0
    ? await db
        .select({
          taskId: taskProofsTable.taskId,
          id: taskProofsTable.id,
        })
        .from(taskProofsTable)
        .where(and(inArray(taskProofsTable.taskId, taskIds), isNull(taskProofsTable.deletedAt)))
    : [];

  const proofCounts = new Map<number, number>();
  for (const proof of proofRows) {
    proofCounts.set(proof.taskId, (proofCounts.get(proof.taskId) ?? 0) + 1);
  }

  const platformMap = new Map(platforms.map((platform) => [platform.id, platform]));
  const last30Start = new Date(now);
  last30Start.setDate(last30Start.getDate() - 30);
  const platformCounts = new Map<number, { publications: number; completedTasks: number }>();
  const monthlyMap = new Map<string, { key: string; monthStart: Date; publications: number; completedTasks: number }>();

  let totalPublications = 0;
  let last30Publications = 0;
  let periodPublications = 0;
  let periodCompletedTasks = 0;

  for (const task of completedTasks) {
    const activityDate = taskActivityDate(task);
    const count = publicationCount(task, proofCounts.get(task.id) ?? 0);
    totalPublications += count;

    if (activityDate >= last30Start && activityDate <= now) {
      last30Publications += count;
    }

    if (activityDate >= period.start && activityDate <= period.end) {
      periodPublications += count;
      periodCompletedTasks += 1;
      const current = platformCounts.get(task.platformId) ?? { publications: 0, completedTasks: 0 };
      current.publications += count;
      current.completedTasks += 1;
      platformCounts.set(task.platformId, current);

      const key = monthKey(activityDate);
      const currentMonth = monthlyMap.get(key) ?? {
        key,
        monthStart: monthStart(activityDate),
        publications: 0,
        completedTasks: 0,
      };
      currentMonth.publications += count;
      currentMonth.completedTasks += 1;
      monthlyMap.set(key, currentMonth);
    }
  }

  const achievementsByPlatform = [...platformCounts.entries()]
    .map(([platformId, counts]) => {
      const platform = platformMap.get(platformId);
      return {
        platformId,
        name: platform?.name ?? "منصة غير معروفة",
        icon: platform?.icon ?? "",
        color: platform?.color ?? "",
        publications: counts.publications,
        completedTasks: counts.completedTasks,
      };
    })
    .sort((a, b) => b.publications - a.publications);

  const monthlyGrowth = [...monthlyMap.values()]
    .filter((row) => row.publications > 0 || row.completedTasks > 0)
    .sort((a, b) => a.monthStart.getTime() - b.monthStart.getTime());

  res.json({
    period: {
      key: period.key,
      label: period.label,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    totalPublications: periodPublications,
    completedTasks: periodCompletedTasks,
    last30Publications,
    activePlatforms: achievementsByPlatform.length,
    dailyAverage: period.averageDays > 0 ? periodPublications / period.averageDays : 0,
    projectStartDate: PROJECT_START_DATE.toISOString(),
    allTime: {
      totalPublications,
      completedTasks: completedTasks.length,
    },
    youtubeViews,
    achievementsByPlatform,
    monthlyGrowth: monthlyGrowth.map((row) => ({
      monthStart: row.monthStart.toISOString(),
      publications: row.publications,
      completedTasks: row.completedTasks,
    })),
    lastUpdated: now.toISOString(),
  });
});

export default router;
