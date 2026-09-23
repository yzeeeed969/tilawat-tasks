import app from "./app";
import { logger } from "./lib/logger";
import { startTelegramScheduler } from "./services/telegram-scheduler";
import { startYoutubeScheduler } from "./services/youtube-scheduler";
import { ensureTaskPrayerSchema } from "./services/task-prayer-schema";
import { ensureYoutubeMonitorSchema } from "./services/youtube-monitor-schema";
import { runShortDurationMarkerBackfillOnce, runDueDateTimezoneBackfillOnce } from "./services/youtube-monitor";

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

// سطر تشخيصي: توقيت عملية Node الفعلي على هذا الخادم. اكتشفنا أن تفسير أعمدة timestamp بلا منطقة
// زمنية (مثل tasks.due_date) يعتمد على هذا التوقيت، وقد لا يكون UTC كما قد يُفترَض — هذا السطر
// يوثّقه صراحةً في السجلات بدل أن يبقى لغزًا.
logger.info(
  { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffsetMinutes: new Date().getTimezoneOffset() },
  "توقيت عملية Node عند الإقلاع",
);

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

// عمود tasks.prayer معرَّف في Drizzle، فأي استعلام يقرأ صفّ المهمة كاملًا سيطلبه.
// لذلك ننشئه قبل الاستماع كي لا ينكسر أي استعلام على جدول المهام. الأمر إضافة فقط
// وآمن للتكرار. إن تعذّرت القاعدة الآن (أو تأخّرت) لا نمنع إقلاع الخادم؛ يُعاد
// الضمان تلقائيًا عند أول طلب على مسارات المهام.
try {
  await Promise.race([
    ensureTaskPrayerSchema(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("ensureTaskPrayerSchema timed out")), 20_000).unref();
    }),
  ]);
  logger.info("tasks.prayer column ensured");
} catch (err) {
  logger.error({ err }, "تعذّر ضمان عمود tasks.prayer عند الإقلاع — سيُعاد المحاولة عند أول طلب مهام");
}

// جداول مراقبة يوتيوب جديدة كليًا (لا يقرأها أي استعلام قائم)، فتعذّرها هنا غير حرج —
// لكن ضمانها الآن مبكرًا يُظهر تحذير بذرة قناة بندر بليلة في السجلات فور الإقلاع إن فشلت.
try {
  await Promise.race([
    ensureYoutubeMonitorSchema(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("ensureYoutubeMonitorSchema timed out")), 20_000).unref();
    }),
  ]);
  logger.info("youtube monitor tables ensured");
} catch (err) {
  logger.error({ err }, "تعذّر ضمان جداول مراقبة يوتيوب عند الإقلاع — سيُعاد المحاولة عند أول فحص");
}

// إصلاح لمرة واحدة: مقاطع تجاهلها خلل سابق بسبب قِصر مدتها رغم حملها العلامة *1.
// آمنة للتكرار (تتحقق من علامة youtube_settings أولًا)، وتُستهلك فقط عند وجود مقاطع متضررة فعلًا.
try {
  await Promise.race([
    runShortDurationMarkerBackfillOnce().then((result) => {
      if (result.ran && result.reprocessed > 0) {
        logger.info({ reprocessed: result.reprocessed }, "أُعيد فحص مقاطع يوتيوب قصيرة كانت مُتجاهَلة رغم حملها العلامة *1");
      }
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("runShortDurationMarkerBackfillOnce timed out")), 20_000).unref();
    }),
  ]);
} catch (err) {
  logger.error({ err }, "تعذّرت إعادة فحص المقاطع القصيرة ذات العلامة عند الإقلاع — سيُعاد المحاولة في الإقلاع التالي");
}

// إصلاح لمرة واحدة منفصل: مقاطع وصلت لحالة "لم تُوثَّق" بسبب خلل تفسير توقيت due_date عند حساب
// التاريخ الهجري (انظر lib/hijri.ts). لا يتعارض مع الإصلاح أعلاه ولا يُعيد تشغيله.
try {
  await Promise.race([
    runDueDateTimezoneBackfillOnce().then((result) => {
      if (result.ran && result.reprocessed > 0) {
        logger.info({ reprocessed: result.reprocessed }, "أُعيد فحص مقاطع يوتيوب تضرّرت من خلل تفسير توقيت تاريخ المهمة");
      }
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("runDueDateTimezoneBackfillOnce timed out")), 20_000).unref();
    }),
  ]);
} catch (err) {
  logger.error({ err }, "تعذّرت إعادة فحص المقاطع المتأثرة بخلل التوقيت عند الإقلاع — سيُعاد المحاولة في الإقلاع التالي");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startTelegramScheduler(logger);
  startYoutubeScheduler(logger);
});
// trigger deploy
