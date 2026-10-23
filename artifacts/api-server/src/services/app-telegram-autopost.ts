// النشر التلقائي: كل تلاوة «فرض» جديدة تُنشر في التطبيق (موقع tilawatalharamain.com) تُرسل ملفًا صوتيًا إلى
// قناة تيليجرام «تطبيق تلاوات الحرمين» بنفس صيغة الفريق، ثم تُوثَّق مهمتا تيليجرام والتطبيق كالمعتاد
// (الإصدار 65، قرار المدير: نشر تلقائي مباشر).
//
// الضمانات (قاعدة «الأمن فوق كل شيء»):
//  • الجديد فقط: عند أول تشغيل يُسجَّل «خط أساس» (أحدث رقم تلاوة موجود)، ولا يُنشر ما قبله.
//  • لا تكرار: سجل app_tg_autopost بمفتاح فريد لكل تلاوة.
//  • لا نشر ناقص: إن تعذّر تحديد الشيخ أو الصلاة أو التاريخ أو الملف ⇐ لا نشر + تنبيه للمدير.
//  • الفروض فقط (الفجر، المغرب، العشاء، الجمعة).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { sendTelegramAudioUpload } from "./telegram";
import { ensureTelegramMonitorSchema } from "./telegram-monitor-schema";
import { processTelegramPost, storeChannelUpdate } from "./telegram-channel-monitor";
import { notifyTelegramAdminsGeneric } from "./telegram-notification-engine";

const SITE = "https://tilawatalharamain.com";
const SEED_ID = 35880; // أحدث رقم معروف عند البرمجة — يُستخدم فقط لبدء البحث عن خط الأساس
const LOOKAHEAD = 15;
const LOOKBACK = 40;
const MAX_ATTEMPTS = 3;
const MAX_BYTES = 49 * 1024 * 1024;
const PRAYERS = ["فجر", "مغرب", "عشاء", "جمعة"];

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureTelegramMonitorSchema();
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_tg_autopost_settings (
          id integer PRIMARY KEY DEFAULT 1,
          enabled boolean NOT NULL DEFAULT true,
          baseline_id integer,
          last_id integer,
          last_run_at timestamp,
          updated_at timestamp NOT NULL DEFAULT now(),
          CONSTRAINT app_tg_autopost_settings_single CHECK (id = 1)
        )`);
      await db.execute(sql`INSERT INTO app_tg_autopost_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_tg_autopost (
          post_id integer PRIMARY KEY,
          status text NOT NULL,
          reason text,
          title text,
          reciter text,
          message_id bigint,
          attempts integer NOT NULL DEFAULT 1,
          created_at timestamp NOT NULL DEFAULT now(),
          posted_at timestamp
        )`);
      // ترتيب المكي قبل النبوي (الإصدار 66): المسجد والصلاة والتاريخ الهجري لكل تلاوة.
      await db.execute(sql`ALTER TABLE app_tg_autopost ADD COLUMN IF NOT EXISTS mosque text`);
      await db.execute(sql`ALTER TABLE app_tg_autopost ADD COLUMN IF NOT EXISTS prayer text`);
      await db.execute(sql`ALTER TABLE app_tg_autopost ADD COLUMN IF NOT EXISTS hijri_key text`);
      // الإصدار 67: إعادة محاولة تلاوة فجر بندر بليلة 12-5-1448 (35887) بعد إصلاح «صلاة الفجر» — مرة واحدة، وإن لم تُنشر.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS app_one_time_migrations (name text PRIMARY KEY, ran_at timestamp NOT NULL DEFAULT now(), details jsonb)`);
      const fresh = rowsOf(await db.execute(sql`INSERT INTO app_one_time_migrations (name) VALUES ('app_tg_autopost_retry_35887_v67') ON CONFLICT (name) DO NOTHING RETURNING name`));
      if (fresh.length) await db.execute(sql`DELETE FROM app_tg_autopost WHERE post_id = 35887 AND status <> 'posted'`);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function settings() {
  await ensureSchema();
  const [row] = rowsOf(await db.execute(sql`SELECT enabled, baseline_id, last_id, last_run_at FROM app_tg_autopost_settings WHERE id = 1`));
  return { enabled: row?.enabled !== false, baselineId: row?.baseline_id != null ? Number(row.baseline_id) : null, lastId: row?.last_id != null ? Number(row.last_id) : null, lastRunAt: row?.last_run_at ?? null };
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "TilawatTasksBot/1.0" } });
    return { status: res.status, text: res.status === 200 ? await res.text() : "" };
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

