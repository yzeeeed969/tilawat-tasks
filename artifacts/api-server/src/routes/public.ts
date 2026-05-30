import { Router } from "express";
import { db, platformsTable, taskProofsTable, tasksTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

const router = Router();

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

function lastMonths(count: number, reference = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(reference.getFullYear(), reference.getMonth() - (count - 1 - index), 1);
    return {
      key: monthKey(date),
      monthStart: date,
      publications: 0,
      completedTasks: 0,
    };
  });
}

router.get("/public/achievements", async (_req, res) => {
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
  const now = new Date();
  const last30Start = new Date(now);
  last30Start.setDate(last30Start.getDate() - 30);
  const monthly = lastMonths(12, now);
  const monthlyMap = new Map(monthly.map((row) => [row.key, row]));
  const platformCounts = new Map<number, { publications: number; completedTasks: number }>();

  let totalPublications = 0;
  let last30Publications = 0;

  for (const task of completedTasks) {
    const activityDate = taskActivityDate(task);
    const count = publicationCount(task, proofCounts.get(task.id) ?? 0);
    totalPublications += count;

    const month = monthlyMap.get(monthKey(activityDate));
    if (month) {
      month.publications += count;
      month.completedTasks += 1;
    }

    if (activityDate >= last30Start && activityDate <= now) {
      last30Publications += count;
      const current = platformCounts.get(task.platformId) ?? { publications: 0, completedTasks: 0 };
      current.publications += count;
      current.completedTasks += 1;
      platformCounts.set(task.platformId, current);
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

  res.json({
    totalPublications,
    completedTasks: completedTasks.length,
    last30Publications,
    activePlatforms: achievementsByPlatform.length,
    achievementsByPlatform,
    monthlyGrowth: monthly.map((row) => ({
      monthStart: row.monthStart.toISOString(),
      publications: row.publications,
      completedTasks: row.completedTasks,
    })),
    lastUpdated: now.toISOString(),
  });
});

export default router;
