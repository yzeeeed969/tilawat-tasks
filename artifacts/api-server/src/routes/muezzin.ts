import express, { Router } from "express";
import { requireAdmin, requireMuezzinAccess } from "../middlewares/auth";
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
  updateSlot,
  sentDateKeys,
} from "../services/muezzin";
import { logWeeklyActivity } from "./weekly-schedule";
import { assignSubstitute, buildSummary, checkV2Promotion, phoneStatus, prepareV2, reregisterPhone, dutiesForDate, dutyStats, eventsForDate, prepareMeta, prepareSummaryTemplate, sendPreview, startSimulation, sendSummary, SUMMARY_TEXT, templateStatuses } from "../services/muezzin-confirm";
import { addDays, ALL_SLOTS, ROLES, type Role, type Slot } from "../services/muezzin";
import { activeVersion, messages, simulatorBundle, type MsgVersion } from "../services/muezzin-messages";

const fillText = (t: string, v: string[]) => t.replace(/\{\{(\d+)\}\}/g, (_, n) => v[Number(n) - 1] ?? "");

// «جدول المؤذنين» — للمدير ولمن مُنح صلاحية «إدارة جدول المؤذنين» (requireMuezzinAccess على كل مسار).
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

router.get("/muezzin-schedule/setup", requireMuezzinAccess, handle(async (_req: any, res) => {
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
    // من أحد الأسبوع الحالي، ثلاثة أسابيع كاملة (أحد ← سبت) ليُعرض الجدول أسبوعًا أسبوعًا.
    upcoming: await getScheduleRange(addDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay()), 21),
    sentDates: await sentDateKeys(addDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay())),
    log: await recentLog(),
  });
}));

router.post("/muezzin-schedule/muezzins", requireMuezzinAccess, handle(async (req, res) => {
  await createMuezzin(req.body ?? {});
  res.status(201).json({ ok: true });
}));

router.patch("/muezzin-schedule/muezzins/:id", requireMuezzinAccess, handle(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new MuezzinError(400, "معرّف غير صحيح");
  await updateMuezzin(id, req.body ?? {});
  res.json({ ok: true });
}));

// الملف (صورة أو PDF) يُرسل خامًا لا JSON — محلّل JSON العام محدود بـ 100KB.
router.post(
  "/muezzin-schedule/read",
  requireMuezzinAccess,
  express.raw({ type: ["image/*", "application/pdf"], limit: "20mb" }),
  handle(async (req, res) => {
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    res.json(await readScheduleImage(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), mime));
  }),
);

router.post("/muezzin-schedule/week", requireMuezzinAccess, handle(async (req, res) => {
  const result = await saveWeek({ ...(req.body ?? {}), userId: req.currentUser?.id ?? null });
  await logWeeklyActivity(req, "muezzin_schedule_created", "muezzin_schedule", null, `جدول المؤذنين ${result.weekStart}`, result).catch(() => {});
  res.json(result);
}));

// تعديل خانة واحدة في الجدول المعتمد (قبل إرسال رسائل ذلك اليوم).
router.patch("/muezzin-schedule/slot", requireMuezzinAccess, handle(async (req, res) => {
  const result = await updateSlot(req.body ?? {});
  await logWeeklyActivity(req, "muezzin_schedule_slot_updated", "muezzin_schedule", null, `تعديل خانة ${result.dateKey} ${result.slot} ${result.role}`, result).catch(() => {});
  res.json(result);
}));

