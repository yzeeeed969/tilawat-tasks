// نشر الجمعة آليًا في تطبيق تلاوات الحرمين (الإصدار 75، اعتماد المدير 31-10-2026):
// جهاز تسجيل كل مسجد (ماك ميني) بعد قصّ الخطبة والصلاة يرفع الملف إلى media.altilawat.com ثم يرسل الرابط هنا.
// والخادم: يحدد الخطيب من منشور «خطباء الحرمين لهذا الأسبوع» في القناة، ويكتب العنوان بصيغة الفريق، ويضيفه
// في لوحة التطبيق بحساب منفصل خاص بالنظام (الإشعار مفعّل لأنها تلاوة اليوم). ثم يتولى النشر التلقائي إرسالها
// إلى قناة التطبيق على تيليجرام بالترتيب المعتمد.
//
// قرارات المدير: أسماء السور تلقائية بالكامل · تلقائي من أول جمعة · حساب لوحة منفصل.
// الضمانات: جمعة اليوم فقط · رابط من media.altilawat.com فقط · لا تكرار (ولا إن نشرها الفريق يدويًا) ·
// أي نقص (الخطيب، السور، الدخول) ⇐ لا نشر + تنبيه للمدير.
//
// إعدادات الخادم (يضعها المدير بنفسه في Railway): APP_ADMIN_EMAIL · APP_ADMIN_PASSWORD · FRIDAY_PUBLISH_KEY

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { notifyTelegramAdminsGeneric } from "./telegram-notification-engine";
import { currentYearCategory, PARENTS, type Mosque } from "./app-khutbah-autopost";
import { SURAHS } from "./quran-surahs";

const SITE = "https://tilawatalharamain.com";
const UA = "TilawatTasksBot/1.0";
const HIJRI_MONTHS = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];

