import { and, eq, gte, inArray, like, or } from "drizzle-orm";
import {
  db,
  activityLogTable,
  taskProofsTable,
  tasksTable,
  youtubeChannelsTable,
  youtubeSettingsTable,
  youtubeVideosTable,
  type YoutubeChannel,
} from "@workspace/db";
import {
  fetchRecentVideoIds,
  fetchVideosDetails,
  resolveChannelByHandle,
  YoutubeApiKeyMissingError,
  type YoutubeVideoDetails,
} from "./youtube-client";
import { parseYoutubeTitle } from "../lib/youtube-title-parser";
import { matchVideoToTask, type MatchResult } from "./youtube-matcher";
import { getYoutubeSettings } from "./youtube-settings";
import { ensureYoutubeMonitorSchema } from "./youtube-monitor-schema";
import { notifyTaskCompleted, notifyDependentTasksReady } from "../routes/tasks";
import { notifyTelegramTaskCompleted } from "./telegram-notification-engine";

// مقاطع لا تُعاد معالجتها إطلاقًا بعد أن تصل لإحدى هذه الحالات (تنتهي هنا، لا تتكرر تلقائيًا).
// الاستثناء الوحيد: "no_marker" — يبقى مفتوحًا لإعادة الفحص طالما بقي المقطع ضمن آخر المقاطع التي
// يقرأها كل فحص (لا حاجة لعدّاد أيام صريح: القناة النشطة تُخرج المقطع من هذه القائمة تلقائيًا خلال
// أيام قليلة مع نشر مقاطع جديدة، وهذا يكفي عمليًا لتحقيق "إعادة فحص لبضعة أيام").
const TERMINAL_STATUSES = new Set([
  "historical", "ignored", "ignored_manual", "documented", "needs_review",
  "no_task", "reverted", "trial_would_document", "trial_would_review", "trial_no_task",
]);

// أقل مدة (ثوانٍ) لاعتبار المقطع تلاوة كاملة لا مقطعًا قصيرًا (Short) يُتجاهل.
const SHORT_VIDEO_THRESHOLD_SECONDS = 180;
const MAX_RECENT_VIDEOS_PER_CHECK = 15;
// نافذة إعادة الفحص الدورية لمقاطع "بحاجة مراجعة"/"بلا مهمة": مقاطع أقدم من هذا تخرج من دائرة
// إعادة الفحص التلقائي إلى الأبد (تبقى قابلة للربط اليدوي دائمًا، بلا حد زمني لذلك).
const RECENT_REVIEW_RECHECK_DAYS = 3;
// علامة التوثيق: نجمة + "توثيق" ملتصقة + نجمة، في سطر مستقل. مطابقة حرفية صارمة بعد trim() للسطر
// (تتجاهل مسافات خارج حدود العلامة فقط — بداية/نهاية السطر — لا أي مسافة داخلها).
// * توثيق* / *توثيق * / *توث يق* كلها مرفوضة؛ فقط "*توثيق*" الحرفية تُقبل.
const MARKER_LINE = "*توثيق*";

function hasStandaloneMarkerLine(description: string | null | undefined): boolean {
  if (!description) return false;
  // نقسّم مع مراعاة \r\n (وندوز) حتى لا يبقى \r خفيًا يكسر المطابقة الحرفية بعد trim().
  return description.split(/\r\n|\n/).some((line) => line.trim() === MARKER_LINE);
}

async function ensureChannelResolved(channel: YoutubeChannel): Promise<YoutubeChannel> {
  if (channel.channelId && channel.uploadsPlaylistId) return channel;

  const resolved = await resolveChannelByHandle(channel.handle);
  if (!resolved || !resolved.uploadsPlaylistId) {
    throw new Error(`تعذّر العثور على قناة يوتيوب لـ ${channel.handle}`);
  }

  const [updated] = await db
    .update(youtubeChannelsTable)
    .set({ channelId: resolved.channelId, uploadsPlaylistId: resolved.uploadsPlaylistId })
    .where(eq(youtubeChannelsTable.id, channel.id))
    .returning();
  return updated;
}

