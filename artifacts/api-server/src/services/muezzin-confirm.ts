import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureMuezzinSchema } from "./muezzin-schema";
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
  substituteTemplate,
  SUP_ACK_TEXT,
  SUP_APOLOGY_BUTTON,
  SUP_APOLOGY_TEXT,
} from "./muezzin-wording";

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

  const meta: MuezzinMeta = { ...settings.meta, rev, templates: {}, wording: w, preparedAt: new Date().toISOString() };
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

export async function templateStatuses() {
  const settings = await getSettings();
  const wanted = Object.values(settings.meta.templates ?? {}).filter(Boolean) as string[];
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
  const pending = statuses.filter((t) => t.status !== "APPROVED");
  if (pending.length) throw new MuezzinError(400, `لم تُعتمد كل القوالب بعد: ${pending.map((t) => `${t.name} (${t.status})`).join("، ")}`);
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

/** يرسل رسالة مهمة واحدة (أصلية أو بديلة) ويحدّث صفّها. */
async function sendDutyMessage(duty: Duty, to: string, originalName?: string) {
  const s = await getSettings();
  const t = s.meta.templates ?? {};
  const useSub = Boolean(originalName && t.substitute);
  const name = useSub ? t.substitute! : t.duty!;
  // الصيغة التي اعتُمدت فعلًا عند ميتا (لا المختارة لاحقًا ولم تُرسل).
  const w = s.meta.wording ?? s.wording;
  const tpl = useSub ? substituteTemplate(w) : dutyTemplate(w);
  const params = tpl.params({ name: duty.name, slot: duty.slot, role: duty.role, dateKey: duty.dateKey, original: originalName });
  const buttons = [
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `ack:${duty.id}` }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `apol:${duty.id}` }] },
  ];
  const r = await sendMessage(to, templatePayload(name, params, buttons));
  await db.execute(sql`UPDATE muezzin_duties SET phone = ${to}, wamid = ${r.wamid}, send_ok = ${r.ok}, send_detail = ${r.detail} WHERE id = ${duty.id}`);
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
    if (existing?.send_ok) { skipped++; continue; }
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
    await sendMessage(from, textMsg("أُسندت هذه المهمة لغيركم بعد اعتذاركم. جزاكم الله خيرًا."));
    return;
  }
  const already = duty.response === "ack";
  await db.execute(sql`UPDATE muezzin_duties SET response = 'ack', responded_at = now() WHERE id = ${duty.id}`);
  await sendMessage(from, textMsg(`تم تسجيل علمكم بمهمة ${dutyLabel(duty)} (${roleLabel(duty)}) يوم ${dayLabel(duty.dateKey)}. جزاكم الله خيرًا.`));
  if (already) return;
  const s = await getSettings();
  // المشرف نفسه لا يصله تنبيه عن ردّه هو (إلا في التجربة حيث الكل رقم واحد).
  const sups = (await supervisorTargets(duty.testMode)).filter((p) => duty.testMode || p !== from);
  if (!sups.length || !s.meta.templates?.supAck) return;
  const params = [duty.name, dutyLabel(duty), roleLabel(duty), dayLabel(duty.dateKey)];
  for (const sup of sups) {
  const r = await sendMessage(sup, templatePayload(s.meta.templates.supAck, params));
  await logEvent({ direction: "out", phone: sup, name: "المشرف", kind: "supervisor_ack", text: fill(SUP_ACK_TEXT, params), dutyId: duty.id, waId: r.wamid });
  }
}

async function onApologyTap(duty: Duty, from: string) {
  if (duty.replacedByDutyId) {
    await sendMessage(from, textMsg("سبق تسجيل اعتذاركم وأُسندت المهمة لغيركم. جزاكم الله خيرًا."));
    return;
  }
  if (duty.response === "apology") {
    await sendMessage(from, textMsg(`سبق تسجيل اعتذاركم عن ${dutyText(duty)}، والمشرف يرتّب البديل. جزاكم الله خيرًا.`));
    return;
  }
  // لا يُسجَّل الاعتذار إلا بعد وصول السبب: ننتظر رسالته النصية التالية.
  await db.execute(sql`UPDATE muezzin_duties SET response = 'apology_pending', responded_at = now(), reason_reminded = false WHERE id = ${duty.id}`);
  const text = `فضلا اكتب سبب الاعتذار عن ${dutyText(duty)} في رسالة هنا.\nلن يُسجَّل الاعتذار إلا بعد وصول السبب.`;
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
  if (pending.length > 1) await sendMessage(from, textMsg(`تم تسجيل اعتذاركم عن ${pending.length} مهام، وسيتولى المشرف ترتيب البدلاء. جزاكم الله خيرًا.`));
  return pending;
}

