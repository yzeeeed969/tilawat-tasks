import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureMuezzinSchema } from "./muezzin-schema";
import { riyadhDayKey } from "../lib/hijri";
import {
  alertAdmins,
  ALL_SLOT_ORDER,
  getScheduleRange,
  getSettings,
  isWhatsAppConfigured,
  listMuezzins,
  MuezzinError,
  ROLE_LABEL,
  rowsOf,
  saveMeta,
  SLOT_MESSAGE,
  type MuezzinMeta,
  type Role,
  type Slot,
} from "./muezzin";
import {
  BUTTONS,
  dutyTemplate,
  EXAMPLE,
  EXAMPLE_CTX,
  EXAMPLE_SUB_CTX,
  fullDayLabel,
  gregorianDate,
  hijriDate,
  substituteTemplate,
  SUP_ACK_TEXT,
  SUP_APOLOGY_BUTTON,
  SUP_APOLOGY_TEXT,
  weekdayName,
} from "./muezzin-wording";
import { activeVersion, DRAFT_TEMPLATES, messages, type MsgCtx } from "./muezzin-messages";

// «التأكيد بالأزرار»: لكل مهمة رسالة مستقلة فيها «عُلم / أعتذر».
// - «عُلم» ← يُسجَّل ويصل المشرفَ تنبيه.
// - «أعتذر» ← يصله نموذج داخل واتساب بخانة سبب إلزامية ← يُسجَّل ويصل المشرفَ تنبيه بزر «اختيار البديل».
// - المشرف يختار البديل من قائمة ← يتحدّث الجدول ويصل البديلَ رسالة المهمة بالزرّين نفسيهما.
// كل الردود تصل عبر Webhook رسمي موقّع من ميتا (WHATSAPP_APP_SECRET).

const WABA_ID = () => process.env.WHATSAPP_WABA_ID?.trim() || "947290318194353";
const GRAPH = () => `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION?.trim() || "v21.0"}`;

/* ───────────────────────── واجهة ميتا ───────────────────────── */

async function graph(path: string, init: { method?: string; body?: unknown } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${GRAPH()}/${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WHATSAPP_TOKEN?.trim() ?? ""}` },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const e = body?.error;
      const msg = [e?.error_user_msg || e?.message, e?.error_data?.details].filter(Boolean).join(" — ");
      throw new MuezzinError(502, `ميتا: ${msg || res.status}`);
    }
    return body;
  } catch (err) {
    if (err instanceof MuezzinError) throw err;
    throw new MuezzinError(504, "تعذّر الاتصال بميتا");
  } finally {
    clearTimeout(timeout);
  }
}

/** معامل نصي آمن لقالب: ميتا ترفض الأسطر الجديدة والمسافات المتتالية الكثيرة. */
function param(text: string) {
  return String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 900) || "—";
}

async function sendMessage(to: string, payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string; wamid: string | null }> {
  if (!isWhatsAppConfigured()) return { ok: false, detail: "واتساب غير مربوط", wamid: null };
  try {
    const body = await graph(`${process.env.WHATSAPP_PHONE_NUMBER_ID!.trim()}/messages`, {
      body: { messaging_product: "whatsapp", to, ...payload },
    });
    const wamid = String(body?.messages?.[0]?.id ?? "");
    return { ok: true, detail: wamid || "OK", wamid: wamid || null };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : "فشل الإرسال", wamid: null };
  }
}

function templatePayload(name: string, bodyParams: string[], buttons: unknown[] = []) {
  return {
    type: "template",
    template: {
      name,
      language: { code: "ar" },
      components: [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: param(t) })) }, ...buttons],
    },
  };
}

async function logEvent(e: { direction: "in" | "out"; phone?: string | null; name?: string | null; kind: string; text?: string | null; dutyId?: number | null; waId?: string | null }) {
  try {
    await db.execute(sql`
      INSERT INTO muezzin_wa_events (direction, phone, muezzin_name, kind, text, duty_id, wa_id)
      VALUES (${e.direction}, ${e.phone ?? null}, ${e.name ?? null}, ${e.kind}, ${e.text ?? null}, ${e.dutyId ?? null}, ${e.waId ?? null})
      ON CONFLICT (wa_id) DO NOTHING`);
  } catch {
    // السجل للعرض فقط — لا يوقف المعالجة.
  }
}

/* ───────────────────────── إعداد النماذج والقوالب ───────────────────────── */

function fill(text: string, values: string[]) {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? "");
}

/**
 * يرسل القوالب لاعتماد ميتا بالنص الذي اختاره المدير. كل تشغيل يستخدم أسماء جديدة (rN) فلا يتعارض مع قوالب سابقة.
 * لا نماذج (Flows): ميتا تشترط لها حسابًا موثّقًا. السبب يُكتب رسالةً عادية، والبديل يُختار من قوائم واتساب.
 */
export async function prepareMeta() {
  await ensureMuezzinSchema();
  if (!isWhatsAppConfigured()) throw new MuezzinError(400, "واتساب غير مربوط");
  const settings = await getSettings();
  const w = settings.wording;
  const rev = (settings.meta.rev ?? 0) + 1;
  const steps: string[] = [];

  // ربط تطبيقنا بحساب واتساب ليستقبل الردود (آمن لو كان مربوطًا مسبقًا).
  await graph(`${WABA_ID()}/subscribed_apps`, { method: "POST" });
  steps.push("رُبط استقبال الردود بحساب واتساب");

  const body = (text: string, example: string[]) => ({ type: "BODY", text, example: { body_text: [example] } });
  const [b1, b2] = BUTTONS[w.buttons];
  const names = {
    duty: `muezzin_duty_r${rev}`,
    substitute: w.substitute === "b" ? `muezzin_sub_r${rev}` : undefined,
    supAck: `muezzin_sup_ack_r${rev}`,
    supApology: `muezzin_sup_apology_r${rev}`,
  };
  const quick = { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: b1 }, { type: "QUICK_REPLY", text: b2 }] };
  const defs: Array<{ name: string; components: unknown[] }> = [
    { name: names.duty, components: [body(dutyTemplate(w).text, dutyTemplate(w).params(EXAMPLE_CTX)), quick] },
    { name: names.supAck, components: [body(SUP_ACK_TEXT, EXAMPLE)] },
    {
      name: names.supApology,
      components: [
        body(SUP_APOLOGY_TEXT, [...EXAMPLE, "ظرف عائلي"]),
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: SUP_APOLOGY_BUTTON }] },
      ],
    },
  ];
  if (names.substitute) defs.push({ name: names.substitute, components: [body(substituteTemplate(w).text, substituteTemplate(w).params(EXAMPLE_SUB_CTX)), quick] });

  // قالب الملخص المسائي مستقل — لا يُعاد إنشاؤه هنا.
  const meta: MuezzinMeta = { ...settings.meta, rev, templates: { summary: settings.meta.templates?.summary }, wording: w, preparedAt: new Date().toISOString() };
  for (const d of defs) {
    await graph(`${WABA_ID()}/message_templates`, { body: { name: d.name, language: "ar", category: "UTILITY", components: d.components } });
    const key = (Object.keys(names) as Array<keyof typeof names>).find((k) => names[k] === d.name)!;
    meta.templates![key] = d.name;
    await saveMeta(meta); // نحفظ أولًا بأول كي لا يضيع ما أُنشئ إن فشل ما بعده.
  }
  steps.push(`أُرسلت ${defs.length} قوالب لمراجعة ميتا`);
  await saveMeta(meta);
  return { steps, meta };
}

/** حالة رقم الإرسال عند ميتا (للقراءة فقط): اسم العرض الحالي وطلب تغييره وتقييم الجودة. */
export async function phoneStatus() {
  if (!isWhatsAppConfigured()) throw new MuezzinError(400, "واتساب غير مربوط");
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  return graph(`${id}?fields=display_phone_number,verified_name,name_status,new_name_status,new_display_name,quality_rating,messaging_limit_tier,status`);
}

/**
 * إعادة تسجيل رقم الإرسال لتطبيق اسم العرض المعتمد. يكتب المدير رمز التحقق بخطوتين في الموقع
 * (لا يُحفظ ولا يُسجَّل في أي مكان) ويُمرَّر لميتا مرة واحدة.
 */
export async function reregisterPhone(pin: unknown) {
  if (!isWhatsAppConfigured()) throw new MuezzinError(400, "واتساب غير مربوط");
  const p = String(pin ?? "").trim();
  if (!/^\d{6}$/.test(p)) throw new MuezzinError(400, "رمز التحقق 6 أرقام");
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const before = await graph(`${id}?fields=verified_name,new_display_name,new_name_status`);
  // نعيّن الرمز الذي كتبه المدير أولًا (لا يمكن معرفة القديم، وتبويبه لم يعد يظهر في مدير واتساب)،
  // ثم نعيد التسجيل بنفس الرمز. إن كانت ميتا ألغت الرمز لهذا الرقم فالخطوة الأولى تُتجاهل.
  let pinSet = false;
  try { await graph(`${id}`, { body: { pin: p } }); pinSet = true; } catch { /* قد لا يلزم رمز لهذا الرقم */ }
  try {
    await graph(`${id}/register`, { body: { messaging_product: "whatsapp", pin: p } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MuezzinError(400, /pin|two.?step|PIN/i.test(msg) ? "رمز التحقق غير صحيح — لم يتغير شيء، والرسائل مستمرة." : `تعذّرت إعادة التسجيل: ${msg}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const after = await graph(`${id}?fields=verified_name,new_display_name,new_name_status,status,quality_rating`);
  return { before, after, pinSet };
}

