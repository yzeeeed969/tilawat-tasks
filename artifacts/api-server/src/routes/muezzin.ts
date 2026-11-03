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
import { assignSubstitute, dutiesForDate, dutyStats, prepareMeta, recentEvents, templateStatuses } from "../services/muezzin-confirm";
import { addDays } from "../services/muezzin";

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

router.get("/muezzin-schedule/setup", requireAdmin, handle(async (_req: any, res) => {
  const today = riyadhDayKey(new Date());
  res.json({
    today,
    settings: await getSettings(),
    status: {
      vision: isVisionConfigured(),
      whatsapp: isWhatsAppConfigured(),
      appSecret: Boolean(process.env.WHATSAPP_APP_SECRET?.trim()),
      webhookUrl: `${_req.protocol}://${_req.get("host")}/api/whatsapp/webhook`,
    },
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

// الملف (صورة أو PDF) يُرسل خامًا لا JSON — محلّل JSON العام محدود بـ 100KB.
router.post(
  "/muezzin-schedule/read",
  requireAdmin,
  express.raw({ type: ["image/*", "application/pdf"], limit: "20mb" }),
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

// ردود المؤذنين (عُلم / اعتذار) ليوم محدد + الإحصائيات + سجل واتساب.
router.get("/muezzin-schedule/duties", requireAdmin, handle(async (req, res) => {
  const date = String(req.query.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MuezzinError(400, "تاريخ غير صحيح");
  const settings = await getSettings();
  const today = riyadhDayKey(new Date());
  res.json({
    duties: await dutiesForDate(date),
    stats: await dutyStats(addDays(today, -30), addDays(today, 7), settings.testMode),
    events: await recentEvents(80),
  });
}));

// إسناد بديل من الموقع (بدل واتساب) — نفس النتيجة: يتحدّث الجدول وتصل البديلَ رسالته.
router.post("/muezzin-schedule/duties/:id/substitute", requireAdmin, handle(async (req, res) => {
  res.json(await assignSubstitute(Number(req.params.id), Number(req.body?.substituteId)));
}));

// إنشاء نماذج واتساب وإرسال القوالب لاعتماد ميتا بالنص المختار.
router.post("/muezzin-schedule/meta/prepare", requireAdmin, handle(async (_req, res) => {
  res.json(await prepareMeta());
}));

router.get("/muezzin-schedule/meta/templates", requireAdmin, handle(async (_req, res) => {
  res.json({ templates: await templateStatuses() });
}));

// إرسال يدوي ليوم محدد (يحترم وضع التجربة ويمنع التكرار).
router.post("/muezzin-schedule/send", requireAdmin, handle(async (req, res) => {
  res.json(await sendForDate(String(req.body?.date ?? "")));
}));

export default router;
