import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  instagramAccountsTable,
  instagramMediaTable,
  instagramWeeklyTasksTable,
  membersTable,
  pageMembersTable,
  recitersTable,
  taskMembersTable,
  taskProofsTable,
  tasksTable,
  type InstagramAccount,
} from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { getInstagramSettings, InstagramError } from "./instagram-accounts";
import { fetchRecentMedia, getInstagramConfig, InstagramApiError, refreshLongLivedToken, type InstagramMediaItem } from "./instagram-client";
import { addQuotaProof } from "./auto-documentation";
import { attributeNewInstagramMedia, attributionByMedia } from "./instagram-attribution";
import { notifyTelegramAdminsInstagramReconnect } from "./telegram-notification-engine";
import { decryptToken, encryptToken } from "../lib/instagram-token-crypto";
import { safeAnchorFromDateKey } from "../lib/hijri";

// محرّك مراقبة إنستقرام: المطابقة بالحساب وحده (لا صلاة ولا تاريخ ولا علامة).
// - مهمة الأسبوع من نوع «هدف أسبوعي بعدد مرات» (weeklyQuotaRequired = هدف الحساب N): تُنشأ أول الأسبوع
//   (الأحد→السبت بتوقيت الرياض) من قالب الحساب فتظهر 0/N، أو عند أول منشور إن لم تكن أُنشئت بعد.
// - كل منشور/ريل في الأسبوع ⇐ شاهد في نفس المهمة (X/N). تكتمل فقط عند بلوغ N، ويُرسل إشعار الإكمال
//   مرة واحدة لحظتها؛ ما زاد عن N شواهد إضافية بلا تغيير حالة ولا إشعار.
// - مهمة واحدة لكل حساب في الأسبوع (instagram_weekly_tasks فريد + قفل لكل حساب داخل العملية).

const ACCEPTED_PRODUCT_TYPES = new Set(["FEED", "REELS"]);
const MEDIA_PER_CHECK = 25;
// التجديد: شرط ميتا عمر 24 ساعة على الأقل؛ نجدّد ما تبقّى له 15 يومًا أو أقل.
const REFRESH_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const REFRESH_WHEN_EXPIRING_WITHIN_MS = 15 * 24 * 60 * 60 * 1000;

function riyadhDayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDaysToKey(dateKey: string, days: number) {
  const anchor = safeAnchorFromDateKey(dateKey);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

// الأحد (YYYY-MM-DD) للأسبوع الذي يقع فيه هذا الوقت بتوقيت الرياض.
export function riyadhWeekStart(date: Date): string {
  const key = riyadhDayKey(date);
  return addDaysToKey(key, -safeAnchorFromDateKey(key).getUTCDay());
}

// تاريخ المهمة: منتصف ليل اليوم الحرفي (كما في الجدول الأسبوعي) فيقرأه to_char يومًا صحيحًا.
function dateOfKey(dateKey: string) {
  return new Date(`${dateKey}T00:00:00Z`);
}

// قفل لكل حساب داخل العملية: الفحص الدوري و«افحص الآن» لا يعالجان نفس الحساب معًا.
const accountLocks = new Map<number, Promise<unknown>>();
const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

async function withAccountLock<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const previous = accountLocks.get(accountId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  accountLocks.set(accountId, run);
  try {
    return await run;
  } finally {
    if (accountLocks.get(accountId) === run) accountLocks.delete(accountId);
  }
}

async function reciterNameOf(reciterId: number) {
  const [row] = await db.select({ name: recitersTable.name }).from(recitersTable).where(eq(recitersTable.id, reciterId)).limit(1);
  return row?.name ?? "القارئ";
}

// انقطاع الربط: الحساب «يحتاج إعادة ربط» + تنبيه تلقرام للمدير مرة واحدة لكل انقطاع.
export async function markNeedsReconnect(account: InstagramAccount, reason: string) {
  const now = new Date();
  const firstAlert = !account.reconnectAlertSentAt;
  await db.update(instagramAccountsTable).set({
    status: "needs_reconnect",
    lastError: reason,
    ...(firstAlert ? { reconnectAlertSentAt: now } : {}),
  }).where(eq(instagramAccountsTable.id, account.id));
  if (firstAlert) {
    await notifyTelegramAdminsInstagramReconnect({
      accountId: account.id,
      reciterName: await reciterNameOf(account.reciterId),
      username: account.username,
      reason,
      alertKey: String(now.getTime()),
    }).catch(() => {});
  }
}

// تجديد المفاتيح المستحقة (عمرها ≥ 24 ساعة وتنتهي خلال 15 يومًا)، وكشف المنتهية.
export async function refreshDueInstagramTokens(now = new Date()): Promise<{ refreshed: number; failed: number }> {
  await ensureInstagramSchema();
  const config = getInstagramConfig();
  if (!config) return { refreshed: 0, failed: 0 };
  const accounts = await db.select().from(instagramAccountsTable).where(and(
    eq(instagramAccountsTable.status, "connected"),
    lte(instagramAccountsTable.tokenExpiresAt, new Date(now.getTime() + REFRESH_WHEN_EXPIRING_WITHIN_MS)),
  ));
  let refreshed = 0;
  let failed = 0;
  for (const account of accounts) {
    if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now.getTime()) {
      await markNeedsReconnect(account, "انتهت صلاحية مفتاح الوصول قبل تجديده");
      failed += 1;
      continue;
    }
    if (account.tokenRefreshedAt && now.getTime() - account.tokenRefreshedAt.getTime() < REFRESH_MIN_AGE_MS) continue;
    const token = decryptToken(account.accessTokenEncrypted, config.appSecret);
    if (!token) {
      await markNeedsReconnect(account, "تعذّر قراءة مفتاح الوصول المحفوظ (تغيّر سر التطبيق؟)");
      failed += 1;
      continue;
    }
    try {
      const result = await refreshLongLivedToken(token);
      await db.update(instagramAccountsTable).set({
        accessTokenEncrypted: encryptToken(result.accessToken, config.appSecret),
        tokenExpiresAt: new Date(now.getTime() + result.expiresIn * 1000),
        tokenRefreshedAt: now,
        lastError: null,
      }).where(eq(instagramAccountsTable.id, account.id));
      refreshed += 1;
    } catch (err) {
      failed += 1;
      if (err instanceof InstagramApiError && err.isAuthError) {
        await markNeedsReconnect(account, `فشل تجديد مفتاح الوصول: ${err.message}`);
      } else {
        // خطأ عابر (شبكة/خادم ميتا): نسجّله ونعيد المحاولة في الدورة التالية دون قطع الربط.
        await db.update(instagramAccountsTable).set({ lastError: `تعذّر التجديد مؤقتًا: ${(err as Error).message}` }).where(eq(instagramAccountsTable.id, account.id));
      }
    }
  }
  return { refreshed, failed };
}

type Outcome = { status: string; reason: string; taskId?: number | null; proofId?: number | null };

async function setMedia(id: number, outcome: Outcome) {
  await db.update(instagramMediaTable).set({
    status: outcome.status,
    reason: outcome.reason,
    ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
    ...(outcome.proofId !== undefined ? { proofId: outcome.proofId } : {}),
    processedAt: new Date(),
  }).where(eq(instagramMediaTable.id, id));
}

// مهمة الأسبوع القائمة (غير محذوفة) لهذا الحساب، إن وُجدت.
async function weeklyTaskFor(accountId: number, weekStart: string) {
  const [row] = await db
    .select({ taskId: tasksTable.id, status: tasksTable.status, required: tasksTable.weeklyQuotaRequired })
    .from(instagramWeeklyTasksTable)
    .innerJoin(tasksTable, eq(tasksTable.id, instagramWeeklyTasksTable.taskId))
    .where(and(eq(instagramWeeklyTasksTable.accountId, accountId), eq(instagramWeeklyTasksTable.weekStart, weekStart), isNull(tasksTable.deletedAt)))
    .limit(1);
  return row ?? null;
}

