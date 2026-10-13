import { and, eq, isNull, sql } from "drizzle-orm";
import { db, tasksTable, taskProofsTable, activityLogTable } from "@workspace/db";
import { notifyTaskCompleted, notifyDependentTasksReady } from "../routes/tasks";
import { notifyTelegramTaskCompleted } from "./telegram-notification-engine";

// توثيق مهمة تلقائيًا من مصدر خارجي (مقطع يوتيوب، منشور تلقرام…) — مشترك بين أنظمة المراقبة.
// يوثّق مهمة واحدة فقط وهي معلّقة: يضيف شاهدًا (يُحفظ معرّفه للتراجع الدقيق) ويكمل المهمة في معاملة،
// ثم سجل نشاط وإشعارات الإكمال. مهمة غير معلّقة ⇐ لا شيء (documented: false).
export async function documentTaskAutomatically(input: {
  taskId: number;
  proofUrl: string;
  publishedAt: Date;
  note: string;
  activityUserName: string;
  activityAction: string;
  meta?: Record<string, unknown>;
}): Promise<{ documented: boolean; createdProofId: number | null; reason?: string }> {
  const [task] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      memberId: tasksTable.memberId,
      submissionUrl: tasksTable.submissionUrl,
      status: tasksTable.status,
      deletedAt: tasksTable.deletedAt,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, input.taskId))
    .limit(1);

  if (!task || task.status !== "pending" || task.deletedAt) {
    return { documented: false, createdProofId: null, reason: "المهمة لم تعد معلّقة عند لحظة التوثيق" };
  }

  const completedAt = new Date();
  const submissionUrl = task.submissionUrl ?? input.proofUrl;

  let createdProofId: number | null = null;
  await db.transaction(async (tx: any) => {
    const [proof] = await tx.insert(taskProofsTable).values({
      taskId: input.taskId,
      url: input.proofUrl,
      note: input.note,
      createdByUserId: null,
    }).returning();
    createdProofId = proof.id;

    await tx.update(tasksTable).set({
      status: "completed",
      completedAt,
      submissionUrl,
    }).where(eq(tasksTable.id, input.taskId));
  });

  await db.insert(activityLogTable).values({
    userId: null,
    userName: input.activityUserName,
    action: input.activityAction,
    entityType: "task",
    entityId: input.taskId,
    entityName: task.title,
    meta: input.meta ?? null,
  });

  const notifyPayload = { id: input.taskId, title: task.title, memberId: task.memberId, submissionUrl, completedAt };
  await notifyTaskCompleted(notifyPayload).catch(() => {});
  await notifyTelegramTaskCompleted(notifyPayload).catch(() => {});
  await notifyDependentTasksReady(input.taskId).catch(() => {});

  return { documented: true, createdProofId };
}

// شاهد إضافي لمهمة مكتملة مسبقًا (مثل منشور تصميم ثانٍ لنفس اليوم): يضيف صف شاهد فقط —
// لا يغيّر الحالة ولا رابط التسليم ولا وقت الإكمال ولا التقدّم، ولا يرسل أي إشعار إكمال ثانٍ.
export async function addExtraProof(input: {
  taskId: number;
  proofUrl: string;
  note: string;
  activityUserName: string;
  activityAction: string;
  meta?: Record<string, unknown>;
}): Promise<{ added: boolean; createdProofId: number | null; reason?: string }> {
  const [task] = await db
    .select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, deletedAt: tasksTable.deletedAt })
    .from(tasksTable)
    .where(eq(tasksTable.id, input.taskId))
    .limit(1);
  if (!task || task.deletedAt) return { added: false, createdProofId: null, reason: "المهمة غير موجودة" };
  if (task.status !== "completed") return { added: false, createdProofId: null, reason: "المهمة ليست مكتملة — الشاهد الإضافي لمهمة مكتملة فقط" };

  const [proof] = await db.insert(taskProofsTable).values({
    taskId: input.taskId,
    url: input.proofUrl,
    note: input.note,
    createdByUserId: null,
  }).returning({ id: taskProofsTable.id });

  await db.insert(activityLogTable).values({
    userId: null,
    userName: input.activityUserName,
    action: input.activityAction,
    entityType: "task",
    entityId: input.taskId,
    entityName: task.title,
    meta: input.meta ?? null,
  });

  return { added: true, createdProofId: proof.id };
}

