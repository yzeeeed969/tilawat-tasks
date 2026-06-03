import { useState, type ElementType } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { BarChart3, CalendarDays, Clock, Eye, Globe2, LineChart, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformIcon } from "@/lib/platform-icon";

type PeriodKey = "7d" | "30d" | "90d" | "all";

type PublicAchievements = {
  period: {
    key: PeriodKey;
    label: string;
    start: string;
    end: string;
  };
  totalPublications: number;
  completedTasks: number;
  last30Publications: number;
  activePlatforms: number;
  dailyAverage: number;
  projectStartDate: string;
  allTime: {
    totalPublications: number;
    systemPublications: number;
    baselinePublications: number;
    completedTasks: number;
  };
  youtubeViews: {
    totalViews: number | null;
    manualViews: number | null;
    baselineViews: number;
    updatedAt: string | null;
    fetchedAt: string;
  };
  achievementsByPlatform: Array<{
    platformId: number;
    name: string;
    icon: string;
    color: string;
    publications: number;
    systemPublications: number;
    baselinePublications: number;
    completedTasks: number;
  }>;
  monthlyGrowth: Array<{
    monthStart: string;
    publications: number;
    completedTasks: number;
  }>;
  lastUpdated: string;
};

const periodOptions: Array<{ value: PeriodKey; label: string }> = [
  { value: "7d", label: "آخر 7 أيام" },
  { value: "30d", label: "آخر 30 يومًا" },
  { value: "90d", label: "آخر 90 يومًا" },
  { value: "all", label: "الكل" },
];

async function fetchPublicAchievements(period: PeriodKey): Promise<PublicAchievements> {
  const response = await fetch(`/api/public/achievements?period=${period}`);
  if (!response.ok) throw new Error("Failed to load achievements");
  return response.json();
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ar-SA").format(Math.round(value));
}

function formatAverage(value: number) {
  return new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 1 }).format(value);
}

function formatDate(date: string | Date) {
  return format(new Date(date), "d MMMM yyyy", { locale: ar });
}

function formatDateTime(date: string | Date) {
  return format(new Date(date), "EEEE، d MMMM yyyy، h:mm a", { locale: ar });
}

