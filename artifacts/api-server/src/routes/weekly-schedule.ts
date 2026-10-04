import { Router } from "express";
import { db, activityLogTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { ensureWeeklyScheduleSchema } from "../services/weekly-schedule-schema";
import {
  applyImport,
  buildImportPreview,
  createTemplateRow,
  deleteTemplateRow,
  listTemplate,
  TemplateError,
  updateTemplateRow,
} from "../services/weekly-schedule-template";

// قالب النشر والجدول الأسبوعي — للمدير فقط (requireAdmin على كل مسار في الخادم، لا إخفاء في الواجهة فقط).
// هذا المسار للإنشاء فقط: لا يعدّل أي مهمة قائمة. تعديل المهام يبقى حصريًا عبر النيابة.
const router = Router();

router.use("/weekly-schedule", async (_req, _res, next) => {
  try {
    await ensureWeeklyScheduleSchema();
    next();
  } catch (err) {
    next(err);
  }
});

function sendError(res: any, error: unknown) {
  if (error instanceof TemplateError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

export async function logWeeklyActivity(req: any, action: string, entityType: string, entityId: number | null, entityName: string | null, meta?: Record<string, unknown>) {
  const user = req.currentUser;
  if (!user) return;
  await db.insert(activityLogTable).values({
    userId: user.id,
    userName: user.displayName ?? user.username,
    action,
    entityType,
    entityId,
    entityName,
    meta: meta ?? null,
  });
}

// ── استيراد القالب الأولي ───────────────────────────────────────────────────────────────────
router.get("/weekly-schedule/template/import", requireAdmin, async (_req, res) => {
  try {
    res.json(await buildImportPreview());
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/weekly-schedule/template/import", requireAdmin, async (req, res) => {
  try {
    const mapping = req.body?.mapping ?? {};
    const result = await applyImport({
      reciters: mapping.reciters ?? {},
      members: mapping.members ?? {},
      platforms: mapping.platforms ?? {},
    });
    await logWeeklyActivity(req, "publishing_template_imported", "publishing_template", null, "استيراد قالب النشر", {
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped.length,
    }).catch(() => {});
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

// ── إدارة صفوف القالب ───────────────────────────────────────────────────────────────────────
router.get("/weekly-schedule/template", requireAdmin, async (_req, res) => {
  try {
    res.json(await listTemplate());
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/weekly-schedule/template", requireAdmin, async (req, res) => {
  try {
    const row = await createTemplateRow(req.body);
    await logWeeklyActivity(req, "publishing_template_row_created", "publishing_template", row.id, null, { ...row }).catch(() => {});
    res.status(201).json(row);
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/weekly-schedule/template/:id", requireAdmin, async (req, res) => {
  try {
    const row = await updateTemplateRow(Number(req.params.id), req.body);
    await logWeeklyActivity(req, "publishing_template_row_updated", "publishing_template", row.id, null, { ...row }).catch(() => {});
    res.json(row);
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/weekly-schedule/template/:id", requireAdmin, async (req, res) => {
  try {
    const result = await deleteTemplateRow(Number(req.params.id));
    await logWeeklyActivity(req, "publishing_template_row_deleted", "publishing_template", result.deleted, null).catch(() => {});
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