type Decision = {
  status:
    | "ignored" | "no_marker" | "needs_review" | "no_task"
    | "documented" | "trial_would_document" | "trial_would_review" | "trial_no_task";
  reason: string;
  matchedTaskId: number | null;
  createdProofId: number | null;
};

// يوثّق مهمة فعليًا: شاهد + إكمال + نفس إشعارات الإكمال اليدوي بالضبط (دوال مُعاد استخدامها من
// routes/tasks.ts، لا نسخة جديدة من منطق الإكمال). وقت الإكمال = وقت الاكتشاف الآن، كما اتُّفق.
async function documentTask(taskId: number, videoUrl: string, publishedAt: Date): Promise<{ documented: boolean; createdProofId: number | null; reason?: string }> {
  const [task] = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      memberId: tasksTable.memberId,
      submissionUrl: tasksTable.submissionUrl,
      status: tasksTable.status,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);

  if (!task || task.status !== "pending") {
    return { documented: false, createdProofId: null, reason: "المهمة لم تعد معلّقة عند لحظة التوثيق" };
  }

  const completedAt = new Date();
  const note = `وثّقه النظام تلقائيًا من مقطع يوتيوب — نُشر بتاريخ ${publishedAt.toISOString()}`;
  const submissionUrl = task.submissionUrl ?? videoUrl;

  let createdProofId: number | null = null;
  await db.transaction(async (tx: any) => {
    const [proof] = await tx.insert(taskProofsTable).values({
      taskId,
      url: videoUrl,
      note,
      createdByUserId: null,
    }).returning();
    createdProofId = proof.id;

    await tx.update(tasksTable).set({
      status: "completed",
      completedAt,
      submissionUrl,
    }).where(eq(tasksTable.id, taskId));
  });

  await db.insert(activityLogTable).values({
    userId: null,
    userName: "مراقبة يوتيوب (تلقائي)",
    action: "youtube_video_documented",
    entityType: "task",
    entityId: taskId,
    entityName: task.title,
    meta: { videoUrl },
  });

  const notifyPayload = { id: taskId, title: task.title, memberId: task.memberId, submissionUrl, completedAt };
  await notifyTaskCompleted(notifyPayload).catch(() => {});
  await notifyTelegramTaskCompleted(notifyPayload).catch(() => {});
  await notifyDependentTasksReady(taskId).catch(() => {});

  return { documented: true, createdProofId };
}

type DecisionOutcome = { decision: Decision; extractedPrayer: string | null; extractedHijriDay: number | null; extractedHijriMonth: number | null };

// كل ما يحدث بعد التأكد من وجود العلامة *توثيق*: قراءة العنوان ثم المطابقة ثم التوثيق أو المراجعة.
// مستخرجة في دالة مستقلة لأن إعادة الفحص التلقائية (runShortDurationMarkerBackfillOnce) تستدعيها
// أيضًا على بيانات مخزَّنة محليًا (بلا تفاصيل يوتيوب كاملة كالخصوصية والمدة)، فلا نكرّر منطق
// المطابقة والتوثيق في مكانين.
async function decideAfterMarkerConfirmed(
  channel: YoutubeChannel,
  video: { title: string; url: string; publishedAt: Date },
  trialMode: boolean,
): Promise<DecisionOutcome> {
  const parsed = parseYoutubeTitle(video.title, channel.reciterNameConstant);
  if (!parsed.ok) {
    return {
      decision: { status: "needs_review", reason: parsed.reason, matchedTaskId: null, createdProofId: null },
      extractedPrayer: null, extractedHijriDay: null, extractedHijriMonth: null,
    };
  }

  const extracted = { extractedPrayer: parsed.prayer, extractedHijriDay: parsed.hijriDay, extractedHijriMonth: parsed.hijriMonth };

  const match: MatchResult = await matchVideoToTask({
    platformId: channel.platformId,
    reciterId: channel.reciterId,
    prayer: parsed.prayer,
    hijriDay: parsed.hijriDay,
    hijriMonth: parsed.hijriMonth,
    dayNameInTitle: parsed.dayNameInTitle,
    publishedAt: video.publishedAt,
  });

  if (match.kind === "no_task") {
    const status = trialMode ? "trial_no_task" : "no_task";
    return { decision: { status, reason: match.reason, matchedTaskId: null, createdProofId: null }, ...extracted };
  }
  if (match.kind === "review") {
    const status = trialMode ? "trial_would_review" : "needs_review";
    return { decision: { status, reason: match.reason, matchedTaskId: match.candidateTaskIds[0] ?? null, createdProofId: null }, ...extracted };
  }

  // match.kind === "match"
  if (trialMode) {
    return { decision: { status: "trial_would_document", reason: match.reason, matchedTaskId: match.taskId, createdProofId: null }, ...extracted };
  }

  const result = await documentTask(match.taskId, video.url, video.publishedAt);
  if (!result.documented) {
    return { decision: { status: "needs_review", reason: result.reason ?? "تعذّر التوثيق التلقائي", matchedTaskId: match.taskId, createdProofId: null }, ...extracted };
  }
  return { decision: { status: "documented", reason: match.reason, matchedTaskId: match.taskId, createdProofId: result.createdProofId }, ...extracted };
}

