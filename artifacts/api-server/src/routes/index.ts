import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import membersRouter from "./members";
import platformsRouter from "./platforms";
import tasksRouter from "./tasks";
import substitutionsRouter from "./substitutions";
import weeklyScheduleRouter from "./weekly-schedule";
import muezzinRouter from "./muezzin";
import telegramMonitorRouter from "./telegram-monitor";
import commentsRouter from "./comments";
import statsRouter from "./stats";
import adminRouter from "./admin";
import recitersRouter from "./reciters";
import notificationsRouter from "./notifications";
import remindersRouter from "./reminders";
import activityLogRouter from "./activity-log";
import telegramRouter from "./telegram";
import publicRouter from "./public";
import youtubeRouter from "./youtube";
import instagramRouter, { instagramOauthRouter } from "./instagram";
import showcaseRouter, { showcasePublicRouter } from "./showcase";
import crosspostRouter, { crosspostMachineRouter } from "./crosspost";
import fridayPublishRouter, { fridayMachineRouter } from "./friday-publish";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use(authRouter);
router.use(telegramRouter);
router.use(publicRouter);
// عودة المتصفح من ربط إنستقرام — محميّة برمز state لمرة واحدة، لا بالجلسة.
router.use(instagramOauthRouter);
// صفحة «منصات المشروع» العامة (/achievements).
router.use(showcasePublicRouter);
// جهاز تنزيل الرفع التلقائي يوتيوب ← فيسبوك — محمي بمفتاح سري (CROSSPOST_API_KEY)، لا بالجلسة.
router.use(crosspostMachineRouter);
// أجهزة تسجيل الحرمين: نشر الجمعة آليًا في التطبيق — محمي بمفتاح سري (FRIDAY_PUBLISH_KEY).
router.use(fridayMachineRouter);

// Protected routes
router.use(requireAuth);
router.use(membersRouter);
router.use(platformsRouter);
router.use(tasksRouter);
router.use(substitutionsRouter);
router.use(weeklyScheduleRouter);
router.use(muezzinRouter);
router.use(telegramMonitorRouter);
router.use(instagramRouter);
router.use(showcaseRouter);
router.use(crosspostRouter);
router.use(fridayPublishRouter);
router.use(commentsRouter);
router.use(statsRouter);
router.use(adminRouter);
router.use(recitersRouter);
router.use(notificationsRouter);
router.use(remindersRouter);
router.use(activityLogRouter);
router.use(youtubeRouter);

export default router;
