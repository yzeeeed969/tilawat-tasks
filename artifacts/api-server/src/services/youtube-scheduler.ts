import type { Logger } from "pino";
import { runYoutubeMonitorTick } from "./youtube-monitor";

const INTERVAL_MS = 10 * 60_000; // كل 10 دقائق
let started = false;
let running = false;
let loggedMissingKey = false;

export function startYoutubeScheduler(logger?: Logger) {
  if (started) return;
  started = true;
  logger?.info({ intervalMs: INTERVAL_MS }, "YouTube monitor scheduler started");

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runYoutubeMonitorTick();
      if (result.skippedNoKey) {
        if (!loggedMissingKey) {
          logger?.warn("YOUTUBE_API_KEY غير مضبوط — مراقبة يوتيوب نائمة حتى يُضاف المفتاح");
          loggedMissingKey = true;
        }
        return;
      }
      loggedMissingKey = false;
      if (result.processed > 0) {
        logger?.info({ result }, "YouTube monitor tick completed");
      }
    } catch (err) {
      logger?.warn({ err }, "YouTube monitor tick failed");
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 15_000).unref();
  setInterval(tick, INTERVAL_MS).unref();
}
