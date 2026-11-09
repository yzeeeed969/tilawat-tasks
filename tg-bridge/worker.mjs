// عامل tg-bridge (الإصدار 76): يشغّل «خادم البوتات المحلي» الرسمي، ويستقبل منشورات قنوات المشايخ،
// ولكل فيديو يسأل خادم الموقع «هل يُرفع؟» (القرار في الخادم)، ثم يمرّر الملف له لينشره في فيسبوك، ويحذف الملف.
//
// المتغيرات (يضعها المدير في Railway بنفسه، لا تُكتب في أي محادثة):
//   TG_BRIDGE_BOT_TOKEN  رمز البوت الجديد (من BotFather)
//   TELEGRAM_API_ID      من my.telegram.org
//   TELEGRAM_API_HASH    من my.telegram.org
//   CROSSPOST_API_KEY    نفس مفتاح خدمة الموقع (مرجع ${{api-server.CROSSPOST_API_KEY}})
//   API_BASE             عنوان خادم الموقع (افتراضيًا العنوان العام)
// القرص الدائم (Volume) على /data.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TOKEN = (process.env.TG_BRIDGE_BOT_TOKEN ?? "").trim();
const API_ID = (process.env.TELEGRAM_API_ID ?? "").trim();
const API_HASH = (process.env.TELEGRAM_API_HASH ?? "").trim();
const KEY = (process.env.CROSSPOST_API_KEY ?? "").trim();
const API_BASE = (process.env.API_BASE ?? "https://workspaceapi-server-production-c92c.up.railway.app").replace(/\/$/, "");
const DATA = process.env.DATA_DIR ?? "/data";
const LOCAL = "http://127.0.0.1:8081";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [name, v] of [["TG_BRIDGE_BOT_TOKEN", TOKEN], ["TELEGRAM_API_ID", API_ID], ["TELEGRAM_API_HASH", API_HASH], ["CROSSPOST_API_KEY", KEY]]) {
  if (!v) { log(`متغير ناقص: ${name} — توقف`); await sleep(60_000); process.exit(1); }
}
fs.mkdirSync(path.join(DATA, "bot-api"), { recursive: true });
fs.mkdirSync(path.join(DATA, "tmp"), { recursive: true });

// 1) نقل البوت من سحابة تيليجرام إلى الخادم المحلي (مرة واحدة فقط، شرط رسمي قبل التشغيل المحلي).
const marker = path.join(DATA, "logged-out-from-cloud");
if (!fs.existsSync(marker)) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/logOut`).then((x) => x.json()).catch((e) => ({ ok: false, description: String(e) }));
  log("logOut من السحابة:", r.ok ? "تم" : r.description);
  if (r.ok || /logged out|Unauthorized/i.test(String(r.description))) fs.writeFileSync(marker, new Date().toISOString());
}

// 2) تشغيل خادم البوتات المحلي؛ إن توقف يخرج العامل فيعيد Railway التشغيل.
const server = spawn("telegram-bot-api", [
  `--api-id=${API_ID}`, `--api-hash=${API_HASH}`, "--local",
  `--dir=${path.join(DATA, "bot-api")}`, `--temp-dir=${path.join(DATA, "tmp")}`,
  "--http-port=8081", "--http-ip-address=127.0.0.1", "--verbosity=1",
], { stdio: ["ignore", "inherit", "inherit"] });
server.on("exit", (code) => { log("خادم البوتات المحلي توقف برمز", code); process.exit(1); });

async function bot(method, params = {}) {
  const res = await fetch(`${LOCAL}/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`);
  return body.result;
}
async function site(pathname, payload) {
  const res = await fetch(`${API_BASE}/api${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (res.status >= 500 || res.status === 401 || res.status === 503) throw new Error(`${pathname}: ${res.status} ${body.message ?? body.reason ?? ""}`);
  return body;
}

for (let i = 0; ; i++) {
  try { const me = await bot("getMe"); log("البوت يعمل محليًا:", `@${me.username}`); break; }
  catch (e) { if (i > 60) { log("تعذّر تشغيل خادم البوتات المحلي:", e.message); process.exit(1); } await sleep(2000); }
}
await bot("deleteWebhook").catch(() => {});

