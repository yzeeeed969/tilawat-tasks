/**
 * تجربة حيّة لصيغ الرسائل الجديدة (قبل اعتمادها): تصل لرقم التجربة فقط كرسائل تفاعلية
 * (لا قوالب)، فلا تحتاج موافقة ميتا، لكنها تحتاج أن يكون جوال التجربة راسل رقم الإرسال خلال 24 ساعة.
 * لا تمس الجدول ولا المهام ولا المشرفين الحقيقيين — كل شيء يصل لنفس رقم التجربة.
 */
import { MuezzinError, getSettings, listMuezzins, addDays } from "./muezzin";
import { riyadhDayKey } from "../lib/hijri";
import { gregorianDate, hijriDate, weekdayName } from "./muezzin-wording";

type Send = (to: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>;
const text = (body: string) => ({ type: "text", text: { body } });
const btn = (id: string, title: string) => ({ type: "reply", reply: { id, title: title.slice(0, 20) } });
const buttons = (body: string, list: Array<ReturnType<typeof btn>>) => ({ type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: list } } });

// حالة التجربة لكل رقم (في الذاكرة — تكفي للتجربة).
const state = new Map<string, { stage: "reason" | null; original: string; sub?: string }>();

const SIM_NAME = "يزيد";
const ORIGINAL_SUB_FOR = "يزيد";

function ctx() {
  const d = addDays(riyadhDayKey(new Date()), 1);
  return { day: weekdayName(d), h: hijriDate(d), g: gregorianDate(d) };
}

// ── الصيغ الجديدة (مسودة المشرف) ──
const T = {
  duty: (name: string, task: string) => {
    const c = ctx();
    return `فضيلة الشيخ : ( ${name} )\n\n⏰ نود تذكيرك بأن لديك :\n${task}\n\n🗓️ يوم : ( ${c.day} )\n${c.h} هـ\n${c.g} م\n\nفضلاً اختر عُلم أو أعتذر`;
  },
  sub: (name: string, task: string, original: string) => {
    const c = ctx();
    return `فضيلة الشيخ : ( ${name} )\n\n🔴 نود تذكيرك بأن لديك :\n${task}\nبديلًا عن الشيخ ( ${original} )\n\n🗓️ يوم : ( ${c.day} )\n${c.h} هـ\n${c.g} م\n\nفضلاً اختر عُلم أو أعتذر`;
  },
  ackSelf: (task: string) => {
    const c = ctx();
    return `تم تسجيل تأكيدك بمهمة :\n${task}\nيوم ${c.day}\n${c.h} هـ\n${c.g} م\n\nجزاك الله خيرا ..`;
  },
  supAck: (icon: string, name: string, task: string) => {
    const c = ctx();
    return `🔔 تنبيه المشرف :\n\n${icon} أكّد الشيخ ${name} مهمة :\n${task}\nيوم ${c.day} ${c.h} هـ\n${c.g} م .\n\nتم تسجيل التأكيد في جدول المؤذنين ..`;
  },
  supApology: (name: string, task: string, reason: string) => {
    const c = ctx();
    return `🔔 تنبيه المشرف :\n\n⛔️ اعتذر الشيخ ${name} عن مهمة :\n${task}\nيوم ${c.day} ${c.h} هـ\n${c.g} م .\n\nالسبب : ( ${reason} )\n\nفضلًا اختر البديل من الزر أدناه .`;
  },
};
const SEP = (who: string) => text(`━━━━━━━━━━━━\n👇 تجربة: هذا ما يصل ${who}`);

export async function startSim(send: Send) {
  const s = await getSettings();
  const to = s.testPhone;
  if (!to) throw new MuezzinError(400, "أضف رقم التجربة أولًا");
  state.set(to, { stage: null, original: SIM_NAME });
  const r = await send(to, buttons(T.duty(SIM_NAME, "( صلاة الظهر )"), [btn("sim:ack", "عُلم"), btn("sim:apol", "أعتذر")]));
  if (!r.ok && /131047|24 hours|re-engage/i.test(r.detail)) {
    throw new MuezzinError(400, "أرسل أولًا أي رسالة (مثل «السلام عليكم») من جوالك إلى رقم الإرسال 0557578627، ثم أعد المحاولة.");
  }
  if (!r.ok) throw new MuezzinError(400, `تعذّر الإرسال: ${r.detail}`);
  return { to };
}

