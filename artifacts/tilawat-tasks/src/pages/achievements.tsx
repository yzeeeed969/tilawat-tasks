import { useState, type ElementType } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { BarChart3, CalendarDays, CheckCircle2, Clock, Globe2, LineChart, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformIcon } from "@/lib/platform-icon";
import { formatHijriDate } from "@/lib/hijri-date";

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
    completedTasks: number;
  };
  achievementsByPlatform: Array<{
    platformId: number;
    name: string;
    icon: string;
    color: string;
    publications: number;
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
  { value: "all", label: "منذ البداية" },
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

function JoodLogoMark() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-200/80 bg-white/75 px-3 py-2 shadow-sm backdrop-blur">
      <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#0f5b3d] text-lg font-black text-[#d8ad45]">
        جود
      </div>
      <div className="leading-tight">
        <p className="text-sm font-bold text-[#123f2e]">جمعية جود</p>
        <p className="text-xs text-[#6b7f73]">لخدمة الحاج والمعتمر</p>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  hint,
  tone = "green",
}: {
  title: string;
  value: string;
  icon: ElementType;
  hint: string;
  tone?: "green" | "gold" | "blue";
}) {
  const toneClass = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-100",
    gold: "bg-amber-50 text-amber-700 border-amber-100",
    blue: "bg-sky-50 text-sky-700 border-sky-100",
  }[tone];

  return (
    <Card className="border-[#eadfcd] bg-white/88 shadow-sm backdrop-blur">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#5f796d]">{title}</p>
            <p className="mt-2 text-3xl font-black text-[#103c2d]">{value}</p>
            <p className="mt-1 text-xs text-[#7c8f85]">{hint}</p>
          </div>
          <div className={`rounded-lg border p-3 ${toneClass}`}>
            <Icon className="h-5 w-5" />
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

export default function Achievements() {
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-achievements", period],
    queryFn: () => fetchPublicAchievements(period),
    staleTime: 60_000,
  });

  const maxMonthly = Math.max(...(data?.monthlyGrowth.map((row) => row.publications) ?? [0]), 1);
  const maxPlatform = Math.max(...(data?.achievementsByPlatform.map((row) => row.publications) ?? [0]), 1);
  const selectedPeriodLabel = periodOptions.find((option) => option.value === period)?.label ?? "آخر 30 يومًا";

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
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <JoodLogoMark />
          <div className="flex items-center gap-5 text-sm font-bold text-[#224f3d]">
            <a href="#top" className="transition hover:text-[#b88724]">الرئيسية</a>
            <a href="#platforms" className="transition hover:text-[#b88724]">منصاتنا</a>
            <a href="#contact" className="transition hover:text-[#b88724]">التواصل</a>
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
            {data?.lastUpdated && (
              <p className="mt-5 text-sm text-[#6d8177]">
                آخر تحديث: {format(new Date(data.lastUpdated), "EEEE، d MMMM yyyy، h:mm a", { locale: ar })}
              </p>
            )}
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-32 rounded-lg bg-white/70" />)}
          </div>
        ) : isError || !data ? (
          <Card className="border-red-200 bg-red-50/80">
            <CardContent className="py-8 text-center font-bold text-red-700">
              تعذر تحميل بيانات الإنجازات الآن.
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <StatCard
                title="إجمالي المنشورات"
                value={formatNumber(data.totalPublications)}
                icon={LineChart}
                hint={selectedPeriodLabel}
              />
              <StatCard
                title="إجمالي الإنجازات"
                value={formatNumber(data.completedTasks)}
                icon={CheckCircle2}
                hint="مهام مكتملة في الفترة"
                tone="gold"
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
                hint="منشور يوميًا تقريبًا"
                tone="gold"
              />
            </section>

            <section className="grid gap-5 lg:grid-cols-[1fr_1.4fr]" id="platforms">
              <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle
                    icon={CalendarDays}
                    title="منذ بداية المشروع"
                    hint="البداية المعتمدة: 24 مايو 2026"
                  />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                    <div className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] p-4">
                      <p className="text-sm font-bold text-[#6d8177]">تاريخ البداية</p>
                      <p className="mt-2 text-2xl font-black">{formatDate(data.projectStartDate)}</p>
                      <p className="mt-1 text-sm text-[#7c8f85]">
                        {formatHijriDate(new Date(data.projectStartDate), { day: "numeric", month: "long", year: "numeric" })}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
                        <p className="text-sm font-bold text-emerald-800">كل المنشورات</p>
                        <p className="mt-2 text-3xl font-black text-emerald-900">{formatNumber(data.allTime.totalPublications)}</p>
                      </div>
                      <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
                        <p className="text-sm font-bold text-amber-800">كل الإنجازات</p>
                        <p className="mt-2 text-3xl font-black text-amber-900">{formatNumber(data.allTime.completedTasks)}</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-[#eadfcd] bg-white/88 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle
                    icon={BarChart3}
                    title="الإنجازات حسب المنصات"
                    hint={`إحصاء مجمع حسب ${selectedPeriodLabel}`}
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
                                <PlatformIcon name={platform.name} icon={platform.icon} className="h-5 w-5" />
                              </span>
                              <span>{platform.name}</span>
                            </div>
                            <span className="rounded-full bg-[#0f5b3d]/10 px-3 py-1 text-sm font-black text-[#0f5b3d]">
                              {formatNumber(platform.publications)} منشور
                            </span>
                          </div>
                          <Progress value={(platform.publications / maxPlatform) * 100} className="mt-3 h-2 bg-[#eee4d2]" />
                          <p className="mt-2 text-xs font-semibold text-[#778b80]">
                            {formatNumber(platform.completedTasks)} مهمة مكتملة
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
                  {data.monthlyGrowth.length === 0 ? (
                    <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
                      لا توجد بيانات نمو لهذه الفترة.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {data.monthlyGrowth.map((row) => {
                        const date = new Date(row.monthStart);
                        return (
                          <div key={`growth-${row.monthStart}`} className="grid gap-3 rounded-lg border border-[#efe6d8] bg-[#fffdf8] p-4 sm:grid-cols-[220px_1fr_100px] sm:items-center">
                            <div>
                              <p className="font-black text-[#103c2d]">
                                {formatHijriDate(date, { month: "long", year: "numeric" })}
                              </p>
                              <p className="text-xs font-semibold text-[#7c8f85]">
                                {format(date, "MMMM yyyy", { locale: ar })}
                              </p>
                            </div>
                            <Progress value={(row.publications / maxMonthly) * 100} className="h-3 bg-[#eee4d2]" />
                            <div className="text-lg font-black text-[#0f5b3d] sm:text-left">{formatNumber(row.publications)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
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
