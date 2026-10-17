import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { arabicNumberWords } from "@/lib/arabic-number-words";
import { ACH_LANGS, dateLocale, fontPlan, initialLang, isRtl, saveLang, translate, type AchKey, type AchLang } from "@/lib/achievements-i18n";

// صفحة «منصات مشروع تطبيق تلاوات الحرمين» (/achievements) — عامة.
// نفس ألوان وخطوط التصميم المعتمد (manassatna.html)، بعرض مضغوط: «حصيلة المشروع» صندوق لكل منصة، باركود
// التطبيق، والمنصات صفوف مطوية قابلة للتوسيع، و«أحدث ما نشرنا» منسدلة. البيانات حيّة من /api/public/showcase.
// الأنماط محصورة تحت ‎.manassat‎ فلا تمس بقية الموقع.

type Clip = { title: string; views: number | null; url: string; thumbnail: string | null; publishedAt: string | null };
type Account = { name: string; url: string | null; followers: number | null; posts: number | null };
type Reel = { account: string; url: string; thumbnail: string | null; publishedAt: string | null; views?: number | null };
type Showcase = {
  generatedAt: string;
  hero: { youtubeViews: number; youtubeSubscribers: number; appsCount: number };
  totals?: { youtubeVideos: number; totalPosts: number; accounts: number; teamClips: number };
  featured: (Clip & { channelTitle: string }) | null;
  youtube: Array<{ channelId: string; title: string; url: string; avatar: string | null; subscribers: number | null; views: number | null; videos?: number | null; clips: Clip[] }>;
  apps: Array<{ name: string; iosUrl: string | null; androidUrl: string | null; avatar: string | null }>;
  platforms: {
    instagram: { accounts: Account[]; reels: Reel[] };
    facebook: { accounts: Account[]; reels: Reel[] };
    telegram: { accounts: Account[] };
    twitter: { accounts: Account[] };
  };
  designs: { items: Array<{ url: string; publishedAt: string }>; channel: { name: string; url: string | null; subscribers: number | null } | null };
  feed: Array<{ platform: "youtube" | "instagram" | "facebook" | "telegram" | "designs"; title: string; kind?: "clip" | "recitation" | "design"; name?: string; url: string; publishedAt: string }>;
};

type T = (key: AchKey, vars?: Record<string, string | number>) => string;

