import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, platformsTable, platformPagesTable, recitersTable, telegramChannelPostsTable, telegramChannelsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { callTelegramApi } from "../services/telegram";
import { ensureTelegramMonitorSchema } from "../services/telegram-monitor-schema";
import {
  addHashtagAlias,
  getMonitorSettings,
  listChannels,
  registerChannel,
  updateChannel,
  ignoreSide,
  linkCandidates,
  linkSideManually,
  listAliases,
  listPosts,
  listSeenChats,
  parseSide,
  reprocessPost,
  revertSide,
  runTelegramMonitorTick,
  tasksWithoutPost,
  TelegramMonitorError,
  updateMonitorSettings,
} from "../services/telegram-channel-monitor";
import {
  designDateCheck,
  designLinkCandidates,
  designTasksWithoutPost,
  DesignsMonitorError,
  ignoreDesignPost,
  linkDesignPost,
  revertDesignPost,
} from "../services/telegram-designs-monitor";

// إدارة مراقبة قناة تلقرام — للمدير فقط (requireAdmin على كل مسار في الخادم).
const router = Router();

router.use("/telegram-monitor", requireAdmin, async (_req, _res, next) => {
  try {
    await ensureTelegramMonitorSchema();
    next();
  } catch (err) {
    next(err);
  }
});

function sendError(res: any, error: unknown) {
  if (error instanceof TelegramMonitorError || error instanceof DesignsMonitorError) {
    res.status(error.status).json({ error: error.message, message: error.message });
    return;
  }
  throw error;
}

// أنواع التحديثات المطلوبة من الـ webhook: «message» لربط الأعضاء (يجب أن يبقى)، و«channel_post»
// و«edited_channel_post» للقناة، و«my_chat_member» لمعرفة القنوات التي أُضيف إليها البوت.
const REQUIRED_UPDATES = ["message", "channel_post", "edited_channel_post", "my_chat_member"];

