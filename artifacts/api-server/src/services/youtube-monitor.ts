import { eq, inArray } from "drizzle-orm";
import {
  db,
  activityLogTable,
  taskProofsTable,
  tasksTable,
  youtubeChannelsTable,
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
const MARKER_LINE = "*1";

function hasStandaloneMarkerLine(description: string | null | undefined): boolean {
  if (!description) return false;
  return description.split("\n").some((line) => line.trim() === MARKER_LINE);
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

async function decideForVideo(
  channel: YoutubeChannel,
  video: YoutubeVideoDetails,
  url: string,
  trialMode: boolean,
): Promise<{ decision: Decision; extractedPrayer: string | null; extractedHijriDay: number | null; extractedHijriMonth: number | null }> {
  const notExtracted = { extractedPrayer: null, extractedHijriDay: null, extractedHijriMonth: null } as const;

  if (video.privacyStatus !== "public") {
    return { decision: { status: "ignored", reason: `المقطع غير عام (${video.privacyStatus})`, matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }
  if (video.isLiveOngoingOrUpcoming) {
    return { decision: { status: "ignored", reason: "بث مباشر جارٍ أو مجدول لم ينتهِ بعد", matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }
  if (video.durationSeconds > 0 && video.durationSeconds < SHORT_VIDEO_THRESHOLD_SECONDS) {
    return { decision: { status: "ignored", reason: `مدة قصيرة (${video.durationSeconds} ثانية) — على الأرجح مقطع Short`, matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }

  if (!hasStandaloneMarkerLine(video.description)) {
    return { decision: { status: "no_marker", reason: "لا يوجد سطر مستقل نصّه *1 في الوصف بعد", matchedTaskId: null, createdProofId: null }, ...notExtracted };
  }

  const parsed = parseYoutubeTitle(video.title, channel.reciterNameConstant);
  if (!parsed.ok) {
    return { decision: { status: "needs_review", reason: parsed.reason, matchedTaskId: null, createdProofId: null }, ...notExtracted };
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

  const result = await documentTask(match.taskId, url, video.publishedAt);
  if (!result.documented) {
    return { decision: { status: "needs_review", reason: result.reason ?? "تعذّر التوثيق التلقائي", matchedTaskId: match.taskId, createdProofId: null }, ...extracted };
  }
  return { decision: { status: "documented", reason: match.reason, matchedTaskId: match.taskId, createdProofId: result.createdProofId }, ...extracted };
}

async function processChannel(channel: YoutubeChannel, trialMode: boolean): Promise<number> {
  const resolvedChannel = await ensureChannelResolved(channel);
  if (!resolvedChannel.uploadsPlaylistId) return 0;

  const videoIds = await fetchRecentVideoIds(resolvedChannel.uploadsPlaylistId, MAX_RECENT_VIDEOS_PER_CHECK);
  if (videoIds.length === 0) {
    await db.update(youtubeChannelsTable).set({ lastCheckedAt: new Date() }).where(eq(youtubeChannelsTable.id, resolvedChannel.id));
    return 0;
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

  let processed = 0;
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
