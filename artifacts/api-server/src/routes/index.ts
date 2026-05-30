import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import membersRouter from "./members";
import platformsRouter from "./platforms";
import tasksRouter from "./tasks";
import commentsRouter from "./comments";
import statsRouter from "./stats";
import adminRouter from "./admin";
import recitersRouter from "./reciters";
import notificationsRouter from "./notifications";
import activityLogRouter from "./activity-log";
import telegramRouter from "./telegram";
import publicRouter from "./public";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use(authRouter);
router.use(telegramRouter);
router.use(publicRouter);

// Protected routes
router.use(requireAuth);
router.use(membersRouter);
router.use(platformsRouter);
router.use(tasksRouter);
router.use(commentsRouter);
router.use(statsRouter);
router.use(adminRouter);
router.use(recitersRouter);
router.use(notificationsRouter);
router.use(activityLogRouter);

export default router;
