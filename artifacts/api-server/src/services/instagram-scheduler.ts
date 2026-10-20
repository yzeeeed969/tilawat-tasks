import type { Logger } from "pino";
import { runInstagramMonitorTick } from "./instagram-monitor";
import { runFacebookCrosspostTick } from "./facebook-crosspost";
import { ensureTelegramWebhookAllowsCallbacks, processInstagramAttributionTimeouts } from "./instagram-attribution";

const INTERVAL_MS = 20 * 60_000; // كل 20 دقيقة (يشمل تجديد المفاتيح المستحقة)
let started = false;
let running = false;
let loggedNoConfig = false;

export function startInstagramScheduler(logger?: Logger) {
  if (started) return;
  started = true;
  logger?.info({ intervalMs: INTERVAL_MS }, "Instagram monitor scheduler started");

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runInstagramMonitorTick();
      if (result.skipped === "no_config") {
        if (!loggedNoConfig) {
          logger?.warn("INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_REDIRECT_URI غير مضبوطة — مراقبة إنستقرام نائمة");
          loggedNoConfig = true;
        }
        return;
      }
      loggedNoConfig = false;
      if (result.processed > 0 || result.refreshed > 0) logger?.info({ result }, "Instagram monitor tick completed");
      // «من نشر؟»: ما لم يُحدَّد خلال 24 ساعة يُنسب للعضو الأول.
      await processInstagramAttributionTimeouts().catch((err) => logger?.warn({ err }, "Instagram attribution timeouts failed"));
      // نسخ فيسبوك: بعد توثيق منشورات إنستقرام (الاتجاه إنستقرام ← فيسبوك فقط).
      const fb = await runFacebookCrosspostTick();
      if (fb.processed > 0) logger?.info({ fb }, "Facebook crosspost tick completed");
    } catch (err) {
      logger?.warn({ err }, "Instagram monitor tick failed");
    } finally {
      running = false;
    }
  };

  // أزرار «أنا نشرته» تحتاج أن يستقبل الـ webhook ضغطات الأزرار (callback_query).
  setTimeout(() => { ensureTelegramWebhookAllowsCallbacks().catch((err) => logger?.warn({ err }, "Telegram webhook callback_query check failed")); }, 15_000).unref();
  setTimeout(tick, 30_000).unref();
  setInterval(tick, INTERVAL_MS).unref();
}
