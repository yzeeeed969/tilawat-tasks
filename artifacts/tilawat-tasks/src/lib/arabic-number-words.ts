// تفقيط عربي للأعداد الصحيحة (كتابة العدد بالحروف) — بقواعد تمييز العدد:
//   1 ⇐ «مليون»، 2 ⇐ «مليونان»، 3–10 ⇐ «ثلاثة ملايين» (جمع مجرور)، 11–99 ⇐ «أحد عشر مليونًا» (مفرد منصوب)،
//   100/200/… بلا باقٍ ⇐ «مئة مليون»/«مئتا مليون» (مفرد مجرور بالإضافة).
// مثال: 227117540 ⇐ «مئتان وسبعة وعشرون مليونًا ومئة وسبعة عشر ألفًا وخمسمئة وأربعون».
// (جُرّبت مكتبة tafgeetjs فوجدت مخصّصة للعملة «فقط … ريال لا غير» وبصياغة «مائتين … مليون» المخالفة لهذا.)

const ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const TEENS = ["عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const HUNDREDS = ["", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"];

// الأسماء: [مفرد، مثنى، جمع، مفرد منصوب]
const SCALES: Array<[string, string, string, string]> = [
  ["", "", "", ""],
  ["ألف", "ألفان", "آلاف", "ألفًا"],
  ["مليون", "مليونان", "ملايين", "مليونًا"],
  ["مليار", "ملياران", "مليارات", "مليارًا"],
  ["تريليون", "تريليونان", "تريليونات", "تريليونًا"],
];

// 1–99 (صيغة العدّ المجرّد).
function belowHundred(n: number): string {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const ones = n % 10;
  const tens = TENS[Math.floor(n / 10)];
  return ones ? `${ONES[ones]} و${tens}` : tens;
}

// 1–999 بلا تمييز.
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!h) return belowHundred(rest);
  if (!rest) return HUNDREDS[h];
  return `${HUNDREDS[h]} و${belowHundred(rest)}`;
}

// مجموعة (1–999) مع اسمها (ألف/مليون/…) بقواعد التمييز.
function groupWithScale(n: number, scale: [string, string, string, string]): string {
  const [single, dual, plural, accusative] = scale;
  if (n === 1) return single;
  if (n === 2) return dual;
  if (n <= 10) return `${belowHundred(n)} ${plural}`;
  if (n < 100) return `${belowHundred(n)} ${accusative}`;
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!rest) return `${h === 2 ? "مئتا" : HUNDREDS[h]} ${single}`;
  // التمييز يتبع آخر جزء: 3–10 ⇐ جمع، وإلا ⇐ مفرد منصوب.
  return `${HUNDREDS[h]} و${belowHundred(rest)} ${rest >= 3 && rest <= 10 ? plural : accusative}`;
}

export function arabicNumberWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "صفر";
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  if (groups.length > SCALES.length) return n.toLocaleString("en-US");
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (!g) continue;
    parts.push(i === 0 ? belowThousand(g) : groupWithScale(g, SCALES[i]));
  }
  return parts.join(" و");
}