// إخفاء الجزء السري من مسار الـ webhook عند العرض.
function maskWebhookUrl(url: string | undefined) {
  if (!url) return "";
  return url.replace(/(\/webhook\/)[^/?#]+/, "$1••••••");
}

router.get("/telegram-monitor/settings", async (_req, res) => {
  try {
    const settings = await getMonitorSettings();
    const platforms = await db.select({ id: platformsTable.id, name: platformsTable.name, coversAllReciters: platformsTable.coversAllReciters }).from(platformsTable).orderBy(platformsTable.id);
    const reciters = await db.select({ id: recitersTable.id, name: recitersTable.name, mosque: recitersTable.mosque }).from(recitersTable).orderBy(recitersTable.id);
    const pages = await db.select({ id: platformPagesTable.id, name: platformPagesTable.name, platformId: platformPagesTable.platformId, reciterId: platformPagesTable.reciterId }).from(platformPagesTable).orderBy(platformPagesTable.id);
    res.json({ settings, channels: await listChannels(), platforms, reciters, pages, seenChats: await listSeenChats(), aliases: await listAliases() });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/telegram-monitor/settings", async (req, res) => {
  try {
    res.json(await updateMonitorSettings(req.body));
  } catch (error) {
    sendError(res, error);
  }
});

// ── القنوات ─────────────────────────────────────────────────────────────────────────────────
router.post("/telegram-monitor/channels", async (req, res) => {
  try {
    res.status(201).json(await registerChannel(req.body?.chatId, req.body?.kind));
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/telegram-monitor/channels/:id", async (req, res) => {
  try {
    res.json(await updateChannel(Number(req.params.id), req.body));
  } catch (error) {
    sendError(res, error);
  }
});

// إجراء وقائي لقناة التصاميم: مهام الصفحة التي لا يقع تاريخها المخزَّن عند منتصف الليل.
router.get("/telegram-monitor/channels/:id/date-check", async (req, res) => {
  try {
    const channel = await channelById(Number(req.params.id));
    res.json(channel.kind === "designs" ? await designDateCheck(channel) : { tasks: 0, notMidnight: 0 });
  } catch (error) {
    sendError(res, error);
  }
});

async function channelById(id: number) {
  const [channel] = await db.select().from(telegramChannelsTable).where(eq(telegramChannelsTable.id, id)).limit(1);
  if (!channel) throw new TelegramMonitorError(404, "القناة غير موجودة");
  return channel;
}

// نوع قناة المنشور — لتوجيه الإجراءات اليدوية لمنطق قناته (تلاوات/تصاميم).
async function postChannelKind(postId: number) {
  const [row] = await db
    .select({ kind: telegramChannelsTable.kind })
    .from(telegramChannelPostsTable)
    .leftJoin(telegramChannelsTable, eq(telegramChannelPostsTable.channelId, telegramChannelsTable.id))
    .where(eq(telegramChannelPostsTable.id, postId))
    .limit(1);
  if (!row) throw new TelegramMonitorError(404, "المنشور غير موجود");
  return row.kind === "designs" ? "designs" : "recitations";
}

router.get("/telegram-monitor/webhook", async (_req, res) => {
  const info = await callTelegramApi<{ url?: string; allowed_updates?: string[]; pending_update_count?: number; last_error_message?: string; last_error_date?: number }>("getWebhookInfo");
  if (!info.ok) {
    res.json({ ok: false, error: info.error });
    return;
  }
  const allowed = info.result?.allowed_updates;
  // قائمة فارغة/غائبة = الافتراضي عند تلقرام: كل الأنواع تقريبًا (ومنها channel_post و my_chat_member).
  const usesDefault = !allowed || allowed.length === 0;
  const missing = usesDefault ? [] : REQUIRED_UPDATES.filter((type) => !allowed.includes(type));
  res.json({
    ok: true,
    url: maskWebhookUrl(info.result?.url),
    hasUrl: Boolean(info.result?.url),
    allowedUpdates: allowed ?? [],
    usesDefault,
    missing,
    pendingUpdateCount: info.result?.pending_update_count ?? 0,
    lastErrorMessage: info.result?.last_error_message ?? null,
    lastErrorDate: info.result?.last_error_date ? new Date(info.result.last_error_date * 1000).toISOString() : null,
  });
});

// يعيد تسجيل نفس عنوان الـ webhook الحالي (لا يغيّره) مع قائمة أنواع صريحة تشمل «message».
router.post("/telegram-monitor/webhook/allowed-updates", async (_req, res) => {
  const info = await callTelegramApi<{ url?: string }>("getWebhookInfo");
  if (!info.ok || !info.result?.url) {
    res.status(400).json({ error: info.error ?? "لا يوجد webhook مسجّل حاليًا — سجّله أولًا", message: info.error ?? "لا يوجد webhook مسجّل حاليًا" });
    return;
  }
  const result = await callTelegramApi("setWebhook", {
    url: info.result.url,
    allowed_updates: REQUIRED_UPDATES,
    drop_pending_updates: false,
  });
  if (!result.ok) {
    res.status(502).json({ error: result.error, message: result.error });
    return;
  }
  res.json({ ok: true, allowedUpdates: REQUIRED_UPDATES });
});

router.get("/telegram-monitor/posts", async (req, res) => {
  try {
    const side = req.query.side === "telegram" || req.query.side === "app" ? req.query.side : "any";
    res.json(await listPosts({
      status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
      side,
      kind: typeof req.query.kind === "string" && req.query.kind ? req.query.kind : undefined,
      limit: Number(req.query.limit) || 100,
      channelId: Number(req.query.channelId) || undefined,
    }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/telegram-monitor/posts/:id/candidates", async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if ((await postChannelKind(postId)) === "designs") {
      res.json(await designLinkCandidates(postId));
      return;
    }
    res.json(await linkCandidates(postId, parseSide(req.query.side)));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/telegram-monitor/posts/:id/link", async (req, res) => {
  try {
    const taskId = Number(req.body?.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new TelegramMonitorError(400, "اختر مهمة");
    const postId = Number(req.params.id);
    if ((await postChannelKind(postId)) === "designs") {
      await linkDesignPost(postId, taskId, (req as any).currentUser?.id ?? null);
      res.json({ ok: true });
      return;
    }
    res.json(await linkSideManually(postId, parseSide(req.body?.side), taskId, (req as any).currentUser?.id ?? null));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/telegram-monitor/posts/:id/ignore", async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if ((await postChannelKind(postId)) === "designs") {
      await ignoreDesignPost(postId, (req as any).currentUser?.id ?? null);
      res.json({ ok: true });
      return;
    }
    res.json(await ignoreSide(postId, parseSide(req.body?.side), (req as any).currentUser?.id ?? null));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/telegram-monitor/posts/:id/revert", async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if ((await postChannelKind(postId)) === "designs") {
      await revertDesignPost(postId, (req as any).currentUser?.id ?? null);
      res.json({ ok: true });
      return;
    }
    res.json(await revertSide(postId, parseSide(req.body?.side), (req as any).currentUser?.id ?? null));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/telegram-monitor/posts/:id/reprocess", async (req, res) => {
  try {
    res.json(await reprocessPost(Number(req.params.id)));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/telegram-monitor/aliases", async (req, res) => {
  try {
    const reciterId = Number(req.body?.reciterId);
    if (!Number.isInteger(reciterId) || reciterId <= 0) throw new TelegramMonitorError(400, "اختر القارئ");
    res.json(await addHashtagAlias(String(req.body?.hashtag ?? ""), reciterId));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/telegram-monitor/tasks-without-post", async (req, res) => {
  try {
    const channelId = Number(req.query.channelId);
    if (channelId) {
      const channel = await channelById(channelId);
      if (channel.kind === "designs") {
        res.json(await designTasksWithoutPost(channel));
        return;
      }
    }
    res.json(await tasksWithoutPost());
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/telegram-monitor/run-now", async (_req, res) => {
  try {
    res.json(await runTelegramMonitorTick());
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
