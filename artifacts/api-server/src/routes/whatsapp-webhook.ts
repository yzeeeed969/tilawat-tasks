import { Router } from "express";
import { logger } from "../lib/logger";
import { ensureMuezzinSchema } from "../services/muezzin-schema";
import { getSettings } from "../services/muezzin";
import { handleWebhook, verifySignature } from "../services/muezzin-confirm";

// استقبال ردود واتساب الرسمية من ميتا (Webhook) — عام بلا جلسة، لكنه محمي:
// - التحقق (GET) برمز سري يظهر للمدير في صفحة «جدول المؤذنين».
// - كل دفعة (POST) يجب أن تحمل توقيع ميتا بمفتاح التطبيق السري WHATSAPP_APP_SECRET وإلا تُرفض.
const router = Router();

router.get("/whatsapp/webhook", async (req, res) => {
  try {
    await ensureMuezzinSchema();
    const { verifyToken } = await getSettings();
    const mode = String(req.query["hub.mode"] ?? "");
    const token = String(req.query["hub.verify_token"] ?? "");
    if (mode === "subscribe" && verifyToken && token === verifyToken) {
      res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
      return;
    }
    res.sendStatus(403);
  } catch {
    res.sendStatus(500);
  }
});

router.post("/whatsapp/webhook", async (req, res) => {
  if (!verifySignature((req as any).rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
    res.sendStatus(401);
    return;
  }
  try {
    await handleWebhook(req.body);
  } catch (err) {
    logger.warn({ err }, "WhatsApp webhook handling failed");
  }
  // نرد 200 دائمًا بعد المعالجة — المعالجة نفسها تمنع التكرار.
  res.sendStatus(200);
});

export default router;
