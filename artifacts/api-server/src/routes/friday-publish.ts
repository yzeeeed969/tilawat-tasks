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

// الجسم: { mosque: "makkah"|"madinah", kind: "khutbah"|"prayer", audioUrl, surahs?: [{ surah, from?, to? }] }
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
    const result = await submitFriday({ mosque, kind, audioUrl, surahs });
    res.status(result.ok ? 200 : result.status === "rejected" ? 400 : 502).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// ── المدير ────────────────────────────────────────────────────────────────────────────────────
const router = Router();

router.get("/friday-publish", requireAdmin, async (_req, res) => {
  try { res.json(await fridayPublishOverview()); } catch (err) { res.status(500).json({ message: (err as Error).message }); }
});

router.post("/friday-publish/test-login", requireAdmin, async (_req, res) => {
  res.json(await testAppLogin());
});

export default router;
