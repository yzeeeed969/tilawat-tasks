/**
 * المصدر الواحد لكل نصوص رسائل جدول المؤذنين — يرسل منه النظام، ويعرض منه «محاكي الرسائل».
 * أي تعديل هنا يظهر في الرسائل الفعلية وفي المحاكي معًا.
 *
 * نسختان:
 * - "live"  : ما يُرسل الآن فعلًا (مطابق للقوالب المعتمدة من ميتا).
 * - "draft" : صياغة المشرف المقترحة — تُعرض في المحاكي فقط حتى تُعتمد.
 */
import { SLOT_MESSAGE, ROLE_LABEL, currentTextVersion, type Role, type Slot } from "./muezzin";
import { DUTY_TEXT, SUBSTITUTE_TEXT_D, SUP_ACK_TEXT, SUP_APOLOGY_TEXT, fullDayLabel, gregorianDate, hijriDate, taskD, weekdayName } from "./muezzin-wording";

export type MsgVersion = "live" | "draft";
/** النسخة المستعملة الآن في الإرسال — تتحول إلى "draft" تلقائيًا عند اعتماد ميتا لقوالب صياغة المشرف. */
export const activeVersion = (): MsgVersion => currentTextVersion();

export type MsgCtx = {
  name: string;
  slot: Slot;
  role: Role;
  dateKey: string;
  /** اسم المؤذن الأصلي إن كانت هذه مهمة بديل (طارئ). */
  original?: string | null;
};

export type Template = { text: string; params: string[] };

const fill = (text: string, values: string[]) => text.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? "");

/* ───────── المسودة (صياغة المشرف) ───────── */

// اسم المهمة بصيغة «صلاة ...» — وللفجر والجمعة أذانان.
const PRAYER: Record<Slot, string> = {
  fajr1: "الأذان الأول لصلاة الفجر", fajr2: "الأذان الثاني لصلاة الفجر", dhuhr: "صلاة الظهر", asr: "صلاة العصر",
  maghrib: "صلاة المغرب", isha: "صلاة العشاء", jumuah1: "الأذان الأول لصلاة الجمعة", jumuah2: "الأذان الثاني لصلاة الجمعة",
};
// بصيغة «لـ...» بعد الدور: «( ملازم / طارئ ) لصلاة العصر».
const PRAYER_LI: Record<Slot, string> = {
  fajr1: "للأذان الأول لصلاة الفجر", fajr2: "للأذان الثاني لصلاة الفجر", dhuhr: "لصلاة الظهر", asr: "لصلاة العصر",
  maghrib: "لصلاة المغرب", isha: "لصلاة العشاء", jumuah1: "للأذان الأول لصلاة الجمعة", jumuah2: "للأذان الثاني لصلاة الجمعة",
};
const roleD = (c: MsgCtx) => `${ROLE_LABEL[c.role]}${c.original ? " / طارئ" : ""}`;
/** «صلاة العصر ( ملازم / طارئ )» */
const taskLine = (c: MsgCtx) => `${PRAYER[c.slot]} ( ${roleD(c)} )`;
/** سطور التاريخ: «يوم الاثنين\n06 / 06 / 1448 هـ\n16 / 11 / 2026 م» */
const dayBlock = (dateKey: string) => `يوم ${weekdayName(dateKey)}\n${hijriDate(dateKey)} هـ\n${gregorianDate(dateKey)} م`;

const DRAFT_DUTY_TEXT = DUTY_TEXT.d; // نص القالب نفسه — يتغير سطر المهمة فقط (متغير)، فلا يحتاج اعتمادًا جديدًا.
const DRAFT_SUB_TEXT = [
  "فضيلة الشيخ : ( {{1}} )", "", "🔴 نود تذكيرك بأن لديك :", "{{2}}", "بديلًا عن الشيخ ( {{3}} )", "",
  "🗓️ يوم : ( {{4}} )", "{{5}} هـ", "{{6}} م", "", "فضلاً اختر عُلم أو أعتذر",
].join("\n");
const DRAFT_SUP_ACK_TEXT = [
  "🔔 تنبيه المشرف :", "", "{{1}} أكّد الشيخ {{2}} مهمة :", "{{3}}", "يوم {{4}} هـ", "{{5}} م .", "", "تم تسجيل التأكيد في جدول المؤذنين ..",
].join("\n");
const DRAFT_SUP_APOLOGY_TEXT = [
  "🔔 تنبيه المشرف :", "", "⛔️ اعتذر الشيخ {{1}} عن مهمة :", "{{2}}", "يوم {{3}} هـ", "{{4}} م .", "", "السبب : ( {{5}} )", "", "فضلًا اختر البديل من الزر أدناه .",
].join("\n");

/* ───────── الحالية (المعتمدة) ───────── */

const liveTask = (c: MsgCtx) => `${SLOT_MESSAGE[c.slot]} (${ROLE_LABEL[c.role]})`;
const liveDutyText = (c: MsgCtx) => `${liveTask(c)} — ${fullDayLabel(c.dateKey)}`;

