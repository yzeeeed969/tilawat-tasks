// صفحة سياسة الخصوصية العامة (/privacy) لتطبيق Quran Views — HTML ثابت من الخادم مباشرة (يقرؤه مدقّق ميتا
// بلا JavaScript)، بلا تسجيل دخول. بريد التواصل قيمة واحدة يسهل تغييرها: متغيّر البيئة PRIVACY_CONTACT_EMAIL
// في Railway (وإلا القيمة المؤقتة أدناه).
const DEFAULT_CONTACT_EMAIL = "";
const LAST_UPDATED = "18 أكتوبر 2026";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function privacyPageHtml(): string {
  const email = (process.env.PRIVACY_CONTACT_EMAIL ?? DEFAULT_CONTACT_EMAIL).trim();
  const contact = email
    ? `<a href="mailto:${escapeHtml(email)}" dir="ltr">${escapeHtml(email)}</a>`
    : `<span class="muted">(سيُضاف بريد التواصل قريبًا)</span>`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>سياسة الخصوصية — Quran Views | تلاوات الحرمين</title>
<meta name="description" content="سياسة الخصوصية لتطبيق Quran Views التابع لمشروع تلاوات الحرمين.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=El+Messiri:wght@600;700&family=Readex+Pro:wght@400;500;600&display=swap">
<style>
  :root{--bg:#F6F1E7;--surface:#FFFDF8;--ink:#2A2620;--muted:#6F675A;--green:#0F5A46;--gold:#B88A2E;--line:#E8DFCD}
  @media (prefers-color-scheme: dark){:root{--bg:#0E1D18;--surface:#16302A;--ink:#F3EBDC;--muted:#BDB4A1;--green:#5DBE9A;--gold:#D6AE57;--line:#2B4A41}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Readex Pro",system-ui,sans-serif;line-height:1.8}
  header{background:linear-gradient(180deg,#0F5A46,#0a3f31);color:#F6F1E7;padding:34px 18px 30px}
  .wrap{max-width:760px;margin:0 auto;padding-inline:18px}
  header .wrap{padding-inline:0}
  h1{font-family:"El Messiri","Readex Pro",sans-serif;font-size:clamp(26px,5vw,36px);margin:0 0 6px}
  header p{margin:0;color:rgba(246,241,231,.85)}
  main{padding:26px 0 40px}
  section{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px}
  h2{font-family:"El Messiri","Readex Pro",sans-serif;font-size:20px;margin:0 0 8px;color:var(--green)}
  h2::before{content:"";display:inline-block;width:18px;height:2px;background:var(--gold);vertical-align:middle;margin-inline-end:8px}
  p,li{margin:0 0 6px}
  ul{margin:0;padding-inline-start:20px}
  a{color:var(--green);font-weight:600}
  .muted{color:var(--muted)}
  footer{text-align:center;color:var(--muted);font-size:13px;padding:0 18px 30px}
</style>
</head>
<body>
<header><div class="wrap">
  <h1>سياسة الخصوصية</h1>
  <p>تطبيق <b dir="ltr">Quran Views</b> — التابع لمشروع «تلاوات الحرمين»</p>
</div></header>
<main class="wrap">
  <section>
    <h2>عن التطبيق</h2>
    <p><b dir="ltr">Quran Views</b> تطبيق داخلي تابع لمشروع «تلاوات الحرمين»، يُستخدم لإدارة حسابات المشروع نفسه على فيسبوك وانستقرام: نشر مقاطع التلاوات، وعرض إحصاءات عامة عن هذه الحسابات.</p>
  </section>
  <section>
    <h2>البيانات التي يصل إليها التطبيق</h2>
    <ul>
      <li>صفحات فيسبوك وحسابات انستقرام للأعمال <b>التابعة للمشروع نفسه فقط</b>.</li>
      <li>نشر مقاطع التلاوات على هذه الصفحات والحسابات.</li>
      <li>قراءة عدد المتابعين والمشاهدات والمنشورات، لعرضها إحصاءاتٍ عامة عن المشروع.</li>
    </ul>
    <p class="muted">لا يجمع التطبيق بيانات شخصية عن متابعي هذه الحسابات أو زوّار الموقع.</p>
  </section>
  <section>
    <h2>نطاق الوصول</h2>
    <p>لا يصل التطبيق إلا إلى حسابات المشروع التي منحه مسؤولها الصلاحية صراحةً، ويمكن للمسؤول سحب هذه الصلاحية في أي وقت من إعدادات فيسبوك أو انستقرام.</p>
  </section>
  <section>
    <h2>استخدام البيانات ومشاركتها</h2>
    <p>لا تُباع أي بيانات، ولا تُشارك مع أي طرف ثالث، وتُستخدم فقط للأغراض المذكورة أعلاه. تُحفظ رموز الوصول مشفّرةً على خادم المشروع ولا تُعرض علنًا.</p>
  </section>
  <section>
    <h2>طلب حذف البيانات</h2>
    <p>لطلب حذف أي بيانات متعلقة بحسابك من التطبيق، راسلنا على البريد أدناه وسنحذفها في أقرب وقت.</p>
  </section>
  <section>
    <h2>التواصل</h2>
    <p>البريد الإلكتروني: ${contact}</p>
  </section>
</main>
<footer>آخر تحديث: ${LAST_UPDATED} · مشروع «تلاوات الحرمين»</footer>
</body>
</html>`;
}
