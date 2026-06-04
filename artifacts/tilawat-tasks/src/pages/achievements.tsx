import { useState, type ElementType } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { BarChart3, CheckCircle2, Clock, Eye, Globe2, LineChart, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformIcon } from "@/lib/platform-icon";

type PeriodKey = "30d" | "all";
type ViewMode = "classic" | "analytics";

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
  { value: "all", label: "الكل" },
  { value: "30d", label: "آخر 30 يومًا" },
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

function numberBelowThousandToArabic(value: number): string {
  const ones = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
  const teens = [
    "عشرة",
    "أحد عشر",
    "اثنا عشر",
    "ثلاثة عشر",
    "أربعة عشر",
    "خمسة عشر",
    "ستة عشر",
    "سبعة عشر",
    "ثمانية عشر",
    "تسعة عشر",
  ];
  const tens = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
  const hundreds = ["", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"];

  const parts: string[] = [];
  const hundred = Math.floor(value / 100);
  const rest = value % 100;

  if (hundred > 0) parts.push(hundreds[hundred]);
  if (rest > 0) {
    if (rest < 10) {
      parts.push(ones[rest]);
    } else if (rest < 20) {
      parts.push(teens[rest - 10]);
    } else {
      const one = rest % 10;
      const ten = Math.floor(rest / 10);
      parts.push(one > 0 ? `${ones[one]} و${tens[ten]}` : tens[ten]);
    }
  }

  return parts.join(" و");
}

function scaleGroupToArabic(value: number, singular: string, dual: string, plural: string, singularAccusative: string) {
  if (value === 1) return singular;
  if (value === 2) return dual;
  const words = numberBelowThousandToArabic(value);
  if (value >= 3 && value <= 10) return `${words} ${plural}`;
  return `${words} ${singularAccusative}`;
}

function numberToArabicWords(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded === 0) return "صفر";

  const scales = [
    { singular: "", dual: "", plural: "", singularAccusative: "" },
    { singular: "ألف", dual: "ألفان", plural: "آلاف", singularAccusative: "ألفًا" },
    { singular: "مليون", dual: "مليونان", plural: "ملايين", singularAccusative: "مليونًا" },
    { singular: "مليار", dual: "ملياران", plural: "مليارات", singularAccusative: "مليارًا" },
  ];

  const groups: number[] = [];
  let remaining = rounded;
  while (remaining > 0) {
    groups.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }

  const parts: string[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === 0) continue;
    if (index === 0) {
      parts.push(numberBelowThousandToArabic(group));
    } else {
      const scale = scales[index] ?? scales[scales.length - 1];
      parts.push(scaleGroupToArabic(group, scale.singular, scale.dual, scale.plural, scale.singularAccusative));
    }
  }

  return parts.join(" و");
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

