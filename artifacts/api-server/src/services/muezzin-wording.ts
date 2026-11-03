// نصوص قوالب «جدول المؤذنين» ونماذج واتساب (Flows). الخيارات نفسها المعروضة على المدير للاختيار.
// المتغيرات في كل قوالب المهمة بالترتيب: {{1}} الاسم، {{2}} المهمة، {{3}} الدور، {{4}} اليوم والتاريخ.
// قالب البديل يضيف {{5}} اسم المعتذر، وتنبيه الاعتذار للمشرف يضيف {{5}} السبب.
// قواعد ميتا: لا يبدأ النص ولا ينتهي بمتغير، ولا متغيرين متجاورين، ونص الزر ≤ 25 حرفًا.

export type Wording = { duty: "a" | "b" | "c"; buttons: "a" | "b" | "c"; form: "a" | "b"; substitute: "a" | "b" };
export const DEFAULT_WORDING: Wording = { duty: "a", buttons: "a", form: "a", substitute: "b" };

export const DUTY_TEXT: Record<Wording["duty"], string> = {
  a: [
    "السلام عليكم ورحمة الله وبركاته",
    "فضيلة الشيخ {{1}}",
    "نفيدكم بتكليفكم بمهمة: {{2}} ({{3}})",
    "بالمسجد الحرام يوم {{4}}.",
    "نأمل التكرم بالتأكيد أو الاعتذار.",
    "وفقكم الله.",
  ].join("\n"),
  b: [
    "حياكم الله فضيلة الشيخ {{1}}",
    "تذكير بمهمتكم بإذن الله:",
    "🕌 {{2}} — {{3}}",
    "📅 {{4}}",
    "فضلًا اضغط «عُلم» للتأكيد، أو «أعتذر» مع ذكر السبب.",
    "جزاكم الله خيرًا.",
  ].join("\n"),
  c: [
    "فضيلة الشيخ {{1}}",
    "مهمتكم: {{2}} ({{3}})",
    "اليوم: {{4}}",
    "فضلًا أكّدوا أو اعتذروا.",
  ].join("\n"),
};

export const BUTTONS: Record<Wording["buttons"], [string, string]> = {
  a: ["عُلم", "أعتذر"],
  b: ["علم وسأحضر بإذن الله", "أعتذر عن المهمة"],
  c: ["✅ عُلم", "❌ أعتذر"],
};

export const FORM: Record<Wording["form"], { title: string; intro: string; label: string; submit: string }> = {
  a: { title: "الاعتذار عن المهمة", intro: "", label: "سبب الاعتذار", submit: "إرسال الاعتذار" },
  b: { title: "نقدّر ظرفكم", intro: "فضلًا اذكروا سبب الاعتذار ليتمكن المشرف من ترتيب البديل.", label: "السبب", submit: "إرسال" },
};

export const SUBSTITUTE_TEXT = [
  "السلام عليكم ورحمة الله وبركاته",
  "فضيلة الشيخ {{1}}",
  "نفيدكم بتكليفكم بمهمة: {{2}} ({{3}})",
  "بالمسجد الحرام يوم {{4}}، بديلًا عن الشيخ {{5}}.",
  "نأمل التكرم بالتأكيد أو الاعتذار.",
].join("\n");

export const SUP_ACK_TEXT = [
  "🔔 تنبيه المشرف",
  "أكّد الشيخ {{1}} مهمة: {{2}} ({{3}})",
  "يوم {{4}}.",
  "تم تسجيل التأكيد في جدول المؤذنين.",
].join("\n");

export const SUP_APOLOGY_TEXT = [
  "🔔 تنبيه المشرف",
  "اعتذر الشيخ {{1}} عن مهمة: {{2}} ({{3}})",
  "يوم {{4}}.",
  "السبب: {{5}}",
  "فضلًا اختر البديل من الزر أدناه.",
].join("\n");
export const SUP_APOLOGY_BUTTON = "اختيار البديل";

// أمثلة إلزامية عند إرسال القالب لميتا.
export const EXAMPLE = ["عبدالله باعفيف", "الأذان الأول للفجر", "مؤذن", "الخميس 2026-11-05"];

export function normalizeWording(input: any): Wording {
  const pick = <K extends keyof Wording>(k: K, allowed: readonly string[]) =>
    (allowed.includes(String(input?.[k])) ? String(input[k]) : DEFAULT_WORDING[k]) as Wording[K];
  return {
    duty: pick("duty", ["a", "b", "c"]),
    buttons: pick("buttons", ["a", "b", "c"]),
    form: pick("form", ["a", "b"]),
    substitute: pick("substitute", ["a", "b"]),
  };
}

/* ───────────── نماذج واتساب (Flow JSON) — ثابتة بلا خادم بيانات ───────────── */

export function apologyFlowJson(w: Wording) {
  const f = FORM[w.form];
  const children: any[] = [{ type: "TextSubheading", text: "${data.duty_text}" }];
  if (f.intro) children.push({ type: "TextBody", text: f.intro });
  children.push(
    { type: "TextArea", name: "reason", label: f.label, required: true, "max-length": 300 },
    { type: "Footer", label: f.submit, "on-click-action": { name: "complete", payload: { reason: "${form.reason}" } } },
  );
  return {
    version: "6.0",
    screens: [{
      id: "APOLOGY",
      title: f.title,
      terminal: true,
      success: true,
      data: { duty_text: { type: "string", __example__: "الأذان الأول للفجر (مؤذن) — الخميس 2026-11-05" } },
      layout: { type: "SingleColumnLayout", children },
    }],
  };
}

export function substituteFlowJson() {
  return {
    version: "6.0",
    screens: [{
      id: "PICK",
      title: "اختيار البديل",
      terminal: true,
      success: true,
      data: {
        duty_text: { type: "string", __example__: "الأذان الأول للفجر (مؤذن) — الخميس 2026-11-05" },
        muezzins: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
          __example__: [{ id: "1", title: "أحمد نحاس" }],
        },
      },
      layout: {
        type: "SingleColumnLayout",
        children: [
          { type: "TextSubheading", text: "${data.duty_text}" },
          { type: "Dropdown", name: "substitute", label: "المؤذن البديل", required: true, "data-source": "${data.muezzins}" },
          { type: "Footer", label: "إسناد المهمة", "on-click-action": { name: "complete", payload: { substitute: "${form.substitute}" } } },
        ],
      },
    }],
  };
}
