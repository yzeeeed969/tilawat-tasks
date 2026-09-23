import { Router } from "express";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  platformsTable,
  recitersTable,
  tasksTable,
  taskProofsTable,
  youtubeChannelsTable,
  youtubeVideosTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { getYoutubeSettings, updateYoutubeSettings } from "../services/youtube-settings";
import { runYoutubeMonitorTick } from "../services/youtube-monitor";
import { ensureYoutubeMonitorSchema } from "../services/youtube-monitor-schema";
import { riyadhDayKey } from "../lib/hijri";

const router = Router();
router.use(requireAdmin);
router.use(async (_req, _res, next) => {
  try {
    await ensureYoutubeMonitorSchema();
    next();
  } catch (err) {
    next(err);
  }
});

// ── الإعدادات (مفتاح التشغيل العام + وضع التجربة) ──────────────────────────
router.get("/youtube/settings", async (_req, res) => {
  const settings = await getYoutubeSettings();
  res.json(settings);
});

router.patch("/youtube/settings", async (req, res) => {
  const body = req.body as { enabled?: unknown; trialMode?: unknown };
  const update: { enabled?: boolean; trialMode?: boolean } = {};
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (typeof body.trialMode === "boolean") update.trialMode = body.trialMode;
  const settings = await updateYoutubeSettings(update);
  res.json(settings);
});

router.post("/youtube/scan-now", async (_req, res) => {
  try {
    const result = await runYoutubeMonitorTick();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message ?? "فشل تشغيل الفحص" });
  }
});

// ── القنوات ──────────────────────────────────────────────────────────────
router.get("/youtube/channels", async (_req, res) => {
  const channels = await db
    .select({
      id: youtubeChannelsTable.id,
      handle: youtubeChannelsTable.handle,
      displayName: youtubeChannelsTable.displayName,
      reciterNameConstant: youtubeChannelsTable.reciterNameConstant,
      platformId: youtubeChannelsTable.platformId,
      platformName: platformsTable.name,
      reciterId: youtubeChannelsTable.reciterId,
      reciterName: recitersTable.name,
      enabled: youtubeChannelsTable.enabled,
      channelId: youtubeChannelsTable.channelId,
      lastCheckedAt: youtubeChannelsTable.lastCheckedAt,
      monitoringStartedAt: youtubeChannelsTable.monitoringStartedAt,
    })
    .from(youtubeChannelsTable)
    .leftJoin(platformsTable, eq(youtubeChannelsTable.platformId, platformsTable.id))
    .leftJoin(recitersTable, eq(youtubeChannelsTable.reciterId, recitersTable.id))
    .orderBy(desc(youtubeChannelsTable.id));
  res.json(channels);
});

// إنشاء يدوي — الحل الاحتياطي إن تعذّر ربط قناة تلقائيًا (لم نجد منصة/قارئ مطابقًا بوضوح).
router.post("/youtube/channels", async (req, res) => {
  const body = req.body as {
    handle?: string; displayName?: string; reciterNameConstant?: string;
    platformId?: number; reciterId?: number;
  };
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const reciterNameConstant = typeof body.reciterNameConstant === "string" ? body.reciterNameConstant.trim() : "";
  const platformId = Number(body.platformId);
  const reciterId = Number(body.reciterId);
  if (!handle || !displayName || !reciterNameConstant || !Number.isInteger(platformId) || !Number.isInteger(reciterId)) {
    res.status(400).json({ error: "بيانات القناة غير مكتملة" });
    return;
  }
  try {
    const [channel] = await db.insert(youtubeChannelsTable).values({
      handle, displayName, reciterNameConstant, platformId, reciterId, enabled: true,
    }).returning();
    res.status(201).json(channel);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message ?? "فشل إنشاء القناة" });
  }
});

router.patch("/youtube/channels/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  const body = req.body as { enabled?: unknown };
  const update: { enabled?: boolean } = {};
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  const [channel] = await db.update(youtubeChannelsTable).set(update).where(eq(youtubeChannelsTable.id, id)).returning();
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  res.json(channel);
});

// ── المقاطع ──────────────────────────────────────────────────────────────
router.get("/youtube/videos", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = await db
    .select({
      id: youtubeVideosTable.id,
      channelRowId: youtubeVideosTable.channelRowId,
      videoId: youtubeVideosTable.videoId,
      title: youtubeVideosTable.title,
      publishedAt: youtubeVideosTable.publishedAt,
      url: youtubeVideosTable.url,
      hasMarker: youtubeVideosTable.hasMarker,
      extractedPrayer: youtubeVideosTable.extractedPrayer,
      extractedHijriDay: youtubeVideosTable.extractedHijriDay,
      extractedHijriMonth: youtubeVideosTable.extractedHijriMonth,
      matchedTaskId: youtubeVideosTable.matchedTaskId,
      status: youtubeVideosTable.status,
      decisionReason: youtubeVideosTable.decisionReason,
      processedAt: youtubeVideosTable.processedAt,
    })
    .from(youtubeVideosTable)
    .where(status ? eq(youtubeVideosTable.status, status) : undefined)
    .orderBy(desc(youtubeVideosTable.publishedAt))
    .limit(200);
  res.json(rows);
});

async function fetchVideoOr404(id: number) {
  const [video] = await db.select().from(youtubeVideosTable).where(eq(youtubeVideosTable.id, id)).limit(1);
  return video ?? null;
}

