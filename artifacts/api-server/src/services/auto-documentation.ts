import { eq } from "drizzle-orm";
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