/** تذكير واحد بعد 30 دقيقة لمن ضغط «أعتذر» ولم يكتب السبب (يُستدعى من مجدول الإرسال). */
export async function remindPendingReasons() {
  await ensureMuezzinSchema();
  const rows = rowsOf(await db.execute(sql`
    UPDATE muezzin_duties SET reason_reminded = true
    WHERE response = 'apology_pending' AND reason_reminded = false AND replaced_by_duty_id IS NULL
      AND responded_at < now() - interval '30 minutes' AND responded_at > now() - interval '23 hours'
    RETURNING *`)).map(mapDuty);
  for (const d of rows) {
    if (!d.phone) continue;
    const text = `تذكير: لم يصلنا سبب اعتذاركم عن ${dutyText(d)}.\nفضلا اكتبه في رسالة هنا ليُسجَّل الاعتذار.`;
    const r = await sendMessage(d.phone, textMsg(text));
    await logEvent({ direction: "out", phone: d.phone, name: d.name, kind: "apology_reminder", text, dutyId: d.id, waId: r.wamid });
  }
  return rows.length;
}

async function onApologyReason(duty: Duty, from: string, reasonRaw: string, quiet = false) {
  const reason = param(reasonRaw).slice(0, 300);
  if (duty.replacedByDutyId) return;
  await db.execute(sql`UPDATE muezzin_duties SET response = 'apology', reason = ${reason}, responded_at = now() WHERE id = ${duty.id}`);
  if (!quiet) await sendMessage(from, textMsg(`تم تسجيل اعتذاركم عن ${dutyText(duty)}، وسيتولى المشرف ترتيب البديل. جزاكم الله خيرًا.`));

  const s = await getSettings();
  const sups = await supervisorTargets(duty.testMode);
  if (!sups.length || !s.meta.templates?.supApology) {
    await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nاعتذر ${duty.name} عن ${dutyText(duty)}\nالسبب: ${reason}\n(لم يُضبط رقم المشرف)`);
    return;
  }
  const params = [duty.name, dutyLabel(duty), roleLabel(duty), dayLabel(duty.dateKey), reason];
  for (const sup of sups) {
  const r = await sendMessage(sup, templatePayload(s.meta.templates.supApology, params, [
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `pick:${duty.id}` }] },
  ]));
  await logEvent({ direction: "out", phone: sup, name: "المشرف", kind: "supervisor_apology", text: fill(SUP_APOLOGY_TEXT, params), dutyId: duty.id, waId: r.wamid });
  if (!r.ok) await alertAdmins(`⚠️ <b>جدول المؤذنين</b>\nتعذّر تنبيه المشرف ${sup} باعتذار ${duty.name} عن ${dutyText(duty)}: ${r.detail}`);
  }
}

/** المشرف ضغط «اختيار البديل» ← قوائم واتساب (10 أسماء لكل قائمة، حد ميتا) بكل المؤذنين عدا المعتذر. */
async function onPickTap(duty: Duty, from: string) {
  if (duty.replacedByDutyId) {
    const sub = await getDuty(duty.replacedByDutyId);
    await sendMessage(from, textMsg(`سبق إسناد هذه المهمة إلى الشيخ ${sub?.name ?? ""}.`));
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
        body: { text: `اختر البديل عن الشيخ ${duty.name}\n${dutyText(duty)}${chunks.length > 1 ? `\n(القائمة ${n + 1} من ${chunks.length})` : ""}` },
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
  if (replyTo) await sendMessage(replyTo, textMsg(`تم إسناد ${dutyText(duty)} إلى الشيخ ${sub.name} بدلًا عن الشيخ ${duty.name}${note || "، وأُرسلت له رسالة المهمة"}.`));
  return { substitute: sub.name, note };
}

/** معالجة دفعة Webhook من ميتا. */
export async function handleWebhook(body: any) {
  await ensureMuezzinSchema();
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