async function decideForVideo(
  channel: YoutubeChannel,
  video: YoutubeVideoDetails,
  url: string,
  trialMode: boolean,
): Promise<DecisionOutcome> {
  const notExtracted = { extractedPrayer: null, extractedHijriDay: null, extractedHijriMonth: null } as const;

  if (video.privacyStatus !== "public") {
    return { decision: { status: "ignored", reason: `المقطع غير عام (${video.privacyStatus})`, matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }
  if (video.isLiveOngoingOrUpcoming) {
    return { decision: { status: "ignored", reason: "بث مباشر جارٍ أو مجدول لم ينتهِ بعد", matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }

  const hasMarker = hasStandaloneMarkerLine(video.description);

  // العلامة *توثيق* تأكيد صريح من المدير بأن المقطع صالح للتوثيق، فتتجاوز شرط المدة القصيرة
  // (تلاواتنا الحقيقية أحيانًا قصيرة جدًا). المقطع القصير بلا علامة يبقى يُتجاهل كما كان دائمًا.
  if (video.durationSeconds > 0 && video.durationSeconds < SHORT_VIDEO_THRESHOLD_SECONDS && !hasMarker) {
    return { decision: { status: "ignored", reason: `مدة قصيرة (${video.durationSeconds} ثانية) — على الأرجح مقطع Short`, matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }

  if (!hasMarker) {
    return { decision: { status: "no_marker", reason: "لا يوجد سطر مستقل نصّه *توثيق* في الوصف بعد", matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }

  return decideAfterMarkerConfirmed(channel, { title: video.title, url, publishedAt: video.publishedAt }, trialMode);
}

async function processChannel(channel: YoutubeChannel, trialMode: boolean): Promise<number> {
  const resolvedChannel = await ensureChannelResolved(channel);

  // إعادة فحص دورية آمنة (بلا اتصال بيوتيوب، القاعدة الصارمة نفسها): تلتقط مهمة ظهرت متأخرة
  // (أُنشئت بعد أول فحص للمقطع، أو أُعيدت من مكتملة إلى معلّقة) خلال أيام قليلة من نشر المقطع.
  // مستقلة تمامًا عن نجاح جلب المقاطع الجديدة أدناه، فتعمل حتى لو فشل الاتصال بيوتيوب هذه الدورة.
  const publishedSince = new Date(Date.now() - RECENT_REVIEW_RECHECK_DAYS * 24 * 60 * 60 * 1000);
  let processed = await reprocessChannelNeedsAttentionVideos(resolvedChannel, trialMode, {
    publishedSince,
    reasonSuffix: `أُعيد فحصه تلقائيًا ضمن إعادة الفحص الدورية (خلال ${RECENT_REVIEW_RECHECK_DAYS} أيام من النشر)`,
  });

  if (!resolvedChannel.uploadsPlaylistId) return processed;

  const videoIds = await fetchRecentVideoIds(resolvedChannel.uploadsPlaylistId, MAX_RECENT_VIDEOS_PER_CHECK);
  if (videoIds.length === 0) {
    await db.update(youtubeChannelsTable).set({ lastCheckedAt: new Date() }).where(eq(youtubeChannelsTable.id, resolvedChannel.id));
    return processed;
  }

  const existingRows = await db
    .select({ videoId: youtubeVideosTable.videoId, status: youtubeVideosTable.status })
    .from(youtubeVideosTable)
    .where(inArray(youtubeVideosTable.videoId, videoIds));
  const existingByVideoId = new Map(existingRows.map((row) => [row.videoId, row.status]));

  // لا داعي لجلب تفاصيل مقطع سبق أن وصل لحالة نهائية — توفير حصة الـAPI.
  const idsNeedingDetails = videoIds.filter((id) => {
    const status = existingByVideoId.get(id);
    return !status || !TERMINAL_STATUSES.has(status);
  });
  const details = await fetchVideosDetails(idsNeedingDetails);

  for (const video of details) {
    const url = `https://www.youtube.com/watch?v=${video.videoId}`;
    const alreadyKnown = existingByVideoId.has(video.videoId);
    const isHistorical = video.publishedAt < resolvedChannel.monitoringStartedAt;

    const { decision, extractedPrayer, extractedHijriDay, extractedHijriMonth } = isHistorical
      ? {
          decision: { status: "historical" as const, reason: "نُشر قبل بدء مراقبة هذه القناة", matchedTaskId: null, createdProofId: null },
          extractedPrayer: null, extractedHijriDay: null, extractedHijriMonth: null,
        }
      : await decideForVideo(resolvedChannel, video, url, trialMode);

    const row = {
      channelRowId: resolvedChannel.id,
      videoId: video.videoId,
      title: video.title,
      description: video.description,
      publishedAt: video.publishedAt,
      url,
      hasMarker: hasStandaloneMarkerLine(video.description),
      extractedPrayer,
      extractedHijriDay,
      extractedHijriMonth,
      matchedTaskId: decision.matchedTaskId,
      createdProofId: decision.createdProofId,
      status: decision.status,
      decisionReason: decision.reason,
      processedAt: new Date(),
    };

    if (alreadyKnown) {
      await db.update(youtubeVideosTable).set(row).where(eq(youtubeVideosTable.videoId, video.videoId));
    } else {
      await db.insert(youtubeVideosTable).values(row);
    }
    processed += 1;
  }

  await db.update(youtubeChannelsTable).set({ lastCheckedAt: new Date() }).where(eq(youtubeChannelsTable.id, resolvedChannel.id));
  return processed;
}

export async function runYoutubeMonitorTick(): Promise<{ processed: number; skippedNoKey: boolean; channelsChecked: number }> {
  await ensureYoutubeMonitorSchema();
  const settings = await getYoutubeSettings();
  if (!settings.enabled) return { processed: 0, skippedNoKey: false, channelsChecked: 0 };

  const channels = await db.select().from(youtubeChannelsTable).where(eq(youtubeChannelsTable.enabled, true));

  let processed = 0;
  let skippedNoKey = false;
  let channelsChecked = 0;

  for (const channel of channels) {
    try {
      processed += await processChannel(channel, settings.trialMode);
      channelsChecked += 1;
    } catch (err) {
      if (err instanceof YoutubeApiKeyMissingError) {
        skippedNoKey = true;
        break;
      }
      console.error(`[youtube-monitor] فشل فحص قناة ${channel.handle}:`, err);
    }
  }

  return { processed, skippedNoKey, channelsChecked };
}

// إصلاح لمرة واحدة (يُستدعى عند أول إقلاع بعد نشر إصلاح خلل "المقطع القصير يتجاهل العلامة *1"):
// يعيد فحص كل مقطع سبق أن وصل لحالة "تجاهل" بسبب مدته القصيرة تحديدًا ويحمل العلامة *1 المخزَّنة
// أصلًا، باستخدام العنوان والوصف المحفوظين محليًا (بلا أي اتصال جديد بيوتيوب). لا يلمس أي صف آخر:
// الشرط الثلاثي (status='ignored' + hasMarker=true + السبب "قصيرة") مطابق تمامًا لتوقيع هذا الخلل
// وحده، فلا يعيد فحص مقاطع تجاهلت لأنها خاصة أو بثًا جاريًا. علامة youtube_settings تمنع تكراره في
// كل إقلاع — وهو مصمَّم أصلًا ليكون آمنًا للتكرار حتى بلا العلامة (الصفوف المُصلَحة لا تطابق الشرط
// نفسه في المرة التالية).
export async function runShortDurationMarkerBackfillOnce(): Promise<{ ran: boolean; reprocessed: number }> {
  await ensureYoutubeMonitorSchema();
  const settings = await getYoutubeSettings();
  if (settings.shortDurationMarkerBackfillDone) return { ran: false, reprocessed: 0 };

  const affectedRows = await db
    .select({
      id: youtubeVideosTable.id,
      title: youtubeVideosTable.title,
      description: youtubeVideosTable.description,
      url: youtubeVideosTable.url,
      publishedAt: youtubeVideosTable.publishedAt,
      channelRowId: youtubeVideosTable.channelRowId,
    })
    .from(youtubeVideosTable)
    .where(and(
      eq(youtubeVideosTable.status, "ignored"),
      eq(youtubeVideosTable.hasMarker, true),
      like(youtubeVideosTable.decisionReason, "%قصيرة%"),
    ));

  let reprocessed = 0;
  for (const row of affectedRows) {
    // تأكيد إضافي مباشرةً على النص المخزَّن، بنفس دالة الفحص الحيّ — لا نثق بالعلم المخزَّن وحده.
    if (!hasStandaloneMarkerLine(row.description)) continue;

    const [channel] = await db.select().from(youtubeChannelsTable).where(eq(youtubeChannelsTable.id, row.channelRowId)).limit(1);
    if (!channel) continue;

    const { decision, extractedPrayer, extractedHijriDay, extractedHijriMonth } = await decideAfterMarkerConfirmed(
      channel,
      { title: row.title, url: row.url, publishedAt: row.publishedAt },
      settings.trialMode,
    );

    await db.update(youtubeVideosTable).set({
      extractedPrayer,
      extractedHijriDay,
      extractedHijriMonth,
      matchedTaskId: decision.matchedTaskId,
      createdProofId: decision.createdProofId,
      status: decision.status,
      decisionReason: `${decision.reason} — أُعيد فحصه تلقائيًا بعد إصلاح خلل تجاهل المقاطع القصيرة ذات العلامة *1`,
      processedAt: new Date(),
    }).where(eq(youtubeVideosTable.id, row.id));

    reprocessed += 1;
  }

  await db.update(youtubeSettingsTable)
    .set({ shortDurationMarkerBackfillDone: true, updatedAt: new Date() })
    .where(eq(youtubeSettingsTable.id, settings.id));

  return { ran: true, reprocessed };
}

// إصلاح لمرة واحدة (يُستدعى عند أول إقلاع بعد نشر إصلاح خلل تفسير توقيت due_date عند حساب الهجري):
// يعيد فحص كل مقطع يحمل العلامة *1 ووصل لحالة "لم يُوثَّق" (بحاجة مراجعة/بلا مهمة، أو مكافئاتهما
// في وضع التجربة)، لأن أيًّا منها قد يكون تضرَّر من نفس الخلل (تاريخ هجري محسوب خطأً بمقدار يوم).
// يستخدم decideAfterMarkerConfirmed (وهي الآن تعتمد على القاعدة المُصلَحة عبر matchVideoToTask)
// على البيانات المحفوظة محليًا فقط — بلا أي اتصال جديد بيوتيوب. علامة منفصلة عن إصلاح المدة
// القصيرة أعلاه، فلا تتعارض معها ولا تُعاد الأخرى بسببها.
export async function runDueDateTimezoneBackfillOnce(): Promise<{ ran: boolean; reprocessed: number }> {
  await ensureYoutubeMonitorSchema();
  const settings = await getYoutubeSettings();
  if (settings.dueDateTimezoneBackfillDone) return { ran: false, reprocessed: 0 };

  const affectedRows = await db
    .select({
      id: youtubeVideosTable.id,
      title: youtubeVideosTable.title,
      description: youtubeVideosTable.description,
      url: youtubeVideosTable.url,
      publishedAt: youtubeVideosTable.publishedAt,
      channelRowId: youtubeVideosTable.channelRowId,
    })
    .from(youtubeVideosTable)
    .where(and(
      eq(youtubeVideosTable.hasMarker, true),
      or(
        eq(youtubeVideosTable.status, "needs_review"),
        eq(youtubeVideosTable.status, "no_task"),
        eq(youtubeVideosTable.status, "trial_would_review"),
        eq(youtubeVideosTable.status, "trial_no_task"),
      ),
    ));

  let reprocessed = 0;
  for (const row of affectedRows) {
    if (!hasStandaloneMarkerLine(row.description)) continue;

    const [channel] = await db.select().from(youtubeChannelsTable).where(eq(youtubeChannelsTable.id, row.channelRowId)).limit(1);
    if (!channel) continue;

    const { decision, extractedPrayer, extractedHijriDay, extractedHijriMonth } = await decideAfterMarkerConfirmed(
      channel,
      { title: row.title, url: row.url, publishedAt: row.publishedAt },
      settings.trialMode,
    );

    await db.update(youtubeVideosTable).set({
      extractedPrayer,
      extractedHijriDay,
      extractedHijriMonth,
      matchedTaskId: decision.matchedTaskId,
      createdProofId: decision.createdProofId,
      status: decision.status,
      decisionReason: `${decision.reason} — أُعيد فحصه تلقائيًا بعد إصلاح خلل تفسير توقيت تاريخ المهمة`,
      processedAt: new Date(),
    }).where(eq(youtubeVideosTable.id, row.id));

    reprocessed += 1;
  }

  await db.update(youtubeSettingsTable)
    .set({ dueDateTimezoneBackfillDone: true, updatedAt: new Date() })
    .where(eq(youtubeSettingsTable.id, settings.id));

  return { ran: true, reprocessed };
}

// إصلاح لمرة واحدة (يُستدعى عند أول إقلاع بعد نشر إصلاح خلل مطابقة اسم الشيخ حين يُكتب كوسم
// يوتيوب مركّب مثل #ماهر_المعيقلي بدل "ماهر المعيقلي"): يعيد فحص كل مقطع في كل القنوات يحمل
// العلامة *توثيق* ووصل لحالة "لم يُوثَّق"، بالقاعدة المُصلَحة (parseYoutubeTitle الآن يتعرّف على
// صيغة الوسم) وبياناته المحفوظة محليًا فقط — بلا أي اتصال جديد بيوتيوب. علامة منفصلة عن
// الإصلاحين السابقين، فلا تتعارض معهما ولا تُعاد أيّ منهما بسببها.
export async function runHashtagNameBackfillOnce(): Promise<{ ran: boolean; reprocessed: number }> {
  await ensureYoutubeMonitorSchema();
  const settings = await getYoutubeSettings();
  if (settings.hashtagNameBackfillDone) return { ran: false, reprocessed: 0 };

  const affectedRows = await db
    .select({
      id: youtubeVideosTable.id,
      title: youtubeVideosTable.title,
      description: youtubeVideosTable.description,
      url: youtubeVideosTable.url,
      publishedAt: youtubeVideosTable.publishedAt,
      channelRowId: youtubeVideosTable.channelRowId,
    })
    .from(youtubeVideosTable)
    .where(and(
      eq(youtubeVideosTable.hasMarker, true),
      or(
        eq(youtubeVideosTable.status, "needs_review"),
        eq(youtubeVideosTable.status, "no_task"),
        eq(youtubeVideosTable.status, "trial_would_review"),
        eq(youtubeVideosTable.status, "trial_no_task"),
      ),
    ));

  let reprocessed = 0;
  for (const row of affectedRows) {
    if (!hasStandaloneMarkerLine(row.description)) continue;

    const [channel] = await db.select().from(youtubeChannelsTable).where(eq(youtubeChannelsTable.id, row.channelRowId)).limit(1);
    if (!channel) continue;

    const { decision, extractedPrayer, extractedHijriDay, extractedHijriMonth } = await decideAfterMarkerConfirmed(
      channel,
      { title: row.title, url: row.url, publishedAt: row.publishedAt },
      settings.trialMode,
    );

    await db.update(youtubeVideosTable).set({
      extractedPrayer,
      extractedHijriDay,
      extractedHijriMonth,
      matchedTaskId: decision.matchedTaskId,
      createdProofId: decision.createdProofId,
      status: decision.status,
      decisionReason: `${decision.reason} — أُعيد فحصه تلقائيًا بعد إصلاح خلل مطابقة اسم الشيخ في صيغة الوسم`,
      processedAt: new Date(),
    }).where(eq(youtubeVideosTable.id, row.id));

    reprocessed += 1;
  }

  await db.update(youtubeSettingsTable)
    .set({ hashtagNameBackfillDone: true, updatedAt: new Date() })
    .where(eq(youtubeSettingsTable.id, settings.id));

  return { ran: true, reprocessed };
}

// يعيد فحص مقاطع قناة معيّنة (بحاجة مراجعة/بلا مهمة، أو مكافئاتهما، وتحمل العلامة *توثيق*) —
// بالقاعدة الحيّة نفسها (decideAfterMarkerConfirmed) وبياناتها المحفوظة محليًا فقط، بلا اتصال
// جديد بيوتيوب. مُستخدَمة في حالتين مختلفتين بنفس المنطق تمامًا، يفرّقهما الخيارات فقط:
//   1) فورًا عند حفظ تعديل قناة يغيّر reciterNameConstant أو handle — بلا حد زمني (نصحّح كل شيء).
//   2) ضمن كل دورة فحص عادية/"افحص الآن" — بحد زمني (آخر RECENT_REVIEW_RECHECK_DAYS أيام من
//      النشر) حتى تلتقط تلقائيًا مهمة ظهرت متأخرة، بلا حلقة إعادة معالجة لا نهائية.
export async function reprocessChannelNeedsAttentionVideos(
  channel: YoutubeChannel,
  trialMode: boolean,
  options?: { publishedSince?: Date; reasonSuffix?: string },
): Promise<number> {
  const reasonSuffix = options?.reasonSuffix ?? "أُعيد فحصه تلقائيًا بعد تعديل بيانات القناة";

  const conditions = [
    eq(youtubeVideosTable.channelRowId, channel.id),
    eq(youtubeVideosTable.hasMarker, true),
    or(
      eq(youtubeVideosTable.status, "needs_review"),
      eq(youtubeVideosTable.status, "no_task"),
      eq(youtubeVideosTable.status, "trial_would_review"),
      eq(youtubeVideosTable.status, "trial_no_task"),
    ),
  ];
  if (options?.publishedSince) {
    conditions.push(gte(youtubeVideosTable.publishedAt, options.publishedSince));
  }

  const affectedRows = await db
    .select({
      id: youtubeVideosTable.id,
      title: youtubeVideosTable.title,
      description: youtubeVideosTable.description,
      url: youtubeVideosTable.url,
      publishedAt: youtubeVideosTable.publishedAt,
    })
    .from(youtubeVideosTable)
    .where(and(...conditions));

  let reprocessed = 0;
  for (const row of affectedRows) {
    if (!hasStandaloneMarkerLine(row.description)) continue;

    const { decision, extractedPrayer, extractedHijriDay, extractedHijriMonth } = await decideAfterMarkerConfirmed(
      channel,
      { title: row.title, url: row.url, publishedAt: row.publishedAt },
      trialMode,
    );

    await db.update(youtubeVideosTable).set({
      extractedPrayer,
      extractedHijriDay,
      extractedHijriMonth,
      matchedTaskId: decision.matchedTaskId,
      createdProofId: decision.createdProofId,
      status: decision.status,
      decisionReason: `${decision.reason} — ${reasonSuffix}`,
      processedAt: new Date(),
    }).where(eq(youtubeVideosTable.id, row.id));

    reprocessed += 1;
  }

  return reprocessed;
}
