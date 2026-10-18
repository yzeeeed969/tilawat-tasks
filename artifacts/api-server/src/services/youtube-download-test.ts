import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ⚠️ تجربة مؤقتة لمرة واحدة (تُحذف بعد القرار): هل يستطيع الخادم (Railway) تنزيل فيديو يوتيوب بنفسه؟
// تنزيل فقط — لا رفع. الملفات تُحذف فور القياس. yt-dlp الرسمي من إصدارات GitHub بإصدار مثبّت، مع التحقق من
// بصمة SHA-256 المنشورة قبل التشغيل.

const YTDLP_VERSION = "2026.08.19";
const RELEASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`;

type Step = { step: string; ok: boolean; seconds: number; detail: string };

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as any).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

const tail = (text: string, lines = 12) => text.split("\n").filter(Boolean).slice(-lines).join("\n");

async function ensureYtDlp(workDir: string): Promise<{ bin: string } | { error: string }> {
  const asset = os.arch() === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  const bin = path.join(workDir, asset);
  const [binRes, sumsRes] = await Promise.all([fetch(`${RELEASE}/${asset}`), fetch(`${RELEASE}/SHA2-256SUMS`)]);
  if (!binRes.ok || !sumsRes.ok) return { error: `تعذّر تنزيل yt-dlp (${binRes.status}/${sumsRes.status})` };
  const bytes = Buffer.from(await binRes.arrayBuffer());
  const expected = (await sumsRes.text()).split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === asset)?.[0];
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!expected || expected.toLowerCase() !== actual) return { error: `بصمة yt-dlp غير مطابقة — لم يُشغَّل (المتوقع ${expected ?? "؟"}، الفعلي ${actual})` };
  await fs.promises.writeFile(bin, bytes, { mode: 0o755 });
  return { bin };
}

export async function youtubeDownloadTest(channelId: string) {
  const started = Date.now();
  const steps: Step[] = [];
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yt-test-"));
  const timed = async (step: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const t0 = Date.now();
    const result = await fn();
    steps.push({ step, ok: result.ok, seconds: Math.round((Date.now() - t0) / 100) / 10, detail: result.detail });
    return result.ok;
  };
  try {
    let bin = "";
    const haveBin = await timed("تنزيل yt-dlp والتحقق من بصمته", async () => {
      const r = await ensureYtDlp(workDir);
      if ("error" in r) return { ok: false, detail: r.error };
      bin = r.bin;
      const version = await run(bin, ["--version"], 60_000);
      return { ok: version.code === 0, detail: version.code === 0 ? `yt-dlp ${version.stdout.trim()} — ${os.platform()}/${os.arch()}` : tail(version.stderr) };
    });
    if (!haveBin) return { ok: false, steps, totalSeconds: Math.round((Date.now() - started) / 1000) };

    const ffmpeg = await run("ffmpeg", ["-version"], 15_000);
    steps.push({ step: "ffmpeg على الخادم", ok: ffmpeg.code === 0, seconds: 0, detail: ffmpeg.code === 0 ? tail(ffmpeg.stdout, 1) : "غير موجود (لا دمج صوت/صورة عالية الجودة على الخادم بدونه)" });

    let videoId = "";
    let title = "";
    const listed = await timed("قراءة أحدث فيديو في القناة", async () => {
      const r = await run(bin, ["--flat-playlist", "--playlist-end", "1", "--print", "%(id)s\t%(title)s", `https://www.youtube.com/playlist?list=UU${channelId.slice(2)}`], 120_000);
      const line = r.stdout.trim().split("\n")[0] ?? "";
      [videoId, title] = line.split("\t");
      return videoId ? { ok: true, detail: `${videoId} — ${title}` } : { ok: false, detail: tail(r.stderr) || "لا نتيجة" };
    });
    if (!listed) return { ok: false, steps, totalSeconds: Math.round((Date.now() - started) / 1000) };

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const downloadOnce = (label: string, format: string, out: string) => timed(label, async () => {
      const target = path.join(workDir, out);
      const r = await run(bin, ["-f", format, "--no-playlist", "--no-part", "-o", target, url], 600_000);
      const files = (await fs.promises.readdir(workDir)).filter((name) => name.startsWith(out.split(".")[0]));
      const size = files.length ? (await fs.promises.stat(path.join(workDir, files[0]))).size : 0;
      if (r.code === 0 && size > 0) return { ok: true, detail: `${(size / 1024 / 1024).toFixed(1)} MB` };
      return { ok: false, detail: tail(r.stderr) || `فشل (رمز ${r.code})` };
    });
    const single = await downloadOnce("تنزيل ملف واحد جاهز (صوت+صورة)", "b", "single.%(ext)s");
    if (single) await downloadOnce("تنزيل أعلى جودة فيديو منفصلة (لقياس السرعة)", "bv*", "bestvideo.%(ext)s");
    return { ok: single, videoId, title, steps, totalSeconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
