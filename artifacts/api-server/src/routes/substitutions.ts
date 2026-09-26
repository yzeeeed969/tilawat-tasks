import { Router } from "express";
import { inArray } from "drizzle-orm";
import { db, activityLogTable, membersTable } from "@workspace/db";
import { ensureReciterSubstitutionSchema } from "../services/reciter-substitution-schema";
import { dispatchSubstitutionNotifications } from "../services/reciter-substitution-notifications";
import {
  applySubstitution,
  buildSubstitutionPlan,
  listSubstitutionSlots,
  listTaskSubstitutions,
  publicPlan,
  SubstitutionError,
  undoSubstitution,
  type SubstitutionScopeKind,
} from "../services/reciter-substitution";

// مسار النيابة الوحيد لتغيير قارئ مهمة قائمة. كل المسارات للمدير فقط.
const router = Router();

router.use(async (_req, _res, next) => {
  try {
    await ensureReciterSubstitutionSchema();
    next();
  } catch (err) {
    next(err);
  }
});

function requireAdmin(req: any, res: any) {
  if (req.currentUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function parseScopeKind(value: unknown): SubstitutionScopeKind {
  if (value === "single" || value === "dates" || value === "rest_of_week") return value;
  throw new SubstitutionError(400, "invalid_scope", "نطاق النيابة غير صالح");
}

function parsePositiveInt(value: unknown, code: string, message: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new SubstitutionError(400, code, message);
  return parsed;
}

function sendError(res: any, error: unknown) {
  if (error instanceof SubstitutionError) {
    res.status(error.status).json({ error: error.code, message: error.message, details: error.details ?? null });
    return;
  }
  throw error;
}

async function logActivity(req: any, action: string, entityId: number | null, entityName: string | null, meta?: Record<string, unknown>) {
  const user = req.currentUser;
  if (!user) return;
  await db.insert(activityLogTable).values({
    userId: user.id,
    userName: user.displayName ?? user.username,
    action,
    entityType: "reciter_substitution",
    entityId,
    entityName,
    meta: meta ?? null,
  });
}

// سجل لكل مهمة مسّتها النيابة بنفس شكل سجلات تعديل المهام، كي تظهر في «التقارير ← تعديلات المهام».
const TASK_CHANGE_ACTIONS = {
  reassigned: "task_reciter_substituted",
  deleted: "task_substitution_deleted",
  created: "task_substitution_created",
} as const;

async function logTaskChanges(req: any, result: Awaited<ReturnType<typeof applySubstitution>>) {
  const user = req.currentUser;
  if (!user || result.taskChanges.length === 0) return;
  const memberIds = [...new Set(result.taskChanges.flatMap((c) => [...c.fromMemberIds, ...(c.toMemberId ? [c.toMemberId] : [])]))];
  const members = memberIds.length > 0
    ? await db.select({ id: membersTable.id, name: membersTable.name }).from(membersTable).where(inArray(membersTable.id, memberIds))
    : [];
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  await db.insert(activityLogTable).values(result.taskChanges.map((change) => ({
    userId: user.id,
    userName: user.displayName ?? user.username,
    action: TASK_CHANGE_ACTIONS[change.action],
    entityType: "task",
    entityId: change.taskId,
    entityName: change.newTitle,
    meta: {
      substitutionId: result.substitutionId,
      fromReciterName: result.fromReciterName,
      toReciterName: result.toReciterName,
      fromMemberIds: change.fromMemberIds,
      fromMemberNames: change.fromMemberIds.map((id) => nameById.get(id) ?? ""),
      toMemberId: change.toMemberId,
      toMemberName: change.toMemberId ? nameById.get(change.toMemberId) ?? null : null,
      platformName: change.platformName,
      previousTitle: change.previousTitle,
      newTitle: change.newTitle,
    },
  })));
}

// فروض القارئ الأصلي لنفس الصلاة في أسبوع المهمة (الأحد → السبت) — لاختيار «أيام محددة».
router.get("/tasks/:id/substitution/slots", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const taskId = parsePositiveInt(req.params.id, "invalid_task", "معرّف مهمة غير صالح");
    res.json(await listSubstitutionSlots(taskId));
  } catch (error) {
    sendError(res, error);
  }
});

