import { Router } from "express";
import { db, platformsTable, taskProofsTable, tasksTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

const router = Router();
const PROJECT_START_DATE = new Date(Date.UTC(2026, 4, 24, 0, 0, 0, 0));

const periodOptions = {
  "7d": { days: 7, label: "آخر 7 أيام" },
  "30d": { days: 30, label: "آخر 30 يومًا" },
  "90d": { days: 90, label: "آخر 90 يومًا" },
  all: { days: null, label: "منذ البداية" },
} as const;

type PeriodKey = keyof typeof periodOptions;

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
