import { openAsBlob } from "node:fs";

// رفع فيديو ناتيف إلى صفحة فيسبوك بالرفع المجزّأ (start → transfer → finish) — من الخادم فقط.
// الرمز يُمرَّر من المستدعي (مفكوكًا على الخادم) ولا يُعاد في أي نتيجة.

const GRAPH_VIDEO = "https://graph-video.facebook.com/v25.0";
const CHUNK_BYTES = 8 * 1024 * 1024;

export type FacebookVideoUploadResult =
  | { ok: true; videoId: string }
  | { ok: false; stage: "start" | "transfer" | "finish"; message: string; metaError: unknown };

async function graphPost(path: string, form: FormData): Promise<{ ok: boolean; body: any }> {
  const res = await fetch(`${GRAPH_VIDEO}/${path}`, { method: "POST", body: form });
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && !body?.error, body };
}

const failure = (stage: "start" | "transfer" | "finish", body: any, fallback: string): FacebookVideoUploadResult =>
  ({ ok: false, stage, message: String(body?.error?.message ?? fallback), metaError: body?.error ?? body });

export async function uploadFacebookVideo(input: {
  pageId: string;
  token: string;
  filePath: string;
  fileSize: number;
  title: string;
  description?: string;
  published: boolean;
}): Promise<FacebookVideoUploadResult> {
  const startForm = new FormData();
  startForm.set("upload_phase", "start");
  startForm.set("file_size", String(input.fileSize));
  startForm.set("access_token", input.token);
  const start = await graphPost(`${input.pageId}/videos`, startForm);
  if (!start.ok) return failure("start", start.body, "فشل بدء الرفع");
  const sessionId = String(start.body.upload_session_id);
  const videoId = String(start.body.video_id);
  let startOffset = Number(start.body.start_offset);
  let endOffset = Number(start.body.end_offset);

  const file = await openAsBlob(input.filePath);
  let guard = 0;
  while (startOffset < endOffset && guard++ < 5000) {
    const form = new FormData();
    form.set("upload_phase", "transfer");
    form.set("upload_session_id", sessionId);
    form.set("start_offset", String(startOffset));
    form.set("video_file_chunk", file.slice(startOffset, Math.min(endOffset, startOffset + CHUNK_BYTES)), "chunk.mp4");
    form.set("access_token", input.token);
    const transfer = await graphPost(`${input.pageId}/videos`, form);
    if (!transfer.ok) return failure("transfer", transfer.body, "فشل نقل جزء من الفيديو");
    startOffset = Number(transfer.body.start_offset);
    endOffset = Number(transfer.body.end_offset);
  }

  const finishForm = new FormData();
  finishForm.set("upload_phase", "finish");
  finishForm.set("upload_session_id", sessionId);
  finishForm.set("published", input.published ? "true" : "false");
  finishForm.set("title", input.title);
  finishForm.set("description", input.description ?? input.title);
  finishForm.set("access_token", input.token);
  const finish = await graphPost(`${input.pageId}/videos`, finishForm);
  if (!finish.ok) return failure("finish", finish.body, "فشل إنهاء الرفع");
  return { ok: true, videoId };
}