// المكلّفون بمهمة الأسبوع: كل أعضاء الصفحة النشطين (page_members — نفس مصدر اقتراح الأعضاء للمهام العادية)،
// وإن لم يكن للصفحة أعضاء ⇐ «العضو المسؤول» في بطاقة الحساب. العضو الأساسي في المهمة: عضو الحساب إن كان
// ضمنهم، وإلا أولهم.
async function weeklyTaskAssignees(account: InstagramAccount): Promise<{ primary: number; all: number[] }> {
  const rows = await db
    .select({ memberId: pageMembersTable.memberId })
    .from(pageMembersTable)
    .innerJoin(membersTable, eq(membersTable.id, pageMembersTable.memberId))
    .where(and(eq(pageMembersTable.pageId, account.pageId), eq(membersTable.isActive, true)))
    .orderBy(pageMembersTable.memberId);
  const all = [...new Set(rows.map((row) => row.memberId as number))];
  if (all.length === 0) return { primary: account.memberId, all: [account.memberId] };
  return { primary: all.includes(account.memberId) ? account.memberId : all[0], all };
}

// إنشاء مهمة الأسبوع من القالب: «هدف أسبوعي بعدد مرات» = هدف الحساب، من الأحد إلى السبت، على صفحة
// القارئ، لكل أعضاء الصفحة (مهمة واحدة مشتركة بهدف واحد — لا مهمة لكل عضو). تبدأ 0/N معلّقة، وتصبح
// متأخرة بعد السبت إن لم تبلغ الهدف.
async function createWeeklyTask(account: InstagramAccount, weekStart: string): Promise<number> {
  const reciterName = await reciterNameOf(account.reciterId);
  const weekEnd = addDaysToKey(weekStart, 6);
  const assignees = await weeklyTaskAssignees(account);
  return db.transaction(async (tx: any) => {
    // مهمة سابقة لنفس الأسبوع حُذفت: نزيل ربطها كي تُنشأ مهمة جديدة.
    await tx.execute(sql`DELETE FROM instagram_weekly_tasks w USING tasks t WHERE w.task_id = t.id AND w.account_id = ${account.id} AND w.week_start = ${weekStart} AND t.deleted_at IS NOT NULL`);
    const [task] = await tx.insert(tasksTable).values({
      source: "admin_created",
      title: `إنستقرام — ${reciterName} — أسبوع ${weekStart}`,
      platformId: account.platformId,
      pageId: account.pageId,
      memberId: assignees.primary,
      reciterId: account.reciterId,
      status: "pending",
      priority: "normal",
      progress: 0,
      startDate: dateOfKey(weekStart),
      endDate: dateOfKey(weekEnd),
      dueDate: dateOfKey(weekEnd),
      recurrence: "none",
      weeklyQuotaRequired: account.weeklyGoal,
      weeklyQuotaPeriodStart: dateOfKey(weekStart),
      weeklyQuotaPeriodEnd: dateOfKey(weekEnd),
      assigneeNote: `هدف أسبوعي: ${account.weeklyGoal} منشورات على إنستقرام — كل منشور يُحتسب شاهدًا تلقائيًا`,
    }).returning({ id: tasksTable.id });
    await tx.insert(taskMembersTable).values(assignees.all.map((memberId) => ({ taskId: task.id, memberId })));
    await tx.insert(instagramWeeklyTasksTable).values({ accountId: account.id, weekStart, taskId: task.id });
    return task.id as number;
  });
}