function rowsOf<T = any>(result: any): T[] {
  return (Array.isArray(result) ? result : result?.rows ?? []) as T[];
}

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_friday_publish (
          id serial PRIMARY KEY,
          mosque text NOT NULL,
          kind text NOT NULL,
          friday date NOT NULL,
          status text NOT NULL,
          reason text,
          title text,
          reciter text,
          audio_url text,
          created_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now(),
          UNIQUE (mosque, kind, friday)
        )`);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ── المفتاح السري لأجهزة التسجيل ────────────────────────────────────────────────────────────────
export function fridayKeyConfigured() {
  return (process.env.FRIDAY_PUBLISH_KEY ?? "").trim().length >= 32;
}
export function checkFridayKey(header: string | undefined): boolean {
  const expected = (process.env.FRIDAY_PUBLISH_KEY ?? "").trim();
  if (expected.length < 32 || !header) return false;
  const a = Buffer.from(header.replace(/^Bearer\s+/i, "").trim());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── التاريخ ───────────────────────────────────────────────────────────────────────────────────
const UMM_AL_QURA = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { timeZone: "Asia/Riyadh", day: "numeric", month: "numeric", year: "numeric" });
function riyadhToday(): { y: number; m: number; d: number; weekday: number } {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", day: "numeric", month: "numeric", year: "numeric" }).formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
function hijriOf(y: number, m: number, d: number) {
  const p = Object.fromEntries(UMM_AL_QURA.formatToParts(new Date(Date.UTC(y, m - 1, d, 9))).map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: Number(p.month), year: Number(String(p.year).replace(/\D/g, "")) };
}

// ── العناوين (صيغة الفريق) ─────────────────────────────────────────────────────────────────────
export type SurahPart = { surah: number; from?: number; to?: number };

function surahPhrase(parts: SurahPart[]): { ar: string; en: string } | { error: string } {
  if (!parts.length) return { error: "لم تصل أسماء السور" };
  const ar: string[] = [];
  const en: string[] = [];
  for (const p of parts) {
    const s = SURAHS[p.surah - 1];
    if (!s) return { error: `رقم سورة غير صحيح (${p.surah})` };
    const whole = !p.from || !p.to || (p.from === 1 && p.to === s.ayat);
    if (!whole && (p.from! < 1 || p.to! > s.ayat || p.from! > p.to!)) return { error: `أرقام آيات غير صحيحة في سورة ${s.ar} (${p.from}-${p.to})` };
    ar.push(`سورة ${s.ar}${whole ? "" : ` ${p.from}-${p.to}`}`);
    en.push(s.en);
  }
  const enJoined = en.length === 1 ? en[0] : `${en.slice(0, -1).join(", ")} and ${en[en.length - 1]}`;
  return { ar: `من ${ar.join(" و")}`, en: `from Surah ${enJoined}` };
}

function buildTitle(kind: "khutbah" | "prayer", h: { day: number; month: number; year: number }, g: { d: number; m: number; y: number }, parts: SurahPart[]) {
  const greg = `${g.d}-${g.m}-${g.y}`;
  if (kind === "khutbah") return { title: `خطبة الجمعة ${h.day} ${HIJRI_MONTHS[h.month - 1]} ${h.year}هـ | Khutbah Jumu’ah ${greg}` };
  const phrase = surahPhrase(parts);
  if ("error" in phrase) return { error: phrase.error };
  return { title: `صلاة الجمعة ${h.day}-${h.month}-${h.year}هـ ${phrase.ar} | Jumu’ah Prayer ${phrase.en} ${greg}` };
}

// ── الخطيب من منشور «خطباء الحرمين لهذا الأسبوع» ────────────────────────────────────────────────
async function weeklyKhateeb(mosque: Mosque, h: { day: number; month: number }): Promise<string | null> {
  const rows = rowsOf(await db.execute(sql`
    SELECT caption FROM telegram_channel_posts WHERE caption LIKE '%خطباء الحرمين%' AND published_at > now() - interval '6 days'
    ORDER BY published_at DESC LIMIT 5`));
  const monthName = HIJRI_MONTHS[h.month - 1];
  for (const r of rows) {
    const c = String(r.caption ?? "").replace(/[⁦-⁩‎‏]/g, "");
    if (!c.includes(`${h.day} ${monthName}`)) continue;
    const label = mosque === "makkah" ? "المسجد الحرام" : "المسجد النبوي";
    const m = c.match(new RegExp(`${label}[^#\\n]*#([^\\s#]+)`));
    if (m) return m[1].replace(/_/g, " ").trim();
  }
  return null;
}

// ── جلسة لوحة التطبيق (حساب النظام المنفصل) ──────────────────────────────────────────────────────
function mergeCookies(current: string, res: Response) {
  const jar = new Map(current.split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const raw of (res.headers as any).getSetCookie?.() ?? []) {
    const pair = String(raw).split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}
const tokenOf = (html: string) => html.match(/name="_token"\s+value="([^"]+)"/)?.[1] ?? html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";

let session: { cookie: string; at: number } | null = null;

async function adminGet(path: string, cookie: string) {
  const res = await fetch(`${SITE}${path}`, { headers: { "User-Agent": UA, Cookie: cookie }, redirect: "manual" });
  const next = mergeCookies(cookie, res);
  return { status: res.status, location: res.headers.get("location") ?? "", html: res.status === 200 ? await res.text() : "", cookie: next };
}

async function login(): Promise<string> {
  const email = (process.env.APP_ADMIN_EMAIL ?? "").trim();
  const password = process.env.APP_ADMIN_PASSWORD ?? "";
  if (!email || !password) throw new Error("حساب النظام في لوحة التطبيق غير مضبوط على الخادم (APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD)");
  const page = await adminGet("/admin/login", "");
  const token = tokenOf(page.html);
  if (!token) throw new Error("تعذّر فتح صفحة الدخول في لوحة التطبيق");
  const res = await fetch(`${SITE}/admin/login`, {
    method: "POST", redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: page.cookie },
    body: new URLSearchParams({ _token: token, email, password, remember: "on" }).toString(),
  });
  const cookie = mergeCookies(page.cookie, res);
  const loc = res.headers.get("location") ?? "";
  if (res.status !== 302 || /\/admin\/login/.test(loc)) throw new Error("رفضت لوحة التطبيق الدخول بحساب النظام (البريد أو كلمة المرور)");
  session = { cookie, at: Date.now() };
  return cookie;
}

