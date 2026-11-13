import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAdmin } from "../middlewares/auth";
import { checkFridayKey, fridayKeyConfigured, fridayPublishOverview, submitFriday, testAppLogin, type SurahPart } from "../services/app-friday-publish";

// ── أجهزة التسجيل (ماك ميني المسجدين): مفتاح سري في Authorization: Bearer <FRIDAY_PUBLISH_KEY> — لا جلسة ──
export const fridayMachineRouter = Router();

function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!fridayKeyConfigured()) { res.status(503).json({ ok: false, message: "المفتاح السري غير مضبوط على الخادم (FRIDAY_PUBLISH_KEY)" }); return; }
  if (!checkFridayKey(req.headers.authorization)) { res.status(401).json({ ok: false, message: "Unauthorized" }); return; }
  next();
}

// فحص الاتصال والمفتاح فقط.
fridayMachineRouter.get("/friday-publish/machine/ping", requireKey, (_req, res) => {
  res.json({ ok: true });
});

// الجسم: { mosque: "makkah"|"madinah", kind: "khutbah"|"prayer", audioUrl, surahs?: [{ surah, from?, to? }], dryRun?: true }
// dryRun: تجربة كاملة بلا نشر (تُقبل في أي يوم).
fridayMachineRouter.post("/friday-publish/machine/submit", requireKey, async (req, res) => {
  const b = req.body ?? {};
  const mosque = b.mosque === "makkah" || b.mosque === "madinah" ? b.mosque : null;
  const kind = b.kind === "khutbah" || b.kind === "prayer" ? b.kind : null;
  const audioUrl = typeof b.audioUrl === "string" ? b.audioUrl.trim() : "";
  if (!mosque || !kind || !audioUrl) { res.status(400).json({ ok: false, message: "mosque و kind و audioUrl مطلوبة" }); return; }
  const surahs: SurahPart[] = Array.isArray(b.surahs)
    ? b.surahs.slice(0, 6).map((s: any) => ({ surah: Number(s?.surah), from: s?.from != null ? Number(s.from) : undefined, to: s?.to != null ? Number(s.to) : undefined }))
    : [];
  try {
    const dryRun = b.dryRun === true || req.query.dryRun === "1";
    const result = await submitFriday({ mosque, kind, audioUrl, surahs, dryRun });
    res.status(result.ok ? 200 : result.status === "rejected" || result.status === "missing-data" ? 400 : 502).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// ── المدير ────────────────────────────────────────────────────────────────────────────────────
const router = Router();

router.get("/friday-publish", requireAdmin, async (_req, res) => {
  try { res.json(await fridayPublishOverview()); } catch (err) { res.status(500).json({ message: (err as Error).message }); }
});

// المدير: إعادة إرسال طلب جمعة اليوم من الموقع (نفس منطق الجهاز)، مع خطيب اختياري.
router.post("/friday-publish/resubmit", requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  if (!(b.mosque === "makkah" || b.mosque === "madinah") || !(b.kind === "khutbah" || b.kind === "prayer") || typeof b.audioUrl !== "string") {
    res.status(400).json({ ok: false, message: "mosque و kind و audioUrl مطلوبة" }); return;
  }
  const surahs: SurahPart[] = Array.isArray(b.surahs) ? b.surahs.map((s: any) => ({ surah: Number(s?.surah), from: s?.from != null ? Number(s.from) : undefined, to: s?.to != null ? Number(s.to) : undefined })) : [];
  res.json(await submitFriday({ mosque: b.mosque, kind: b.kind, audioUrl: b.audioUrl.trim(), surahs, khateeb: typeof b.khateeb === "string" ? b.khateeb : undefined }));
});

router.post("/friday-publish/test-login", requireAdmin, async (_req, res) => {
  res.json(await testAppLogin());
});

export default router;