// مهمة الأسبوع لهذا الحساب: القائمة، أو تُنشأ الآن (سباق نادر ⇐ نستخدم ما أُنشئ للتو).
async function ensureWeeklyTask(account: InstagramAccount, weekStart: string): Promise<{ taskId: number; created: boolean } | null> {
  const existing = await weeklyTaskFor(account.id, weekStart);
  if (existing) return { taskId: existing.taskId, created: false };
  // مهمة الأسبوع أُعيدت من السلة (ربطها أُزيل عند إنشاء بديل لها): نعيد ربطها بدل إنشاء مهمة جديدة مكررة.
  const [restored] = rowsOf(await db.execute(sql`
    SELECT t.id FROM tasks t
    WHERE t.deleted_at IS NULL AND t.page_id = ${account.pageId} AND t.reciter_id = ${account.reciterId}
      AND t.weekly_quota_period_start = ${dateOfKey(weekStart)} AND t.title = ${`إنستقرام — ${await reciterNameOf(account.reciterId)} — أسبوع ${weekStart}`}
    ORDER BY t.id LIMIT 1`));
  if (restored) {
    await db.execute(sql`DELETE FROM instagram_weekly_tasks w USING tasks t WHERE w.task_id = t.id AND w.account_id = ${account.id} AND w.week_start = ${weekStart} AND t.deleted_at IS NOT NULL`);
    await db.execute(sql`INSERT INTO instagram_weekly_tasks (account_id, week_start, task_id) VALUES (${account.id}, ${weekStart}, ${Number(restored.id)}) ON CONFLICT DO NOTHING`);
    const relinked = await weeklyTaskFor(account.id, weekStart);
    if (relinked) return { taskId: relinked.taskId, created: false };
  }
  try {
    return { taskId: await createWeeklyTask(account, weekStart), created: true };
  } catch {
    const raced = await weeklyTaskFor(account.id, weekStart);
    return raced ? { taskId: raced.taskId, created: false } : null;
  }
}

// أول الأسبوع: مهمة 0/N لكل حساب مفعّل سبق ربطه (حتى لو انقطع ربطه) — فيظهر الحساب الذي لم ينشر شيئًا.
export async function ensureCurrentWeekInstagramTasks(now = new Date()): Promise<number> {
  await ensureInstagramSchema();
  const weekStart = riyadhWeekStart(now);
  const accounts = await db.select().from(instagramAccountsTable).where(and(
    eq(instagramAccountsTable.enabled, true),
    inArray(instagramAccountsTable.status, ["connected", "needs_reconnect"]),
  ));
  let created = 0;
  for (const account of accounts) {
    if (!account.monitoringStartedAt) continue;
    const result = await withAccountLock(account.id, () => ensureWeeklyTask(account, weekStart));
    if (result?.created) created += 1;
  }
  return created;
}

