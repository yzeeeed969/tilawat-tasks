import app from "./app";
import { logger } from "./lib/logger";
import { startTelegramScheduler } from "./services/telegram-scheduler";

// حماية على مستوى العملية: تمنع توقّف الخادم بسبب أخطاء عابرة غير متوقّعة.
// في Node، الوعد الفاشل دون معالجة (unhandled rejection) يُنهي العملية افتراضيًا؛
// نلتقطه هنا ونسجّله فقط، فيبقى الخادم يعمل.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection (تم تجاهله، الخادم مستمر)");
});

// الخطأ المتزامن غير الملتقَط قد يترك العملية في حالة غير سليمة؛ نسجّله ثم نخرج
// بهدوء (رمز 1) ليتكفّل المشغّل التلقائي (run-api-forever) بإعادة التشغيل نظيفًا.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — سيُعاد تشغيل الخادم تلقائيًا");
  process.exit(1);
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startTelegramScheduler(logger);
});
// trigger deploy