// نبض كل 6 ساعات + تحقق من وجود البوت في قنوات المشايخ المسجّلة في الموقع (getChat/getChatMember).
const me = await bot("getMe");
async function heartbeat() {
  try {
    const hb = await site("/crosspost/tg/heartbeat", {});
    for (const handle of hb.handles ?? []) {
      try {
        const chat = await bot("getChat", { chat_id: `@${handle}` });
        const member = await bot("getChatMember", { chat_id: chat.id, user_id: me.id }).catch(() => null);
        await site("/crosspost/tg/channel", { chatId: String(chat.id), title: chat.title ?? null, username: chat.username ?? handle, botStatus: member?.status ?? "not_member" });
        log(`@${handle}: البوت ${member?.status ?? "ليس عضوًا"}`);
      } catch (e) {
        log(`@${handle}: تعذّر الفحص (${e.message})`);
      }
      await sleep(1500);
    }
  } catch (e) {
    log("heartbeat:", e.message);
  }
}
heartbeat();
setInterval(heartbeat, 6 * 60 * 60_000);

const offsetFile = path.join(DATA, "offset");
let offset = Number(fs.existsSync(offsetFile) ? fs.readFileSync(offsetFile, "utf8") : 0) || 0;

async function withRetry(fn, label, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries) throw e; log(`${label}: محاولة ${i} فشلت (${e.message}) — إعادة بعد 30 ثانية`); await sleep(30_000); }
  }
}

// تقرير كل فيديو في محادثة المدير الخاصة مع البوت «رفع فيسبوك» (الإصدار 80).
async function report(chatId, lines) {
  if (!chatId) return;
  await bot("sendMessage", { chat_id: chatId, text: lines.filter(Boolean).join("\n"), link_preview_options: { is_disabled: true } }).catch((e) => log("report:", e.message));
}

async function handleVideo(post) {
  const v = post.video;
  const firstLine = String(post.caption ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 90) || "(بلا نص)";
  const tgLink = post.chat.username ? `https://t.me/${post.chat.username}/${post.message_id}` : "";
  const head = (icon, status) => [`${icon} ${status}`, `القناة: ${post.chat.title ?? ""}`, `المقطع: ${firstLine}`];
  let lastError = "";
  let reportTo = null;
  const payload = {
    chatId: String(post.chat.id), messageId: post.message_id, username: post.chat.username ?? null, chatTitle: post.chat.title ?? null,
    caption: post.caption ?? "", width: v.width ?? 0, height: v.height ?? 0, duration: v.duration ?? 0, fileSize: v.file_size ?? 0, fileId: v.file_id,
  };
  for (let cycle = 1; cycle <= 3; cycle++) {
    const check = await withRetry(() => site("/crosspost/tg/check", payload), "check");
    reportTo = check.recoveryChatId ?? reportTo;
    if (!check.upload) {
      log(`لا رفع (${post.chat.title} #${post.message_id}):`, check.reason);
      if (!/سبق التعامل|معطّل/.test(String(check.reason))) await report(reportTo, [...head("⚪", "لم يُرفع لفيسبوك"), `السبب: ${check.reason}`, tgLink]);
      return;
    }
    let filePath = null;
    try {
      const file = await withRetry(() => bot("getFile", { file_id: v.file_id }), "getFile");
      filePath = file.file_path; // في الوضع المحلي: مسار كامل على القرص
      const size = fs.statSync(filePath).size;
      log(`رفع إلى «${check.pageName}»: ${post.chat.title} #${post.message_id} (${Math.round(size / 1048576)}MB)`);
      const res = await fetch(`${API_BASE}/api/crosspost/tg/upload?uploadId=${check.uploadId}`, {
        method: "POST", duplex: "half", body: fs.createReadStream(filePath),
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size), Authorization: `Bearer ${KEY}` },
      });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        log("✅ نُشر في فيسبوك:", body.fbVideoId);
        await report(reportTo, [...head("✅", "نُشر في فيسبوك"), `الصفحة: ${check.pageName}`, body.fbVideoId ? `فيسبوك: https://www.facebook.com/${body.fbVideoId}` : "", tgLink ? `تيليجرام: ${tgLink}` : ""]);
        return;
      }
      lastError = String(body.message ?? res.status);
      log(`❌ فشل الرفع (دورة ${cycle}):`, lastError);
    } catch (e) {
      lastError = e.message;
      log(`❌ خطأ (دورة ${cycle}):`, e.message);
    } finally {
      if (filePath) fs.promises.unlink(filePath).catch(() => {});
    }
    await sleep(60_000);
  }
  await report(reportTo, [...head("❌", "فشل رفعه لفيسبوك بعد 3 محاولات"), `السبب: ${lastError.slice(0, 300)}`, tgLink, "يمكن إعادة رفعه دون إعادة نشره في القناة — أخبر Claude."]);
}