async function processMediaItem(account: InstagramAccount, item: InstagramMediaItem, trialMode: boolean): Promise<boolean> {
  const weekStart = riyadhWeekStart(item.timestamp);
  const productType = item.mediaProductType?.toUpperCase() ?? null;
  const historical = !account.monitoringStartedAt || item.timestamp < account.monitoringStartedAt;
  const accepted = productType ? ACCEPTED_PRODUCT_TYPES.has(productType) : true;

  const [row] = await db.insert(instagramMediaTable).values({
    accountId: account.id,
    igMediaId: item.id,
    permalink: item.permalink,
    caption: item.caption,
    mediaType: item.mediaType,
    mediaProductType: item.mediaProductType,
    publishedAt: item.timestamp,
    weekStart,
    status: "processing",
  }).onConflictDoNothing().returning({ id: instagramMediaTable.id });
  if (!row) return false; // سبق رؤيته

  if (historical) {
    await setMedia(row.id, { status: "historical", reason: "نُشر قبل ربط الحساب — لا يُعالَج" });
    return true;
  }
  if (!accepted) {
    await setMedia(row.id, { status: "ignored", reason: `نوع غير مشمول (${productType}) — المنشورات والريلز فقط` });
    return true;
  }
  if (!item.permalink) {
    await setMedia(row.id, { status: "needs_review", reason: "المنشور بلا رابط من إنستقرام" });
    return true;
  }

  const existing = await weeklyTaskFor(account.id, weekStart);

  // وضع التجربة: لا مهام ولا شواهد — نحسب ما كان سيحدث (X/N) من الشواهد الفعلية + سجلات التجربة السابقة.
  if (trialMode) {
    const goal = existing?.required && existing.required > 0 ? existing.required : account.weeklyGoal;
    const realProofs = existing
      ? Number((await db.select({ c: sql<number>`count(*)::int` }).from(taskProofsTable).where(and(eq(taskProofsTable.taskId, existing.taskId), isNull(taskProofsTable.deletedAt), eq(taskProofsTable.isSupplementary, false))))[0].c)
      : 0;
    const trialBefore = Number((await db.select({ c: sql<number>`count(*)::int` }).from(instagramMediaTable).where(and(
      eq(instagramMediaTable.accountId, account.id),
      eq(instagramMediaTable.weekStart, weekStart),
      inArray(instagramMediaTable.status, ["trial_would_create", "trial_would_add"]),
    )))[0].c);
    const count = realProofs + trialBefore + 1;
    const what = count < goal ? `شاهد ${count}/${goal} — لن تكتمل بعد` : count === goal ? `شاهد ${count}/${goal} — ستكتمل المهمة` : `شاهد إضافي (+${count - goal} فوق الهدف)`;
    await setMedia(row.id, {
      status: existing || trialBefore > 0 ? "trial_would_add" : "trial_would_create",
      reason: `وضع التجربة: ${existing || trialBefore > 0 ? "" : "كان سيُنشئ مهمة الأسبوع، "}${what}`,
      taskId: existing?.taskId ?? null,
    });
    return true;
  }

  const weekly = existing ? { taskId: existing.taskId, created: false } : await ensureWeeklyTask(account, weekStart);
  if (!weekly) {
    await setMedia(row.id, { status: "needs_review", reason: "تعذّر إنشاء مهمة الأسبوع" });
    return true;
  }
  const note = `وثّقه النظام تلقائيًا من منشور إنستقرام${account.username ? ` (@${account.username})` : ""} — نُشر بتاريخ ${item.timestamp.toISOString()}`;
  const added = await addQuotaProof({
    taskId: weekly.taskId,
    proofUrl: item.permalink,
    note,
    activityUserName: "مراقبة إنستقرام (تلقائي)",
    activityAction: "instagram_post_proof",
    meta: { accountId: account.id, mediaId: item.id, permalink: item.permalink, weekStart },
  });
  if (!added.added) {
    await setMedia(row.id, { status: "needs_review", reason: added.reason ?? "تعذّر إضافة الشاهد", taskId: weekly.taskId });
    return true;
  }
  const { count, required } = added;
  const outcome: Outcome = added.completedNow
    ? { status: "documented", reason: `اكتمل الهدف الأسبوعي (${count}/${required}) — أُرسل إشعار الإكمال` }
    : count < required
      ? { status: "proof_counted", reason: `شاهد ${count}/${required} — المهمة لم تكتمل بعد` }
      : { status: "extra_proof", reason: `شاهد إضافي (+${count - required} فوق الهدف) — بلا تغيير حالة ولا إشعار` };
  await setMedia(row.id, { ...outcome, taskId: weekly.taskId, proofId: added.createdProofId });
  // من نشر؟ (للمعرفة فقط — لا تؤثر على المهمة). أي خطأ هنا لا يُفسد التوثيق.
  try {
    const assignees = await weeklyTaskAssignees(account);
    await attributeNewInstagramMedia({
      mediaRowId: row.id,
      reciterName: await reciterNameOf(account.reciterId),
      username: account.username,
      permalink: item.permalink,
      candidates: assignees.all,
      primary: assignees.primary,
    });
  } catch (err) {
    console.warn("instagram attribution failed", err);
  }
  return true;
}

