import { Router } from "express";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

router.use(requireAdmin);

const disabledResponse = {
  error: "task_generation_disabled",
  message: "ميزة توليد المهام غير مفعلة حاليًا",
};

router.get("/task-generation/source-tasks", (_req, res) => {
  res.status(410).json(disabledResponse);
});

router.post("/task-generation/preview", (_req, res) => {
  res.status(410).json(disabledResponse);
});

router.post("/task-generation/commit", (_req, res) => {
  res.status(410).json(disabledResponse);
});

router.all(/^\/task-generation(?:\/.*)?$/, (_req, res) => {
  res.status(410).json(disabledResponse);
});

export default router;
