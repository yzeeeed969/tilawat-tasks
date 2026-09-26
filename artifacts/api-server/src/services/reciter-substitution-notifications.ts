import { and, eq, inArray } from "drizzle-orm";
import { db, notificationsTable, usersTable } from "@workspace/db";
import { safeAnchorFromDateKey } from "../lib/hijri";
import { notifyTelegramReciterSubstitution } from "./telegram-notification-engine";
import type { SubstitutionNotification } from "./reciter-substitution";

// إشعارات النيابة: لكل عضو رسالة واحدة (داخلية + تيليجرام) تجمع كل ما تغيّر في مهامه.
// تُرسل بعد نجاح المعاملة فقط؛ فشلها لا يلغي النيابة (يُسجَّل في السجل).

const PRAYER_LABELS: Record<string, string> = {
  fajr: "الفجر",
  maghrib: "المغرب",
  isha: "العشاء",
  jumuah: "الجمعة",
};

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ar-SA", { timeZone: "Asia/Riyadh", weekday: "long" });
const HIJRI_FORMATTER = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura", { timeZone: "Asia/Riyadh", day: "numeric", month: "long" });

function slotText(n: SubstitutionNotification) {
  const parts: string[] = [n.platformName];
  if (n.dateKey) {
    const anchor = safeAnchorFromDateKey(n.dateKey);
    parts.push(`${WEEKDAY_FORMATTER.format(anchor)} ${HIJRI_FORMATTER.format(anchor)}`);
  }
  if (n.prayer) parts.push(`صلاة ${PRAYER_LABELS[n.prayer] ?? n.prayer}`);
  return parts.join(" — ");
}

type Context = {
  substitutionId: number;
  fromReciterName: string | null;
  toReciterName: string | null;
  undo: boolean;
};

function sectionsFor(items: SubstitutionNotification[], ctx: Context) {
  const from = ctx.fromReciterName ?? "القارئ الأصلي";
  const to = ctx.toReciterName ?? "النائب";
  const byKind = (kind: SubstitutionNotification["kind"]) => items.filter((item) => item.kind === kind).map(slotText);
  const sections: Array<{ title: string; lines: string[] }> = [];
  const assigned = byKind("assigned");
  const changed = byKind("reciter_changed");
  const cancelled = byKind("cancelled");
  const movedAway = byKind("moved_away");

  if (!ctx.undo) {
    if (assigned.length) sections.push({ title: `أُسندت إليك هذه المهام (القارئ: ${to} نيابةً عن ${from}):`, lines: assigned });
    if (changed.length) sections.push({ title: `تغيّر القارئ في مهامك إلى ${to} (نيابةً عن ${from}):`, lines: changed });
    if (cancelled.length) sections.push({ title: `أُلغيت هذه المهام لأن ${to} لا حساب له على المنصة:`, lines: cancelled });
    if (movedAway.length) sections.push({ title: "لم تعد مسؤولًا عن هذه المهام (أُسندت لعضو آخر بسبب النيابة):", lines: movedAway });
  } else {
    if (assigned.length) sections.push({ title: `عادت إليك هذه المهام (القارئ: ${from}):`, lines: assigned });
    if (changed.length) sections.push({ title: `عاد القارئ في مهامك إلى ${from}:`, lines: changed });
    if (cancelled.length) sections.push({ title: "أُلغيت هذه المهام (كانت مُنشأة للنيابة):", lines: cancelled });
    if (movedAway.length) sections.push({ title: "لم تعد مسؤولًا عن هذه المهام (عادت لمسؤولها السابق):", lines: movedAway });
  }
  return sections;
}

export async function dispatchSubstitutionNotifications(notifications: SubstitutionNotification[], ctx: Context) {
  if (notifications.length === 0) return;
  const byMember = new Map<number, SubstitutionNotification[]>();
  for (const n of notifications) {
    if (!byMember.has(n.memberId)) byMember.set(n.memberId, []);
    byMember.get(n.memberId)!.push(n);
  }

  const heading = ctx.undo
    ? `تم التراجع عن نيابة ${ctx.toReciterName ?? ""} عن ${ctx.fromReciterName ?? ""}`
    : `نيابة: ${ctx.toReciterName ?? ""} عن ${ctx.fromReciterName ?? ""}`;

  const memberIds = [...byMember.keys()];
  const users = await db
    .select({ id: usersTable.id, memberId: usersTable.memberId })
    .from(usersTable)
    .where(and(inArray(usersTable.memberId as any, memberIds), eq(usersTable.isApproved, true)));

  for (const [memberId, items] of byMember) {
    const sections = sectionsFor(items, ctx);
    if (sections.length === 0) continue;
    const body = sections.map((section) => [section.title, ...section.lines.map((line) => `• ${line}`)].join("\n")).join("\n\n");
    const firstTaskId = items[0]?.taskId ?? null;
    const isAssignment = items.some((item) => item.kind === "assigned");

    const memberUsers = users.filter((user) => user.memberId === memberId);
    if (memberUsers.length > 0) {
      await db.insert(notificationsTable).values(
        memberUsers.map((user) => ({
          userId: user.id,
          type: isAssignment ? "task_assigned" : "task_updated",
          title: heading,
          body,
          taskId: firstTaskId,
          isRead: false,
        })),
      ).catch(() => {});
    }

    await notifyTelegramReciterSubstitution({
      memberId,
      heading,
      sections,
      dedupeKey: `telegram:reciter_substitution:${ctx.substitutionId}:${ctx.undo ? "undo" : "apply"}:member:${memberId}`,
      taskId: firstTaskId,
    }).catch(() => {});
  }
}