export async function templateStatuses() {
  const settings = await getSettings();
  const wanted = [...new Set([...Object.values(settings.meta.templates ?? {}), ...Object.values(settings.meta.v2?.templates ?? {})].filter(Boolean) as string[])];
  if (!wanted.length || !isWhatsAppConfigured()) return [];
  const r = await graph(`${WABA_ID()}/message_templates?fields=name,status,rejected_reason,category&limit=200`);
  const all: any[] = r?.data ?? [];
  return wanted.map((name) => {
    const t = all.find((x) => x.name === name);
    return { name, status: String(t?.status ?? "NOT_FOUND"), reason: t?.rejected_reason && t.rejected_reason !== "NONE" ? String(t.rejected_reason) : null, category: t?.category ?? null };
  });
}

/** شروط تفعيل التأكيد بالأزرار — يرمي رسالة واضحة إن نقص شيء. */
export async function checkConfirmReady() {
  const s = await getSettings();
  if (!process.env.WHATSAPP_APP_SECRET?.trim()) throw new MuezzinError(400, "أضف WHATSAPP_APP_SECRET في Railway أولًا (لاستقبال الردود بأمان)");
  if (!s.supervisorPhones.length) throw new MuezzinError(400, "أضف رقم مشرف واحد على الأقل");
  if (!s.meta.templates?.duty || !s.meta.templates?.supApology) throw new MuezzinError(400, "أرسل القوالب لاعتماد ميتا أولًا");
  const statuses = await templateStatuses();
  const pending = statuses.filter((t) => t.status !== "APPROVED" && t.name !== s.meta.templates?.summary);
  if (pending.length) throw new MuezzinError(400, `لم تُعتمد كل القوالب بعد: ${pending.map((t) => `${t.name} (${t.status})`).join("، ")}`);
}

/* ───────────────────────── الملخص المسائي للمشرفين ───────────────────────── */

export const SUMMARY_TEXT =
  "📋 ملخص ردود المؤذنين على مهام يوم ( {{1}} )\n{{2}}\n\n✅ عُلم ( {{3}} ) :\n{{4}}\n\n❌ اعتذر ( {{5}} ) :\n{{6}}\n\n⏳ لم يرد ( {{7}} ) :\n{{8}}\n\nالتفاصيل في صفحة جدول المؤذنين.";
const SUMMARY_EXAMPLE = [
  "الثلاثاء", "07 / 06 / 1448 هـ — 17 / 11 / 2026 م", "10", "هاشم السقاف ، أحمد نحاس ، محمد باسعد",
  "1", "سعيد فلاته (العصر) — السبب: سفر", "1", "علي ملا (المغرب – ملازم)",
];

/** ينشئ قالب الملخص وحده ويرسله لمراجعة ميتا (لا يمس القوالب المعتمدة). */
export async function prepareSummaryTemplate() {
  await ensureMuezzinSchema();
  if (!isWhatsAppConfigured()) throw new MuezzinError(400, "واتساب غير مربوط");
  const s = await getSettings();
  const n = Number(String(s.meta.templates?.summary ?? "").match(/_r(\d+)$/)?.[1] ?? 0) + 1;
  const name = `muezzin_summary_r${n}`;
  await graph(`${WABA_ID()}/message_templates`, {
    body: { name, language: "ar", category: "UTILITY", components: [{ type: "BODY", text: SUMMARY_TEXT, example: { body_text: [SUMMARY_EXAMPLE] } }] },
  });
  await saveMeta({ ...s.meta, templates: { ...(s.meta.templates ?? {}), summary: name } });
  return { name };
}

/** معاملات القالب لا تقبل أسطرًا جديدة؛ نفصل بـ « ، » ونختصر الطويل. */
function joinList(items: string[], max = 420) {
  if (!items.length) return "لا أحد";
  const out: string[] = [];
  let len = 0;
  for (const [i, it] of items.entries()) {
    if (len + it.length > max) { out.push(`… و${items.length - i} غيرهم`); break; }
    out.push(it); len += it.length + 3;
  }
  return out.join(" ، ");
}