function JoodLogoMark() {
  return (
    <div className="rounded-lg border border-amber-200/80 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
      <img
        src="/jood-logo.png"
        alt="جمعية جود لخدمة الحاج والمعتمر"
        className="h-12 w-auto object-contain"
      />
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  hint,
  tone = "green",
  className = "",
}: {
  title: string;
  value: string;
  icon: ElementType;
  hint: string;
  tone?: "green" | "gold" | "blue";
  className?: string;
}) {
  const toneClass = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-100",
    gold: "bg-amber-50 text-amber-700 border-amber-100",
    blue: "bg-sky-50 text-sky-700 border-sky-100",
  }[tone];

  return (
    <Card className={`border-[#eadfcd] bg-white/88 shadow-sm backdrop-blur ${className}`}>
      <CardContent className="p-3 sm:p-5">
        <div className="flex items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold leading-5 text-[#5f796d] sm:text-sm">{title}</p>
            <p className="mt-2 break-words text-2xl font-black leading-tight text-[#103c2d] sm:text-3xl">{value}</p>
            <p className="mt-1 text-xs text-[#7c8f85]">{hint}</p>
          </div>
          <div className={`rounded-lg border p-2 sm:p-3 ${toneClass}`}>
            <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionTitle({ icon: Icon, title, hint }: { icon: ElementType; title: string; hint: string }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-black text-[#103c2d]">
          <Icon className="h-5 w-5 text-[#c59226]" />
          {title}
        </h2>
        <p className="mt-1 text-sm text-[#6f8378]">{hint}</p>
      </div>
    </div>
  );
}

function MonthlyGrowthChart({
  rows,
}: {
  rows: PublicAchievements["monthlyGrowth"];
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
        لا توجد بيانات نمو لهذه الفترة.
      </p>
    );
  }

  const maxValue = Math.max(...rows.map((row) => row.publications), 1);
  const width = 860;
  const height = 260;
  const paddingX = 48;
  const paddingTop = 26;
  const paddingBottom = 48;
  const chartHeight = height - paddingTop - paddingBottom;
  const usableWidth = width - paddingX * 2;
  const points = rows.map((row, index) => {
    const x = rows.length === 1 ? width / 2 : paddingX + (index / (rows.length - 1)) * usableWidth;
    const y = paddingTop + chartHeight - (row.publications / maxValue) * chartHeight;
    return { ...row, x, y };
  });
  const baseline = height - paddingBottom;
  const linePath = points.length === 1
    ? `M ${paddingX} ${points[0].y} L ${width - paddingX} ${points[0].y}`
    : points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = points.length === 1
    ? `M ${paddingX} ${points[0].y} L ${width - paddingX} ${points[0].y} L ${width - paddingX} ${baseline} L ${paddingX} ${baseline} Z`
    : `${linePath} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;

  return (
    <div className="overflow-hidden rounded-lg border border-[#efe6d8] bg-[#fffdf8] p-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[260px] w-full" role="img" aria-label="رسم النمو الشهري">
        <defs>
          <linearGradient id="monthlyGrowthFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f5b3d" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#0f5b3d" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = paddingTop + chartHeight * ratio;
          return (
            <line
              key={`grid-${ratio}`}
              x1={paddingX}
              x2={width - paddingX}
              y1={y}
              y2={y}
              stroke="#eadfcd"
              strokeDasharray="5 7"
            />
          );
        })}
        <path d={areaPath} fill="url(#monthlyGrowthFill)" />
        <path d={linePath} fill="none" stroke="#0f5b3d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" />
        {points.map((point) => {
          const date = new Date(point.monthStart);
          return (
            <g key={point.monthStart}>
              <circle cx={point.x} cy={point.y} r="7" fill="#c59226" stroke="#fffaf0" strokeWidth="4" />
              <text x={point.x} y={point.y - 16} textAnchor="middle" className="fill-[#103c2d] text-[18px] font-black">
                {formatNumber(point.publications)}
              </text>
              <text x={point.x} y={height - 18} textAnchor="middle" className="fill-[#6f8378] text-[15px] font-bold">
                {format(date, "MMM yyyy", { locale: ar })}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function Achievements() {
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-achievements", period],
    queryFn: () => fetchPublicAchievements(period),
    staleTime: 60_000,
  });

  const maxPlatform = Math.max(...(data?.achievementsByPlatform.map((row) => row.publications) ?? [0]), 1);
  const selectedPeriodLabel = periodOptions.find((option) => option.value === period)?.label ?? "آخر 30 يومًا";
  const isAllPeriod = period === "all";

  return (
    <main dir="rtl" className="min-h-screen bg-[#f6f1e8] text-[#103c2d]">
      <section
        id="top"
        className="relative overflow-hidden border-b border-[#eadfcd]"
        style={{
          backgroundImage:
            "linear-gradient(90deg, rgba(246,241,232,0.96), rgba(246,241,232,0.87), rgba(246,241,232,0.72)), url('/haram-achievements-bg.jpg')",
          backgroundPosition: "center",
          backgroundSize: "cover",
        }}
      >
        <nav className="mx-auto flex w-full max-w-7xl flex-col items-start gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <JoodLogoMark />
          <div className="text-right">
            <p className="text-lg font-black text-[#0f3327]">إنجازات فريق تطبيق تلاوات الحرمين</p>
            <p className="mt-1 text-xs font-semibold text-[#6d8177]">
              {data?.lastUpdated
                ? `آخر تحديث: ${formatDateTime(data.lastUpdated)}`
                : "آخر تحديث: يتم تحميل البيانات"}
            </p>
          </div>
        </nav>

        <div className="mx-auto grid w-full max-w-7xl gap-8 px-5 pb-12 pt-6 sm:px-8 lg:grid-cols-[1fr_360px] lg:items-end lg:pb-16">
          <div className="max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d8c496] bg-white/70 px-3 py-1 text-sm font-bold text-[#8a641d] shadow-sm backdrop-blur">
              <Globe2 className="h-4 w-4" />
              واجهة عامة للإنجازات
            </div>
            <h1 className="text-4xl font-black leading-tight text-[#0f3327] sm:text-5xl">
              إنجازات فريق تطبيق تلاوات الحرمين
            </h1>
            <p className="mt-4 max-w-2xl text-base font-semibold text-[#5d756b]">
              عرض رسمي مختصر لأثر العمل ومنجزاته عبر المنصات.
            </p>
          </div>

          <div className="rounded-lg border border-[#decfae] bg-white/78 p-4 shadow-sm backdrop-blur">
            <label className="text-sm font-black text-[#103c2d]" htmlFor="achievement-period">الفترة</label>
            <select
              id="achievement-period"
              value={period}
              onChange={(event) => setPeriod(event.target.value as PeriodKey)}
              className="mt-2 h-12 w-full rounded-lg border border-[#d8cba9] bg-white px-3 text-base font-bold text-[#103c2d] outline-none focus:border-[#b88724]"
            >
              {periodOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="mt-3 text-xs leading-6 text-[#74877d]">
              تتغير البطاقات والمنصات والرسم البياني حسب الفترة المختارة دون عرض أي بيانات تشغيلية داخلية.
            </p>
          </div>
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:py-10">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
            {[...Array(6)].map((_, index) => <Skeleton key={index} className="h-32 rounded-lg bg-white/70" />)}
          </div>
        ) : isError || !data ? (
          <Card className="border-red-200 bg-red-50/80">
            <CardContent className="py-8 text-center font-bold text-red-700">
              تعذر تحميل بيانات الإنجازات الآن.
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
              <StatCard
                className="col-span-2 xl:col-span-1"
                title="مشاهدات قنوات YouTube التابعة لتطبيق تلاوات الحرمين"
                value={data.youtubeViews.totalViews === null ? "غير متاح مؤقتًا" : `${formatNumber(data.youtubeViews.totalViews)} مشاهدة`}
                icon={Eye}
                hint={data.youtubeViews.updatedAt ? `آخر تحديث: ${formatDateTime(data.youtubeViews.updatedAt)}` : "لم يتم تحديث الرقم بعد"}
                tone="blue"
              />
              <StatCard
                title="إجمالي المنشورات"
                value={formatNumber(data.totalPublications)}
                icon={LineChart}
                hint={isAllPeriod ? "تراكمي: تأسيسي + إنجازات النظام" : selectedPeriodLabel}
              />
              <StatCard
                title="آخر 30 يومًا"
                value={formatNumber(data.last30Publications)}
                icon={Clock}
                hint="مواد منشورة حديثًا"
                tone="blue"
              />
              <StatCard
                title="المنصات النشطة"
                value={formatNumber(data.activePlatforms)}
                icon={Globe2}
                hint="حسب الفترة المختارة"
              />
              <StatCard
                title="متوسط الإنجاز اليومي"
                value={formatAverage(data.dailyAverage)}
                icon={TrendingUp}
                hint={isAllPeriod ? "متوسط تراكمي تقريبي" : "منشور يوميًا تقريبًا"}
                tone="gold"
              />
              <StatCard
                title="بداية احتساب النظام"
                value={formatDate(data.projectStartDate)}
                icon={CalendarDays}
                hint="الكل يجمع الأرقام التأسيسية مع إنجازات النظام"
                tone="gold"
              />
            </section>

            <section id="platforms">
              <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle
                    icon={BarChart3}
                    title="الإنجازات حسب المنصات"
                    hint={isAllPeriod ? "الأرقام التراكمية لكل منصة" : `إحصاء مجمع حسب ${selectedPeriodLabel}`}
                  />
                  {data.achievementsByPlatform.length === 0 ? (
                    <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
                      لا توجد إنجازات في هذه الفترة.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {data.achievementsByPlatform.map((platform) => (
                        <div key={platform.platformId} className="rounded-lg border border-[#efe6d8] bg-[#fffdf8] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 font-black">
                              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#f4eddf]">
                                <PlatformIcon name={platform.name} className="h-5 w-5" />
                              </span>
                              <span>{platform.name}</span>
                            </div>
                            <span className="rounded-full bg-[#0f5b3d]/10 px-3 py-1 text-sm font-black text-[#0f5b3d]">
                              {formatNumber(platform.publications)} منشور
                            </span>
                          </div>
                          <Progress value={(platform.publications / maxPlatform) * 100} className="mt-3 h-2 bg-[#eee4d2]" />
                          <p className="mt-2 text-xs font-semibold text-[#778b80]">
                            {isAllPeriod && platform.baselinePublications > 0
                              ? `يشمل ${formatNumber(platform.baselinePublications)} رقمًا تأسيسيًا و${formatNumber(platform.systemPublications)} من نظام المهام`
                              : `${formatNumber(platform.completedTasks)} مهمة مكتملة`}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            <section>
              <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle
                    icon={LineChart}
                    title="النمو الشهري"
                    hint="يبدأ من أول شهر توجد فيه بيانات فعلية فقط"
                  />
                  <MonthlyGrowthChart rows={data.monthlyGrowth} />
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </div>

      <footer id="contact" className="border-t border-[#eadfcd] bg-[#103c2d] px-5 py-6 text-center text-sm font-bold text-[#f8efd9]">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-center gap-2 sm:flex-row sm:gap-6">
          <span>Tilawatalharamain.com</span>
          <span className="hidden text-[#d3aa4f] sm:inline">|</span>
          <span>بدعم جمعية جود لخدمة الحاج والمعتمر</span>
        </div>
      </footer>
    </main>
  );
}