// ربط يدوي بمهمة معيّنة: يضيف شاهدًا ويكمل المهمة بنفس الشكل الذي يفعله POST /tasks/:id/proofs
// اليوم يدويًا. عمدًا بلا إشعارات هنا (خلافًا للتوثيق التلقائي) لأن المدير يشاهد النتيجة مباشرة في
// نفس الصفحة، فلا داعي لتنبيه نفسه.
router.post("/youtube/videos/:id/link", async (req, res) => {
  const id = Number(req.params.id);
  const taskId = Number((req.body as { taskId?: unknown }).taskId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "بيانات غير صحيحة" });
    return;
  }
  const video = await fetchVideoOr404(id);
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  const [task] = await db.select({ id: tasksTable.id, status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (task.status !== "pending") {
    res.status(409).json({ error: "المهمة ليست معلّقة" });
    return;
  }

  const [proof] = await db.insert(taskProofsTable).values({
    taskId,
    url: video.url,
    note: `رُبط يدويًا من صفحة مراقبة يوتيوب — نُشر بتاريخ ${video.publishedAt.toISOString()}`,
    createdByUserId: (req as any).currentUser?.id ?? null,
  }).returning();

  await db.update(tasksTable).set({
    status: "completed",
    completedAt: new Date(),
    submissionUrl: video.url,
  }).where(eq(tasksTable.id, taskId));

  const [updated] = await db.update(youtubeVideosTable).set({
    status: "documented",
    matchedTaskId: taskId,
    createdProofId: proof.id,
    decisionReason: "رُبط يدويًا من صفحة الإدارة",
    reviewedByUserId: (req as any).currentUser?.id ?? null,
    reviewedAt: new Date(),
  }).where(eq(youtubeVideosTable.id, id)).returning();

  res.json(updated);
});

router.post("/youtube/videos/:id/ignore", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid video id" });
    return;
  }
  const [updated] = await db.update(youtubeVideosTable).set({
    status: "ignored_manual",
    decisionReason: "تجاهله المدير يدويًا",
    reviewedByUserId: (req as any).currentUser?.id ?? null,
    reviewedAt: new Date(),
  }).where(eq(youtubeVideosTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.json(updated);
});

// تراجع دقيق: يحذف حذفًا ناعمًا الشاهد الذي أنشأه هذا المقطع بعينه فقط (لا يبحث بالرابط)،
// ويعيد المهمة معلّقة فقط إن لم يعد لها أي شاهد آخر فعّال — لا يمسّ أي شيء غير ذلك.
// تنبيه: لا يسحب أي إشعار سبق إرساله.
router.post("/youtube/videos/:id/revert", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid video id" });
    return;
  }
  const video = await fetchVideoOr404(id);
  if (!video || !video.matchedTaskId) {
    res.status(400).json({ error: "لا يوجد توثيق مرتبط بهذا المقطع للتراجع عنه" });
    return;
  }

  await db.transaction(async (tx: any) => {
    if (video.createdProofId) {
      await tx.update(taskProofsTable).set({ deletedAt: new Date() }).where(eq(taskProofsTable.id, video.createdProofId));
    }
    const [remainingProof] = await tx
      .select({ id: taskProofsTable.id })
      .from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, video.matchedTaskId!), isNull(taskProofsTable.deletedAt)))
      .limit(1);
    if (!remainingProof) {
      await tx.update(tasksTable).set({ status: "pending", completedAt: null }).where(eq(tasksTable.id, video.matchedTaskId!));
    }
  });

  const [updated] = await db.update(youtubeVideosTable).set({
    status: "reverted",
    decisionReason: "تراجع عنه المدير — الإشعارات المُرسَلة سابقًا لم تُسحَب",
    reviewedByUserId: (req as any).currentUser?.id ?? null,
    reviewedAt: new Date(),
  }).where(eq(youtubeVideosTable.id, id)).returning();

  res.json(updated);
});

// ── تبويب "مهام بلا مقطع" ───────────────────────────────────────────────
router.get("/youtube/tasks-without-video", async (_req, res) => {
  const channels = await db.select().from(youtubeChannelsTable).where(eq(youtubeChannelsTable.enabled, true));
  if (channels.length === 0) {
    res.json([]);
    return;
  }
  const platformIds = [...new Set(channels.map((c) => c.platformId))];
  const todayKey = riyadhDayKey(new Date());

  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      dueDate: tasksTable.dueDate,
      // اليوم الميلادي الحرفي من PostgreSQL مباشرة (to_char) — لا كائن Date — بلا أي اعتماد على
      // توقيت عملية Node (انظر lib/hijri.ts).
      dueDateKey: sql<string | null>`to_char(${tasksTable.dueDate}, 'YYYY-MM-DD')`,
      platformId: tasksTable.platformId,
      reciterId: tasksTable.reciterId,
    })
    .from(tasksTable)
    .where(and(
      inArray(tasksTable.platformId, platformIds),
      eq(tasksTable.status, "pending"),
      isNull(tasksTable.deletedAt),
      lt(tasksTable.dueDate, new Date()),
    ))
    .orderBy(tasksTable.dueDate);

  // "فات موعدها" بتوقيت الرياض: نستبعد يوم اليوم نفسه، فقط ما قبله فعليًا. مقارنة نصّية مباشرة
  // بين مفتاحَي يوم (YYYY-MM-DD)، بلا أي كائن Date وسيط.
  const pastDue = rows
    .filter((task) => task.dueDateKey && task.dueDateKey < todayKey)
    .map(({ dueDateKey: _dueDateKey, ...task }) => task);
  res.json(pastDue);
});

export default router;