// صفحة من اللوحة بجلسة صالحة (تُجدَّد الجلسة إن انتهت).
async function adminPage(path: string): Promise<{ html: string; cookie: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = session && Date.now() - session.at < 60 * 60_000 ? session.cookie : await login();
    const r = await adminGet(path, cookie);
    if (r.status === 200 && !/name="password"/.test(r.html)) { session = { cookie: r.cookie, at: session?.at ?? Date.now() }; return { html: r.html, cookie: r.cookie }; }
    if (r.status === 507) throw new Error("لوحة التطبيق: مساحة الاستضافة ممتلئة (507)");
    session = null;
  }
  throw new Error(`تعذّر فتح ${path} في لوحة التطبيق بحساب النظام (ربما ينقصه تصريح)`);
}

async function adminPost(path: string, cookie: string, fields: Array<[string, string]>): Promise<void> {
  const res = await fetch(`${SITE}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams(fields).toString(),
  });
  const next = mergeCookies(cookie, res);
  if (res.status === 507) throw new Error("لوحة التطبيق: مساحة الاستضافة ممتلئة (507)");
  if (res.status !== 302) throw new Error(`لوحة التطبيق ردّت برمز ${res.status} عند الحفظ`);
  const back = await adminGet(new URL(res.headers.get("location") ?? "/admin", SITE).pathname, next);
  session = { cookie: back.cookie, at: session?.at ?? Date.now() };
  if (!/تم حفظ البيانات/.test(back.html)) {
    const err = back.html.match(/class="[^"]*(?:invalid-feedback|alert-danger|text-danger)[^"]*"[^>]*>([\s\S]{0,200}?)</)?.[1]?.replace(/\s+/g, " ").trim();
    throw new Error(`لم تؤكد لوحة التطبيق الحفظ${err ? `: ${err}` : ""}`);
  }
}

// اختيار الشيخ من قائمة اللوحة: الاسم نفسه، ويُفضَّل ما يطابق المسجد إن وُجدت نسختان (مثل «( المكي )»).
function pickReciter(html: string, name: string, mosque: Mosque): { id: string; label: string } | null {
  const select = html.match(/<select[^>]*name="reciter"[\s\S]*?<\/select>/)?.[0] ?? "";
  const norm = (s: string) => s.replace(/[ً-ْ]/g, "").replace(/[أإآ]/g, "ا").replace(/\s+/g, " ").trim();
  const target = norm(name.replace(/^(?:الشيخ|د\.?)\s+/, ""));
  const options = [...select.matchAll(/<option value="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)].map((m) => ({ id: m[1], label: m[2].replace(/<[^>]*>/g, "").trim() }));
  const matches = options.filter((o) => norm(o.label.replace(/\(.*?\)/g, "")) === target && !/رحمه الله/.test(o.label));
  if (!matches.length) return null;
  const want = mosque === "makkah" ? /المكي|الحرم المكي/ : /النبوي/;
  return matches.find((o) => want.test(o.label)) ?? matches.find((o) => !/\(/.test(o.label)) ?? matches[0];
}

// هل نشرها الفريق في التطبيق مسبقًا؟
async function alreadyInApp(kind: "khutbah" | "prayer", mosque: Mosque, h: { day: number; month: number; year: number }, greg: string, cookie: string): Promise<boolean> {
  if (kind === "khutbah") {
    const cat = await currentYearCategory(PARENTS[mosque]);
    if (!cat) return false;
    const res = await fetch(`${SITE}/miscellanies/c/${cat}`, { headers: { "User-Agent": UA } });
    const html = res.ok ? await res.text() : "";
    return html.includes(`Jumu’ah ${greg}`) || html.includes(`aljumuea ${greg}`) || html.includes(`Jumu'ah ${greg}`);
  }
  const r = await adminGet(`/admin/prayers?mosque=${mosque === "makkah" ? 1 : 2}`, cookie);
  return new RegExp(`صلاة الجمعة\\s*${h.day}\\s*-\\s*${h.month}\\s*-\\s*${h.year}`).test(r.html);
}

