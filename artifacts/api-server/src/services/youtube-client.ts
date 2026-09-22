// عميل رفيع لـ YouTube Data API v3 عبر fetch المدمجة — بلا مكتبة googleapis إضافية،
// بنفس أسلوب services/telegram.ts. المفتاح من متغيّر البيئة فقط، لا يُكتب في الكود أبدًا.

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export class YoutubeApiKeyMissingError extends Error {
  constructor() {
    super("YOUTUBE_API_KEY is not set");
    this.name = "YoutubeApiKeyMissingError";
  }
}

function getApiKey(): string {
  const key = process.env["YOUTUBE_API_KEY"];
  if (!key) throw new YoutubeApiKeyMissingError();
  return key;
}

async function callYoutubeApi<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = getApiKey();
  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("key", key);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`YouTube API ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export async function resolveChannelByHandle(handle: string): Promise<{ channelId: string; uploadsPlaylistId: string | null } | null> {
  const data = await callYoutubeApi<{ items?: Array<{ id: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(
    "channels",
    { part: "contentDetails", forHandle: handle },
  );
  const item = data.items?.[0];
  if (!item) return null;
  return { channelId: item.id, uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null };
}

export async function fetchRecentVideoIds(uploadsPlaylistId: string, maxResults = 15): Promise<string[]> {
  const data = await callYoutubeApi<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>(
    "playlistItems",
    { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: String(maxResults) },
  );
  return (data.items ?? [])
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => Boolean(id));
}

export type YoutubeVideoDetails = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: Date;
  privacyStatus: string;
  // بث جارٍ الآن أو مجدول لم يبدأ/ينتهِ بعد — لا يُعالَج كمقطع عادي.
  isLiveOngoingOrUpcoming: boolean;
  durationSeconds: number;
};

function parseIso8601DurationSeconds(iso: string | undefined): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h ?? 0) * 3600) + (Number(m ?? 0) * 60) + Number(s ?? 0);
}

type YoutubeVideoApiItem = {
  id: string;
  snippet?: { title?: string; description?: string; publishedAt?: string };
  contentDetails?: { duration?: string };
  status?: { privacyStatus?: string };
  liveStreamingDetails?: { actualEndTime?: string };
};

export async function fetchVideosDetails(videoIds: string[]): Promise<YoutubeVideoDetails[]> {
  if (videoIds.length === 0) return [];
  const data = await callYoutubeApi<{ items?: YoutubeVideoApiItem[] }>("videos", {
    part: "snippet,contentDetails,status,liveStreamingDetails",
    id: videoIds.join(","),
  });

  return (data.items ?? [])
    .filter((item) => item.snippet?.publishedAt)
    .map((item) => {
      const liveDetails = item.liveStreamingDetails;
      const isLiveOngoingOrUpcoming = Boolean(liveDetails) && !liveDetails?.actualEndTime;
      return {
        videoId: item.id,
        title: item.snippet?.title ?? "",
        description: item.snippet?.description ?? "",
        publishedAt: new Date(item.snippet!.publishedAt!),
        privacyStatus: item.status?.privacyStatus ?? "private",
        isLiveOngoingOrUpcoming,
        durationSeconds: parseIso8601DurationSeconds(item.contentDetails?.duration),
      };
    });
}
