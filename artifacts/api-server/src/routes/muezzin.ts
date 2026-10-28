import express, { Router } from "express";
import { requireAdmin } from "../middlewares/auth";
import { riyadhDayKey } from "../lib/hijri";
import { ensureMuezzinSchema } from "../services/muezzin-schema";
import {
  createMuezzin,
  getScheduleRange,
  getSettings,
  isVisionConfigured,
  isWhatsAppConfigured,
  listMuezzins,
  MuezzinError,
  readScheduleImage,
  recentLog,
  saveWeek,
  sendForDate,
  updateMuezzin,
  updateSettings,
} from "../services/muezzin";
import { logWeeklyActivity } from "./weekly-schedule";

// «جدول المؤذنين» — للمدير فقط (requireAdmin على كل مسار في الخادم).
const router = Router();

router.use("/muezzin-schedule", async (_req, _res, next) => {
  try {
    await ensureMuezzinSchema();
    next();
  } catch (err) {
    next(err);
  }
});

function handle(fn: (req: any, res: any) => Promise<unknown>) {
  return async (req: any, res: any, next: any) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof MuezzinError) {
        res.status(error.status).json({ error: "MUEZZIN_ERROR", message: error.message });
        return;
      }
      next(error);
    }
  };
}

router.get("/muezzin-schedule/setup", requireAdmin, handle(async (_req, res) => {
  const today = riyadhDayKey(new Date());
  res.json({
    today,
    settings: await getSettings(),
    status: { vision: isVisionConfigured(), whatsapp: isWhatsAppConfigured() },
    muezzins: await listMuezzins(),
    upcoming: await getScheduleRange(today, 8),
    log: await recentLog(),
  });
}));

router.post("/muezzin-schedule/muezzins", requireAdmin, handle(async (req, res) => {
  await createMuezzin(req.body ?? {});
  res.status(201).json({ ok: true });
}));

router.patch("/muezzin-schedule/muezzins/:id", requireAdmin, handle(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new MuezzinError(400, "معرّف غير صحيح");
  await updateMuezzin(id, req.body ?? {});
  res.json({ ok: true });
}));

// الصورة تُرسل خامًا (image/*) لا JSON — محلّل JSON العام محدود بـ 100KB.
router.post(
  "/muezzin-schedule/read",
  requireAdmin,
  express.raw({ type: "image/*", limit: "12mb" }),
  handle(async (req, res) => {
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    res.json(await readScheduleImage(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), mime));
  }),
);

router.post("/muezzin-schedule/week", requireAdmin, handle(async (req, res) => {
  const result = await saveWeek({ ...(req.body ?? {}), userId: req.currentUser?.id ?? null });
  await logWeeklyActivity(req, "muezzin_schedule_created", "muezzin_schedule", null, `جدول المؤذنين ${result.weekStart}`, result).catch(() => {});
  res.json(result);
}));

router.patch("/muezzin-schedule/settings", requireAdmin, handle(async (req, res) => {
  await updateSettings(req.body ?? {});
  res.json(await getSettings());
}));

// إرسال يدوي ليوم محدد (يحترم وضع التجربة ويمنع التكرار).
router.post("/muezzin-schedule/send", requireAdmin, handle(async (req, res) => {
  res.json(await sendForDate(String(req.body?.date ?? "")));
}));

export default router;
