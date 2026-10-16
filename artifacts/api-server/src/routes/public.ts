import { Router } from "express";

// كان هنا مسار صفحة الإنجازات القديمة (/public/achievements) ومسارا «الإحصائيات العامة» (الرقم التأسيسي
// والرقم اليدوي لمشاهدات يوتيوب) — حُذفت نهائيًا (الإصدار 32). صفحة /achievements الحالية تعتمد فقط على
// /api/public/showcase (أرقام آلية من مصادرها الرسمية). جدول public_site_settings يبقى في القاعدة بلا استخدام.
const router = Router();

export default router;