export function buildSummary(duties: Array<Pick<Duty, "slot" | "role" | "name" | "response" | "reason" | "sendOk" | "replacedByDutyId">>, dateKey: string) {
  const live = duties.filter((d) => d.sendOk && !d.replacedByDutyId);
  const task = (d: { slot: Slot; role: Role }) => `${SLOT_SHORT[d.slot] ?? d.slot}${d.role === "muezzin" ? "" : ` – ${ROLE_LABEL[d.role]}`}`;
  const ack = live.filter((d) => d.response === "ack");
  const apol = live.filter((d) => d.response === "apology" || d.response === "apology_pending");
  const none = live.filter((d) => !d.response);
  const ackNames = [...new Set(ack.map((d) => d.name))];
  const params = [
    weekdayName(dateKey),
    `${hijriDate(dateKey)} هـ — ${gregorianDate(dateKey)} م`,
    String(ack.length), joinList(ackNames),
    String(apol.length), joinList(apol.map((d) => `${d.name} (${task(d)})${d.response === "apology_pending" ? " — لم يكتب السبب" : d.reason ? ` — السبب: ${param(d.reason).slice(0, 80)}` : ""}`), 300),
    String(none.length), joinList(none.map((d) => `${d.name} (${task(d)})`), 300),
  ].map(param);
  return { params, counts: { total: live.length, ack: ack.length, apology: apol.length, none: none.length } };
}

const SLOT_SHORT: Record<string, string> = {
  fajr1: "الفجر الأول", fajr2: "الفجر الثاني", dhuhr: "الظهر", asr: "العصر", maghrib: "المغرب", isha: "العشاء", jumuah1: "الجمعة الأول", jumuah2: "الجمعة الثاني",
};

