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
import { runYoutubeMonitorTick, reprocessChannelNeedsAttentionVideos } from "../services/youtube-monitor";
import { ensureYoutubeMonitorSchema } from "../services/youtube-monitor-schema";
import { riyadhDayKey } from "../lib/hijri";

// يزيل المسافات الطرفية وعلامات الاقتباس الطرفية بكل أشكالها الشائعة (مستقيمة أو منحنية/ذكية) —
// خطأ شائع عند اللصق من الهاتف أو Word، وقد سبّب هذا تحديدًا خللًا حقيقيًا (قناة الوليد الشمسان).
// نطبّقه في الخادم لا الواجهة فقط، ليبقى فعّالًا مهما كان مصدر الطلب مستقبلًا.
function normalizeChannelText(value: string): string {
  // نجمع المسافات وعلامات الاقتباس في فئة واحدة لإزالتهما معًا من الطرفين، فيغطي هذا حالات مثل
  // ‎" 'النص' "‎ (اقتباس متداخل مع مسافات) في مرة واحدة، لا اقتباسًا واحدًا فقط.
  return value.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
}

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
  const handle = typeof body.handle === "string" ? normalizeChannelText(body.handle) : "";
  const displayName = typeof body.displayName === "string" ? normalizeChannelText(body.displayName) : "";
  const reciterNameConstant = typeof body.reciterNameConstant === "string" ? normalizeChannelText(body.reciterNameConstant) : "";
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

// تعديل بيانات قناة موجودة — تحديث جزئي، ترسل فقط ما تغيّر.
router.patch("/youtube/channels/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const [existing] = await db.select().from(youtubeChannelsTable).where(eq(youtubeChannelsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const body = req.body as {
    enabled?: unknown; handle?: unknown; displayName?: unknown; reciterNameConstant?: unknown;
    platformId?: unknown; reciterId?: unknown;
  };
  const update: Partial<typeof youtubeChannelsTable.$inferInsert> = {};

  if (typeof body.enabled === "boolean") update.enabled = body.enabled;

  if (typeof body.handle === "string") {
    const handle = normalizeChannelText(body.handle);
    if (!handle) {
      res.status(400).json({ error: "رابط القناة مطلوب" });
      return;
    }
    update.handle = handle;
  }
  if (typeof body.displayName === "string") {
    const displayName = normalizeChannelText(body.displayName);
    if (!displayName) {
      res.status(400).json({ error: "الاسم الوصفي مطلوب" });
      return;
    }
    update.displayName = displayName;
  }
  if (typeof body.reciterNameConstant === "string") {
    const reciterNameConstant = normalizeChannelText(body.reciterNameConstant);
    if (!reciterNameConstant) {
      res.status(400).json({ error: "الاسم الثابت في العناوين مطلوب" });
      return;
    }
    update.reciterNameConstant = reciterNameConstant;
  }
  if (body.platformId !== undefined) {
    const platformId = Number(body.platformId);
    if (!Number.isInteger(platformId) || platformId <= 0) {
      res.status(400).json({ error: "منصة غير صحيحة" });
      return;
    }
    update.platformId = platformId;
  }
  if (body.reciterId !== undefined) {
    const reciterId = Number(body.reciterId);
    if (!Number.isInteger(reciterId) || reciterId <= 0) {
      res.status(400).json({ error: "قارئ غير صحيح" });
      return;
    }
    update.reciterId = reciterId;
  }

  // تغيير الرابط يعني قناة يوتيوب مختلفة محتمَلة — نصفّر المعرّف المحلول القديم ليُعاد ربطه
  // بالرابط الجديد في الفحص التالي، بدل الاستمرار بمراقبة القناة السابقة بصمت.
  const handleChanged = update.handle !== undefined && update.handle !== existing.handle;
  if (handleChanged) {
    update.channelId = null;
    update.uploadsPlaylistId = null;
  }

  let channel: typeof existing;
  try {
    [channel] = await db.update(youtubeChannelsTable).set(update).where(eq(youtubeChannelsTable.id, id)).returning();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message ?? "فشل حفظ تعديل القناة" });
    return;
  }

  // إعادة فحص فورية لمقاطع هذه القناة "بحاجة مراجعة/بلا مهمة" فقط إذا تغيّر ما يؤثّر على
  // المطابقة (الاسم الثابت أو الرابط) — لا داعي لها عند تعديل الاسم الوصفي أو التفعيل مثلًا.
  const affectsMatching = (update.reciterNameConstant !== undefined && update.reciterNameConstant !== existing.reciterNameConstant) || handleChanged;
  const reprocessed = affectsMatching
    ? await reprocessChannelNeedsAttentionVideos(channel, (await getYoutubeSettings()).trialMode)
    : 0;

  res.json({ ...channel, reprocessed });
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