// النمط الليلي: اختيار الزائر المحفوظ، وإلا نظام الجهاز (prefers-color-scheme).
type Theme = "light" | "dark";
const THEME_KEY = "achievements-theme";
function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}
function initialTheme(): Theme {
  const saved = savedTheme();
  if (saved) return saved;
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

// كل الأرقام بالأرقام اللاتينية مع فواصل الآلاف (227,117,540).
const ar = (n: number) => Math.round(n).toLocaleString("en-US");
// الرقم كاملًا بفواصل الآلاف (بلا اختصار «ألف/مليون»).
function compact(n: number | null | undefined): string | null {
  return n == null ? null : ar(n);
}
// الوقت النسبي بلغة الصفحة؛ الأقدم من 10 أيام ⇐ تاريخ منسّق بلغة الصفحة (بأرقام لاتينية).
function ago(iso: string | null, t: T, lang: AchLang): string {
  if (!iso) return "";
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return t("time.justNow");
  if (hours < 24) { const h = Math.floor(hours); return h === 1 ? t("time.hourAgo") : h === 2 ? t("time.twoHoursAgo") : t("time.hoursAgo", { n: ar(h) }); }
  const days = Math.floor(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days === 2) return t("time.twoDaysAgo");
  if (days <= 10) return t("time.daysAgo", { n: ar(days) });
  return new Date(iso).toLocaleDateString(dateLocale(lang), { timeZone: "Asia/Riyadh", day: "numeric", month: "long" });
}
const firstLetter = (name: string) => name.replace(/^(تطبيق|تلاوات|الشيخ)\s+/g, "").replace(/^(الشيخ)\s+/, "").trim().charAt(0) || "ت";

const PlayIcon = ({ size = 18, fill = "#0F5A46" }: { size?: number; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}><path d="M8 5v14l11-7z" /></svg>
);
const ICONS = {
  youtube: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23 12s0-3.3-.4-4.9a2.6 2.6 0 00-1.8-1.8C19.2 5 12 5 12 5s-7.2 0-8.8.4A2.6 2.6 0 001.4 7.2C1 8.7 1 12 1 12s0 3.3.4 4.8a2.6 2.6 0 001.8 1.8C4.8 19 12 19 12 19s7.2 0 8.8-.4a2.6 2.6 0 001.8-1.8c.4-1.5.4-4.8.4-4.8zM9.8 15.2V8.8l5.6 3.2z" /></svg>,
  apps: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="3" /><line x1="12" y1="18" x2="12" y2="18" /></svg>,
  platforms: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>,
  feed: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h10" /></svg>,
  ig: (s = 19) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="#fff" stroke="none" /></svg>,
  fb: (s = 19) => <svg width={s} height={s} viewBox="0 0 24 24" fill="#fff"><path d="M14 9h3V6h-3c-1.9 0-3 1.4-3 3.3V11H9v3h2v6h3v-6h2.3l.7-3H14V9.6c0-.4.3-.6.8-.6z" /></svg>,
  tg: (s = 19) => <svg width={s} height={s} viewBox="0 0 24 24" fill="#fff"><path d="M21 4L3 11l5 2 2 6 3-4 5 4z" /></svg>,
  tw: (s = 17) => <svg width={s} height={s} viewBox="0 0 24 24" fill="#fff"><path d="M18 2h3l-7 8 8 12h-6l-5-7-6 7H2l8-9L1 2h6l4 6z" /></svg>,
  ds: (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 2l2.5 6.5L21 9l-5 4 1.5 7L12 16l-5.5 4L8 13 3 9l6.5-.5z" /></svg>,
  appsWhite: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="3" /><line x1="12" y1="18" x2="12" y2="18" /></svg>,
  ytWhite: <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M23 12s0-3.3-.4-4.9a2.6 2.6 0 00-1.8-1.8C19.2 5 12 5 12 5s-7.2 0-8.8.4A2.6 2.6 0 001.4 7.2C1 8.7 1 12 1 12s0 3.3.4 4.8a2.6 2.6 0 001.8 1.8C4.8 19 12 19 12 19s7.2 0 8.8-.4a2.6 2.6 0 001.8-1.8c.4-1.5.4-4.8.4-4.8zM9.8 15.2V8.8l5.6 3.2z" /></svg>,
  image: <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>,
};
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#C1121F,#8E0E17)",
  "linear-gradient(135deg,#0F5A46,#13715C)",
  "linear-gradient(135deg,#B88A2E,#946d1f)",
  "linear-gradient(135deg,#3B2E6E,#2a2150)",
  "linear-gradient(135deg,#1f6b57,#0c4a3a)",
];

// رابط خارجي: يفتح في نافذة جديدة؛ بلا رابط ⇐ نفس الوسم بلا href (كما في التصميم).
function Ext({ href, className, style, children }: { href: string | null | undefined; className?: string; style?: React.CSSProperties; children: ReactNode }) {
  return href
    ? <a className={className} style={style} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span className={className} style={style}>{children}</span>;
}

function ReelsRow({ reels, fb, t, lang }: { reels: Reel[]; fb?: boolean; t: T; lang: AchLang }) {
  return (
    <div className="ig-reels">
      {reels.map((reel) => (
        <Ext key={reel.url} href={reel.url} className={`reel${fb ? " fb" : ""}`}>
          {reel.thumbnail && <img className="rimg" src={reel.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          <div className="rplay"><i><PlayIcon size={17} fill={fb ? "#1877F2" : "#8134AF"} /></i></div>
          <div className="rinfo"><b><bdi>{reel.account}</bdi></b><span className="mono-num">{reel.views != null ? `${t("unit.views", { n: compact(reel.views)! })} · ${ago(reel.publishedAt, t, lang)}` : ago(reel.publishedAt, t, lang)}</span></div>
        </Ext>
      ))}
    </div>
  );
}

const FEED_META: Record<Showcase["feed"][number]["platform"], { label: AchKey; cls: string; style?: React.CSSProperties; icon: ReactNode }> = {
  youtube: { label: "platform.youtube", cls: "c-fb", style: { background: "#C1121F" }, icon: ICONS.ytWhite },
  instagram: { label: "platform.instagram", cls: "c-ig", icon: ICONS.ig(17) },
  facebook: { label: "platform.facebook", cls: "c-fb", icon: ICONS.fb(17) },
  telegram: { label: "platform.telegram", cls: "c-tg", icon: ICONS.tg(17) },
  designs: { label: "platform.designs", cls: "c-ds", icon: ICONS.ds(17) },
};

// عنوان عنصر «أحدث ما نشرنا»: العنوان الحقيقي كما هو، وإلا الجملة من الترجمة حسب نوع المنشور.
function feedTitle(item: Showcase["feed"][number], t: T): string {
  if (item.kind === "clip") return t("feed.newClip", { name: item.name ?? "" });
  if (item.kind === "recitation") return [t("feed.newRecitation"), item.name].filter(Boolean).join(" — ");
  if (item.kind === "design") return t("feed.newDesign");
  return item.title;
}

export default function Achievements() {
  const { data, isError } = useQuery({
    queryKey: ["public-showcase"],
    queryFn: async () => {
      const res = await fetch("/api/public/showcase");
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as Showcase;
    },
    staleTime: 5 * 60 * 1000,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useState<AchLang>(initialLang);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [themeChosen, setThemeChosen] = useState<boolean>(() => savedTheme() !== null);
  // بلا اختيار يدوي: يتبع نظام الجهاز حتى لو تغيّر أثناء التصفّح.
  useEffect(() => {
    if (themeChosen || typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(media.matches ? "dark" : "light");
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [themeChosen]);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeChosen(true);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  };
  const t: T = (key, vars) => translate(lang, key, vars);
  const rtl = isRtl(lang);
  const fonts = fontPlan(lang);

  const chooseLang = (next: AchLang) => {
    setLang(next);
    saveLang(next);
  };

  // الخطوط (حسب اللغة) — رابط واحد يُحدَّث عند تغيير اللغة.
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = fonts.href;
    document.head.appendChild(link);
    return () => { link.remove(); };
  }, [fonts.href]);

  // عنوان التبويب بلغة الصفحة، ويُعاد العنوان السابق عند المغادرة.
  useEffect(() => {
    const previousTitle = document.title;
    return () => { document.title = previousTitle; };
  }, []);
  useEffect(() => {
    document.title = translate(lang, "page.title");
  }, [lang]);

  // العدّادات المتحرّكة (نفس نص التصميم): تبدأ عند ظهورها، مع احترام تقليل الحركة.
  useEffect(() => {
    if (!data || !rootRef.current) return;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];
    const run = (el: HTMLElement) => {
      const target = parseInt(el.getAttribute("data-to") ?? "0", 10) || 0;
      if (reduce) { el.textContent = ar(target); return; }
      const dur = 1600;
      // ضمان الرقم النهائي حتى لو توقّف الرسم المتحرّك (تبويب في الخلفية/نافذة مخفية يوقف requestAnimationFrame).
      timers.push(window.setTimeout(() => { el.textContent = ar(target); }, dur + 150));
      let start: number | null = null;
      const ease = (t: number) => 1 - Math.pow(1 - t, 3);
      const step = (ts: number) => {
        if (start === null) start = ts;
        const p = Math.min((ts - start) / dur, 1);
        el.textContent = ar(target * ease(p));
        if (p < 1) requestAnimationFrame(step); else el.textContent = ar(target);
      };
      requestAnimationFrame(step);
    };
    const counts = Array.from(rootRef.current.querySelectorAll<HTMLElement>(".count"));
    if (!("IntersectionObserver" in window)) { counts.forEach(run); return () => timers.forEach(clearTimeout); }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) { run(entry.target as HTMLElement); io.unobserve(entry.target); } });
    }, { threshold: 0.4 });
    counts.forEach((el) => io.observe(el));
    return () => { io.disconnect(); timers.forEach(clearTimeout); };
  }, [data]);

  const share = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
    }
  };

  const hero = data?.hero ?? { youtubeViews: 0, youtubeSubscribers: 0, appsCount: 0 };
  const totals = data?.totals ?? { youtubeVideos: 0, totalPosts: 0, accounts: 0, teamClips: 0 };
  const p = data?.platforms;
  const sum = (accounts: Account[] | undefined, field: "followers" | "posts") => (accounts ?? []).reduce((total, account) => total + (account[field] ?? 0), 0);
  const igFollowers = sum(p?.instagram.accounts, "followers");
  const igPosts = sum(p?.instagram.accounts, "posts");
  const fbFollowers = sum(p?.facebook.accounts, "followers");
  const tgMembers = sum(p?.telegram.accounts, "followers");
  // إنتاج الفريق = مقاطع يوتيوب + منشورات انستقرام، مقرّبًا للأسفل لأقرب ألف («أكثر من N»).
  const teamOutput = Math.floor((totals.youtubeVideos + igPosts) / 1000) * 1000;
  // الحاشية: اسم الجمعية بخط مميّز داخل الجملة، أينما وقع {charityName} في ترجمة اللغة.
  const [footerBefore, footerAfter = ""] = translate(lang, "footer.supportedBy", { charityName: "\u0001" }).split("\u0001");
  const [moreBefore, moreAfter = ""] = translate(lang, "team.moreThan", { n: "\u0001" }).split("\u0001");

  // رقم متحرّك داخل صندوق منصة.
  const num = (key: string, value: number, label: AchKey, extra?: ReactNode) => (
    <div className="tn" key={key}>
      <b className="mono-num count" data-to={value} key={`${key}-${value}`}>{ar(value)}</b>
      {extra}
      <span>{t(label)}</span>
    </div>
  );
  const box = (cls: string, icon: ReactNode, name: AchKey, numbers: ReactNode) => (
    <div className={`tbox ${cls}`}>
      <div className="tbox-head"><span className="tico">{icon}</span><b>{t(name)}</b></div>
      <div className="tbox-nums">{numbers}</div>
    </div>
  );
  // صف قابل للطي: مطوي افتراضيًا، أهم الأرقام في سطر واحد، والتفاصيل عند الضغط.
  const row = (key: string, avatar: ReactNode, name: string, meta: string, body: ReactNode) => (
    <details className="prow" key={key}>
      <summary>
        {avatar}
        <span className="prow-main"><b><bdi>{name}</bdi></b>{meta && <span className="prow-meta mono-num">{meta}</span>}</span>
        <span className="chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="prow-body">{body}</div>
    </details>
  );
  const group = (key: string, icon: ReactNode, iconCls: string, title: AchKey, count: number, rows: ReactNode) => (
    <section className="pgroup" key={key}>
      <div className="pgroup-head"><span className={`gico ${iconCls}`}>{icon}</span><h2>{t(title)}</h2><span className="gcount mono-num">{ar(count)}</span></div>
      <div className="prows">{rows}</div>
    </section>
  );
  const metaLine = (parts: Array<string | null>) => parts.filter(Boolean).join(" · ");
  const accountRows = (accounts: Account[], prefix: string, avatarCls: string, unit: AchKey, open: AchKey, reels?: Reel[], fb?: boolean) => accounts.map((account, index) => {
    const own = (reels ?? []).filter((reel) => reel.account === account.name);
    return row(
      `${prefix}-${index}`,
      <span className={`prow-ava ${avatarCls}`}>{firstLetter(account.name)}</span>,
      account.name,
      metaLine([account.followers != null ? t(unit, { n: ar(account.followers) }) : null, account.posts != null ? t("unit.posts", { n: ar(account.posts) }) : null]),
      <>
        {own.length > 0 && <ReelsRow reels={own} fb={fb} t={t} lang={lang} />}
        {account.url && <Ext href={account.url} className="btn btn-green">{t(open)}</Ext>}
      </>,
    );
  });

  return (
    <div
      className="manassat"
      ref={rootRef}
      dir={rtl ? "rtl" : "ltr"}
      lang={lang}
      data-theme={theme}
      style={{ "--display": fonts.display, "--body": fonts.body } as React.CSSProperties}
    >
      <style>{CSS}</style>
      <div className="hero">
        <div className="wrap hero-inner">
          <div className="brandbar">
            <span className="plate">
              <img src="/jood-logo.png" alt={t("logo.alt")} style={{ height: 46, width: "auto", display: "block" }} />
            </span>
            <div className="hero-actions">
              <label className="lang-pick">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F6F1E7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>
                <select value={lang} onChange={(event) => chooseLang(event.target.value as AchLang)} aria-label="Language / اللغة">
                  {ACH_LANGS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                </select>
              </label>
              <button className="share-btn theme-btn" type="button" onClick={toggleTheme} aria-label={t(theme === "dark" ? "theme.light" : "theme.dark")} title={t(theme === "dark" ? "theme.light" : "theme.dark")}>
                {theme === "dark" ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F6F1E7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F6F1E7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></svg>
                )}
              </button>
              <button className="share-btn" id="shareBtn" type="button" onClick={share}>
                {copied ? (
                  <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F6F1E7" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg> {t("share.copied")}</>
                ) : (
                  <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F6F1E7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg> {t("share.button")}</>
                )}
              </button>
            </div>
          </div>

          <div className="hero-top">
            <h1>{t("hero.title")}</h1>
            <AppQr t={t} />
          </div>

          {/* «حصيلة المشروع»: صندوق لكل منصة، والأرقام داخله يفصلها خط ذهبي رفيع. */}
          <div className="tally">
            <div className="summary-title">{t("summary.title")}</div>
            <div className="tally-grid">
              {box("tb-yt", ICONS.ytWhite, "platform.youtube", <>
                {num("v", hero.youtubeViews, "stat.views", lang === "ar" && hero.youtubeViews > 0 ? <em className="words">{arabicNumberWords(hero.youtubeViews)}</em> : null)}
                {num("s", hero.youtubeSubscribers, "stat.subscribers")}
                {num("yv", totals.youtubeVideos, "stat.videos")}
              </>)}
              {box("tb-ig", ICONS.ig(17), "platform.instagram", <>
                {num("igf", igFollowers, "stat.followers")}
                {num("igp", igPosts, "stat.posts")}
              </>)}
              {box("tb-fb", ICONS.fb(17), "platform.facebook", num("fbf", fbFollowers, "stat.followers"))}
              {box("tb-tg", ICONS.tg(17), "platform.telegram", num("tgm", tgMembers, "stat.subscribers"))}
              {box("tb-apps", ICONS.appsWhite, "hero.apps", num("apps", hero.appsCount, "stat.apps"))}
              {box("tb-team", ICONS.ds(17), "team.title", (
                <div className="tn">
                  <b className="mono-num">{moreBefore}<span className="count" data-to={teamOutput} key={`team-${teamOutput}`}>{ar(teamOutput)}</span>{moreAfter}</b>
                  <span>{t("team.caption")}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="wrap">
        {isError && <div className="note" style={{ marginTop: 24 }}>{t("error.loadFailed")}</div>}

        {data?.featured && (
          <div className="feat">
            <Ext href={data.featured.url} className="fthumb">
              {data.featured.thumbnail && <img className="timg" src={data.featured.thumbnail} alt="" referrerPolicy="no-referrer" />}
              <span className="play"><PlayIcon size={22} /></span>
            </Ext>
            <div className="fbody">
              <span className="ftag">{t("featured.tag")}</span>
              <div className="ftitle" dir="auto">{data.featured.title}</div>
              <div className="fmeta">
                {data.featured.views != null && <strong className="mono-num">{t("unit.views", { n: compact(data.featured.views)! })}</strong>}
                <span><bdi>{t("featured.source", { name: data.featured.channelTitle })}</bdi></span>
              </div>
              <Ext href={data.featured.url} className="btn btn-red" style={{ alignSelf: "flex-start" }}>{t("featured.watch")}</Ext>
            </div>
          </div>
        )}

        <div className="pgroups">
          {(data?.youtube.length ?? 0) > 0 && group("yt", ICONS.ytWhite, "g-yt", "youtube.title", data!.youtube.length, data!.youtube.map((channel, index) => row(
            channel.channelId,
            <span className="prow-ava" style={{ background: AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length] }}>
              {channel.avatar ? <img src={channel.avatar} alt="" referrerPolicy="no-referrer" /> : firstLetter(channel.title)}
            </span>,
            channel.title,
            metaLine([
              channel.subscribers != null ? t("unit.subscribers", { n: ar(channel.subscribers) }) : null,
              channel.views != null ? t("unit.views", { n: ar(channel.views) }) : null,
              channel.videos != null ? t("unit.videos", { n: ar(channel.videos) }) : null,
            ]),
            <>
              <div className="clips">
                {channel.clips.map((clip) => (
                  <Ext key={clip.url} href={clip.url} className="clip">
                    <div className="thumb">
                      {clip.thumbnail && <img className="timg" src={clip.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                      <span className="play"><PlayIcon /></span>
                    </div>
                    <div className="clip-body"><div className="t" dir="auto">{clip.title}</div>{clip.views != null && <div className="v mono-num">{t("unit.views", { n: compact(clip.views)! })}</div>}</div>
                  </Ext>
                ))}
              </div>
              <Ext href={channel.url} className="btn btn-red">{t("youtube.visitChannel")}</Ext>
            </>,
          )))}

          {p && p.instagram.accounts.length > 0 && group("ig", ICONS.ig(17), "c-ig", "instagram.title", p.instagram.accounts.length,
            accountRows(p.instagram.accounts, "ig", "c-ig", "unit.followers", "row.openAccount", p.instagram.reels))}

          {p && p.facebook.accounts.length > 0 && group("fb", ICONS.fb(17), "c-fb", "facebook.title", p.facebook.accounts.length,
            accountRows(p.facebook.accounts, "fb", "c-fb", "unit.followers", "row.openPage", p.facebook.reels, true))}

          {p && p.telegram.accounts.length > 0 && group("tg", ICONS.tg(17), "c-tg", "telegram.title", p.telegram.accounts.length,
            accountRows(p.telegram.accounts, "tg", "c-tg", "unit.subscribers", "row.openChannel"))}

          {p && p.twitter.accounts.length > 0 && group("tw", ICONS.tw(15), "c-tw", "platform.twitter", p.twitter.accounts.length,
            accountRows(p.twitter.accounts, "tw", "c-tw", "unit.followers", "row.openAccount"))}

          {(data?.apps.length ?? 0) > 0 && group("apps", ICONS.appsWhite, "g-apps", "hero.apps", data!.apps.length, data!.apps.map((app, index) => row(
            `app-${index}`,
            <span className="prow-ava app-round">{app.avatar ? <img src={app.avatar} alt="" referrerPolicy="no-referrer" /> : firstLetter(app.name)}</span>,
            app.name,
            [app.iosUrl ? "App Store" : null, app.androidUrl ? "Google Play" : null].filter(Boolean).join(" · "),
            <span className="store">
              {app.iosUrl && <a href={app.iosUrl} target="_blank" rel="noopener noreferrer">{t("app.downloadAppStore")}</a>}
              {app.androidUrl && <a href={app.androidUrl} target="_blank" rel="noopener noreferrer">{t("app.downloadGooglePlay")}</a>}
            </span>,
          )))}
        </div>

        {/* «أحدث ما نشرنا»: قائمة منسدلة مطوية افتراضيًا — ريلز انستقرام وفيسبوك بمشاهداتها، ثم آخر المنشورات. */}
        {data && (p?.instagram.reels.length || p?.facebook.reels.length || data.feed.length) ? (
          <details className="latest">
            <summary>
              <span className="gico g-feed">{ICONS.feed}</span>
              <span className="latest-title"><h2>{t("feed.title")}</h2><span>{t("feed.subtitle")}</span></span>
              <span className="chev" aria-hidden="true">⌄</span>
            </summary>
            <div className="latest-body">
              {p!.instagram.reels.length > 0 && <><div className="reels-label">{t("instagram.reelsLabel")}</div><ReelsRow reels={p!.instagram.reels} t={t} lang={lang} /></>}
              {p!.facebook.reels.length > 0 && <><div className="reels-label">{t("facebook.reelsLabel")}</div><ReelsRow reels={p!.facebook.reels} fb t={t} lang={lang} /></>}
              {data.feed.length > 0 && (
                <div className="feed">
                  {data.feed.map((item) => {
                    const meta = FEED_META[item.platform];
                    return (
                      <a className="fitem" key={`${item.platform}-${item.url}`} href={item.url} target="_blank" rel="noopener noreferrer">
                        <span className={`fi-ico ${meta.cls}`} style={meta.style}>{meta.icon}</span>
                        <span className="fi-main"><b dir="auto">{feedTitle(item, t)}</b><span>{t(meta.label)} · {ago(item.publishedAt, t, lang)}</span></span>
                        <span className="fi-go">↗</span>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          </details>
        ) : null}
      </div>

      <footer>
        <div className="wrap foot">
          <span>Tilawatalharamain.com</span>
          <span>{footerBefore}<span className="jname">{t("footer.charityName")}</span>{footerAfter}</span>
        </div>
      </footer>
    </div>
  );
}

// باركود (QR) تطبيق تلاوات الحرمين — يُولَّد محليًا (SVG) فيبقى حادًّا عند التكبير، والضغط عليه يكبّره.
const APP_URL = "https://tilawatalharamain.netlify.app";
function AppQr({ t }: { t: T }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toString(APP_URL, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0F5A46", light: "#FFFDF8" } })
      .then((markup) => { if (alive) setSvg(markup); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setZoomed(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);
  return (
    <div className="appqr">
      <button type="button" className="qr" onClick={() => setZoomed(true)} aria-label={t("app.enlarge")} title={t("app.enlarge")}>
        {svg ? <span className="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="qr-svg qr-wait" />}
      </button>
      <div className="appqr-text">
        <b>{t("app.qrTitle")}</b>
        <span>{t("app.scan")}</span>
        <a className="btn btn-gold" href={APP_URL} target="_blank" rel="noopener noreferrer">{t("app.open")} ↗</a>
      </div>
      {zoomed && svg && (
        <div className="qr-zoom" role="dialog" aria-modal="true" aria-label={t("app.qrTitle")} onClick={() => setZoomed(false)}>
          <div className="qr-zoom-card" onClick={(event) => event.stopPropagation()}>
            <span className="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} />
            <b>{t("app.qrTitle")}</b>
            <a className="btn btn-gold" href={APP_URL} target="_blank" rel="noopener noreferrer">{t("app.open")} ↗</a>
          </div>
        </div>
      )}
    </div>
  );
}

// أنماط التصميم المعتمد حرفيًا، محصورة تحت ‎.manassat‎ (بدل body). إضافات صغيرة فقط لعرض الصور الحقيقية
// (‎.timg‎، صورة القناة/الشيخ، ‎.rimg‎) فوق نفس الخلفيات البديلة.
const CSS = `
.manassat{
  color-scheme: light;
  --bg:#F6F1E7; --surface:#FFFDF8; --surface-2:#FBF6EC; --ink:#2A2620; --muted:#6F675A;
  --green:#0F5A46; --green-soft:#E4EFE9; --gold:#B88A2E; --gold-soft:#F0E6CF; --line:#E8DFCD;
  --shadow:0 10px 30px rgba(42,38,32,.08); --radius:18px; --maxw:1120px;
  --display:"El Messiri", "Readex Pro", system-ui, sans-serif; --body:"Readex Pro", system-ui, sans-serif;
  background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.6;font-weight:400;min-height:100vh;text-align:start;
}
.manassat *{box-sizing:border-box}
.manassat .wrap{max-width:var(--maxw);margin:0 auto;padding-left:max(18px,env(safe-area-inset-left,0px));padding-right:max(18px,env(safe-area-inset-right,0px))}
.manassat a{color:inherit;text-decoration:none}
.manassat h1,.manassat h2,.manassat h3{font-family:var(--display);text-wrap:balance;margin:0;font-weight:700;letter-spacing:0}
.manassat .mono-num{font-variant-numeric:tabular-nums}
.manassat .hero{position:relative;overflow:hidden;border-radius:0 0 34px 34px;background:linear-gradient(180deg, rgba(12,58,46,.60) 0%, rgba(10,47,38,.78) 62%, rgba(9,40,33,.90) 100%),url('/haram-achievements-bg.jpg') center 26%/cover no-repeat;color:#F6F1E7}
.manassat .hero-inner{position:relative;padding-block:28px 52px}
.manassat .brandbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.manassat .plate{background:#FBF9F2;border-radius:14px;padding:9px 16px;box-shadow:0 8px 22px rgba(0,0,0,.22);display:flex;align-items:center;gap:10px}
.manassat .hero h1{font-size:clamp(30px,6.4vw,52px);margin-top:20px;line-height:1.1}
.manassat .hero-top{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-top:20px}
.manassat .hero-top h1{margin-top:0;flex:1 1 360px}
.manassat .appqr{display:flex;align-items:center;gap:12px;background:rgba(246,241,231,.08);border:1px solid rgba(246,241,231,.18);border-radius:16px;padding:10px 12px}
.manassat .qr{background:#FFFDF8;border:0;border-radius:12px;padding:6px;cursor:zoom-in;line-height:0;flex:none}
.manassat .qr-svg{display:block;width:92px;height:92px}
.manassat .qr-svg svg{width:100%;height:100%;display:block}
.manassat .qr-wait{background:#FBF6EC;border-radius:6px}
.manassat .appqr-text{display:flex;flex-direction:column;gap:5px;min-width:0}
.manassat .appqr-text b{font-family:var(--display);font-size:15px;color:#F6F1E7}
.manassat .appqr-text span{font-size:12px;color:rgba(246,241,231,.82)}
.manassat .btn-gold{background:#B88A2E;color:#fff;align-self:flex-start;padding:7px 14px;font-size:13px}
.manassat .btn-green{background:var(--green);color:#fff}
.manassat .qr-zoom{position:fixed;inset:0;z-index:50;background:rgba(9,40,33,.78);display:grid;place-items:center;padding:20px;cursor:zoom-out}
.manassat .qr-zoom-card{background:var(--surface);border-radius:20px;padding:20px;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:var(--shadow);cursor:default}
.manassat .qr-zoom-card .qr-svg{width:min(78vw,340px);height:min(78vw,340px)}
.manassat .qr-zoom-card b{font-family:var(--display);font-size:18px;color:var(--ink)}
.manassat .qr-zoom-card .btn-gold{align-self:center}
.manassat .tally{margin-top:22px}
.manassat .summary-title{display:inline-flex;align-items:center;gap:8px;font-family:var(--display);font-size:14px;font-weight:600;letter-spacing:.2px;color:#E9D9A9;margin-bottom:10px}
.manassat .summary-title::before{content:"";width:22px;height:2px;border-radius:2px;background:#B88A2E}
.manassat .tally-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px}
.manassat .tbox{background:rgba(246,241,231,.08);border:1px solid rgba(246,241,231,.18);border-radius:16px;padding:12px 14px 14px;min-width:0}
.manassat .tb-yt{grid-column:span 7}
.manassat .tb-ig{grid-column:span 5}
.manassat .tb-fb,.manassat .tb-tg{grid-column:span 3}
.manassat .tb-apps{grid-column:span 2}
.manassat .tb-team{grid-column:span 4}
.manassat .tbox-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.manassat .tbox-head b{font-family:var(--display);font-size:14px;font-weight:600;color:#F6F1E7}
.manassat .tico{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none}
.manassat .tb-yt .tico{background:#C1121F}
.manassat .tb-ig .tico{background:linear-gradient(135deg,#F58529,#DD2A7B 55%,#8134AF)}
.manassat .tb-fb .tico{background:#1877F2}
.manassat .tb-tg .tico{background:#2CA5E0}
.manassat .tb-apps .tico{background:var(--green)}
.manassat .tb-team .tico{background:linear-gradient(135deg,#B88A2E,#946d1f)}
.manassat .tbox-nums{display:flex;align-items:stretch}
.manassat .tn{flex:1 1 0;min-width:0;padding-inline:12px}
.manassat .tn:first-child{padding-inline-start:0}
.manassat .tn:last-child{padding-inline-end:0}
.manassat .tn + .tn{border-inline-start:1px solid rgba(184,138,46,.55)}
.manassat .tn b{font-family:var(--display);font-size:clamp(18px,2.6vw,26px);color:#E9D9A9;line-height:1.1;display:block;white-space:nowrap}
.manassat .tn span{color:rgba(246,241,231,.82);font-size:12.5px;margin-top:6px;display:block}
.manassat .tn b span{display:inline;font-size:inherit;color:inherit;margin:0}
.manassat .tn .words{display:block;font-style:normal;font-family:var(--body);font-size:11.5px;line-height:1.5;color:rgba(233,217,169,.92);margin-top:6px}
@media (max-width:900px){.manassat .tb-yt,.manassat .tb-ig{grid-column:span 12}.manassat .tb-fb,.manassat .tb-tg,.manassat .tb-apps,.manassat .tb-team{grid-column:span 6}}
@media (max-width:520px){.manassat .tn{padding-inline:8px}.manassat .tn b{font-size:17px}.manassat .tbox{padding:11px 12px 12px}.manassat .appqr{width:100%}}
.manassat .pgroups{padding-block:28px 6px;display:flex;flex-direction:column;gap:22px}
.manassat .pgroup{padding-block:0}
.manassat .pgroup-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.manassat .pgroup-head h2{font-size:clamp(19px,3.4vw,24px)}
.manassat .gico{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;flex:none}
.manassat .g-yt{background:#C1121F}
.manassat .g-apps{background:var(--green)}
.manassat .g-feed{background:var(--green-soft);color:var(--green)}
.manassat .gcount{margin-inline-start:auto;font-size:12.5px;color:var(--muted);background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
.manassat .prows{display:flex;flex-direction:column;gap:8px}
.manassat .prow{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 4px 14px rgba(42,38,32,.05);overflow:hidden}
.manassat .prow > summary{list-style:none;display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer}
.manassat .prow > summary::-webkit-details-marker,.manassat .latest > summary::-webkit-details-marker{display:none}
.manassat .prow-ava{width:38px;height:38px;border-radius:11px;flex:none;display:grid;place-items:center;color:#fff;overflow:hidden;font-family:var(--display);font-weight:700;font-size:16px;background:linear-gradient(135deg,#0F5A46,#13715C)}
.manassat .prow-ava img{width:100%;height:100%;object-fit:cover}
.manassat .prow-ava.app-round{border-radius:50%}
.manassat .prow-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.manassat .prow-main b{font-weight:600;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.manassat .prow-meta{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.manassat .chev{flex:none;color:var(--muted);font-size:18px;line-height:1;transition:transform .2s}
.manassat details[open] > summary .chev{transform:rotate(180deg)}
.manassat .prow-body{padding:4px 14px 14px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.manassat .prow-body .clips{margin-top:8px;width:100%}
.manassat .prow-body .ig-reels{width:100%}
.manassat .latest{margin-block:6px 34px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.manassat .latest > summary{list-style:none;display:flex;align-items:center;gap:12px;padding:14px 18px;cursor:pointer}
.manassat .latest-title{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.manassat .latest-title h2{font-size:clamp(19px,3.4vw,24px)}
.manassat .latest-title span{font-size:13px;color:var(--muted)}
.manassat .latest-body{padding:4px 18px 18px;border-top:1px solid var(--line)}
.manassat .latest-body .feed{margin-top:12px}
.manassat .hs b{font-family:var(--display);font-size:clamp(20px,3.4vw,30px);color:#E9D9A9;line-height:1;display:block}
.manassat .hs span{color:rgba(246,241,231,.82);font-size:13px;margin-top:7px;display:block}
.manassat .hs .words{display:block;font-style:normal;font-family:var(--body);font-size:12.5px;line-height:1.55;color:rgba(233,217,169,.92);margin-top:8px;max-width:30ch}
.manassat section{padding-block:40px}
.manassat .sec-head{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.manassat .sec-head .ico{width:40px;height:40px;border-radius:12px;background:var(--green-soft);color:var(--green);display:grid;place-items:center;flex:none}
.manassat .sec-head h2{font-size:clamp(22px,4vw,30px)}
.manassat .sec-sub{color:var(--muted);font-size:15px;margin-block:0 22px;margin-inline:0 52px}
@media (max-width:560px){.manassat .sec-sub{margin-inline-start:0}}
.manassat .yt-channel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;margin-bottom:20px}
.manassat .yt-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.manassat .yt-ava{width:52px;height:52px;border-radius:14px;flex:none;display:grid;place-items:center;color:#fff;font-family:var(--display);font-weight:700;font-size:20px;background:linear-gradient(135deg,#C1121F,#8E0E17);overflow:hidden}
.manassat .yt-ava img{width:100%;height:100%;object-fit:cover}
.manassat .yt-name{flex:1;min-width:160px}
.manassat .yt-name b{font-family:var(--display);font-size:18px;display:block}
.manassat .yt-name .meta{color:var(--muted);font-size:13px;display:flex;gap:14px;flex-wrap:wrap;margin-top:3px}
.manassat .yt-name .meta strong{color:var(--green);font-weight:600}
.manassat .btn{display:inline-flex;align-items:center;gap:7px;border-radius:999px;font-weight:600;font-size:13.5px;padding:9px 16px;border:1px solid transparent;white-space:nowrap;cursor:pointer}
.manassat .btn-red{background:#C1121F;color:#fff}
.manassat .clips{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}
@media (max-width:640px){.manassat .clips{grid-template-columns:1fr}}
.manassat .clip{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface-2);display:flex;flex-direction:column}
.manassat .thumb{position:relative;aspect-ratio:16/9;background:linear-gradient(135deg,#143d33,#0F5A46 60%,#17715a);display:grid;place-items:center}
.manassat .thumb .play,.manassat .fthumb .play{position:relative;z-index:1}
.manassat .thumb .play{width:46px;height:46px;border-radius:50%;background:rgba(246,241,231,.92);display:grid;place-items:center;box-shadow:0 6px 16px rgba(0,0,0,.25)}
.manassat .thumb .play svg{margin-right:-3px}
.manassat .timg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.manassat .clip-body{padding:11px 12px 13px}
.manassat .clip-body .t{font-size:13.5px;font-weight:500;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.9em}
.manassat .clip-body .v{color:var(--muted);font-size:12px;margin-top:6px;display:flex;align-items:center;gap:6px}
.manassat .apps{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
@media (max-width:720px){.manassat .apps{grid-template-columns:1fr}}
.manassat .app{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;display:flex;align-items:center;gap:15px;flex-wrap:wrap}
.manassat .app-ico{width:58px;height:58px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;overflow:hidden;font-family:var(--display);font-size:22px;font-weight:700;background:linear-gradient(135deg,#0F5A46,#13715C);box-shadow:0 2px 9px rgba(42,38,32,.16)}
.manassat .app-ico img{width:100%;height:100%;object-fit:cover}
.manassat .app b{font-family:var(--display);font-size:16px;flex:1;min-width:130px}
.manassat .store{display:flex;gap:9px;flex-wrap:wrap}
.manassat .store a{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;padding:8px 13px;border-radius:11px;border:1px solid var(--line);background:var(--surface-2)}
.manassat .plat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 18px 8px;margin-bottom:18px}
.manassat .plat-head{display:flex;align-items:center;gap:11px;margin-bottom:6px}
.manassat .plat-head .pico{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:#fff;flex:none}
.manassat .plat-head b{font-family:var(--display);font-size:17px}
.manassat .plat-head .n{color:var(--muted);font-size:12.5px;margin-inline-start:auto}
.manassat .accs{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding-block:8px}
@media (max-width:560px){.manassat .accs{grid-template-columns:1fr}}
.manassat .acc{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line)}
.manassat .acc .dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex:none}
.manassat .acc .go{margin-inline-start:auto;color:var(--muted);flex:none}
.manassat .acc-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.manassat .acc-main b{font-weight:600;font-size:14px}
.manassat .acc-sub{font-size:11.5px;color:var(--muted)}
.manassat .c-ig{background:linear-gradient(135deg,#F58529,#DD2A7B 55%,#8134AF)}
.manassat .c-fb{background:#1877F2}
.manassat .c-tg{background:#2CA5E0}
.manassat .c-tw{background:#111}
.manassat .c-ds{background:linear-gradient(135deg,#B88A2E,#946d1f)}
.manassat .reels-label{font-size:13px;color:var(--muted);margin:10px 2px 2px}
.manassat .ig-reels{display:grid;grid-template-columns:repeat(3,minmax(0,190px));gap:12px;padding-block:8px}
@media(max-width:560px){.manassat .ig-reels{grid-template-columns:repeat(2,1fr)}}
.manassat .reel{position:relative;aspect-ratio:9/16;border-radius:14px;overflow:hidden;background:linear-gradient(160deg,#515BD4,#8134AF 40%,#DD2A7B 72%,#F58529);display:block}
.manassat .reel .rimg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.manassat .reel .rplay{position:absolute;inset:0;display:grid;place-items:center}
.manassat .reel .rplay i{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center;box-shadow:0 6px 16px rgba(0,0,0,.3)}
.manassat .reel .rinfo{position:absolute;inset-inline:0;bottom:0;padding:10px 11px;background:linear-gradient(0deg,rgba(0,0,0,.62),transparent);color:#fff}
.manassat .reel .rinfo b{font-size:12px;font-weight:600;display:block;line-height:1.3}
.manassat .reel .rinfo span{font-size:11px;opacity:.92}
.manassat footer{margin-top:20px;border-top:1px solid var(--line);background:var(--surface-2)}
.manassat .theme-btn{padding:9px 11px}
.manassat .foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-block:22px;color:var(--muted);font-size:13.5px}
.manassat .foot .jname{font-family:var(--display);color:var(--green)}
.manassat .note{max-width:var(--maxw);margin:16px auto 34px;font-size:12px;color:var(--muted);background:var(--gold-soft);border:1px solid #E7D7AC;border-radius:12px;padding:12px 15px}
.manassat .hero-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.manassat .lang-pick{display:inline-flex;align-items:center;gap:6px;background:rgba(246,241,231,.14);border:1px solid rgba(246,241,231,.3);color:#F6F1E7;padding:0 12px;border-radius:999px;height:38px}
.manassat .lang-pick select{appearance:auto;background:transparent;border:0;color:#F6F1E7;font-family:var(--body);font-weight:600;font-size:13px;height:100%;cursor:pointer;outline:none;max-width:170px}
.manassat .lang-pick select option{color:#2A2620;background:#FFFDF8}
.manassat .share-btn{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-family:var(--body);font-weight:600;font-size:13px;background:rgba(246,241,231,.14);border:1px solid rgba(246,241,231,.3);color:#F6F1E7;padding:9px 16px;border-radius:999px}
.manassat .feat{display:grid;grid-template-columns:320px 1fr;gap:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;margin-top:-26px;position:relative;z-index:2}
@media(max-width:640px){.manassat .feat{grid-template-columns:1fr}}
.manassat .fthumb{position:relative;aspect-ratio:16/9;background:linear-gradient(135deg,#143d33,#0F5A46 60%,#17715a);display:grid;place-items:center}
.manassat .fthumb .play{width:58px;height:58px;border-radius:50%;background:rgba(246,241,231,.92);display:grid;place-items:center;box-shadow:0 8px 20px rgba(0,0,0,.3)}
.manassat .fbody{padding:20px 22px;display:flex;flex-direction:column;justify-content:center;gap:9px}
.manassat .ftag{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;background:var(--gold-soft);color:#8a6a1f;border:1px solid #E7D7AC;font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px}
.manassat .ftitle{font-family:var(--display);font-size:clamp(18px,3vw,23px);line-height:1.4}
.manassat .fmeta{color:var(--muted);font-size:13.5px;display:flex;gap:14px;flex-wrap:wrap}
.manassat .fmeta strong{color:var(--green)}
.manassat .feed{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
@media(max-width:640px){.manassat .feed{grid-template-columns:1fr}}
/* عناصر الشبكات لا تتّسع بنصّها الطويل (العنوان يُقصّ بـ…) — بلا هذا يتجاوز الصفحة عرض الشاشة. */
.manassat .clips>*,.manassat .apps>*,.manassat .accs>*,.manassat .feed>*,.manassat .designs>*{min-width:0}
.manassat .fitem{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 14px;box-shadow:0 4px 14px rgba(42,38,32,.05)}
.manassat .fi-ico{width:38px;height:38px;border-radius:10px;flex:none;display:grid;place-items:center;color:#fff}
.manassat .fi-main{min-width:0;flex:1}
.manassat .fi-main b{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.manassat .fi-main span{font-size:12px;color:var(--muted)}
.manassat .fi-go{color:var(--muted);flex:none}
.manassat .designs{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding-block:8px}
@media(max-width:640px){.manassat .designs{grid-template-columns:repeat(2,1fr)}}
.manassat .dcard{aspect-ratio:1/1;border-radius:12px;overflow:hidden;background:linear-gradient(135deg,#C9A74A,#9a7320);display:grid;place-items:center;color:rgba(255,255,255,.72)}
.manassat .reel.fb{background:linear-gradient(160deg,#1877F2,#0d5bbf)}
.manassat .reel.fb .rplay i svg{fill:#1877F2}
/* ── النمط الليلي: خلفية خضراء داكنة دافئة، بطاقات أفتح قليلًا، نص عاجي، واللمسات الذهبية والخضراء واضحة ── */
.manassat[data-theme="dark"]{
  color-scheme: dark;
  --bg:#0E1D18; --surface:#16302A; --surface-2:#1B3832; --ink:#F3EBDC; --muted:#BDB4A1;
  --green:#5DBE9A; --green-soft:#21453B; --gold:#D6AE57; --gold-soft:#3A3121; --line:#2B4A41;
  --shadow:0 10px 30px rgba(0,0,0,.35);
}
.manassat[data-theme="dark"] .hero{background:linear-gradient(180deg, rgba(8,32,26,.72) 0%, rgba(7,26,21,.86) 62%, rgba(6,22,18,.94) 100%),url('/haram-achievements-bg.jpg') center 26%/cover no-repeat}
.manassat[data-theme="dark"] .btn-green{background:#1E7A5E}
.manassat[data-theme="dark"] .btn-gold{background:#B88A2E}
.manassat[data-theme="dark"] .ftag{color:#E9D9A9;border-color:#5C4B25}
.manassat[data-theme="dark"] .note{border-color:#5C4B25;color:var(--ink)}
.manassat[data-theme="dark"] .store a{border-color:#3C5F55;background:#21423A;color:var(--ink)}
.manassat[data-theme="dark"] .prow,.manassat[data-theme="dark"] .fitem{box-shadow:0 4px 14px rgba(0,0,0,.25)}
.manassat[data-theme="dark"] .gcount{background:#21423A;border-color:#3C5F55}
.manassat[data-theme="dark"] .c-tw,.manassat[data-theme="dark"] .gico.c-tw{background:#2A2A2A}
.manassat[data-theme="dark"] .qr-zoom{background:rgba(3,12,9,.85)}
.manassat[data-theme="dark"] .lang-pick select option{color:#F3EBDC;background:#16302A}
`;