/** يرسل ملخص ردود يوم المهام لكل المشرفين. */
export async function sendSummary(dateKey: string) {
  const s = await getSettings();
  if (!s.meta.templates?.summary) throw new MuezzinError(400, "قالب الملخص لم يُنشأ بعد");
  const duties = rowsOf(await db.execute(sql`SELECT * FROM muezzin_duties WHERE date_key = ${dateKey} AND test_mode = ${s.testMode}`)).map(mapDuty);
  if (!duties.length) return { sent: 0, failed: 0, noDuties: true };
  const { params, counts } = buildSummary(duties, dateKey);
  const sups = await supervisorTargets(s.testMode);
  if (!sups.length) throw new MuezzinError(400, "لا يوجد مشرفون");
  let sent = 0, failed = 0;
  for (const sup of sups) {
    const r = await sendMessage(sup, templatePayload(s.meta.templates.summary, params));
    await logEvent({ direction: "out", phone: sup, name: "المشرف", kind: "supervisor_summary", text: fill(SUMMARY_TEXT, params), waId: r.wamid });
    if (r.ok) sent++; else { failed++; await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nتعذّر إرسال الملخص للمشرف ${sup}: ${r.detail}`); }
  }
  return { sent, failed, counts };
}

/* ───────────────────────── الإرسال: رسالة لكل مهمة ───────────────────────── */

type Duty = {
  id: number; dateKey: string; slot: Slot; role: Role; muezzinId: number | null; name: string; phone: string | null;
  testMode: boolean; wamid: string | null; sendOk: boolean; response: string | null; reason: string | null;
  substituteForDutyId: number | null; replacedByDutyId: number | null;
};

function mapDuty(r: any): Duty {
  return {
    id: Number(r.id), dateKey: String(r.date_key), slot: String(r.slot) as Slot, role: String(r.role) as Role,
    muezzinId: r.muezzin_id == null ? null : Number(r.muezzin_id), name: String(r.muezzin_name), phone: r.phone ? String(r.phone) : null,
    testMode: Boolean(r.test_mode), wamid: r.wamid ? String(r.wamid) : null, sendOk: Boolean(r.send_ok),
    response: r.response ? String(r.response) : null, reason: r.reason ? String(r.reason) : null,
    substituteForDutyId: r.substitute_for_duty_id == null ? null : Number(r.substitute_for_duty_id),
    replacedByDutyId: r.replaced_by_duty_id == null ? null : Number(r.replaced_by_duty_id),
  };
}

async function getDuty(id: number): Promise<Duty | null> {
  const r = rowsOf(await db.execute(sql`SELECT * FROM muezzin_duties WHERE id = ${id}`))[0];
  return r ? mapDuty(r) : null;
}

const dutyLabel = (d: { slot: Slot }) => SLOT_MESSAGE[d.slot];
const roleLabel = (d: { slot: Slot; role: Role }) => ROLE_LABEL[d.role];
const dayLabel = (dateKey: string) => fullDayLabel(dateKey);
const dutyText = (d: { slot: Slot; role: Role; dateKey: string }) => `${dutyLabel(d)} (${roleLabel(d)}) — ${dayLabel(d.dateKey)}`;
/** سياق النصوص من المهمة — كل النصوص من muezzin-messages (المصدر الواحد مع المحاكي). */
const ctxOf = (d: { name: string; slot: Slot; role: Role; dateKey: string; substituteForDutyId?: number | null }): MsgCtx =>
  ({ name: d.name, slot: d.slot, role: d.role, dateKey: d.dateKey, original: d.substituteForDutyId ? "بديل" : null });
const M = () => messages(activeVersion());

/** يرسل رسالة مهمة واحدة (أصلية أو بديلة) ويحدّث صفّها. */
async function sendDutyMessage(duty: Duty, to: string, originalName?: string) {
  const s = await getSettings();
  const t = s.meta.templates ?? {};
  const useSub = Boolean(originalName && t.substitute);
  const name = useSub ? t.substitute! : t.duty!;
  // الصيغة التي اعتُمدت فعلًا عند ميتا (لا المختارة لاحقًا ولم تُرسل).
  const w = s.meta.wording ?? s.wording;
  // بعد اعتماد صياغة المشرف: نفس قالب المهمة المعتمد (يتغير سطر المهمة فقط) وقالب البديل الجديد.
  const tpl = activeVersion() === "draft"
    ? (() => { const x = messages("draft").duty({ name: duty.name, slot: duty.slot, role: duty.role, dateKey: duty.dateKey, original: useSub ? originalName : null }); return { text: x.text, params: () => x.params }; })()
    : useSub ? substituteTemplate(w) : dutyTemplate(w);
  const params = tpl.params({ name: duty.name, slot: duty.slot, role: duty.role, dateKey: duty.dateKey, original: originalName });
  const buttons = [
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `ack:${duty.id}` }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `apol:${duty.id}` }] },
  ];
  const r = await sendMessage(to, templatePayload(name, params, buttons));
  await db.execute(sql`UPDATE muezzin_duties SET phone = ${to}, wamid = ${r.wamid}, send_ok = ${r.ok}, send_detail = ${r.detail}, delivery_status = NULL, delivery_error = NULL, sent_at = now() WHERE id = ${duty.id}`);
  await logEvent({ direction: "out", phone: to, name: duty.name, kind: useSub ? "substitute_duty" : "duty", text: fill(tpl.text, params), dutyId: duty.id, waId: r.wamid });
  return r;
}

export async function sendDutiesForDate(dateKey: string) {
  await ensureMuezzinSchema();
  const settings = await getSettings();
  const testMode = settings.testMode;
  if (testMode && !settings.testPhone) throw new MuezzinError(400, "أضف رقم التجربة أولًا (وضع التجربة مفعّل)");
  if (!settings.meta.templates?.duty) throw new MuezzinError(400, "قوالب التأكيد غير جاهزة");

  const entries = (await getScheduleRange(dateKey, 1)).sort((a, b) => ALL_SLOT_ORDER[a.slot] - ALL_SLOT_ORDER[b.slot]);
  if (!entries.length) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nلا يوجد جدول ليوم ${dayLabel(dateKey)} — لم تُرسل أي رسالة. ارفع جدول الأسبوع.`);
    return { sent: 0, failed: 0, skipped: 0, testMode, noSchedule: true };
  }
  const muezzins = await listMuezzins();
  let sent = 0, failed = 0, skipped = 0;
  const failures: string[] = [];

  for (const e of entries) {
    const m = muezzins.find((x) => x.name === e.name);
    if (!m || !m.isActive) { skipped++; continue; }
    // لا تكرار: مهمة أُرسلت بنجاح لنفس الشخص ونفس الوضع.
    const existing = rowsOf(await db.execute(sql`
      SELECT * FROM muezzin_duties WHERE date_key = ${dateKey} AND slot = ${e.slot} AND role = ${e.role}
        AND muezzin_id = ${m.id} AND test_mode = ${testMode} ORDER BY id DESC LIMIT 1`))[0];
    // ما قبلته ميتا ثم فشل تسليمه (رقم خاطئ مثلًا) يُعاد إرساله — بالرقم الحالي في القائمة.
    if (existing?.send_ok && existing.delivery_status !== "failed") { skipped++; continue; }
    const to = testMode ? settings.testPhone! : m.phone;
    // من لا رقم له يُتجاوز بهدوء (الإطلاق تدريجي: يُضاف رقم المؤذن متى اتُّفق معه).
    if (!to) { skipped++; continue; }
    const duty = existing
      ? mapDuty(existing)
      : mapDuty(rowsOf(await db.execute(sql`
          INSERT INTO muezzin_duties (date_key, slot, role, muezzin_id, muezzin_name, phone, test_mode)
          VALUES (${dateKey}, ${e.slot}, ${e.role}, ${m.id}, ${m.name}, ${to}, ${testMode}) RETURNING *`))[0]);
    const r = await sendDutyMessage(duty, to);
    if (r.ok) sent++;
    else { failed++; failures.push(`${m.name} (${dutyLabel(duty)}): ${r.detail}`); }
  }
  if (failures.length) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b> — فشل ${failures.length} رسالة ليوم ${dateKey}${testMode ? " (تجربة)" : ""}:\n${failures.slice(0, 15).join("\n")}`);
  }
  return { sent, failed, skipped, testMode, noSchedule: false };
}

/* ───────────────────────── استقبال الردود (Webhook) ───────────────────────── */

export function verifySignature(rawBody: Buffer | undefined, header: string | undefined) {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (!secret || !rawBody || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

const textMsg = (body: string) => ({ type: "text", text: { body } });

/** أرقام المشرفين (في التجربة: رقم التجربة وحده). */
async function supervisorTargets(testMode: boolean): Promise<string[]> {
  const s = await getSettings();
  return testMode ? (s.testPhone ? [s.testPhone] : []) : s.supervisorPhones;
}

async function onAck(duty: Duty, from: string) {
  if (duty.replacedByDutyId) {
    await sendMessage(from, textMsg(M().replacedAfterApology()));
    return;
  }
  const already = duty.response === "ack";
  await db.execute(sql`UPDATE muezzin_duties SET response = 'ack', responded_at = now() WHERE id = ${duty.id}`);
  await sendMessage(from, textMsg(M().ackReply(ctxOf(duty))));
  if (already) return;
  const s = await getSettings();
  // المشرف نفسه لا يصله تنبيه عن ردّه هو (إلا في التجربة حيث الكل رقم واحد).
  const sups = (await supervisorTargets(duty.testMode)).filter((p) => duty.testMode || p !== from);
  if (!sups.length || !s.meta.templates?.supAck) return;
  const { text: supAckText, params } = M().supAck(ctxOf(duty));
  for (const sup of sups) {
  const r = await sendMessage(sup, templatePayload(s.meta.templates.supAck, params));
  await logEvent({ direction: "out", phone: sup, name: "المشرف", kind: "supervisor_ack", text: fill(supAckText, params), dutyId: duty.id, waId: r.wamid });
  }
}

async function onApologyTap(duty: Duty, from: string) {
  if (duty.replacedByDutyId) {
    await sendMessage(from, textMsg(M().replacedOnApologyTap()));
    return;
  }
  if (duty.response === "apology") {
    await sendMessage(from, textMsg(M().alreadyApologized(ctxOf(duty))));
    return;
  }
  // لا يُسجَّل الاعتذار إلا بعد وصول السبب: ننتظر رسالته النصية التالية.
  await db.execute(sql`UPDATE muezzin_duties SET response = 'apology_pending', responded_at = now(), reason_reminded = false WHERE id = ${duty.id}`);
  const text = M().apologyPrompt(ctxOf(duty));
  const r = await sendMessage(from, textMsg(text));
  await logEvent({ direction: "out", phone: from, name: duty.name, kind: "apology_prompt", text, dutyId: duty.id, waId: r.wamid });
}

/** رسالة نصية من رقم له اعتذار بانتظار السبب ← تُعدّ سببًا لكل اعتذاراته المعلّقة (آخر 24 ساعة). */
async function onTextMaybeReason(from: string, text: string) {
  const pending = rowsOf(await db.execute(sql`
    SELECT * FROM muezzin_duties WHERE phone = ${from} AND response = 'apology_pending' AND replaced_by_duty_id IS NULL
      AND responded_at > now() - interval '24 hours' ORDER BY id`)).map(mapDuty);
  if (!pending.length || !text.trim()) return [];
  for (const d of pending) await onApologyReason(d, from, text, pending.length > 1);
  if (pending.length > 1) await sendMessage(from, textMsg(M().apologyRecordedMulti(pending.length)));
  return pending;
}

/** تذكير واحد بعد 30 دقيقة لمن ضغط «أعتذر» ولم يكتب السبب (يُستدعى من مجدول الإرسال). */
/* ───────────────────────── صياغة المشرف (v2) وتذكير من لم يرد ───────────────────────── */

const V2_EXAMPLE_CTX = { name: "محمد المغربي", slot: "asr" as Slot, role: "mulazim" as Role, dateKey: "2026-11-16" };

/** يرسل لميتا قوالب صياغة المشرف + قالب التذكير (لا يمس القوالب المعتمدة الحالية). */
export async function prepareV2() {
  await ensureMuezzinSchema();
  if (!isWhatsAppConfigured()) throw new MuezzinError(400, "واتساب غير مربوط");
  const s = await getSettings();
  const d = messages("draft");
  const ex = V2_EXAMPLE_CTX;
  const body = (text: string, example: string[]) => ({ type: "BODY", text, example: { body_text: [example] } });
  const w = s.meta.wording ?? s.wording;
  const [b1, b2] = BUTTONS[w.buttons];
  const quick = { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: b1 }, { type: "QUICK_REPLY", text: b2 }] };
  const rev = (Number(String(s.meta.v2?.templates?.supAck ?? "").match(/_r(\d+)$/)?.[1] ?? 0) || 0) + 1;
  const names = { substitute: `muezzin_sub_v2_r${rev}`, supAck: `muezzin_sup_ack_v2_r${rev}`, supApology: `muezzin_sup_apology_v2_r${rev}`, remind: `muezzin_remind_r${rev}` };
  const defs: Array<{ key: keyof typeof names; components: unknown[] }> = [
    { key: "substitute", components: [body(DRAFT_TEMPLATES.substitute, d.duty({ ...ex, original: "د. ماجد العباس" }).params), quick] },
    { key: "supAck", components: [body(DRAFT_TEMPLATES.supAck, d.supAck(ex).params)] },
    { key: "supApology", components: [body(DRAFT_TEMPLATES.supApology, d.supApology({ ...ex, name: "د. ماجد العباس" }, "إجراء عملية جراحية").params), { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: SUP_APOLOGY_BUTTON }] }] },
    { key: "remind", components: [body(DRAFT_TEMPLATES.remind, d.reminder({ ...ex, name: "علي ملا", slot: "isha", role: "muezzin" }).params), quick] },
  ];
  const v2 = { templates: {} as Record<string, string>, preparedAt: new Date().toISOString() };
  for (const def of defs) {
    await graph(`${WABA_ID()}/message_templates`, { body: { name: names[def.key], language: "ar", category: "UTILITY", components: def.components } });
    v2.templates[def.key] = names[def.key];
    await saveMeta({ ...(await getSettings()).meta, v2 });
  }
  return { templates: v2.templates };
}

let lastV2Check = 0;
/**
 * كل 10 دقائق: إن اعتمدت ميتا قوالب صياغة المشرف الثلاثة → تتحول الرسائل كلها إليها دفعة واحدة.
 * قالب التذكير يُفعَّل وحده متى اعتُمد. ويُنبَّه المدير مرة إن رُفض شيء.
 */
export async function checkV2Promotion(force = false) {
  if (!force && Date.now() - lastV2Check < 10 * 60_000) return { checked: false };
  lastV2Check = Date.now();
  const s = await getSettings();
  const v2 = s.meta.v2;
  if (!v2?.templates || !isWhatsAppConfigured()) return { checked: false };
  const st = await templateStatuses();
  const status = (n?: string) => (n ? st.find((t) => t.name === n)?.status : undefined);
  const meta = { ...s.meta, templates: { ...(s.meta.templates ?? {}) }, v2: { ...v2 } };
  let changed = false;
  if (v2.templates.remind && status(v2.templates.remind) === "APPROVED" && meta.templates.remind !== v2.templates.remind) {
    meta.templates.remind = v2.templates.remind; changed = true;
    await alertAdmins("✅ <b>جدول المؤذنين</b>\nاعتمدت ميتا قالب «تذكير من لم يرد» — بدأ العمل.");
  }
  const core = (["substitute", "supAck", "supApology"] as const).map((k) => v2.templates[k]);
  if (!v2.promotedAt && core.every((n) => status(n) === "APPROVED")) {
    meta.templates.substitute = v2.templates.substitute; meta.templates.supAck = v2.templates.supAck; meta.templates.supApology = v2.templates.supApology;
    meta.textVersion = "draft"; meta.v2.promotedAt = new Date().toISOString(); changed = true;
    await alertAdmins("✅ <b>جدول المؤذنين</b>\nاعتمدت ميتا قوالب صياغة المشرف — تحولت كل الرسائل إلى الصياغة الجديدة.");
  }
  const rejected = st.filter((t) => Object.values(v2.templates).includes(t.name) && t.status === "REJECTED");
  if (rejected.length && !v2.rejectedNotified) {
    meta.v2.rejectedNotified = true; changed = true;
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nرفضت ميتا: ${rejected.map((t) => `${t.name}${t.reason ? ` (${t.reason})` : ""}`).join("، ")} — الرسائل الحالية مستمرة بلا تغيير.`);
  }
  if (changed) await saveMeta(meta);
  return { checked: true, promoted: Boolean(meta.v2.promotedAt), remind: Boolean(meta.templates.remind) };
}

