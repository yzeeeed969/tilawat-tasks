import { Router } from "express";
import { db, platformsTable, taskProofsTable, tasksTable } from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { getPublicSiteSettings, updatePublicSiteSettings } from "../services/public-site-settings";

const router = Router();
const PROJECT_START_DATE = new Date(Date.UTC(2026, 4, 24, 0, 0, 0, 0));

const periodOptions = {
  "7d": { days: 7, label: "آخر 7 أيام" },
  "30d": { days: 30, label: "آخر 30 يومًا" },
  "90d": { days: 90, label: "آخر 90 يومًا" },
  all: { days: null, label: "الكل" },
} as const;

type PeriodKey = keyof typeof periodOptions;

type YoutubeViewsStats = {
  totalViews: number | null;
  manualViews: number | null;
  baselineViews: number;
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

let platformsSchemaEnsured = false;
let platformsSchemaEnsurePromise: Promise<void> | null = null;

async function ensurePlatformsBaselineColumn() {
  if (platformsSchemaEnsured) return;
  if (!platformsSchemaEnsurePromise) {
    platformsSchemaEnsurePromise = db
      .execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS baseline_posts_count integer NOT NULL DEFAULT 0`)
      .then(() => {
        platformsSchemaEnsured = true;
      })
      .finally(() => {
        platformsSchemaEnsurePromise = null;
      });
  }
  await platformsSchemaEnsurePromise;
}

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

async function getYoutubeViewsStats(): Promise<YoutubeViewsStats> {
  const settings = await getPublicSiteSettings();
  const manualViews = settings?.youtubeTotalViews ?? null;
  const baselineViews = settings?.youtubeBaselineViews ?? 0;
  return {
    totalViews: manualViews === null ? baselineViews : baselineViews + manualViews,
    manualViews,
    baselineViews,
    updatedAt: settings?.youtubeViewsUpdatedAt?.toISOString() ?? null,
    fetchedAt: new Date().toISOString(),
  };
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

router.get("/public-site-settings", requireAdmin, async (_req, res) => {
  const settings = await getPublicSiteSettings();
  res.json(settings);
});

router.patch("/public-site-settings", requireAdmin, async (req, res) => {
  try {
    const settings = await updatePublicSiteSettings({
      youtubeTotalViews: req.body?.youtubeTotalViews,
      youtubeBaselineViews: req.body?.youtubeBaselineViews,
    });
    res.json(settings);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "فشل حفظ الإحصائيات العامة",
    });
  }
});

router.get("/public/achievements", async (req, res) => {
  const now = new Date();
  const period = resolvePeriod(req.query.period, now);
  const includeBaselines = period.key === "all";
  const youtubeViews = await getYoutubeViewsStats();
  await ensurePlatformsBaselineColumn();
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
  const baselinePostsByPlatform = new Map(platforms.map((platform) => [platform.id, platform.baselinePostsCount ?? 0]));
  const baselinePostsTotal = [...baselinePostsByPlatform.values()].reduce((sum, value) => sum + value, 0);
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

  const platformIdsForAchievements = includeBaselines
    ? new Set([...platforms.map((platform) => platform.id), ...platformCounts.keys()])
    : new Set(platformCounts.keys());

  const achievementsByPlatform = [...platformIdsForAchievements]
    .map((platformId) => {
      const counts = platformCounts.get(platformId) ?? { publications: 0, completedTasks: 0 };
      const platform = platformMap.get(platformId);
      const baselinePublications = includeBaselines ? (baselinePostsByPlatform.get(platformId) ?? 0) : 0;
      return {
        platformId,
        name: platform?.name ?? "منصة غير معروفة",
        icon: platform?.icon ?? "",
        color: platform?.color ?? "",
        publications: counts.publications + baselinePublications,
        systemPublications: counts.publications,
        baselinePublications,
        completedTasks: counts.completedTasks,
      };
    })
    .filter((row) => row.publications > 0 || row.completedTasks > 0 || includeBaselines)
    .sort((a, b) => b.publications - a.publications);

  const displayedTotalPublications = periodPublications + (includeBaselines ? baselinePostsTotal : 0);

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
    totalPublications: displayedTotalPublications,
    completedTasks: periodCompletedTasks,
    last30Publications,
    activePlatforms: achievementsByPlatform.filter((row) => row.publications > 0).length,
    dailyAverage: period.averageDays > 0 ? displayedTotalPublications / period.averageDays : 0,
    projectStartDate: PROJECT_START_DATE.toISOString(),
    allTime: {
      totalPublications: totalPublications + baselinePostsTotal,
      systemPublications: totalPublications,
      baselinePublications: baselinePostsTotal,
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