// تذكير من لم يرد — بأسلوب المشرف، وبنفس زرّي رسالة المهمة.
export const REMIND_TEXT = [
  "فضيلة الشيخ : ( {{1}} )", "", "🔔 تذكير : لم يصلنا ردك على مهمة :", "{{2}}", "",
  "🗓️ يوم : ( {{3}} )", "{{4}} هـ", "{{5}} م", "", "فضلاً اختر عُلم أو أعتذر",
].join("\n");
/** نصوص قوالب صياغة المشرف (تُرسل لميتا عند الاعتماد). */
export const DRAFT_TEMPLATES = { substitute: DRAFT_SUB_TEXT, supAck: DRAFT_SUP_ACK_TEXT, supApology: DRAFT_SUP_APOLOGY_TEXT, remind: REMIND_TEXT };

export function messages(v: MsgVersion = activeVersion()) {
  const draft = v === "draft";
  return {
    version: v,

    /* قوالب ميتا (نص القالب + المتغيرات) */
    duty(c: MsgCtx): Template {
      if (c.original) {
        const text = draft ? DRAFT_SUB_TEXT : SUBSTITUTE_TEXT_D;
        const task = draft ? `( ${roleD(c)} ) ${PRAYER_LI[c.slot]}` : taskD({ ...c, original: c.original ?? undefined });
        return { text, params: [c.name, task, c.original, weekdayName(c.dateKey), hijriDate(c.dateKey), gregorianDate(c.dateKey)] };
      }
      const task = draft ? `( ${roleD(c)} ) ${PRAYER_LI[c.slot]}` : taskD({ ...c, original: c.original ?? undefined });
      return { text: draft ? DRAFT_DUTY_TEXT : DUTY_TEXT.d, params: [c.name, task, weekdayName(c.dateKey), hijriDate(c.dateKey), gregorianDate(c.dateKey)] };
    },
    supAck(c: MsgCtx): Template {
      if (draft) return { text: DRAFT_SUP_ACK_TEXT, params: [c.original ? "🔴✅" : "✅", c.name, taskLine(c), `${weekdayName(c.dateKey)} ${hijriDate(c.dateKey)}`, gregorianDate(c.dateKey)] };
      return { text: SUP_ACK_TEXT, params: [c.name, SLOT_MESSAGE[c.slot], ROLE_LABEL[c.role], fullDayLabel(c.dateKey)] };
    },
    supApology(c: MsgCtx, reason: string): Template {
      if (draft) return { text: DRAFT_SUP_APOLOGY_TEXT, params: [c.name, taskLine(c), `${weekdayName(c.dateKey)} ${hijriDate(c.dateKey)}`, gregorianDate(c.dateKey), reason] };
      return { text: SUP_APOLOGY_TEXT, params: [c.name, SLOT_MESSAGE[c.slot], ROLE_LABEL[c.role], fullDayLabel(c.dateKey), reason] };
    },

    /** تذكير من لم يرد (قالب واحد بأسلوب المشرف). */
    reminder(c: MsgCtx): Template {
      return { text: REMIND_TEXT, params: [c.name, `( ${roleD(c)} ) ${PRAYER_LI[c.slot]}`, weekdayName(c.dateKey), hijriDate(c.dateKey), gregorianDate(c.dateKey)] };
    },

    /* رسائل نصية (لا تحتاج اعتماد ميتا) — للمؤذن */
    ackReply: (c: MsgCtx) => draft
      ? `تم تسجيل تأكيدك بمهمة :\n${taskLine(c)}\n${dayBlock(c.dateKey)}\n\nجزاك الله خيرا ..`
      : `تم تسجيل علمكم بمهمة ${SLOT_MESSAGE[c.slot]} (${ROLE_LABEL[c.role]}) يوم ${fullDayLabel(c.dateKey)}. جزاكم الله خيرًا.`,
    apologyPrompt: (c: MsgCtx) => draft
      ? `فضلًا اكتب سبب اعتذارك عن مهمة :\n${taskLine(c)}\n${dayBlock(c.dateKey)}\n\nفي رسالة هنا ، ولن يُسجَّل الاعتذار إلا بعد وصول السبب .`
      : `فضلا اكتب سبب الاعتذار عن ${liveDutyText(c)} في رسالة هنا.\nلن يُسجَّل الاعتذار إلا بعد وصول السبب.`,
    reasonReminder: (c: MsgCtx) => draft
      ? `⏳ تذكير :\nلم يصلنا سبب اعتذارك عن مهمة :\n${taskLine(c)}\n${dayBlock(c.dateKey)}\n\nفضلًا اكتبه في رسالة هنا ليُسجَّل الاعتذار .`
      : `تذكير: لم يصلنا سبب اعتذاركم عن ${liveDutyText(c)}.\nفضلا اكتبه في رسالة هنا ليُسجَّل الاعتذار.`,
    apologyRecorded: (c: MsgCtx) => {
      const reserve = c.role === "reserve";
      return draft
        ? `تم تسجيل اعتذارك عن مهمة :\n${taskLine(c)}\n${dayBlock(c.dateKey)}\n\n${reserve ? "" : "وسيتولى المشرف ترتيب البديل . "}جزاك الله خيرا ..`
        : `تم تسجيل اعتذاركم عن ${liveDutyText(c)}${reserve ? "" : "، وسيتولى المشرف ترتيب البديل"}. جزاكم الله خيرًا.`;
    },
    apologyRecordedMulti: (n: number) => draft
      ? `تم تسجيل اعتذارك عن ${n} مهام ، وسيتولى المشرف ترتيب البدلاء . جزاك الله خيرا ..`
      : `تم تسجيل اعتذاركم عن ${n} مهام، وسيتولى المشرف ترتيب البدلاء. جزاكم الله خيرًا.`,
    alreadyApologized: (c: MsgCtx) => draft
      ? `سبق تسجيل اعتذارك عن مهمة :\n${taskLine(c)}\n\nوالمشرف يرتّب البديل . جزاك الله خيرا ..`
      : `سبق تسجيل اعتذاركم عن ${liveDutyText(c)}، والمشرف يرتّب البديل. جزاكم الله خيرًا.`,
    replacedAfterApology: () => draft ? "أُسندت هذه المهمة لغيرك بعد اعتذارك . جزاك الله خيرا .." : "أُسندت هذه المهمة لغيركم بعد اعتذاركم. جزاكم الله خيرًا.",
    replacedOnApologyTap: () => draft ? "سبق تسجيل اعتذارك وأُسندت المهمة لغيرك . جزاك الله خيرا .." : "سبق تسجيل اعتذاركم وأُسندت المهمة لغيركم. جزاكم الله خيرًا.",

    /* رسائل نصية — للمشرف */
    pickListHeader: (c: MsgCtx, n: number, total: number) => {
      const part = total > 1 ? `\n(القائمة ${n} من ${total})` : "";
      return draft
        ? `اختر البديل عن الشيخ ( ${c.name} ) لمهمة :\n${taskLine(c)}\n${dayBlock(c.dateKey)}${part}`
        : `اختر البديل عن الشيخ ${c.name}\n${liveDutyText(c)}${part}`;
    },
    assigned: (c: MsgCtx, sub: string, note = "") => draft
      ? `✅ تم إسناد مهمة :\n${taskLine({ ...c, original: null })}\n${dayBlock(c.dateKey)}\n\nإلى الشيخ ( ${sub} ) بدلًا عن الشيخ ( ${c.name} )${note || " ، وأُرسلت له رسالة المهمة"} .`
      : `تم إسناد ${liveDutyText(c)} إلى الشيخ ${sub} بدلًا عن الشيخ ${c.name}${note || "، وأُرسلت له رسالة المهمة"}.`,
    alreadyAssigned: (sub: string) => draft ? `سبق إسناد هذه المهمة إلى الشيخ ( ${sub} ) .` : `سبق إسناد هذه المهمة إلى الشيخ ${sub}.`,
    reservePick: (c: MsgCtx) => draft
      ? `هذا اعتذار عن مهمة احتياطي :\n${taskLine(c)}\n\nلا يلزم اختيار بديل ، ويمكن إضافة احتياطي آخر من الموقع .`
      : `هذا اعتذار عن مهمة احتياطي (${liveDutyText(c)}) — لا يلزم اختيار بديل. ويمكن إضافة احتياطي آخر من الموقع.`,
  };
}