/** تذكير واحد لمن لم يضغط «عُلم» ولا «أعتذر»: بعد ساعتين للأصلي، ونصف ساعة للبديل الطارئ. */
export async function remindNoReply() {
  await ensureMuezzinSchema();
  const s = await getSettings();
  const tpl = s.meta.templates?.remind;
  if (!s.remindEnabled || !tpl || !s.confirmMode) return { sent: 0 };
  const today = riyadhDayKey(new Date());
  const rows = rowsOf(await db.execute(sql`
    UPDATE muezzin_duties SET noreply_reminded = true
    WHERE response IS NULL AND send_ok = true AND (delivery_status IS DISTINCT FROM 'failed')
      AND replaced_by_duty_id IS NULL AND noreply_reminded = false AND test_mode = ${s.testMode}
      AND date_key >= ${today}
      AND COALESCE(sent_at, created_at) < now() - make_interval(mins => CASE WHEN substitute_for_duty_id IS NULL THEN ${s.remindAfterMin}::int ELSE ${s.remindSubAfterMin}::int END)
      AND COALESCE(sent_at, created_at) > now() - interval '20 hours'
    RETURNING *`)).map(mapDuty);
  let sent = 0;
  for (const d of rows) {
    if (!d.phone) continue;
    const { text, params } = messages("draft").reminder(ctxOf(d));
    const buttons = [
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `ack:${d.id}` }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `apol:${d.id}` }] },
    ];
    const r = await sendMessage(d.phone, templatePayload(tpl, params, buttons));
    await logEvent({ direction: "out", phone: d.phone, name: d.name, kind: "noreply_reminder", text: fill(text, params), dutyId: d.id, waId: r.wamid });
    if (r.ok) sent++;
  }
  return { sent };
}

