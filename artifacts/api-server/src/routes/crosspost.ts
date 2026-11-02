import { Router, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin } from "../middlewares/auth";
import { ensureCrosspostSchema } from "../services/crosspost-schema";
import { checkTgVideo, ensureTgCrosspostSchema, performTgUpload, registerChannel, setTgCrosspostEnabled, tgCrosspostOverview } from "../services/tg-crosspost";
import { addManualLink, listManualLinks, removeManualLink, attachFacebookProofsToYoutubeTasks, checkMachineKey, claimUpload, crosspostOverview, listPendingVideos, machineKeyConfigured, performUpload, setCrosspostEnabled } from "../services/crosspost";

// ── جهاز التنزيل (الماك ميني): بمفتاح سري في ترويسة Authorization: Bearer <CROSSPOST_API_KEY> — لا جلسة ──
export const crosspostMachineRouter = Router();

function requireMachineKey(req: Request, res: Response, next: NextFunction) {
  if (!machineKeyConfigured()) {
    res.status(503).json({ ok: false, message: "المفتاح السري غير مضبوط على الخادم (CROSSPOST_API_KEY)" });
    return;
  }
  if (!checkMachineKey(req.headers.authorization)) {
    res.status(401).json({ ok: false, message: "Unauthorized" });
    return;
  }
  ensureCrosspostSchema().then(() => next(), next);
}

