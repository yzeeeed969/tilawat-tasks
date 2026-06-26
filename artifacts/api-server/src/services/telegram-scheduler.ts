import type { Logger } from "pino";
import { runTelegramNotificationCycle } from "./telegram-notification-engine";

const INTERVAL_MS = 60_000;
let started = false;
let running = false;

export function startTelegramScheduler(logger?: Logger) {
  if (started) return;
  started = true;
  logger?.info({ intervalMs: INTERVAL_MS }, "Telegram scheduler started");

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTelegramNotificationCycle();
      if (result.sent > 0 || result.personalReminders?.due > 0) {
        logger?.info({ result }, "Telegram notification cycle completed");
      }
    } catch (err) {
      logger?.warn({ err }, "Telegram notification cycle failed");
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 10_000).unref();
  setInterval(tick, INTERVAL_MS).unref();
}
