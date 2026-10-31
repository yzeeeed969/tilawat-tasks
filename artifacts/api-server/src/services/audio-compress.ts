// ضغط الملف الصوتي ليناسب حد تيليجرام للبوت (50 ميجابايت) — الإصدار 75، اعتماد المدير 31-10-2026.
// يُستخدم فقط حين يكون الملف أكبر من الحد. يُحسب معدل البت من مدة الملف حتى يخرج الملف نحو 46 ميجابايت،
// بحد أعلى 128kbps (لا ضغط زائد بلا داعٍ) وحد أدنى 48kbps (حفاظًا على وضوح التلاوة).

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TARGET_BYTES = 46 * 1024 * 1024;

async function durationSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeout: 60_000 });
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("تعذّرت معرفة مدة الملف");
  return d;
}

// يُرجع ملف MP3 مضغوطًا، أو يرمي خطأ بالعربية.
export async function compressAudioForTelegram(input: Blob, maxBytes: number): Promise<Blob> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-audio-"));
  const src = path.join(dir, "in");
  const out = path.join(dir, "out.mp3");
  try {
    await fs.writeFile(src, Buffer.from(await input.arrayBuffer()));
    const seconds = await durationSeconds(src);
    let kbps = Math.floor((TARGET_BYTES * 8) / seconds / 1000);
    kbps = Math.min(128, kbps);
    if (kbps < 48) throw new Error(`الملف طويل جدًا (${Math.round(seconds / 60)} دقيقة) ولا يمكن ضغطه بجودة مقبولة`);
    await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-vn", "-map_metadata", "0", "-codec:a", "libmp3lame", "-b:a", `${kbps}k`, out], { timeout: 10 * 60_000 });
    const buf = await fs.readFile(out);
    if (buf.length > maxBytes) throw new Error(`بقي الملف أكبر من الحد بعد الضغط (${Math.round(buf.length / 1048576)}MB)`);
    if (buf.length < 10_000) throw new Error("خرج الملف المضغوط فارغًا");
    return new Blob([buf], { type: "audio/mpeg" });
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === "ENOENT" ? "أداة الضغط (ffmpeg) غير مثبتة على الخادم" : (err as Error).message;
    throw new Error(`تعذّر ضغط الملف: ${msg}`);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
