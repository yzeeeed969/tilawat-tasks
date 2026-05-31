import { Router } from "express";
import { db, telegramRecipientsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { isTelegramConfigured, sendTelegramMessage } from "../services/telegram";
import {
  createTelegramLinkToken,
  disconnectTelegramForUser,
  getTelegramSettings,
  linkTelegramChat,
  listTelegramLogs,
  listTelegramRecipients,
  runTelegramNotificationCycle,
  sendDailyPublicSummaryNow,
  sendTelegramTestMessage,
  updateTelegramSettings,
} from "../services/telegram-notification-engine";
import { ensureTelegramSchema } from "../services/telegram-schema";

const router = Router();

function parseTelegramStartToken(text: unknown) {
  if (typeof text !== "string") return null;
  const [command, token] = text.trim().split(/\s+/);
  if (command !== "/start" || !token) return null;
  return token;
}

async function replyToTelegramStart(chatId: unknown, text: string) {
  if (chatId === undefined || chatId === null) return;
  await sendTelegramMessage(String(chatId), text);
}

// Public Telegram webhook. Security is handled by the secret path segment.
router.post("/telegram/webhook/:secret", async (req, res) => {
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || req.params.secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(404).json({ ok: false });
    return;
  }

  const message = req.body?.message;
  const token = parseTelegramStartToken(message?.text);
  const chatId = message?.chat?.id;
  const username = message?.from?.username;

  if (chatId === undefined || chatId === null) {
    res.json({ ok: true });
    return;
  }

  if (!token) {
    if (typeof message?.text === "string" && message.text.trim().startsWith("/start")) {
      await replyToTelegramStart(
        chatId,
        "رمز الربط غير موجود.\nأنشئ رمز ربط جديد من الموقع ثم أرسله هنا كاملًا، مثل:\n<code>/start الرمز</code>",
      );
      res.json({ ok: true });
      return;
    }

    res.json({ ok: true });
    return;
  }

  try {
    await linkTelegramChat({
      token,
      chatId: String(chatId),
      telegramUsername: typeof username === "string" ? username : null,
    });
    await replyToTelegramStart(
      chatId,
      "تم ربط حسابك في Telegram بنجاح.\nيمكنك الآن الرجوع إلى الموقع والضغط على <b>إرسال اختبار لي</b>.",
    );
    res.json({ ok: true });
  } catch {
    await replyToTelegramStart(
      chatId,
      "رمز الربط غير صالح أو منتهي.\nأنشئ رمزًا جديدًا من الموقع ثم أرسله هنا خلال 30 دقيقة.",
    );
    res.json({ ok: true });
  }
});

router.get("/telegram/settings", requireAdmin, async (_req, res) => {
  try {
    const [settings, recipients] = await Promise.all([
      getTelegramSettings(),
      listTelegramRecipients(),
    ]);
    res.json({ settings, recipients, botConfigured: isTelegramConfigured() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "فشل تحميل إعدادات Telegram" });
  }
});

router.patch("/telegram/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await updateTelegramSettings(req.body ?? {});
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "بيانات غير صحيحة" });
  }
});

router.get("/telegram/logs", requireAdmin, async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  try {
    const logs = await listTelegramLogs(Number.isFinite(limit) ? limit : 100);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "فشل تحميل سجل Telegram" });
  }
});

router.post("/telegram/run-due", requireAdmin, async (_req, res) => {
  try {
    const result = await runTelegramNotificationCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "فشل تشغيل فحص Telegram" });
  }
});

router.post("/telegram/public-summary-now", requireAdmin, async (req, res) => {
  const user = (req as any).currentUser;
  try {
    const result = await sendDailyPublicSummaryNow(user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "فشل إرسال ملخص منشورات اليوم" });
  }
});

router.get("/telegram/me", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  try {
    await ensureTelegramSchema();
    const [recipient] = await db
      .select()
      .from(telegramRecipientsTable)
      .where(and(
        eq(telegramRecipientsTable.userId, user.id),
        eq(telegramRecipientsTable.isEnabled, true),
      ))
      .limit(1);
    res.json({
      linked: Boolean(recipient),
      telegramUsername: recipient?.telegramUsername ?? null,
      linkedAt: recipient?.linkedAt ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "فشل تحميل ربط Telegram" });
  }
});

router.post("/telegram/link-token", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  const requestedUserId = Number(req.body?.userId ?? user.id);

  try {
    const result = await createTelegramLinkToken({
      userId: Number.isFinite(requestedUserId) ? requestedUserId : user.id,
      requestedByUserId: user.id,
      requestedByRole: user.role,
    });
    res.json(result);
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : "غير مصرح" });
  }
});

router.delete("/telegram/me", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  try {
    await disconnectTelegramForUser(user.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "فشل إلغاء الربط" });
  }
});

router.post("/telegram/test", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  const requestedUserId = Number(req.body?.userId ?? user.id);

  if (user.role !== "admin" && requestedUserId !== user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const result = await sendTelegramTestMessage(Number.isFinite(requestedUserId) ? requestedUserId : user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "فشل إرسال الاختبار" });
  }
});

export default router;