export async function remindPendingReasons() {
  await ensureMuezzinSchema();
  await getSettings();
  const rows = rowsOf(await db.execute(sql`
    UPDATE muezzin_duties SET reason_reminded = true
    WHERE response = 'apology_pending' AND reason_reminded = false AND replaced_by_duty_id IS NULL
      AND responded_at < now() - interval '30 minutes' AND responded_at > now() - interval '23 hours'
    RETURNING *`)).map(mapDuty);
  for (const d of rows) {
    if (!d.phone) continue;
    const text = M().reasonReminder(ctxOf(d));
    const r = await sendMessage(d.phone, textMsg(text));
    await logEvent({ direction: "out", phone: d.phone, name: d.name, kind: "apology_reminder", text, dutyId: d.id, waId: r.wamid });
  }
  return rows.length;
}

async function onApologyReason(duty: Duty, from: string, reasonRaw: string, quiet = false) {
  const reason = param(reasonRaw).slice(0, 300);
  if (duty.replacedByDutyId) return;
  await db.execute(sql`UPDATE muezzin_duties SET response = 'apology', reason = ${reason}, responded_at = now() WHERE id = ${duty.id}`);
  if (!quiet) {
    await sendMessage(from, textMsg(M().apologyRecorded(ctxOf(duty))));
  }

  const s = await getSettings();
  const sups = await supervisorTargets(duty.testMode);
  if (!sups.length || !s.meta.templates?.supApology) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nاعتذر ${duty.name} عن ${dutyText(duty)}\nالسبب: ${reason}\n(لم يُضبط رقم المشرف)`);
    return;
  }
  const { text: supApologyText, params } = M().supApology(ctxOf(duty), reason);
  for (const sup of sups) {
  const r = await sendMessage(sup, templatePayload(s.meta.templates.supApology, params, [
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `pick:${duty.id}` }] },
  ]));
  await logEvent({ direction: "out", phone: sup, name: "المشرف", kind: "supervisor_apology", text: fill(supApologyText, params), dutyId: duty.id, waId: r.wamid });
  if (!r.ok) await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nتعذّر تنبيه المشرف ${sup} باعتذار ${duty.name} عن ${dutyText(duty)}: ${r.detail}`);
  }
}

/** المشرف ضغط «اختيار البديل» ← قوائم واتساب (10 أسماء لكل قائمة، حد ميتا) بكل المؤذنين عدا المعتذر. */
async function onPickTap(duty: Duty, from: string) {
  // الاحتياطي: يكفي تنبيه المشرف بالاعتذار، بلا قائمة بديل (زر القالب ثابت فيظهر، فنردّ بتوضيح).
  if (duty.role === "reserve") {
    await sendMessage(from, textMsg(M().reservePick(ctxOf(duty))));
    return;
  }
  if (duty.replacedByDutyId) {
    const sub = await getDuty(duty.replacedByDutyId);
    await sendMessage(from, textMsg(M().alreadyAssigned(sub?.name ?? "")));
    return;
  }
  const options = (await listMuezzins()).filter((m) => m.isActive && m.id !== duty.muezzinId);
  const chunks: typeof options[] = [];
  for (let i = 0; i < options.length; i += 10) chunks.push(options.slice(i, i + 10));
  for (const [n, chunk] of chunks.entries()) {
    const r = await sendMessage(from, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: M().pickListHeader(ctxOf(duty), n + 1, chunks.length) },
        action: {
          button: chunks.length > 1 ? `المؤذنون ${n + 1}` : "المؤذنون",
          sections: [{ title: "المؤذنون", rows: chunk.map((m) => ({ id: `sub:${duty.id}:${m.id}`, title: m.name.slice(0, 24) })) }],
        },
      },
    });
    await logEvent({ direction: "out", phone: from, name: "المشرف", kind: "substitute_list", text: `قائمة البدلاء ${n + 1}`, dutyId: duty.id, waId: r.wamid });
  }
}

export async function assignSubstitute(dutyId: number, substituteId: number, replyTo?: string | null) {
  const duty = await getDuty(dutyId);
  if (!duty) throw new MuezzinError(404, "المهمة غير موجودة");
  if (duty.role === "reserve") throw new MuezzinError(400, "مهمة الاحتياطي لا تحتاج بديلًا — أضف احتياطيًا آخر من الجدول المعتمد");
  if (duty.replacedByDutyId) {
    // عدة مشرفين: أول اختيار هو المعتمد.
    const prev = await getDuty(duty.replacedByDutyId);
    throw new MuezzinError(409, `سبق إسناد هذه المهمة إلى الشيخ ${prev?.name ?? ""}`);
  }
  const sub = (await listMuezzins()).find((m) => m.id === substituteId && m.isActive);
  if (!sub) throw new MuezzinError(400, "البديل غير موجود أو موقوف");
  if (sub.id === duty.muezzinId) throw new MuezzinError(400, "البديل هو نفس المعتذر");
  const s = await getSettings();
  const to = duty.testMode ? s.testPhone : sub.phone;

  // تحديث الجدول المعتمد: البديل مكان المعتذر في هذه الخانة.
  await db.execute(sql`
    UPDATE muezzin_schedule SET muezzin_id = ${sub.id}
    WHERE date_key = ${duty.dateKey} AND slot = ${duty.slot} AND role = ${duty.role} AND muezzin_id = ${duty.muezzinId}`);
  const newDuty = mapDuty(rowsOf(await db.execute(sql`
    INSERT INTO muezzin_duties (date_key, slot, role, muezzin_id, muezzin_name, phone, test_mode, substitute_for_duty_id)
    VALUES (${duty.dateKey}, ${duty.slot}, ${duty.role}, ${sub.id}, ${sub.name}, ${to}, ${duty.testMode}, ${duty.id}) RETURNING *`))[0]);
  await db.execute(sql`UPDATE muezzin_duties SET replaced_by_duty_id = ${newDuty.id} WHERE id = ${duty.id}`);

  let note = "";
  if (!to) {
    await db.execute(sql`UPDATE muezzin_duties SET send_ok = false, send_detail = 'لا يوجد رقم' WHERE id = ${newDuty.id}`);
    note = " (لم تُرسل له رسالة: لا يوجد رقم مسجّل)";
  } else {
    const r = await sendDutyMessage(newDuty, to, duty.name);
    if (!r.ok) note = ` (تعذّر إرسال رسالته: ${r.detail})`;
  }
  if (replyTo) await sendMessage(replyTo, textMsg(M().assigned(ctxOf(duty), sub.name, note)));
  return { substitute: sub.name, note };
}