// الملخص المسائي: إنشاء قالبه (مرة) وإرساله يدويًا ليوم محدد.
router.post("/muezzin-schedule/summary/prepare", requireMuezzinAccess, handle(async (_req, res) => {
  res.json(await prepareSummaryTemplate());
}));
router.post("/muezzin-schedule/summary/send", requireMuezzinAccess, handle(async (req, res) => {
  const date = String(req.body?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MuezzinError(400, "تاريخ غير صحيح");
  res.json(await sendSummary(date));
}));

// تجربة حيّة للصيغ الجديدة على جوال التجربة.
router.post("/muezzin-schedule/sim/start", requireMuezzinAccess, handle(async (_req, res) => {
  res.json(await startSimulation());
}));

// «محاكي الرسائل»: نصوص سيناريو كامل من نفس مصدر الرسائل الفعلية — لا يرسل شيئًا.
router.get("/muezzin-schedule/simulator", requireMuezzinAccess, handle(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const version: MsgVersion = q.version === "live" ? "live" : "draft";
  const slot = (ALL_SLOTS as readonly string[]).includes(String(q.slot)) ? (q.slot as Slot) : "dhuhr";
  const role = (ROLES as readonly string[]).includes(String(q.role)) ? (q.role as Role) : "muezzin";
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date)) ? String(q.date) : addDays(riyadhDayKey(new Date()), 1);
  const name = String(q.name || "يزيد").slice(0, 60);
  const sub = String(q.sub || "أحمد نحاس").slice(0, 60);
  const reason = String(q.reason || "").slice(0, 300);
  // orig: إن كانت المهمة نفسها لبديل (طارئ) — اسم من اعتذر قبله، لمحاكاة بديل البديل.
  const orig = q.orig ? String(q.orig).slice(0, 60) : null;
  const ctx = { name, slot, role, dateKey, original: orig };
  const bundle = simulatorBundle(version, ctx, reason, sub);
  const one = (response: string | null, r: string | null = null) => ({ slot, role, name, response, reason: r, sendOk: true, replacedByDutyId: null });
  const subDuty = (response: string | null) => ({ slot, role, name: sub, response, reason: null, sendOk: true, replacedByDutyId: null });
  const summary = (list: any[]) => fillText(SUMMARY_TEXT, buildSummary(list, dateKey).params);
  // قوائم البديل كما في الواقع: كل المؤذنين النشطين عدا المعتذر، 10 أسماء لكل قائمة (حد ميتا).
  const pool = (await listMuezzins()).filter((m) => m.isActive && m.name !== name).map((m) => m.name);
  const chunks: string[][] = [];
  for (let i = 0; i < pool.length; i += 10) chunks.push(pool.slice(i, i + 10));
  const msgs = messages(version);
  const pickLists = chunks.map((names, i) => ({ header: msgs.pickListHeader(ctx, i + 1, chunks.length), names }));
  res.json({
    ...bundle,
    pickLists,
    active: activeVersion(),
    summaries: {
      ack: summary([one("ack")]),
      none: summary([one(null)]),
      apologyPending: summary([one("apology_pending")]),
      apology: summary([one("apology", reason || "—")]),
      subNone: summary([subDuty(null)]),
      subAck: summary([subDuty("ack")]),
    },
  });
}));

// صياغة المشرف: إرسال قوالبها (والتذكير) لميتا — التحول يتم تلقائيًا عند اعتمادها.
router.post("/muezzin-schedule/meta/prepare-v2", requireMuezzinAccess, handle(async (_req, res) => {
  res.json(await prepareV2());
}));

router.patch("/muezzin-schedule/settings", requireMuezzinAccess, handle(async (req, res) => {
  await updateSettings(req.body ?? {});
  res.json(await getSettings());
}));

// ردود المؤذنين (عُلم / اعتذار) ليوم محدد + الإحصائيات + سجل واتساب.
router.get("/muezzin-schedule/duties", requireMuezzinAccess, handle(async (req, res) => {
  const date = String(req.query.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MuezzinError(400, "تاريخ غير صحيح");
  const settings = await getSettings();
  const today = riyadhDayKey(new Date());
  res.json({
    duties: await dutiesForDate(date),
    stats: await dutyStats(addDays(today, -30), addDays(today, 7), settings.testMode),
    events: await eventsForDate(date),
  });
}));

// إسناد بديل من الموقع (بدل واتساب) — نفس النتيجة: يتحدّث الجدول وتصل البديلَ رسالته.
router.post("/muezzin-schedule/duties/:id/substitute", requireMuezzinAccess, handle(async (req, res) => {
  res.json(await assignSubstitute(Number(req.params.id), Number(req.body?.substituteId)));
}));

// إنشاء نماذج واتساب وإرسال القوالب لاعتماد ميتا بالنص المختار.
router.post("/muezzin-schedule/meta/prepare", requireMuezzinAccess, handle(async (_req, res) => {
  res.json(await prepareMeta());
}));

// حالة رقم الإرسال (اسم العرض وطلب تغييره) — قراءة فقط.
router.get("/muezzin-schedule/meta/phone", requireMuezzinAccess, handle(async (_req, res) => {
  res.json(await phoneStatus());
}));

// إعادة تسجيل الرقم لتطبيق اسم العرض المعتمد — للمدير فقط، والرمز لا يُحفظ.
router.post("/muezzin-schedule/meta/reregister", requireAdmin, handle(async (req, res) => {
  const result = await reregisterPhone(req.body?.pin);
  await logWeeklyActivity(req, "muezzin_phone_reregistered", "muezzin_settings", null, "إعادة تسجيل رقم الإرسال لتطبيق اسم العرض", { name: (result.after as any)?.verified_name }).catch(() => {});
  res.json(result);
}));

router.get("/muezzin-schedule/meta/templates", requireMuezzinAccess, handle(async (_req, res) => {
  await checkV2Promotion(true).catch(() => {}); // فتح الإعدادات يفحص اعتماد صياغة المشرف فورًا
  res.json({ templates: await templateStatuses() });
}));

// معاينة شكل الرسائل على جوال التجربة (بلا قالب — لا تحتاج اعتماد ميتا).
router.post("/muezzin-schedule/meta/preview", requireMuezzinAccess, handle(async (req, res) => {
  res.json(await sendPreview(req.body?.wording));
}));

// إرسال يدوي ليوم محدد (يحترم وضع التجربة ويمنع التكرار).
router.post("/muezzin-schedule/send", requireMuezzinAccess, handle(async (req, res) => {
  res.json(await sendForDate(String(req.body?.date ?? "")));
}));

export default router;