type Parsed = { title: string; section: string; mp3: string; categoryId: number | null };

function parsePage(html: string): Parsed | null {
  const rawTitle = decodeHtml((html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()).replace(/\s*-\s*تلاوات الحرمين\s*$/, "");
  const parts = rawTitle.split(" > ").map((p) => p.trim());
  if (parts.length < 2) return null;
  const mp3 = decodeHtml(html.match(/href="(https?:\/\/[^"]+\.mp3)"/i)?.[1] ?? "");
  const categoryId = Number(html.match(/\/prayers\/c\/(\d+)/)?.[1] ?? NaN);
  return { title: parts[0], section: parts[parts.length - 1], mp3, categoryId: Number.isFinite(categoryId) ? categoryId : null };
}

// صفحة قائمة القسم تعرض اسم الشيخ بجانب كل تلاوة. الموقع يعرض قوائم مسجد واحد بحسب «الجلسة»
// (اختيار المكي/النبوي يُحفظ بطلب POST إلى /change-mosque)، فلقوائم المسجد النبوي نفتح جلسة خاصة به.
type Mosque = "makkah" | "madinah";
const sessions = new Map<Mosque, { at: number; cookie: string }>();

function mergeCookies(current: string, res: Response) {
  const jar = new Map(current.split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const raw of (res.headers as any).getSetCookie?.() ?? []) {
    const pair = String(raw).split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

async function mosqueSession(mosque: Mosque): Promise<string> {
  const hit = sessions.get(mosque);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.cookie;
  const home = await fetch(`${SITE}/`, { headers: { "User-Agent": "TilawatTasksBot/1.0" } });
  let cookie = mergeCookies("", home);
  const html = await home.text();
  const token = html.match(/'X-CSRF-TOKEN':\s*'([^']+)'/)?.[1] ?? html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";
  const change = await fetch(`${SITE}/change-mosque`, {
    method: "POST",
    headers: { "User-Agent": "TilawatTasksBot/1.0", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest", Cookie: cookie },
    body: `mosque=${mosque}`,
  });
  cookie = mergeCookies(cookie, change);
  sessions.set(mosque, { at: Date.now(), cookie });
  return cookie;
}

const listingCache = new Map<string, { at: number; html: string }>();
async function fetchListing(categoryId: number, mosque: Mosque, postId: number): Promise<string | null> {
  const key = `${mosque}:${categoryId}`;
  const hit = listingCache.get(key);
  if (hit && Date.now() - hit.at < 2 * 60_000 && hit.html.includes(`/prayers/${postId}"`)) return hit.html;
  const cookie = await mosqueSession(mosque);
  const res = await fetch(`${SITE}/prayers/c/${categoryId}`, { headers: { "User-Agent": "TilawatTasksBot/1.0", Cookie: cookie } });
  if (res.status !== 200) return null;
  const html = await res.text();
  if (!html.includes(`/prayers/${postId}"`)) sessions.delete(mosque); // جلسة منتهية؟ تُجدَّد في المحاولة القادمة
  listingCache.set(key, { at: Date.now(), html });
  return html;
}

async function reciterFromListing(categoryId: number, mosque: Mosque, postId: number, title: string): Promise<string | null> {
  const html = await fetchListing(categoryId, mosque, postId);
  if (!html) return null;
  const i = html.indexOf(`/prayers/${postId}"`);
  if (i < 0) return null;
  const chunk = html.slice(i, i + 3000).replace(/<[^>]*>/g, "\n");
  const texts = chunk.split("\n").map((t) => decodeHtml(t).replace(/\s+/g, " ").trim()).filter((t) => t && !/^\/prayers\//.test(t) && !t.startsWith('"'));
  // أول نص = عنوان التلاوة، والثاني = اسم الشيخ.
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const idx = texts.findIndex((t) => norm(t) === norm(title) || norm(title).startsWith(norm(t)) || norm(t).startsWith(norm(title).slice(0, 20)));
  const name = idx >= 0 ? texts[idx + 1] : texts[1];
  return name && name.length <= 40 ? name : null;
}

// الصلاة من أول العنوان فقط: «فجر» «الفجر» «صلاة فجر» «صلاة الفجر» (ومثلها المغرب والعشاء والجمعة).
// البحث في أول العنوان فقط حتى لا تُفهم «سورة الجمعة» على أنها صلاة الجمعة.
function detectPrayer(title: string): string | undefined {
  const m = title.trim().match(/^(?:صلاة\s+)?(?:ال)?(فجر|مغرب|عشاء|جمعة)(?=\s|$|[0-9٠-٩\-|:،,])/);
  return m && PRAYERS.includes(m[1]) ? m[1] : undefined;
}

const toArabicDigits = (n: number | string) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

function buildPost(id: number, title: string, reciterRaw: string) {
  const prayer = detectPrayer(title);
  const hijri = title.match(/(\d{1,2})-(\d{1,2})-(14\d\d)/);
  const reciter = reciterRaw.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  if (!prayer) return { ok: false as const, reason: "تعذّر تحديد الصلاة من العنوان" };
  if (!hijri) return { ok: false as const, reason: "تعذّر تحديد التاريخ الهجري من العنوان" };
  if (!reciter) return { ok: false as const, reason: "تعذّر تحديد اسم الشيخ" };
  const tag = `#${reciter.replace(/\s+/g, "_")}`;
  const caption = [
    `تلاوةٌ للشيخ ${tag}`,
    "",
    title,
    "",
    `${SITE}/p/${id}`,
    "",
    "تمت المشاركة من 📱| #تطبيق_تلاوات_الحرمين",
    SITE,
  ].join("\n");
  const lastName = reciter.split(" ").pop() ?? reciter;
  const fileName = `${prayer} ${lastName} ${toArabicDigits(Number(hijri[1]))}-${toArabicDigits(Number(hijri[2]))}.mp3`;
  return { ok: true as const, caption, fileName, reciter };
}

async function recitationsChannel() {
  const [row] = rowsOf(await db.execute(sql`SELECT id, chat_id FROM telegram_channels WHERE kind = 'recitations' AND enabled = true ORDER BY id LIMIT 1`));
  return row ? { id: Number(row.id), chatId: String(row.chat_id) } : null;
}

async function claim(id: number): Promise<boolean> {
  const rows = rowsOf(await db.execute(sql`
    INSERT INTO app_tg_autopost (post_id, status, attempts) VALUES (${id}, 'posting', 1)
    ON CONFLICT (post_id) DO UPDATE SET status = 'posting', reason = NULL,
      attempts = CASE WHEN app_tg_autopost.status = 'waiting' THEN app_tg_autopost.attempts ELSE app_tg_autopost.attempts + 1 END
    WHERE app_tg_autopost.status = 'waiting'
      OR app_tg_autopost.status = 'failed' AND app_tg_autopost.attempts < ${MAX_ATTEMPTS}
      OR (app_tg_autopost.status = 'posting' AND app_tg_autopost.created_at < now() - interval '20 minutes')
    RETURNING post_id`));
  return rows.length > 0;
}

async function finish(id: number, values: { status: string; reason?: string | null; title?: string | null; reciter?: string | null; messageId?: number | null }) {
  await db.execute(sql`UPDATE app_tg_autopost SET status = ${values.status}, reason = ${values.reason ?? null}, title = coalesce(${values.title ?? null}, title),
    reciter = coalesce(${values.reciter ?? null}, reciter), message_id = ${values.messageId ?? null}, posted_at = ${values.status === "posted" ? new Date() : null} WHERE post_id = ${id}`);
}

async function alertAdmin(id: number, title: string, reason: string) {
  await notifyTelegramAdminsGeneric({
    title: "تلاوة لم تُنشر تلقائيًا في قناة التطبيق",
    lines: [`التلاوة: ${title || `رقم ${id}`}`, `الرابط: ${SITE}/p/${id}`, `السبب: ${reason}`, "", "انشرها يدويًا في القناة."],
    alertKey: `app_autopost:${id}`,
  }).catch(() => {});
}

// ── المكي قبل النبوي (قرار المدير: انتظار مفتوح) ─────────────────────────────────────────────
// تلاوة المسجد النبوي لا تُنشر قبل تلاوة المسجد الحرام لنفس الصلاة ونفس اليوم الهجري. تبقى «بانتظار المكي»
// مهما طال، وبعد ساعة يصل المدير تنبيه واحد ليقرر بنفسه.
const PRAYER_CODE: Record<string, string> = { "فجر": "fajr", "مغرب": "maghrib", "عشاء": "isha", "جمعة": "jumuah" };

function prayerAndHijri(title: string) {
  const prayer = detectPrayer(title) ?? null;
  const h = title.match(/(\d{1,2})-(\d{1,2})-(14\d\d)/);
  return { prayer, hijriKey: h ? `${Number(h[1])}-${Number(h[2])}-${h[3]}` : null, day: h ? Number(h[1]) : null, month: h ? Number(h[2]) : null };
}

async function makkahAlreadyPosted(prayer: string, hijriKey: string, day: number, month: number): Promise<boolean> {
  const [own] = rowsOf(await db.execute(sql`SELECT 1 FROM app_tg_autopost WHERE mosque = 'makkah' AND prayer = ${prayer} AND hijri_key = ${hijriKey} AND status = 'posted' LIMIT 1`));
  if (own) return true;
  // أو نُشرت يدويًا في القناة (يقرؤها نظام مراقبة تلقرام).
  const [manual] = rowsOf(await db.execute(sql`
    SELECT 1 FROM telegram_channel_posts WHERE kind = 'recitation' AND mosque = 'haram' AND extracted_prayer = ${PRAYER_CODE[prayer] ?? prayer}
      AND hijri_day = ${day} AND hijri_month = ${month} AND published_at > now() - interval '3 days' LIMIT 1`));
  return Boolean(manual);
}

async function holdForMakkah(id: number, title: string, reciter: string, prayer: string, hijriKey: string) {
  await db.execute(sql`UPDATE app_tg_autopost SET status = 'waiting', reason = 'بانتظار تلاوة المسجد الحرام لنفس الصلاة', title = ${title}, reciter = ${reciter} WHERE post_id = ${id}`);
  const [row] = rowsOf(await db.execute(sql`SELECT created_at < now() - interval '60 minutes' AS late FROM app_tg_autopost WHERE post_id = ${id}`));
  if (row?.late) {
    await notifyTelegramAdminsGeneric({
      title: "تلاوة المسجد النبوي تنتظر تلاوة المسجد الحرام",
      lines: [`التلاوة: ${title}`, `الرابط: ${SITE}/p/${id}`, `مضت ساعة ولم تُنشر تلاوة المسجد الحرام لنفس الصلاة (${prayer} ${hijriKey}).`, "", "ستُنشر النبوية تلقائيًا فور نشر المكية. وإن أردت نشرها الآن فانشرها يدويًا في القناة."],
      alertKey: `app_autopost_order:${id}`,
    }).catch(() => {});
  }
}

// ── التلاوات القديمة (الإصدار 68) ─────────────────────────────────────────────────────────────
// يُنشر فقط ما تاريخه الهجري في العنوان هو اليوم أو الأمس (تقويم أم القرى بتوقيت الرياض)، مع سماحية يوم
// بعده لاحتمال فرق رؤية الهلال. الأقدم يُتجاهل بلا تنبيه (قرار المدير).
const UMM_AL_QURA = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { timeZone: "Asia/Riyadh", day: "numeric", month: "numeric", year: "numeric" });
function hijriKeyOf(date: Date): string {
  const parts = Object.fromEntries(UMM_AL_QURA.formatToParts(date).map((p) => [p.type, p.value]));
  return `${Number(parts.day)}-${Number(parts.month)}-${Number(parts.year)}`;
}
function isRecentHijri(hijriKey: string): boolean {
  const now = Date.now();
  return [-2, -1, 0, 1].some((d) => hijriKeyOf(new Date(now + d * 86_400_000)) === hijriKey);
}

// معالجة تلاوة واحدة موجودة في الموقع.
async function handlePost(id: number, html: string, channel: { id: number; chatId: string }) {
  if (!(await claim(id))) return;
  const parsed = parsePage(html);
  if (!parsed) { await finish(id, { status: "failed", reason: "تعذّرت قراءة صفحة التلاوة" }); return; }
  if (parsed.section !== "الفروض") { await finish(id, { status: "skipped", reason: `ليست من الفروض (${parsed.section})`, title: parsed.title }); return; }
  const fail = async (reason: string, final = true) => {
    await finish(id, { status: "failed", reason, title: parsed.title });
    if (final) await alertAdmin(id, parsed.title, reason);
  };
  if (!parsed.mp3) return fail("لا يوجد رابط ملف صوتي في الصفحة");
  if (!parsed.categoryId) return fail("تعذّر تحديد قسم التلاوة");
  const mosque: Mosque = /🕌|\/madani\//.test(`${html.match(/<title>[\s\S]*?<\/title>/i)?.[0] ?? ""} ${parsed.mp3}`) ? "madinah" : "makkah";
  const reciterRaw = await reciterFromListing(parsed.categoryId, mosque, id, parsed.title);
  if (!reciterRaw) return fail("تعذّر تحديد اسم الشيخ من قائمة التلاوات", false);
  const post = buildPost(id, parsed.title, reciterRaw);
  if (!post.ok) return fail(post.reason);
  const ph = prayerAndHijri(parsed.title);
  if (ph.hijriKey && !isRecentHijri(ph.hijriKey)) {
    await finish(id, { status: "skipped", reason: "تلاوة قديمة — لم تُنشر", title: parsed.title });
    return;
  }
  await db.execute(sql`UPDATE app_tg_autopost SET mosque = ${mosque}, prayer = ${ph.prayer}, hijri_key = ${ph.hijriKey} WHERE post_id = ${id}`);
  if (mosque === "madinah" && ph.prayer && ph.hijriKey && ph.day && ph.month && !(await makkahAlreadyPosted(ph.prayer, ph.hijriKey, ph.day, ph.month))) {
    await holdForMakkah(id, parsed.title, post.reciter, ph.prayer, ph.hijriKey);
    return;
  }

  const audio = await fetch(parsed.mp3).catch(() => null);
  if (!audio || !audio.ok) return fail(`تعذّر تنزيل الملف الصوتي (${audio?.status ?? "خطأ اتصال"})`, false);
  const size = Number(audio.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES) return fail(`الملف أكبر من حد تيليجرام للبوت (${Math.round(size / 1048576)}MB)`);
  const blob = await audio.blob();
  if (blob.size > MAX_BYTES) return fail(`الملف أكبر من حد تيليجرام للبوت (${Math.round(blob.size / 1048576)}MB)`);
  if (blob.size < 10_000) return fail("الملف الصوتي فارغ أو تالف", false);

  const sent = await sendTelegramAudioUpload({ chatId: channel.chatId, file: blob, fileName: post.fileName, caption: post.caption });
  if (!sent.ok) return fail(`رفض تيليجرام النشر: ${sent.error}`, false);
  await finish(id, { status: "posted", title: parsed.title, reciter: post.reciter, messageId: Number(sent.result?.message_id ?? 0) || null });
  // توثيق المهمتين كما لو نُشرت يدويًا (البوت لا يستقبل منشوراته عبر الـ webhook).
  try {
    const stored = await storeChannelUpdate({ channel_post: sent.result });
    if (stored) await processTelegramPost(stored);
  } catch { /* التوثيق يُعاد في الفحص الدوري لمراقبة تلقرام */ }
}

// خط الأساس: أحدث رقم موجود الآن (لا يُنشر ما قبله)، وما حوله من الموجود يُعلَّم «قبل التفعيل».
async function establishBaseline(): Promise<number> {
  let id = SEED_ID;
  let last = SEED_ID;
  let misses = 0;
  while (misses < 12 && id < SEED_ID + 5000) {
    id += 1;
    const { status } = await fetchText(`${SITE}/p/${id}`);
    if (status === 200) { last = id; misses = 0; } else misses += 1;
  }
  for (let k = last - LOOKBACK; k <= last; k++) {
    const { status } = await fetchText(`${SITE}/p/${k}`);
    if (status === 200) await db.execute(sql`INSERT INTO app_tg_autopost (post_id, status, reason) VALUES (${k}, 'skipped', 'قبل التفعيل') ON CONFLICT DO NOTHING`);
  }
  await db.execute(sql`UPDATE app_tg_autopost_settings SET baseline_id = ${last}, last_id = ${last}, updated_at = now() WHERE id = 1`);
  return last;
}

let running = false;
export async function runAppTelegramAutopost(): Promise<{ posted: number }> {
  if (running) return { posted: 0 };
  running = true;
  try {
    const s = await settings();
    if (!s.enabled) return { posted: 0 };
    const channel = await recitationsChannel();
    if (!channel) return { posted: 0 };
    let lastId = s.lastId ?? (await establishBaseline());
    const handled = new Set(rowsOf(await db.execute(sql`SELECT post_id FROM app_tg_autopost WHERE post_id >= ${lastId - LOOKBACK} AND (status IN ('posted','skipped') OR (status = 'failed' AND attempts >= ${MAX_ATTEMPTS}))`)).map((r) => Number(r.post_id)));
    let posted = 0;
    let maxSeen = lastId;
    const pages: Array<{ id: number; text: string; madinah: boolean }> = [];
    // النبوية المنتظرة التي خرجت من نافذة الفحص تُعاد أيضًا (انتظار مفتوح، آخر 7 أيام).
    const oldWaiting = rowsOf(await db.execute(sql`SELECT post_id FROM app_tg_autopost WHERE status = 'waiting' AND post_id < ${lastId - LOOKBACK} AND created_at > now() - interval '7 days'`)).map((r) => Number(r.post_id));
    const ids = [...oldWaiting];
    for (let id = lastId - LOOKBACK; id <= lastId + LOOKAHEAD; id++) ids.push(id);
    for (const id of ids) {
      if (handled.has(id) || id <= (s.baselineId ?? 0) - LOOKBACK) continue;
      const { status, text } = await fetchText(`${SITE}/p/${id}`).catch(() => ({ status: 0, text: "" }));
      if (status !== 200) continue;
      maxSeen = Math.max(maxSeen, id);
      pages.push({ id, text, madinah: /🕌|\/madani\//.test(`${text.match(/<title>[\s\S]*?<\/title>/i)?.[0] ?? ""} ${text.match(/href="(https?:\/\/[^"]+\.mp3)"/i)?.[1] ?? ""}`) });
    }
    // المكي أولًا ثم النبوي (فإن ظهرا معًا يُنشر المكي ثم النبوي في نفس الفحص).
    for (const page of [...pages.filter((p) => !p.madinah), ...pages.filter((p) => p.madinah)]) {
      const before = rowsOf(await db.execute(sql`SELECT status FROM app_tg_autopost WHERE post_id = ${page.id}`))[0]?.status;
      await handlePost(page.id, page.text, channel).catch(() => {});
      const after = rowsOf(await db.execute(sql`SELECT status FROM app_tg_autopost WHERE post_id = ${page.id}`))[0]?.status;
      if (after === "posted" && before !== "posted") posted += 1;
    }
    await db.execute(sql`UPDATE app_tg_autopost_settings SET last_id = ${maxSeen}, last_run_at = now() WHERE id = 1`);
    return { posted };
  } finally {
    running = false;
  }
}

export function startAppTelegramAutopostScheduler(logger: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const run = () => runAppTelegramAutopost().catch((err) => logger.error({ err }, "app telegram autopost failed"));
  setTimeout(run, 60_000).unref?.();
  setInterval(run, 3 * 60_000).unref?.();
  logger.info("app → telegram autopost scheduler started");
}

export async function appAutopostOverview() {
  const s = await settings();
  const items = rowsOf(await db.execute(sql`SELECT post_id, status, reason, title, reciter, attempts, created_at, posted_at FROM app_tg_autopost WHERE coalesce(reason, '') <> 'قبل التفعيل' ORDER BY post_id DESC LIMIT 30`));
  const iso = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(`${String(v).replace(" ", "T")}Z`).toISOString());
  return {
    enabled: s.enabled, baselineId: s.baselineId, lastId: s.lastId, lastRunAt: iso(s.lastRunAt),
    items: items.map((r) => ({ postId: Number(r.post_id), status: String(r.status), reason: r.reason ?? null, title: r.title ?? null, reciter: r.reciter ?? null, attempts: Number(r.attempts), postedAt: iso(r.posted_at), createdAt: iso(r.created_at) })),
  };
}

export async function setAppAutopostEnabled(enabled: boolean) {
  await ensureSchema();
  // إعادة التشغيل تبدأ من جديد (خط أساس جديد): لا يُنشر ما صدر أثناء الإيقاف.
  if (enabled) await db.execute(sql`UPDATE app_tg_autopost_settings SET enabled = true, baseline_id = NULL, last_id = NULL, updated_at = now() WHERE id = 1`);
  else await db.execute(sql`UPDATE app_tg_autopost_settings SET enabled = false, updated_at = now() WHERE id = 1`);
}