/** معالجة دفعة Webhook من ميتا. */
export async function handleWebhook(body: any) {
  await ensureMuezzinSchema();
  await getSettings(); // يحدّث نسخة النصوص الحالية قبل أي رد.
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      // حالات التسليم (أُرسلت/وصلت/قُرئت/فشلت).
      for (const st of value.statuses ?? []) {
        const err = st?.errors?.[0];
        const errText = err ? `${err.code ?? ""} ${err.title ?? ""} ${err.error_data?.details ?? ""}`.trim() : null;
        await db.execute(sql`UPDATE muezzin_duties SET delivery_status = ${String(st.status ?? "")}, delivery_error = COALESCE(${errText}, delivery_error) WHERE wamid = ${String(st.id ?? "")}`);
        if (err && st.status === "failed") {
          const d = rowsOf(await db.execute(sql`SELECT muezzin_name, date_key FROM muezzin_duties WHERE wamid = ${String(st.id ?? "")}`))[0];
          if (d) await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nلم تصل رسالة ${d.muezzin_name} (${d.date_key}): ${errText}`);
        }
      }
      for (const msg of value.messages ?? []) {
        const from = String(msg?.from ?? "");
        const waId = String(msg?.id ?? "");
        // منع المعالجة المكررة (ميتا تعيد الإرسال أحيانًا).
        const fresh = rowsOf(await db.execute(sql`
          INSERT INTO muezzin_wa_events (direction, phone, kind, text, wa_id) VALUES ('in', ${from}, 'raw', NULL, ${waId})
          ON CONFLICT (wa_id) DO NOTHING RETURNING id`))[0];
        if (!fresh) continue;
        const eventId = Number(fresh.id);
        const setEvent = (kind: string, text: string, dutyId?: number | null, name?: string | null) =>
          db.execute(sql`UPDATE muezzin_wa_events SET kind = ${kind}, text = ${text}, duty_id = ${dutyId ?? null}, muezzin_name = ${name ?? null} WHERE id = ${eventId}`);

        try {
          // تجربة الصيغ الجديدة (رقم التجربة فقط): ضغطات sim:… ونص السبب أثناء التجربة.
          {
            const { handleSim } = await import("./muezzin-sim");
            const simId = msg.type === "interactive" ? String(msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? "") : null;
            const simText = msg.type === "text" ? String(msg.text?.body ?? "") : null;
            const isTest = (await getSettings()).testPhone === from;
            if (isTest && ((simId && simId.startsWith("sim:")) || (simId === null && simText !== null))) {
              if (await handleSim(from, simId && simId.startsWith("sim:") ? simId : null, simText, sendMessage)) {
                await setEvent("sim", simText ?? simId ?? "", null, "تجربة");
                continue;
              }
            }
          }
          if (msg.type === "button") {
            const payload = String(msg.button?.payload ?? "");
            const [kind, idStr] = payload.split(":");
            const duty = await getDuty(Number(idStr));
            if (kind === "pick") {
              // زر المشرف «اختيار البديل».
              if (!duty || !(await supervisorTargets(duty.testMode)).includes(from)) { await setEvent("button_unknown", String(msg.button?.text ?? payload)); continue; }
              await setEvent("pick_tap", String(msg.button?.text ?? ""), duty.id, "المشرف");
              await onPickTap(duty, from);
              continue;
            }
            if (!duty || duty.phone !== from) { await setEvent("button_unknown", String(msg.button?.text ?? payload)); continue; }
            await setEvent(kind === "ack" ? "ack" : "apology_tap", String(msg.button?.text ?? ""), duty.id, duty.name);
            if (kind === "ack") await onAck(duty, from);
            else if (kind === "apol") await onApologyTap(duty, from);
          } else if (msg.type === "interactive" && msg.interactive?.type === "list_reply") {
            // المشرف اختار البديل من القائمة: sub:<المهمة>:<البديل>
            const [kind, dutyIdStr, subIdStr] = String(msg.interactive.list_reply?.id ?? "").split(":");
            const duty = kind === "sub" ? await getDuty(Number(dutyIdStr)) : null;
            if (!duty || !(await supervisorTargets(duty.testMode)).includes(from)) { await setEvent("list_unknown", String(msg.interactive.list_reply?.title ?? "")); continue; }
            await setEvent("substitute_pick", `البديل: ${String(msg.interactive.list_reply?.title ?? "")}`, duty.id, "المشرف");
            try {
              await assignSubstitute(duty.id, Number(subIdStr), from);
            } catch (err) {
              await sendMessage(from, textMsg(`تعذّر إسناد البديل: ${err instanceof Error ? err.message : "خطأ"}`));
            }
          } else if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") {
            const resp = JSON.parse(String(msg.interactive.nfm_reply?.response_json ?? "{}"));
            const [kind, idStr] = String(resp.flow_token ?? "").split(":");
            const duty = await getDuty(Number(idStr));
            if (!duty) { await setEvent("form_unknown", JSON.stringify(resp).slice(0, 500)); continue; }
            if (kind === "apol") {
              if (duty.phone !== from) { await setEvent("form_unknown", "رد من رقم غير صاحب المهمة"); continue; }
              await setEvent("apology_reason", String(resp.reason ?? ""), duty.id, duty.name);
              await onApologyReason(duty, from, String(resp.reason ?? ""));
            } else if (kind === "sub") {
              if (!(await supervisorTargets(duty.testMode)).includes(from)) { await setEvent("form_unknown", "اختيار بديل من رقم غير المشرف"); continue; }
              const subId = Number(resp.substitute);
              const subName = (await listMuezzins()).find((m) => m.id === subId)?.name ?? String(resp.substitute);
              await setEvent("substitute_pick", `البديل: ${subName}`, duty.id, "المشرف");
              try {
                await assignSubstitute(duty.id, subId, from);
              } catch (err) {
                await sendMessage(from, textMsg(`تعذّر إسناد البديل: ${err instanceof Error ? err.message : "خطأ"}`));
              }
            }
          } else {
            const text = msg.type === "text" ? String(msg.text?.body ?? "") : `[${msg.type}]`;
            const m = (await listMuezzins()).find((x) => x.phone === from);
            const asReason = msg.type === "text" ? await onTextMaybeReason(from, text) : [];
            if (asReason.length) await setEvent("apology_reason", text.slice(0, 1000), asReason[0].id, asReason[0].name);
            else await setEvent("message", text.slice(0, 1000), null, m?.name ?? null);
          }
        } catch (err) {
          await setEvent("error", err instanceof Error ? err.message.slice(0, 300) : "خطأ");
        }
      }
    }
  }
}

/* ───────────────────────── العرض في الموقع ───────────────────────── */

export async function dutiesForDate(dateKey: string) {
  await ensureMuezzinSchema();
  const rows = rowsOf(await db.execute(sql`SELECT * FROM muezzin_duties WHERE date_key = ${dateKey} ORDER BY id`)).map((r) => ({
    ...mapDuty(r),
    sendDetail: r.send_detail ? String(r.send_detail) : null,
    deliveryStatus: r.delivery_status ? String(r.delivery_status) : null,
    deliveryError: r.delivery_error ? String(r.delivery_error) : null,
    respondedAt: r.responded_at,
    createdAt: r.created_at,
  }));
  return rows.sort((a, b) => ALL_SLOT_ORDER[a.slot] - ALL_SLOT_ORDER[b.slot] || a.role.localeCompare(b.role) || a.id - b.id);
}

export async function dutyStats(fromKey: string, toKey: string, testMode: boolean) {
  await ensureMuezzinSchema();
  return rowsOf(await db.execute(sql`
    SELECT muezzin_name,
      count(*) FILTER (WHERE send_ok)::int AS total,
      count(*) FILTER (WHERE response = 'ack')::int AS ack,
      count(*) FILTER (WHERE response = 'apology')::int AS apology,
      count(*) FILTER (WHERE send_ok AND response IS NULL)::int AS no_reply,
      count(*) FILTER (WHERE substitute_for_duty_id IS NOT NULL)::int AS as_substitute
    FROM muezzin_duties
    WHERE date_key BETWEEN ${fromKey} AND ${toKey} AND test_mode = ${testMode}
    GROUP BY muezzin_name ORDER BY muezzin_name`)).map((r) => ({
    name: String(r.muezzin_name), total: Number(r.total), ack: Number(r.ack), apology: Number(r.apology), noReply: Number(r.no_reply), asSubstitute: Number(r.as_substitute),
  }));
}

/**
 * سجل واتساب ليوم مهام محدد: كل ما يخص مهام ذلك اليوم (رسائلها وردودها وتنبيهات المشرفين)،
 * وما ليس مربوطًا بمهمة (رسائل نصية عامة) من ظهر اليوم السابق إلى نهاية اليوم بتوقيت مكة.
 */
export async function eventsForDate(dateKey: string) {
  await ensureMuezzinSchema();
  const ids = rowsOf(await db.execute(sql`SELECT id FROM muezzin_duties WHERE date_key = ${dateKey}`)).map((r) => Number(r.id));
  const prev = new Date(`${dateKey}T00:00:00Z`); prev.setUTCDate(prev.getUTCDate() - 1);
  const from = `${prev.toISOString().slice(0, 10)} 09:00:00`; // 12:00 ظهرًا بتوقيت مكة (UTC+3)
  const to = `${dateKey} 20:59:59`; // 11:59 مساءً بتوقيت مكة
  const idList = ids.length ? sql.join(ids.map((i) => sql`${i}`), sql`, `) : sql`NULL`;
  return rowsOf(await db.execute(sql`
    SELECT id, direction, phone, muezzin_name, kind, text, duty_id, created_at FROM muezzin_wa_events
    WHERE kind <> 'raw' AND (duty_id IN (${idList}) OR (duty_id IS NULL AND created_at BETWEEN ${from}::timestamp AND ${to}::timestamp))
    ORDER BY id DESC LIMIT 500`)).map((r) => ({
    id: Number(r.id), direction: String(r.direction), phone: r.phone ? String(r.phone) : null, name: r.muezzin_name ? String(r.muezzin_name) : null,
    kind: String(r.kind), text: r.text ? String(r.text) : "", dutyId: r.duty_id == null ? null : Number(r.duty_id), createdAt: r.created_at,
  }));
}

export async function recentEvents(limit = 100) {
  await ensureMuezzinSchema();
  return rowsOf(await db.execute(sql`
    SELECT id, direction, phone, muezzin_name, kind, text, created_at FROM muezzin_wa_events
    WHERE kind <> 'raw' ORDER BY id DESC LIMIT ${limit}`)).map((r) => ({
    id: Number(r.id), direction: String(r.direction), phone: r.phone ? String(r.phone) : null, name: r.muezzin_name ? String(r.muezzin_name) : null,
    kind: String(r.kind), text: r.text ? String(r.text) : "", createdAt: r.created_at,
  }));
}


/* ───────────────────────── معاينة على جوال التجربة ───────────────────────── */

/**
 * يرسل لرقم التجربة شكل الرسائل بالنص المختار، كرسائل تفاعلية بلا قالب (لا تحتاج اعتماد ميتا).
 * شرط ميتا: أن يكون رقم التجربة راسل رقم الإرسال خلال آخر 24 ساعة. الأزرار هنا للعرض فقط.
 */
export async function startSimulation() {
  const { startSim } = await import("./muezzin-sim");
  return startSim(sendMessage);
}

export async function sendPreview(input: unknown) {
  const { normalizeWording } = await import("./muezzin-wording");
  const s = await getSettings();
  const to = s.testPhone;
  if (!to) throw new MuezzinError(400, "أضف رقم التجربة أولًا");
  const w = normalizeWording(input ?? s.wording);
  const [b1, b2] = BUTTONS[w.buttons];
  // أزرار الرسائل التفاعلية حدّها 20 حرفًا (في القالب الفعلي 25).
  const btn = (id: string, title: string) => ({ type: "reply", reply: { id, title: title.slice(0, 20) } });
  const interactive = (text: string, buttons: Array<ReturnType<typeof btn>>) => ({
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons } },
  });
  const messages: Array<{ label: string; payload: Record<string, unknown> }> = [
    { label: "رسالة المهمة", payload: interactive(fill(dutyTemplate(w).text, dutyTemplate(w).params(EXAMPLE_CTX)), [btn("p1", b1), btn("p2", b2)]) },
    { label: "تنبيه المشرف (علم)", payload: textMsg(fill(SUP_ACK_TEXT, EXAMPLE)) },
    { label: "تنبيه المشرف (اعتذار)", payload: interactive(fill(SUP_APOLOGY_TEXT, [...EXAMPLE, "ظرف عائلي"]), [btn("p3", SUP_APOLOGY_BUTTON)]) },
  ];
  if (w.substitute === "b") {
    messages.push({ label: "رسالة البديل", payload: interactive(fill(substituteTemplate(w).text, substituteTemplate(w).params(EXAMPLE_SUB_CTX)), [btn("p4", b1), btn("p5", b2)]) });
  }
  const results: Array<{ label: string; ok: boolean; detail: string }> = [];
  for (const m of messages) {
    const r = await sendMessage(to, m.payload);
    results.push({ label: m.label, ok: r.ok, detail: r.detail });
    if (!r.ok) break;
  }
  const outside = results.some((r) => !r.ok && /131047|24 hours|re-engage/i.test(r.detail));
  if (outside) throw new MuezzinError(400, `أرسل أولًا أي رسالة (مثل «السلام عليكم») من جوال التجربة إلى رقم الإرسال 0557578627، ثم أعد المحاولة.`);
  return { to, results };
}
