import { Router, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requireAdmin } from "../middlewares/auth";
import { ensureCrosspostSchema } from "../services/crosspost-schema";
import { attachFacebookProofsToYoutubeTasks, checkMachineKey, claimUpload, crosspostOverview, listPendingVideos, machineKeyConfigured, performUpload, setCrosspostEnabled } from "../services/crosspost";

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

// ── المدير: لوحة المتابعة ومفتاح التشغيل ─────────────────────────────────────────────────────────
const router = Router();
router.use("/crosspost", requireAdmin, (_req, _res, next) => { ensureCrosspostSchema().then(() => next(), next); });

router.get("/crosspost/overview", async (_req, res) => {
  res.json(await crosspostOverview());
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