export async function checkInstagramAccount(accountId: number, trialMode: boolean): Promise<{ processed: number; error?: string }> {
  return withAccountLock(accountId, async () => {
    const config = getInstagramConfig();
    if (!config) return { processed: 0, error: "إعدادات ميتا غير مكتملة" };
    const [account] = await db.select().from(instagramAccountsTable).where(eq(instagramAccountsTable.id, accountId)).limit(1);
    if (!account || !account.enabled || account.status !== "connected") return { processed: 0, error: "الحساب غير مربوط أو موقوف" };
    const token = decryptToken(account.accessTokenEncrypted, config.appSecret);
    if (!token) {
      await markNeedsReconnect(account, "تعذّر قراءة مفتاح الوصول المحفوظ (تغيّر سر التطبيق؟)");
      return { processed: 0, error: "يحتاج إعادة ربط" };
    }
    let media: InstagramMediaItem[];
    try {
      media = await fetchRecentMedia(token, MEDIA_PER_CHECK);
    } catch (err) {
      if (err instanceof InstagramApiError && err.isAuthError) {
        await markNeedsReconnect(account, `رفض إنستقرام مفتاح الوصول: ${err.message}`);
        return { processed: 0, error: "يحتاج إعادة ربط" };
      }
      const message = `تعذّر الفحص مؤقتًا: ${(err as Error).message}`;
      await db.update(instagramAccountsTable).set({ lastError: message, lastCheckedAt: new Date() }).where(eq(instagramAccountsTable.id, account.id));
      return { processed: 0, error: message };
    }
    let processed = 0;
    // الأقدم أولًا: الشواهد تُحتسب بترتيب النشر.
    for (const item of [...media].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
      if (await processMediaItem(account, item, trialMode)) processed += 1;
    }
    await db.update(instagramAccountsTable).set({ lastCheckedAt: new Date(), lastError: null }).where(eq(instagramAccountsTable.id, account.id));
    return { processed };
  });
}

export async function runInstagramMonitorTick(): Promise<{ processed: number; accountsChecked: number; skipped?: "disabled" | "no_config"; refreshed: number }> {
  await ensureInstagramSchema();
  const settings = await getInstagramSettings();
  if (!settings.enabled) return { processed: 0, accountsChecked: 0, skipped: "disabled", refreshed: 0 };
  if (!getInstagramConfig()) return { processed: 0, accountsChecked: 0, skipped: "no_config", refreshed: 0 };
  const { refreshed } = await refreshDueInstagramTokens();
  if (!settings.trialMode) await ensureCurrentWeekInstagramTasks();
  const accounts = await db.select({ id: instagramAccountsTable.id }).from(instagramAccountsTable)
    .where(and(eq(instagramAccountsTable.enabled, true), eq(instagramAccountsTable.status, "connected")));
  let processed = 0;
  for (const account of accounts) {
    processed += (await checkInstagramAccount(account.id, settings.trialMode)).processed;
  }
  return { processed, accountsChecked: accounts.length, refreshed };
}

// ── الإدارة: السجل، العدّ الأسبوعي، والتراجع ─────────────────────────────────────────────────
export async function listInstagramMedia(options: { accountId?: number; limit?: number } = {}) {
  await ensureInstagramSchema();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);
  const rows = await db
    .select({
      id: instagramMediaTable.id,
      accountId: instagramMediaTable.accountId,
      reciterName: recitersTable.name,
      username: instagramAccountsTable.username,
      permalink: instagramMediaTable.permalink,
      caption: instagramMediaTable.caption,
      mediaProductType: instagramMediaTable.mediaProductType,
      publishedAt: instagramMediaTable.publishedAt,
      weekStart: instagramMediaTable.weekStart,
      status: instagramMediaTable.status,
      reason: instagramMediaTable.reason,
      taskId: instagramMediaTable.taskId,
    })
    .from(instagramMediaTable)
    .innerJoin(instagramAccountsTable, eq(instagramAccountsTable.id, instagramMediaTable.accountId))
    .innerJoin(recitersTable, eq(recitersTable.id, instagramAccountsTable.reciterId))
    .where(options.accountId ? eq(instagramMediaTable.accountId, options.accountId) : undefined)
    .orderBy(desc(instagramMediaTable.publishedAt))
    .limit(limit);
  const attribution = await attributionByMedia(rows.map((r: { id: number }) => r.id));
  return rows.map((r: { id: number }) => ({ ...r, postedBy: attribution.get(r.id)?.postedBy ?? null, attribution: attribution.get(r.id)?.attribution ?? null }));
}