// شاهد لمهمة «هدف أسبوعي بعدد مرات» (weeklyQuotaRequired = N) — بنفس قاعدة إضافة الشاهد اليدوي
// (POST /tasks/:id/proofs): التقدّم = الشواهد الفعّالة ÷ N، والمهمة تكتمل فقط عند بلوغ N شواهد،
// ويُرسل إشعار الإكمال مرة واحدة لحظة الاكتمال. ما زاد عن N يُضاف شاهدًا بلا تغيير حالة ولا إشعار.
export async function addQuotaProof(input: {
  taskId: number;
  proofUrl: string;
  note: string;
  activityUserName: string;
  activityAction: string;
  meta?: Record<string, unknown>;
}): Promise<{ added: boolean; createdProofId: number | null; count: number; required: number; completedNow: boolean; reason?: string }> {
  type QuotaOutcome = { createdProofId: number; count: number; required: number; completedNow: boolean; title: string; memberId: number; submissionUrl: string; completedAt: Date | null };
  let outcome = null as QuotaOutcome | null;
  let failure = null as string | null;

  await db.transaction(async (tx: any) => {
    // قفل صف المهمة: شاهدان متزامنان لا يحسبان نفس العدد فيُكملان مرتين.
    const [task] = await tx.select({
      id: tasksTable.id,
      title: tasksTable.title,
      memberId: tasksTable.memberId,
      status: tasksTable.status,
      submissionUrl: tasksTable.submissionUrl,
      weeklyQuotaRequired: tasksTable.weeklyQuotaRequired,
      deletedAt: tasksTable.deletedAt,
    }).from(tasksTable).where(eq(tasksTable.id, input.taskId)).for("update");
    if (!task || task.deletedAt) {
      failure = "المهمة غير موجودة";
      return;
    }
    const required = task.weeklyQuotaRequired && task.weeklyQuotaRequired > 0 ? task.weeklyQuotaRequired : 1;
    const [proof] = await tx.insert(taskProofsTable).values({
      taskId: input.taskId,
      url: input.proofUrl,
      note: input.note,
      createdByUserId: null,
    }).returning({ id: taskProofsTable.id });
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, input.taskId), isNull(taskProofsTable.deletedAt)));
    const completedNow = count >= required && task.status !== "completed";
    const submissionUrl = task.submissionUrl ?? input.proofUrl;
    const completedAt = completedNow ? new Date() : null;
    await tx.update(tasksTable).set({
      submissionUrl,
      progress: Math.min(100, Math.round((count / required) * 100)),
      ...(completedNow ? { status: "completed", completedAt } : {}),
    }).where(eq(tasksTable.id, input.taskId));
    outcome = { createdProofId: proof.id, count: Number(count), required, completedNow, title: task.title, memberId: task.memberId, submissionUrl, completedAt };
  });

  if (!outcome) return { added: false, createdProofId: null, count: 0, required: 0, completedNow: false, reason: failure ?? "تعذّر إضافة الشاهد" };
  const done: QuotaOutcome = outcome;

  await db.insert(activityLogTable).values({
    userId: null,
    userName: input.activityUserName,
    action: input.activityAction,
    entityType: "task",
    entityId: input.taskId,
    entityName: done.title,
    meta: { ...(input.meta ?? {}), count: done.count, required: done.required, completedNow: done.completedNow },
  });

  if (done.completedNow) {
    const notifyPayload = { id: input.taskId, title: done.title, memberId: done.memberId, submissionUrl: done.submissionUrl, completedAt: done.completedAt };
    await notifyTaskCompleted(notifyPayload).catch(() => {});
    await notifyTelegramTaskCompleted(notifyPayload).catch(() => {});
    await notifyDependentTasksReady(input.taskId).catch(() => {});
  }

  return { added: true, createdProofId: done.createdProofId, count: done.count, required: done.required, completedNow: done.completedNow };
}
