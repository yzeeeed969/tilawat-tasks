import translations from "@/locales/achievements.json";

// تعدّد اللغات لصفحة «منصات المشروع» (/achievements) فقط. النصوص من locales/achievements.json (21 لغة، نفس
// المفاتيح). العربية هي الافتراضية وهي أيضًا الاحتياط لأي مفتاح ناقص. المحتوى الديناميكي يبقى كما هو.

type TranslationFile = typeof translations;
export type AchLang = Exclude<keyof TranslationFile, "_meta">;
export type AchKey = keyof TranslationFile["ar"];

const DICT = translations as unknown as Record<AchLang, Record<AchKey, string>> & { _meta: { rtl: string[] } };

// ترتيب القائمة المنسدلة + اسم كل لغة بلغتها.
export const ACH_LANGS: Array<{ code: AchLang; label: string }> = [
  { code: "ar", label: "العربية" },
  { code: "en", label: "English" },
  { code: "ur", label: "اردو" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "tr", label: "Türkçe" },
  { code: "bn", label: "বাংলা" },
  { code: "fa", label: "فارسی" },
  { code: "hi", label: "हिन्दी" },
  { code: "ms", label: "Bahasa Melayu" },
  { code: "ha", label: "Hausa" },
  { code: "ru", label: "Русский" },
  { code: "sw", label: "Kiswahili" },
  { code: "de", label: "Deutsch" },
  { code: "zh", label: "中文" },
  { code: "am", label: "አማርኛ" },
  { code: "fil", label: "Filipino" },
  { code: "ne", label: "नेपाली" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "ko", label: "한국어" },
  { code: "so", label: "Soomaali" },
];
const CODES = new Set<string>(ACH_LANGS.map((lang) => lang.code));
const STORAGE_KEY = "achievements-lang";

export function isRtl(lang: AchLang) {
  return DICT._meta.rtl.includes(lang);
}

// النص بمفتاحه مع تعويض {n} و{name} و{charityName}. مفتاح ناقص ⇐ العربية.
export function translate(lang: AchLang, key: AchKey, vars: Record<string, string | number> = {}): string {
  const template = DICT[lang]?.[key] ?? DICT.ar[key] ?? key;
  const values: Record<string, string | number> = { charityName: DICT[lang]?.["footer.charityName"] ?? DICT.ar["footer.charityName"], ...vars };
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

// اختيار الزائر المحفوظ، وإلا لغة المتصفح إن كانت ضمن اللغات، وإلا العربية.
export function initialLang(): AchLang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && CODES.has(saved)) return saved as AchLang;
  } catch { /* ignore */ }
  const browser = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  const aliases: Record<string, AchLang> = { tl: "fil", in: "id", iw: "ar" };
  for (const tag of browser) {
    const base = String(tag || "").toLowerCase().split("-")[0];
    if (CODES.has(base)) return base as AchLang;
    if (aliases[base]) return aliases[base];
  }
  return "ar";
}

export function saveLang(lang: AchLang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
}

// منطقة التاريخ لكل لغة — مع أرقام لاتينية دائمًا (-u-nu-latn).
const DATE_LOCALES: Partial<Record<AchLang, string>> = { ar: "ar-SA", zh: "zh-CN", fil: "fil-PH" };
export function dateLocale(lang: AchLang) {
  return `${DATE_LOCALES[lang] ?? lang}-u-nu-latn`;
}

// الخطوط: El Messiri وReadex Pro للعربية واللاتينية، وخط Noto مناسب لكل سكربت آخر (يُحمَّل عند الحاجة فقط).
// تنزيل Google Fonts مقسّم بحسب نطاق الحروف، فالمتصفح لا ينزّل إلا ما تحتاجه الصفحة فعلًا.
const BASE_FONTS = "family=El+Messiri:wght@500;600;700&family=Readex+Pro:wght@300;400;500;600";
type FontPlan = { families?: string; display: string; body: string };
const LATIN_FALLBACK: FontPlan = {
  families: "family=Noto+Sans:wght@400;500;600;700",
  display: `"El Messiri", "Readex Pro", "Noto Sans", system-ui, sans-serif`,
  body: `"Readex Pro", "Noto Sans", system-ui, sans-serif`,
};
const scriptFont = (family: string, css: string): FontPlan => ({
  families: `family=${family}:wght@400;500;600;700`,
  display: `"${css}", "El Messiri", system-ui, sans-serif`,
  body: `"${css}", "Readex Pro", system-ui, sans-serif`,
});
const FONT_PLANS: Partial<Record<AchLang, FontPlan>> = {
  ar: { display: `"El Messiri", "Readex Pro", system-ui, sans-serif`, body: `"Readex Pro", system-ui, sans-serif` },
  ur: {
    families: "family=Noto+Sans+Arabic:wght@400;500;600;700",
    display: `"El Messiri", "Noto Sans Arabic", system-ui, sans-serif`,
    body: `"Readex Pro", "Noto Sans Arabic", system-ui, sans-serif`,
  },
  fa: {
    families: "family=Noto+Sans+Arabic:wght@400;500;600;700",
    display: `"El Messiri", "Noto Sans Arabic", system-ui, sans-serif`,
    body: `"Readex Pro", "Noto Sans Arabic", system-ui, sans-serif`,
  },
  bn: scriptFont("Noto+Sans+Bengali", "Noto Sans Bengali"),
  hi: scriptFont("Noto+Sans+Devanagari", "Noto Sans Devanagari"),
  ne: scriptFont("Noto+Sans+Devanagari", "Noto Sans Devanagari"),
  am: scriptFont("Noto+Sans+Ethiopic", "Noto Sans Ethiopic"),
  zh: scriptFont("Noto+Sans+SC", "Noto Sans SC"),
  ko: scriptFont("Noto+Sans+KR", "Noto Sans KR"),
};
export function fontPlan(lang: AchLang): { href: string; display: string; body: string } {
  const plan = FONT_PLANS[lang] ?? LATIN_FALLBACK;
  const families = [BASE_FONTS, plan.families].filter(Boolean).join("&");
  return { href: `https://fonts.googleapis.com/css2?${families}&display=swap`, display: plan.display, body: plan.body };
}