// عدد منشورات الأسبوع الحالي لكل حساب: الموثَّقة + الشواهد الإضافية، أو (في وضع التجربة) ما كان سيحدث.
export async function currentWeekPostCounts(trialMode: boolean, now = new Date()): Promise<Map<number, number>> {
  await ensureInstagramSchema();
  const rows = await db
    .select({ accountId: instagramMediaTable.accountId, count: sql<number>`count(*)::int` })
    .from(instagramMediaTable)
    .where(and(
      eq(instagramMediaTable.weekStart, riyadhWeekStart(now)),
      inArray(instagramMediaTable.status, trialMode ? ["trial_would_create", "trial_would_add"] : ["documented", "proof_counted", "extra_proof"]),
    ))
    .groupBy(instagramMediaTable.accountId);
  return new Map(rows.map((row) => [row.accountId, Number(row.count)]));
}

// تراجع عن شاهد منشور: يُحذف الشاهد ناعمًا ويُعاد حساب X/N. إن نزل العدد عن الهدف تعود مهمة الأسبوع
// معلّقة (ومتأخرة إن فات السبت). الإشعارات المُرسَلة سابقًا لا تُسحَب.
export async function revertInstagramMedia(mediaId: number, userId: number | null) {
  await ensureInstagramSchema();
  const [media] = await db.select().from(instagramMediaTable).where(eq(instagramMediaTable.id, mediaId)).limit(1);
  if (!media) throw new InstagramError(404, "المنشور غير موجود");
  if (!["documented", "proof_counted", "extra_proof"].includes(media.status) || !media.taskId) throw new InstagramError(400, "لا يوجد توثيق في هذا المنشور للتراجع عنه");
  const taskId = media.taskId;
  await db.transaction(async (tx: any) => {
    const [task] = await tx.select({ status: tasksTable.status, required: tasksTable.weeklyQuotaRequired }).from(tasksTable).where(eq(tasksTable.id, taskId)).for("update");
    if (media.proofId) await tx.update(taskProofsTable).set({ deletedAt: new Date() }).where(eq(taskProofsTable.id, media.proofId));
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(taskProofsTable)
      .where(and(eq(taskProofsTable.taskId, taskId), isNull(taskProofsTable.deletedAt), eq(taskProofsTable.isSupplementary, false)));
    const required = task?.required && task.required > 0 ? task.required : 1;
    const belowGoal = Number(count) < required;
    await tx.update(tasksTable).set({
      progress: Math.min(100, Math.round((Number(count) / required) * 100)),
      ...(belowGoal && task?.status === "completed" ? { status: "pending", completedAt: null } : {}),
    }).where(eq(tasksTable.id, taskId));
    // رابط التسليم يتبع أقدم شاهد فعّال إن كان يشير إلى شاهد محذوف (أو يُمسح إن لم يبقَ شاهد).
    await tx.execute(sql`UPDATE tasks SET submission_url = (SELECT url FROM task_proofs WHERE task_id = ${taskId} AND deleted_at IS NULL AND NOT is_supplementary ORDER BY created_at LIMIT 1)
      WHERE id = ${taskId} AND submission_url IN (SELECT url FROM task_proofs WHERE task_id = ${taskId} AND deleted_at IS NOT NULL)`);
  });
  await db.update(instagramMediaTable).set({ status: "reverted", reason: "تراجع عنه المدير — الإشعارات المُرسَلة سابقًا لم تُسحَب", reviewedByUserId: userId, reviewedAt: new Date() }).where(eq(instagramMediaTable.id, mediaId));
  // نسخة فيسبوك المرتبطة (شاهد تكميلي) تتبع أصلها: لا شاهد فيسبوك بلا أصل إنستقرام.
  await db.execute(sql`UPDATE task_proofs SET deleted_at = now()
    WHERE is_supplementary AND deleted_at IS NULL AND id IN (SELECT proof_id FROM instagram_facebook_links WHERE media_id = ${mediaId} AND status IN ('linked', 'manual'))`);
  await db.execute(sql`UPDATE instagram_facebook_links SET status = 'reverted', reason = 'تراجع المدير عن منشور إنستقرام الأصلي'
    WHERE media_id = ${mediaId} AND status IN ('linked', 'manual', 'pending', 'trial_would_link', 'ambiguous', 'not_found')`);
}
