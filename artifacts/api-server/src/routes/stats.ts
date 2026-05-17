import { Router } from "express";
import { db, tasksTable, membersTable, platformsTable, recitersTable } from "@workspace/db";
import { count, isNull } from "drizzle-orm";

const router = Router();

const now = () => new Date();

router.get("/stats/overview", async (_req, res) => {
  const allTasks = await db
    .select({ status: tasksTable.status, dueDate: tasksTable.dueDate })
    .from(tasksTable)
    .where(isNull(tasksTable.deletedAt));

  const [membersCount] = await db.select({ count: count(membersTable.id) }).from(membersTable);

  const totalTasks = allTasks.length;
  const completedTasks = allTasks.filter((t) => t.status === "completed").length;
  const pendingTasks = allTasks.filter((t) => t.status === "pending").length;
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress").length;
  const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  res.json({
    totalTasks,
    completedTasks,
    pendingTasks,
    inProgressTasks,
    totalMembers: Number(membersCount.count),
    completionRate: Math.round(completionRate * 10) / 10,
  });
});

router.get("/stats/members", async (_req, res) => {
  const members = await db.select().from(membersTable).orderBy(membersTable.createdAt);
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(isNull(tasksTable.deletedAt));

  const nowDate = now();

  const stats = members.map((member) => {
    const memberTasks = tasks.filter((t) => t.memberId === member.id);
    const completedTasks = memberTasks.filter((t) => t.status === "completed").length;
    const pendingTasks = memberTasks.filter((t) => t.status === "pending").length;
    const inProgressTasks = memberTasks.filter((t) => t.status === "in_progress").length;
    const totalTasks = memberTasks.length;
    const overdueTasksCount = memberTasks.filter(
      (t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < nowDate
    ).length;
    const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

    return {
      member: {
        id: member.id,
        name: member.name,
        role: member.role,
        phone: member.phone ?? null,
        avatarUrl: member.avatarUrl ?? null,
        isActive: member.isActive,
        lastLoginAt: member.lastLoginAt ?? null,
        createdAt: member.createdAt,
      },
      totalTasks,
      completedTasks,
      pendingTasks,
      inProgressTasks,
      overdueTasksCount,
      completionRate: Math.round(completionRate * 10) / 10,
    };
  });

  res.json(stats);
});

router.get("/stats/platforms", async (_req, res) => {
  const platforms = await db.select().from(platformsTable).orderBy(platformsTable.id);
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(isNull(tasksTable.deletedAt));

  const nowDate = now();

  const stats = platforms.map((platform) => {
    const platformTasks = tasks.filter((t) => t.platformId === platform.id);
    const completedTasks = platformTasks.filter((t) => t.status === "completed").length;
    const pendingTasks = platformTasks.filter((t) => t.status === "pending").length;
    const inProgressTasks = platformTasks.filter((t) => t.status === "in_progress").length;
    const totalTasks = platformTasks.length;
    const overdueTasksCount = platformTasks.filter(
      (t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < nowDate
    ).length;
    const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

    return {
      platform: {
        id: platform.id,
        name: platform.name,
        icon: platform.icon,
        color: platform.color,
        isMain: platform.isMain,
      },
      totalTasks,
      completedTasks,
      pendingTasks,
      inProgressTasks,
      overdueTasksCount,
      completionRate: Math.round(completionRate * 10) / 10,
    };
  });

  res.json(stats);
});

router.get("/stats/reciters", async (_req, res) => {
  const reciters = await db.select().from(recitersTable).orderBy(recitersTable.id);
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(isNull(tasksTable.deletedAt));

  const nowDate = now();

  const stats = reciters.map((reciter) => {
    const reciterTasks = tasks.filter((t) => t.reciterId === reciter.id);
    const completedTasks = reciterTasks.filter((t) => t.status === "completed").length;
    const pendingTasks = reciterTasks.filter((t) => t.status === "pending").length;
    const inProgressTasks = reciterTasks.filter((t) => t.status === "in_progress").length;
    const totalTasks = reciterTasks.length;
    const overdueTasksCount = reciterTasks.filter(
      (t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < nowDate
    ).length;
    const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

    return {
      reciter: {
        id: reciter.id,
        name: reciter.name,
        mosque: reciter.mosque,
        createdAt: reciter.createdAt,
      },
      totalTasks,
      completedTasks,
      pendingTasks,
      inProgressTasks,
      overdueTasksCount,
      completionRate: Math.round(completionRate * 10) / 10,
    };
  });

  res.json(stats);
});

export default router;