// الفيديوهات الجديدة غير المرفوعة.
crosspostMachineRouter.get("/crosspost/machine/pending", requireMachineKey, async (_req, res) => {
  try {
    res.json(await listPendingVideos());
    attachFacebookProofsToYoutubeTasks().catch(() => {}); // شاهد فيسبوك التكميلي لما وُثّق بعد الرفع
  } catch (err) {
    res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// رفع فيديو واحد: الجسم = ملف الفيديو (application/octet-stream)، و?videoId=… في الرابط.
crosspostMachineRouter.post("/crosspost/machine/upload", requireMachineKey, async (req, res) => {
  const videoId = String(req.query.videoId ?? "").trim();
  const claim = await claimUpload(videoId).catch((err) => ({ ok: false as const, status: 500, message: (err as Error).message }));
  if (!claim.ok) {
    req.resume(); // نتجاهل الملف المرسَل
    res.status(claim.status).json({ ok: false, videoId, message: claim.message });
    return;
  }
  const filePath = path.join(os.tmpdir(), `yt-fb-${videoId}-${Date.now()}.mp4`);
  try {
    await pipeline(req, fs.createWriteStream(filePath));
    const { size } = await fs.promises.stat(filePath);
    const result = await performUpload(claim, filePath, size);
    res.status(result.ok ? 200 : 502).json({ ...result, videoId, pageId: claim.pageId, pageName: claim.pageName, title: claim.title });
    if (result.ok) attachFacebookProofsToYoutubeTasks().catch(() => {});
  } catch (err) {
    const message = (err as Error).message;
    await performUpload(claim, filePath, 0).catch(() => {}); // يسجّل الإخفاق (ملف لم يكتمل)
    res.status(500).json({ ok: false, videoId, message });
  } finally {
    fs.promises.unlink(filePath).catch(() => {});
  }
});

// ── خدمة tg-bridge (مسار تيليجرام ← فيسبوك، الإصدار 76): نفس المفتاح السري CROSSPOST_API_KEY ──
function requireBridgeKey(req: Request, res: Response, next: NextFunction) {
  if (!machineKeyConfigured()) { res.status(503).json({ ok: false, message: "المفتاح السري غير مضبوط على الخادم (CROSSPOST_API_KEY)" }); return; }
  if (!checkMachineKey(req.headers.authorization)) { res.status(401).json({ ok: false, message: "Unauthorized" }); return; }
  ensureTgCrosspostSchema().then(() => next(), next);
}

// البوت أُضيف لقناة/تغيّرت صلاحيته.
crosspostMachineRouter.post("/crosspost/tg/channel", requireBridgeKey, async (req, res) => {
  const chatId = String(req.body?.chatId ?? "").trim();
  if (!/^-?\d+$/.test(chatId)) { res.status(400).json({ ok: false, message: "chatId غير صالح" }); return; }
  await registerChannel({ chatId, title: req.body?.title ?? null, username: req.body?.username ?? null, botStatus: req.body?.botStatus ?? null });
  res.json({ ok: true });
});

// فيديو جديد في قناة: هل يُرفع؟
crosspostMachineRouter.post("/crosspost/tg/check", requireBridgeKey, async (req, res) => {
  const b = req.body ?? {};
  const chatId = String(b.chatId ?? "").trim();
  const messageId = Number(b.messageId);
  if (!/^-?\d+$/.test(chatId) || !Number.isFinite(messageId)) { res.status(400).json({ upload: false, reason: "chatId/messageId غير صالح" }); return; }
  try {
    res.json(await checkTgVideo({
      chatId, messageId, username: typeof b.username === "string" ? b.username : null, chatTitle: typeof b.chatTitle === "string" ? b.chatTitle : null,
      caption: typeof b.caption === "string" ? b.caption : "", width: Number(b.width) || 0, height: Number(b.height) || 0, duration: Number(b.duration) || 0, fileSize: Number(b.fileSize) || 0,
    }));
  } catch (err) {
    res.status(500).json({ upload: false, reason: (err as Error).message });
  }
});

// الملف نفسه: الجسم = ملف الفيديو، و?uploadId=… من رد check.
crosspostMachineRouter.post("/crosspost/tg/upload", requireBridgeKey, async (req, res) => {
  const uploadId = Number(req.query.uploadId);
  if (!Number.isFinite(uploadId)) { req.resume(); res.status(400).json({ ok: false, message: "uploadId مطلوب" }); return; }
  const filePath = path.join(os.tmpdir(), `tg-fb-${uploadId}-${Date.now()}.mp4`);
  try {
    await pipeline(req, fs.createWriteStream(filePath));
    const { size } = await fs.promises.stat(filePath);
    const result = await performTgUpload(uploadId, filePath, size);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    await performTgUpload(uploadId, filePath, 0).catch(() => {});
    res.status(500).json({ ok: false, message: (err as Error).message });
  } finally {
    fs.promises.unlink(filePath).catch(() => {});
  }
});

// ── المدير: لوحة المتابعة ومفتاح التشغيل ─────────────────────────────────────────────────────────
const router = Router();
router.use("/crosspost", requireAdmin, (_req, _res, next) => { ensureCrosspostSchema().then(() => next(), next); });

router.get("/crosspost/overview", async (_req, res) => {
  res.json(await crosspostOverview());
});

// الربط اليدوي قناة ← صفحة (الإصدار 64): للقنوات العامة التي لا قارئ لها.
router.get("/crosspost/manual-links", async (_req, res) => {
  res.json(await listManualLinks());
});
router.post("/crosspost/manual-links", async (req, res) => {
  const channel = String(req.body?.channel ?? "").trim();
  const fbPageId = String(req.body?.fbPageId ?? "").trim();
  if (!channel || !/^\d+$/.test(fbPageId)) {
    res.status(400).json({ message: "اكتب رابط القناة واختر صفحة فيسبوك" });
    return;
  }
  try {
    res.json(await addManualLink(channel, fbPageId));
  } catch (err) {
    res.status(400).json({ message: (err as Error).message });
  }
});
router.delete("/crosspost/manual-links/:channelId", async (req, res) => {
  await removeManualLink(String(req.params.channelId));
  res.json({ ok: true });
});

// مسار تيليجرام ← فيسبوك (الإصدار 76).
router.get("/crosspost/tg/overview", async (_req, res) => {
  res.json(await tgCrosspostOverview());
});
router.patch("/crosspost/tg/settings", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") { res.status(400).json({ ok: false, message: "enabled مطلوب (true/false)" }); return; }
  res.json(await setTgCrosspostEnabled(req.body.enabled));
});

router.patch("/crosspost/settings", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ ok: false, message: "enabled مطلوب (true/false)" });
    return;
  }
  const result = await setCrosspostEnabled(req.body.enabled);
  res.status(result.ok ? 200 : 502).json(result);
});

export default router;