/** يعالج ضغطات التجربة (معرّفات تبدأ بـ sim:) ونص السبب. يرجع true إن عالجها. */
export async function handleSim(from: string, id: string | null, body: string | null, send: Send): Promise<boolean> {
  const st = state.get(from);
  if (id === null) {
    if (!st || st.stage !== "reason" || !body?.trim()) return false;
    st.stage = null;
    await send(from, text(`تم تسجيل اعتذاركم عن مهمة صلاة الظهر ( مؤذن ) يوم ${ctx().day}، وسيتولى المشرف ترتيب البديل. جزاكم الله خيرًا.`));
    await send(from, SEP("المشرف"));
    await send(from, buttons(T.supApology(st.original, "صلاة الظهر ( مؤذن )", body.trim().slice(0, 200)), [btn("sim:pick", "اختيار البديل")]));
    return true;
  }
  if (!id.startsWith("sim:")) return false;
  const s = st ?? { stage: null, original: SIM_NAME };
  state.set(from, s);
  const [, kind, extra] = id.split(":");
  if (kind === "ack") {
    await send(from, text(T.ackSelf("صلاة الظهر ( مؤذن )")));
    await send(from, SEP("المشرف"));
    await send(from, text(T.supAck("✅", SIM_NAME, "صلاة الظهر ( مؤذن )")));
    await send(from, text("✔️ انتهت التجربة. لتجربة الاعتذار والبديل اضغط «أعتذر» في رسالة المهمة أعلاه."));
  } else if (kind === "apol") {
    s.stage = "reason";
    await send(from, text(`فضلا اكتب سبب الاعتذار عن مهمة صلاة الظهر ( مؤذن ) يوم ${ctx().day} في رسالة هنا.\nلن يُسجَّل الاعتذار إلا بعد وصول السبب.`));
  } else if (kind === "pick") {
    const ms = (await listMuezzins()).filter((m) => m.isActive).slice(0, 10);
    await send(from, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: `اختر البديل عن الشيخ ${s.original}\nصلاة الظهر ( مؤذن ) — يوم ${ctx().day}` },
        action: { button: "قائمة المؤذنين", sections: [{ title: "المؤذنون", rows: ms.map((m) => ({ id: `sim:sub:${m.id}`, title: m.name.slice(0, 24) })) }] },
      },
    });
  } else if (kind === "sub") {
    const m = (await listMuezzins()).find((x) => x.id === Number(extra));
    s.sub = m?.name ?? "البديل";
    await send(from, text(`تم إسناد مهمة صلاة الظهر ( مؤذن ) يوم ${ctx().day} إلى الشيخ ${s.sub} بدلًا عن الشيخ ${s.original}، وأُرسلت له رسالة المهمة.`));
    await send(from, SEP(`البديل (الشيخ ${s.sub})`));
    await send(from, buttons(T.sub(s.sub, "( مؤذن / طارئ ) لصلاة الظهر", s.original), [btn("sim:sack", "عُلم"), btn("sim:sapol", "أعتذر")]));
  } else if (kind === "sack") {
    await send(from, text(T.ackSelf("صلاة الظهر ( مؤذن / طارئ )")));
    await send(from, SEP("المشرف"));
    await send(from, text(T.supAck("🔴✅", s.sub ?? "البديل", "صلاة الظهر ( مؤذن / طارئ )")));
    await send(from, text("✔️ انتهت التجربة كاملة."));
  } else if (kind === "sapol") {
    await send(from, text("في الحقيقة: يُطلب من البديل السبب، ويصل المشرف تنبيه الاعتذار ليختار بديلًا آخر — كما جرّبت أعلاه.\n✔️ انتهت التجربة."));
  }
  return true;
}

void ORIGINAL_SUB_FOR;