function YoutubeViewsCard({ stats }: { stats: PublicAchievements["youtubeViews"] }) {
  const hasValue = stats.totalViews !== null;
  return (
    <Card className="border-[#eadfcd] bg-white/90 shadow-sm backdrop-blur">
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-black leading-6 text-[#5f796d]">
              مشاهدات قنوات YouTube التابعة لتطبيق تلاوات الحرمين
            </p>
            <p className="mt-3 break-words text-3xl font-black leading-tight text-[#103c2d] sm:text-5xl">
              {hasValue ? `${formatNumber(stats.totalViews!)} مشاهدة` : "غير متاح مؤقتًا"}
            </p>
            {hasValue ? (
              <p className="mt-3 max-w-3xl text-sm font-bold leading-7 text-[#5f796d] sm:text-base">
                {numberToArabicWords(stats.totalViews!)} مشاهدة
              </p>
            ) : null}
            <p className="mt-3 text-xs text-[#7c8f85]">
              {stats.updatedAt ? `آخر تحديث: ${formatDateTime(stats.updatedAt)}` : "لم يتم تحديث الرقم بعد"}
            </p>
          </div>
          <div className="rounded-lg border border-sky-100 bg-sky-50 p-3 text-sky-700">
            <Eye className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PeriodSelectorCard({
  period,
  onChange,
}: {
  period: PeriodKey;
  onChange: (period: PeriodKey) => void;
}) {
  return (
    <Card className="border-[#eadfcd] bg-white/88 shadow-sm backdrop-blur">
      <CardContent className="p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_260px] sm:items-end">
          <div>
            <p className="text-base font-black text-[#103c2d]">الفترة</p>
            <p className="mt-1 text-sm text-[#6f8378]">اختر الفترة التي تريد عرض إحصائياتها.</p>
          </div>
          <select
            id="achievement-period"
            value={period}
            onChange={(event) => onChange(event.target.value as PeriodKey)}
            className="h-12 w-full rounded-lg border border-[#d8cba9] bg-white px-3 text-base font-bold text-[#103c2d] outline-none focus:border-[#b88724]"
          >
            {periodOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </CardContent>
    </Card>
  );
}

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (viewMode: ViewMode) => void;
}) {
  const options: Array<{ value: ViewMode; label: string }> = [
    { value: "classic", label: "العرض الكلاسيكي" },
    { value: "analytics", label: "العرض التحليلي" },
  ];

  return (
    <div className="inline-flex rounded-lg border border-[#d8cba9] bg-white/85 p-1 shadow-sm">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-2 text-sm font-black transition-colors sm:px-4 ${
            viewMode === option.value
              ? "bg-[#d6a12a] text-[#103c2d] shadow-sm"
              : "text-[#5f796d] hover:bg-[#f7f0df] hover:text-[#103c2d]"
          }`}
        >
          {option.label}
        </button>
      ))}
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

const chartPalette = ["#0f5b3d", "#c59226", "#2563eb", "#dc2626", "#7c3aed", "#0f766e", "#ea580c", "#475569"];

function PlatformDistributionDonut({
  rows,
}: {
  rows: PublicAchievements["achievementsByPlatform"];
}) {
  const total = rows.reduce((sum, row) => sum + row.publications, 0);
  if (rows.length === 0 || total <= 0) {
    return (
      <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
        لا توجد بيانات منصات للعرض.
      </p>
    );
  }

  let cursor = 0;
  const segments = rows.map((row, index) => {
    const value = (row.publications / total) * 100;
    const start = cursor;
    const end = cursor + value;
    cursor = end;
    return {
      ...row,
      color: chartPalette[index % chartPalette.length],
      percentage: value,
      start,
      end,
    };
  });
  const gradient = segments.map((segment) => `${segment.color} ${segment.start}% ${segment.end}%`).join(", ");

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr] lg:items-center">
      <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-full border border-[#eadfcd] shadow-inner" style={{ background: `conic-gradient(${gradient})` }}>
        <div className="flex h-36 w-36 flex-col items-center justify-center rounded-full border border-[#eadfcd] bg-[#fffdf8] text-center shadow-sm">
          <span className="text-xs font-bold text-[#6f8378]">إجمالي المنصات</span>
          <span className="mt-1 text-2xl font-black text-[#103c2d]">{formatNumber(total)}</span>
        </div>
      </div>
      <div className="space-y-3">
        {segments.map((segment) => (
          <div key={segment.platformId} className="flex items-center justify-between gap-3 rounded-lg border border-[#efe6d8] bg-[#fffdf8] px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
              <span className="truncate text-sm font-black text-[#103c2d]">{segment.name}</span>
            </div>
            <span className="text-sm font-black text-[#5f796d]">{formatAverage(segment.percentage)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformComparisonBars({
  rows,
}: {
  rows: PublicAchievements["achievementsByPlatform"];
}) {
  const maxValue = Math.max(...rows.map((row) => row.publications), 1);
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
        لا توجد بيانات منصات للمقارنة.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {rows.map((row, index) => (
        <div key={row.platformId} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 font-black text-[#103c2d]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f4eddf]">
                <PlatformIcon name={row.name} className="h-4 w-4" />
              </span>
              <span className="truncate">{row.name}</span>
            </div>
            <span className="rounded-full bg-[#0f5b3d]/10 px-3 py-1 text-sm font-black text-[#0f5b3d]">
              {formatNumber(row.publications)}
            </span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-[#eee4d2]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(5, (row.publications / maxValue) * 100)}%`,
                backgroundColor: chartPalette[index % chartPalette.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function PlatformSummaryTable({
  rows,
}: {
  rows: PublicAchievements["achievementsByPlatform"];
}) {
  const total = rows.reduce((sum, row) => sum + row.publications, 0);
  if (rows.length === 0 || total <= 0) {
    return (
      <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
        لا توجد بيانات منصات للعرض.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[#eadfcd] bg-[#fffdf8]">
      <table className="w-full min-w-[560px] text-right text-sm">
        <thead className="bg-[#f4eddf] text-[#103c2d]">
          <tr>
            <th className="px-4 py-3 font-black">المنصة</th>
            <th className="px-4 py-3 font-black">الإجمالي</th>
            <th className="px-4 py-3 font-black">النسبة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#eadfcd]">
          {rows.map((row) => (
            <tr key={row.platformId}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2 font-bold text-[#103c2d]">
                  <PlatformIcon name={row.name} className="h-4 w-4" />
                  <span>{row.name}</span>
                </div>
              </td>
              <td className="px-4 py-3 font-black text-[#0f5b3d]">{formatNumber(row.publications)}</td>
              <td className="px-4 py-3 font-bold text-[#5f796d]">{formatAverage((row.publications / total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsView({
  data,
  period,
  onPeriodChange,
  last30DailyAverage,
}: {
  data: PublicAchievements;
  period: PeriodKey;
  onPeriodChange: (period: PeriodKey) => void;
  last30DailyAverage: number;
}) {
  return (
    <>
      <section>
        <SectionTitle
          icon={Globe2}
          title="لوحة الأثر التحليلية"
          hint="عرض بصري عام يوضح حجم الإنجاز وتوزيعه دون تفاصيل تشغيلية."
        />
        <YoutubeViewsCard stats={data.youtubeViews} />
        <div className="mt-4">
          <PeriodSelectorCard period={period} onChange={onPeriodChange} />
        </div>
      </section>

      <section>
        <SectionTitle
          icon={TrendingUp}
          title="ملخص الأرقام"
          hint="أرقام مختصرة تساعد على قراءة أثر المشروع بسرعة."
        />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
          <StatCard
            title="إجمالي المنشورات"
            value={formatNumber(data.allTime.totalPublications)}
            icon={LineChart}
            hint="تراكمي"
          />
          <StatCard
            title="منشورات آخر 30 يومًا"
            value={formatNumber(data.last30Publications)}
            icon={Clock}
            hint="آخر 30 يومًا"
            tone="blue"
          />
          <StatCard
            title="متوسط الإنجاز اليومي"
            value={formatAverage(last30DailyAverage)}
            icon={TrendingUp}
            hint="آخر 30 يومًا"
            tone="gold"
          />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
          <CardContent className="p-6">
            <SectionTitle
              icon={BarChart3}
              title="توزيع الإنجازات حسب المنصات"
              hint="نسبة كل منصة من إجمالي الإنجازات."
            />
            <PlatformDistributionDonut rows={data.achievementsByPlatform} />
          </CardContent>
        </Card>
        <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
          <CardContent className="p-6">
            <SectionTitle
              icon={LineChart}
              title="مقارنة المنصات"
              hint="ترتيب المنصات حسب حجم الإنجاز."
            />
            <PlatformComparisonBars rows={data.achievementsByPlatform} />
          </CardContent>
        </Card>
      </section>

      <section>
        <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
          <CardContent className="p-6">
            <SectionTitle
              icon={LineChart}
              title="النمو الشهري"
              hint="رسم يوضح تطور المنشورات عبر الأشهر."
            />
            <MonthlyGrowthChart rows={data.monthlyGrowth} />
          </CardContent>
        </Card>
      </section>

      <section>
        <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
          <CardContent className="p-6">
            <SectionTitle
              icon={Globe2}
              title="جدول المنصات المختصر"
              hint="قراءة رقمية سريعة لإجمالي كل منصة وحصتها."
            />
            <div className="overflow-x-auto">
              <PlatformSummaryTable rows={data.achievementsByPlatform} />
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

export default function Achievements() {
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("classic");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-achievements", period],
    queryFn: () => fetchPublicAchievements(period),
    staleTime: 60_000,
  });

  const maxPlatform = Math.max(...(data?.achievementsByPlatform.map((row) => row.publications) ?? [0]), 1);
  const selectedPeriodLabel = periodOptions.find((option) => option.value === period)?.label ?? "الكل";
  const last30DailyAverage = data ? data.last30Publications / 30 : 0;

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

        <div className="mx-auto w-full max-w-7xl px-5 pb-12 pt-6 sm:px-8 lg:pb-16">
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
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:py-10">
        <div className="flex justify-center sm:justify-end">
          <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
        </div>
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
            {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-32 rounded-lg bg-white/70" />)}
          </div>
        ) : isError || !data ? (
          <Card className="border-red-200 bg-red-50/80">
            <CardContent className="py-8 text-center font-bold text-red-700">
              تعذر تحميل بيانات الإنجازات الآن.
            </CardContent>
          </Card>
        ) : (
          viewMode === "classic" ? (
          <>
            <section id="platforms">
              <SectionTitle
                icon={Globe2}
                title="الإحصائيات التراكمية"
                hint="أرقام عامة لعرض أثر المشروع."
              />
              <YoutubeViewsCard stats={data.youtubeViews} />
              <div className="mt-4">
                <PeriodSelectorCard period={period} onChange={setPeriod} />
              </div>
            </section>

            <section>
              <SectionTitle
                icon={Clock}
                title="إحصائيات الفترة"
                hint={`تتغير حسب اختيار الفترة الحالية: ${selectedPeriodLabel}.`}
              />
              <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
                <StatCard
                  title="إجمالي منشورات الفترة"
                  value={formatNumber(data.totalPublications)}
                  icon={LineChart}
                  hint={selectedPeriodLabel}
                />
                <StatCard
                  title="المهام المكتملة في الفترة"
                  value={formatNumber(data.completedTasks)}
                  icon={CheckCircle2}
                  hint="حسب الفترة المختارة"
                />
                <StatCard
                  title="متوسط الإنجاز اليومي"
                  value={formatAverage(last30DailyAverage)}
                  icon={TrendingUp}
                  hint="آخر 30 يومًا"
                  tone="gold"
                />
              </div>
            </section>

            <section>
              <Card className="mt-8 border-[#eadfcd] bg-white/88 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle
                    icon={BarChart3}
                    title="الإنجازات حسب المنصات"
                    hint="عرض إجمالي الإنجازات لكل منصة."
                  />
                  {data.achievementsByPlatform.length === 0 ? (
                    <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
                      لا توجد منصات للعرض حاليًا.
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
                    hint="يرتبط بالفترة المختارة ويبدأ من أول شهر توجد فيه بيانات فعلية."
                  />
                  <MonthlyGrowthChart rows={data.monthlyGrowth} />
                </CardContent>
              </Card>
            </section>
          </>
          ) : (
            <AnalyticsView
              data={data}
              period={period}
              onPeriodChange={setPeriod}
              last30DailyAverage={last30DailyAverage}
            />
          )
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