async function alertAdmin(title: string, lines: string[], key: string) {
  await notifyTelegramAdminsGeneric({ title, lines, alertKey: key }).catch(() => {});
}

// ── الطلب من جهاز التسجيل ─────────────────────────────────────────────────────────────────────
export type FridaySubmission = { mosque: Mosque; kind: "khutbah" | "prayer"; audioUrl: string; surahs?: SurahPart[] };

export async function submitFriday(input: FridaySubmission): Promise<{ ok: boolean; status: string; title?: string; message?: string }> {
  await ensureSchema();
  const mosqueLabel = input.mosque === "makkah" ? "المسجد الحرام" : "المسجد النبوي";
  const kindLabel = input.kind === "khutbah" ? "خطبة الجمعة" : "صلاة الجمعة";
  const t = riyadhToday();
  if (t.weekday !== 5) return { ok: false, status: "rejected", message: "اليوم ليس جمعة" };
  if (!/^https:\/\/media\.altilawat\.com\/[^\s?#]+\.(?:mp3|m4a)$/i.test(input.audioUrl)) return { ok: false, status: "rejected", message: "الرابط يجب أن يكون ملف mp3 أو m4a من media.altilawat.com" };
  const friday = `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;

  // حجز (لا تكرار): مرة واحدة لكل مسجد/نوع/جمعة، ويُسمح بإعادة المحاولة إن فشلت.
  const claimed = rowsOf(await db.execute(sql`
    INSERT INTO app_friday_publish (mosque, kind, friday, status, audio_url) VALUES (${input.mosque}, ${input.kind}, ${friday}, 'working', ${input.audioUrl})
    ON CONFLICT (mosque, kind, friday) DO UPDATE SET status = 'working', reason = NULL, audio_url = EXCLUDED.audio_url, updated_at = now()
    WHERE app_friday_publish.status = 'failed' OR (app_friday_publish.status = 'working' AND app_friday_publish.updated_at < now() - interval '15 minutes')
    RETURNING id`));
  if (!claimed.length) {
    const [row] = rowsOf(await db.execute(sql`SELECT status, title FROM app_friday_publish WHERE mosque = ${input.mosque} AND kind = ${input.kind} AND friday = ${friday}`));
    return { ok: true, status: String(row?.status ?? "done"), title: row?.title ?? undefined, message: "سبق التعامل معها" };
  }
  const done = async (status: string, values: { reason?: string; title?: string; reciter?: string } = {}) => {
    await db.execute(sql`UPDATE app_friday_publish SET status = ${status}, reason = ${values.reason ?? null}, title = coalesce(${values.title ?? null}, title),
      reciter = coalesce(${values.reciter ?? null}, reciter), updated_at = now() WHERE mosque = ${input.mosque} AND kind = ${input.kind} AND friday = ${friday}`);
  };
  const fail = async (reason: string, title?: string) => {
    await done("failed", { reason, title });
    await alertAdmin(`لم تُنشر ${kindLabel} (${mosqueLabel}) في التطبيق آليًا`, [`السبب: ${reason}`, `الملف: ${input.audioUrl}`, "", "انشرها يدويًا في لوحة التطبيق."], `friday_publish:${friday}:${input.mosque}:${input.kind}`);
    return { ok: false, status: "failed", title, message: reason };
  };

  try {
    const h = hijriOf(t.y, t.m, t.d);
    const built = buildTitle(input.kind, h, t, input.surahs ?? []);
    if ("error" in built) return await fail(built.error!);
    const title = built.title!;
    const khateeb = await weeklyKhateeb(input.mosque, h);
    if (!khateeb) return await fail("لم أجد اسم الخطيب في منشور «خطباء الحرمين لهذا الأسبوع» في القناة", title);

    const createPath = input.kind === "khutbah" ? "/admin/miscellanies/create" : "/admin/prayers/create";
    const form = await adminPage(createPath);
    if (await alreadyInApp(input.kind, input.mosque, h, `${t.d}-${t.m}-${t.y}`, form.cookie)) {
      await done("skipped", { reason: "نشرها الفريق في التطبيق مسبقًا", title, reciter: khateeb });
      return { ok: true, status: "skipped", title, message: "نشرها الفريق في التطبيق مسبقًا" };
    }
    const reciter = pickReciter(form.html, khateeb, input.mosque);
    if (!reciter) return await fail(`الخطيب «${khateeb}» غير موجود في قائمة القراء في لوحة التطبيق`, title);
    const token = tokenOf(form.html);
    if (!token) return await fail("تعذّرت قراءة نموذج الإضافة في لوحة التطبيق", title);

    let fields: Array<[string, string]>;
    if (input.kind === "khutbah") {
      const cat = await currentYearCategory(PARENTS[input.mosque]);
      if (!cat) return await fail("لم أجد قسم خطب السنة الحالية في التطبيق", title);
      const position = form.html.match(/name="position"[^>]*value="(\d+)"/)?.[1] ?? form.html.match(/value="(\d+)"[^>]*name="position"/)?.[1] ?? "";
      fields = [["_token", token], ["_method", "POST"], ["category", String(cat)], ["name", title], ["sound_url", input.audioUrl], ["youtube_id", ""],
        ["reciter", reciter.id], ["position", position], ["status", "1"], ["send_push_notification", "1"]];
    } else {
      const emoji = input.mosque === "makkah" ? "🕋" : "🕌";
      const select = form.html.match(/<select[^>]*name="category"[\s\S]*?<\/select>/)?.[0] ?? "";
      const cat = [...select.matchAll(/<option value="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)].find((m) => m[2].includes(String(h.year)) && m[2].includes(emoji))?.[1];
      if (!cat) return await fail(`لم أجد قسم «${h.year} ${emoji}» في تلاوات الفروض`, title);
      const positionsJson = form.html.match(/var positions = (\{[\s\S]*?\});/)?.[1];
      const position = positionsJson ? (JSON.parse(positionsJson)?.[cat]?.[String(h.month)] ?? "") : "";
      if (!position) return await fail("تعذّر تحديد ترتيب التلاوة (position) في لوحة التطبيق", title);
      fields = [["_token", token], ["_method", "POST"], ["category", cat], ["month", String(h.month)], ["name", title], ["sound_url", input.audioUrl],
        ["youtube_id", ""], ["reciter", reciter.id], ["position", String(position)], ["status", "1"], ["send_push_notification", "1"]];
    }
    await adminPost(input.kind === "khutbah" ? "/admin/miscellanies" : "/admin/prayers", form.cookie, fields);
    await done("published", { title, reciter: reciter.label });
    return { ok: true, status: "published", title };
  } catch (err) {
    return await fail((err as Error).message);
  }
}

// للمدير: حالة الإعدادات وآخر العمليات.
export async function fridayPublishOverview() {
  await ensureSchema();
  const items = rowsOf(await db.execute(sql`SELECT mosque, kind, friday, status, reason, title, reciter, audio_url, updated_at FROM app_friday_publish ORDER BY id DESC LIMIT 20`));
  return {
    configured: { machineKey: fridayKeyConfigured(), appAccount: Boolean((process.env.APP_ADMIN_EMAIL ?? "").trim() && process.env.APP_ADMIN_PASSWORD) },
    items,
  };
}

// للمدير: اختبار الدخول بحساب النظام دون نشر شيء.
export async function testAppLogin(): Promise<{ ok: boolean; message: string }> {
  try {
    session = null;
    await adminPage("/admin/prayers/create");
    await adminPage("/admin/miscellanies/create");
    return { ok: true, message: "تم الدخول بحساب النظام، ويستطيع فتح صفحتي إضافة التلاوات والخطب." };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