export type Messages = ReturnType<typeof messages>;

/** كل نصوص سيناريو واحد جاهزة للعرض (للمحاكي). */
export function simulatorBundle(v: MsgVersion, c: MsgCtx, reason: string, substitute: string) {
  const m = messages(v);
  const sub: MsgCtx = { ...c, name: substitute, original: c.name };
  const t = (x: Template) => fill(x.text, x.params);
  return {
    version: v,
    main: {
      duty: t(m.duty(c)), reminder: t(m.reminder(c)), ackReply: m.ackReply(c), apologyPrompt: m.apologyPrompt(c), reasonReminder: m.reasonReminder(c),
      apologyRecorded: m.apologyRecorded(c), alreadyApologized: m.alreadyApologized(c), replacedAfterApology: m.replacedAfterApology(),
      supAck: t(m.supAck(c)), supApology: t(m.supApology(c, reason || "—")),
      pickListHeader: m.pickListHeader(c, 1, 3), assigned: m.assigned(c, substitute), alreadyAssigned: m.alreadyAssigned(substitute), reservePick: m.reservePick(c),
    },
    sub: {
      duty: t(m.duty(sub)), reminder: t(m.reminder(sub)), ackReply: m.ackReply(sub), apologyPrompt: m.apologyPrompt(sub), apologyRecorded: m.apologyRecorded(sub),
      supAck: t(m.supAck(sub)), supApology: t(m.supApology(sub, reason || "—")),
    },
  };
}