// معاينة (قراءة فقط): لا تغيّر أي شيء.
router.post("/tasks/:id/substitution/preview", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const taskId = parsePositiveInt(req.params.id, "invalid_task", "معرّف مهمة غير صالح");
    const newReciterId = parsePositiveInt(req.body?.newReciterId, "invalid_reciter", "اختر القارئ النائب");
    const scopeKind = parseScopeKind(req.body?.scopeKind);
    const plan = await buildSubstitutionPlan({ taskId, newReciterId, scopeKind, dates: req.body?.dates });
    res.json(publicPlan(plan));
  } catch (error) {
    sendError(res, error);
  }
});

// تطبيق: يعيد حساب الخطة ويقارن البصمة، ثم ينفّذ كل شيء في معاملة واحدة.
router.post("/tasks/:id/substitution/apply", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const taskId = parsePositiveInt(req.params.id, "invalid_task", "معرّف مهمة غير صالح");
    const newReciterId = parsePositiveInt(req.body?.newReciterId, "invalid_reciter", "اختر القارئ النائب");
    const scopeKind = parseScopeKind(req.body?.scopeKind);
    const result = await applySubstitution({
      taskId,
      newReciterId,
      scopeKind,
      dates: req.body?.dates,
      planToken: String(req.body?.planToken ?? ""),
      decisions: Array.isArray(req.body?.decisions) ? req.body.decisions : [],
      extras: Array.isArray(req.body?.extras) ? req.body.extras : [],
      userId: (req as any).currentUser?.id ?? null,
    });

    await logActivity(req, "reciter_substitution_applied", result.substitutionId, `${result.fromReciterName} ← ${result.toReciterName}`, {
      baseTaskId: taskId,
      scopeKind,
      reassigned: result.reassigned,
      deleted: result.deleted,
      created: result.created,
      protected: result.protected,
    }).catch(() => {});
    await logTaskChanges(req, result).catch((err) => (req as any).log?.error?.({ err }, "reciter_substitution_task_log_failed"));
    await dispatchSubstitutionNotifications(result.notifications, {
      substitutionId: result.substitutionId,
      fromReciterName: result.fromReciterName,
      toReciterName: result.toReciterName,
      undo: false,
    }).catch((err) => (req as any).log?.error?.({ err }, "reciter_substitution_notifications_failed"));

    const { notifications: _n, taskChanges: _c, ...summary } = result;
    res.json(summary);
  } catch (error) {
    sendError(res, error);
  }
});

// سجلّ النيابات التي مسّت هذه المهمة.
router.get("/tasks/:id/substitutions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const taskId = parsePositiveInt(req.params.id, "invalid_task", "معرّف مهمة غير صالح");
    res.json(await listTaskSubstitutions(taskId));
  } catch (error) {
    sendError(res, error);
  }
});

// تراجع كامل عن عملية نيابة (يتخطّى ما اكتمل أو رُفع له شاهد بعدها، ويخبر بذلك).
router.post("/substitutions/:id/undo", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const substitutionId = parsePositiveInt(req.params.id, "invalid_substitution", "معرّف نيابة غير صالح");
    const result = await undoSubstitution(substitutionId, (req as any).currentUser?.id ?? null);
    await logActivity(req, "reciter_substitution_undone", substitutionId, `${result.fromReciterName ?? ""} ← ${result.toReciterName ?? ""}`, {
      restored: result.restored,
      undeleted: result.undeleted,
      removedCreated: result.removedCreated,
      skipped: result.skipped.length,
    }).catch(() => {});
    await dispatchSubstitutionNotifications(result.notifications, {
      substitutionId,
      fromReciterName: result.fromReciterName,
      toReciterName: result.toReciterName,
      undo: true,
    }).catch((err) => (req as any).log?.error?.({ err }, "reciter_substitution_undo_notifications_failed"));
    const { notifications: _n, ...summary } = result;
    res.json(summary);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
