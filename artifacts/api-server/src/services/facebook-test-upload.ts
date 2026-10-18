import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getFacebookConfig } from "./facebook-client";
import { decryptToken } from "../lib/instagram-token-crypto";
import { openAsBlob } from "node:fs";

// ⚠️ تجربة مؤقتة لمرة واحدة (تُحذف بعد التأكد): رفع فيديو واحد إلى صفحة فيسبوك كمسودة غير منشورة
// (published=false) للتحقق من صلاحية pages_manage_posts. ليس نظام الرفع.
// الرمز يبقى على الخادم: يُقرأ مشفّرًا من القاعدة ويُفك هنا، ولا يُعاد أبدًا في الرد.

const GRAPH_VIDEO = "https://graph-video.facebook.com/v25.0";
const CHUNK_BYTES = 8 * 1024 * 1024;

export type FacebookTestUploadResult =
  | { ok: true; pageId: string; pageName: string; reciter: string; videoId: string; finish: unknown }
  | { ok: false; stage: string; pageId?: string; pageName?: string; metaError?: unknown; message: string };

async function graphPost(path: string, form: FormData): Promise<{ ok: boolean; body: any }> {
  const res = await fetch(`${GRAPH_VIDEO}/${path}`, { method: "POST", body: form });
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && !body?.error, body };
}

export async function facebookTestUpload(input: { reciterMatch: string; title: string; filePath: string; fileSize: number }): Promise<FacebookTestUploadResult> {
  const config = getFacebookConfig();
  if (!config) return { ok: false, stage: "config", message: "متغيرات فيسبوك غير مضبوطة على الخادم" };

  const rows: any[] = ((await db.execute(sql`
    SELECT DISTINCT ON (fp.fb_page_id) fp.fb_page_id, fp.name AS page_name, fp.access_token_encrypted, r.name AS reciter_name
    FROM instagram_accounts a
    JOIN facebook_pages fp ON fp.fb_page_id = a.fb_page_id AND fp.status = 'connected'
    JOIN reciters r ON r.id = a.reciter_id
    WHERE r.name ILIKE ${"%" + input.reciterMatch + "%"}`)) as any).rows ?? [];
  if (rows.length !== 1) return { ok: false, stage: "page", message: rows.length === 0 ? `لا توجد صفحة فيسبوك مربوطة لقارئ يطابق «${input.reciterMatch}»` : `أكثر من صفحة تطابق «${input.reciterMatch}» — حدّد الاسم أكثر` };
  const page = rows[0];
  const pageId = String(page.fb_page_id);
  const pageName = String(page.page_name);
  const token = decryptToken(page.access_token_encrypted, config.appSecret);
  if (!token) return { ok: false, stage: "token", pageId, pageName, message: "تعذّر فك رمز الصفحة — أعد «ربط فيسبوك»" };

  // 1) بدء جلسة الرفع
  const startForm = new FormData();
  startForm.set("upload_phase", "start");
  startForm.set("file_size", String(input.fileSize));
  startForm.set("access_token", token);
  const start = await graphPost(`${pageId}/videos`, startForm);
  if (!start.ok) return { ok: false, stage: "start", pageId, pageName, metaError: start.body?.error ?? start.body, message: String(start.body?.error?.message ?? "فشل بدء الرفع") };
  const sessionId = String(start.body.upload_session_id);
  const videoId = String(start.body.video_id);
  let startOffset = Number(start.body.start_offset);
  let endOffset = Number(start.body.end_offset);

  // 2) نقل الأجزاء
  const file = await openAsBlob(input.filePath);
  let guard = 0;
  while (startOffset < endOffset && guard++ < 1000) {
    const chunk = file.slice(startOffset, Math.min(endOffset, startOffset + CHUNK_BYTES));
    const form = new FormData();
    form.set("upload_phase", "transfer");
    form.set("upload_session_id", sessionId);
    form.set("start_offset", String(startOffset));
    form.set("video_file_chunk", chunk, "chunk.mp4");
    form.set("access_token", token);
    const transfer = await graphPost(`${pageId}/videos`, form);
    if (!transfer.ok) return { ok: false, stage: "transfer", pageId, pageName, metaError: transfer.body?.error ?? transfer.body, message: String(transfer.body?.error?.message ?? "فشل نقل جزء من الفيديو") };
    startOffset = Number(transfer.body.start_offset);
    endOffset = Number(transfer.body.end_offset);
  }

  // 3) الإنهاء كمسودة غير منشورة
  const finishForm = new FormData();
  finishForm.set("upload_phase", "finish");
  finishForm.set("upload_session_id", sessionId);
  finishForm.set("published", "false");
  finishForm.set("title", input.title);
  finishForm.set("description", input.title);
  finishForm.set("access_token", token);
  const finish = await graphPost(`${pageId}/videos`, finishForm);
  if (!finish.ok) return { ok: false, stage: "finish", pageId, pageName, metaError: finish.body?.error ?? finish.body, message: String(finish.body?.error?.message ?? "فشل إنهاء الرفع") };
  return { ok: true, pageId, pageName, reciter: String(page.reciter_name), videoId, finish: finish.body };
}