// إعادة المحاولة التي يطلبها المدير (الإصدار 77): كل 5 دقائق.
let retrying = false;
setInterval(async () => {
  if (retrying) return;
  retrying = true;
  try {
    const r = await site("/crosspost/tg/retries", {});
    for (const x of r.retries ?? []) {
      log(`إعادة رفع: ${x.chatTitle} #${x.messageId}`);
      let video = x.fileId ? { file_id: x.fileId, width: x.width, height: x.height, duration: x.duration, file_size: x.fileSize } : null;
      let caption = x.caption;
      if (!video && r.recoveryChatId) {
        // استرجاع منشور قديم بلا معرّف: إعادة توجيهه لمحادثة المدير الخاصة لنحصل على الملف.
        try {
          const fwd = await bot("forwardMessage", { chat_id: r.recoveryChatId, from_chat_id: x.chatId, message_id: x.messageId });
          if (fwd.video) { video = fwd.video; caption = fwd.caption ?? x.caption; }
          else throw new Error("المنشور ليس فيديو");
        } catch (e) {
          log("استرجاع:", e.message);
          await site("/crosspost/tg/retry-failed", { chatId: x.chatId, messageId: x.messageId, reason: e.message }).catch(() => {});
          continue;
        }
      }
      if (!video) continue;
      await handleVideo({ chat: { id: Number(x.chatId), username: x.username, title: x.chatTitle }, message_id: x.messageId, caption, video }).catch((e) => log("retry:", e.message));
    }
  } catch (e) { log("retries:", e.message); } finally { retrying = false; }
}, 5 * 60_000);

log("بدء الاستماع لقنوات المشايخ…");
for (;;) {
  let updates = [];
  try {
    updates = await bot("getUpdates", { offset, timeout: 50, allowed_updates: ["channel_post", "my_chat_member", "message"] });
  } catch (e) {
    log("getUpdates:", e.message);
    await sleep(5000);
    continue;
  }
  for (const u of updates) {
    try {
      if (u.my_chat_member && u.my_chat_member.chat?.type === "channel") {
        const c = u.my_chat_member.chat;
        await site("/crosspost/tg/channel", { chatId: String(c.id), title: c.title ?? null, username: c.username ?? null, botStatus: u.my_chat_member.new_chat_member?.status ?? null }).catch((e) => log("channel:", e.message));
        log(`القناة «${c.title}»: حالة البوت ${u.my_chat_member.new_chat_member?.status}`);
      } else if (u.message && u.message.chat?.type === "private" && typeof u.message.text === "string") {
        const r = await site("/crosspost/tg/private", { chatId: String(u.message.chat.id), text: u.message.text }).catch(() => null);
        if (r?.reply) await bot("sendMessage", { chat_id: u.message.chat.id, text: r.reply }).catch(() => {});
      } else if (u.channel_post?.video) {
        await handleVideo(u.channel_post);
      }
    } catch (e) {
      log("خطأ في معالجة منشور:", e.message);
    }
    offset = u.update_id + 1;
    fs.writeFileSync(offsetFile, String(offset));
  }
}
