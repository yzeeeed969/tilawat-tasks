import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { BarChart3, CheckCircle2, Clock, Globe2, LineChart, ListTodo } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PlatformIcon } from "@/lib/platform-icon";
import { formatHijriDate } from "@/lib/hijri-date";

type PublicAchievements = {
  totalPublications: number;
  completedTasks: number;
  last30Publications: number;
  activePlatforms: number;
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

async function fetchPublicAchievements(): Promise<PublicAchievements> {
  const response = await fetch("/api/public/achievements");
  if (!response.ok) throw new Error("Failed to load achievements");
  return response.json();
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ar-SA").format(value);
}

function StatCard({
  title,
  value,
  icon: Icon,
  hint,
}: {
  title: string;
  value: number;
  icon: React.ElementType;
  hint: string;
}) {
  return (
    <Card className="border-border/60 shadow-sm">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="mt-2 text-3xl font-bold text-sidebar-primary">{formatNumber(value)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className="rounded-lg bg-sidebar-primary/10 p-3">
            <Icon className="h-5 w-5 text-sidebar-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Achievements() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-achievements"],
    queryFn: fetchPublicAchievements,
    staleTime: 60_000,
  });

  const maxMonthly = Math.max(...(data?.monthlyGrowth.map((row) => row.publications) ?? [0]), 1);
  const maxPlatform = Math.max(...(data?.achievementsByPlatform.map((row) => row.publications) ?? [0]), 1);

  return (
    <main dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10">
        <header className="space-y-3 border-b border-border pb-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-sidebar-primary/20 bg-sidebar-primary/5 px-3 py-1 text-sm font-semibold text-sidebar-primary">
            <Globe2 className="h-4 w-4" />
            صفحة عامة
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">إنجازات فريق تلاوات الحرمين</h1>
            <p className="max-w-2xl text-muted-foreground">
              عرض مختصر لأثر العمل والمواد المنشورة، بدون أسماء أعضاء أو تفاصيل تشغيلية داخلية.
            </p>
          </div>
          {data?.lastUpdated && (
            <p className="text-xs text-muted-foreground">
              آخر تحديث: {format(new Date(data.lastUpdated), "EEEE، d MMMM yyyy، h:mm a", { locale: ar })}
            </p>
          )}
        </header>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}
          </div>
        ) : isError || !data ? (
          <Card className="border-red-200 bg-red-50/50">
            <CardContent className="py-8 text-center text-red-700">
              تعذر تحميل بيانات الإنجازات الآن.
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard title="إجمالي المنشورات" value={data.totalPublications} icon={LineChart} hint="من المهام المكتملة والشواهد" />
              <StatCard title="المهام المنجزة" value={data.completedTasks} icon={CheckCircle2} hint="إجمالي المهام المكتملة" />
              <StatCard title="آخر 30 يومًا" value={data.last30Publications} icon={Clock} hint="مواد منشورة حديثًا" />
              <StatCard title="منصات نشطة" value={data.activePlatforms} icon={Globe2} hint="نشاط منشور خلال آخر 30 يومًا" />
            </section>

            <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <Card className="border-border/60 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-sidebar-primary" />
                    الإنجازات حسب المنصات خلال آخر 30 يومًا
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {data.achievementsByPlatform.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">لا توجد إنجازات في آخر 30 يومًا.</p>
                  ) : (
                    data.achievementsByPlatform.map((platform) => (
                      <div key={platform.platformId} className="space-y-2">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <div className="flex items-center gap-2 font-semibold">
                            <PlatformIcon name={platform.name} icon={platform.icon} className="h-5 w-5" />
                            {platform.name}
                          </div>
                          <span className="font-bold text-sidebar-primary">{formatNumber(platform.publications)} منشور</span>
                        </div>
                        <Progress value={(platform.publications / maxPlatform) * 100} className="h-2" />
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card className="border-border/60 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ListTodo className="h-5 w-5 text-sidebar-primary" />
                    آخر 12 شهرًا
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">الشهر</TableHead>
                        <TableHead className="text-right">المنشورات</TableHead>
                        <TableHead className="text-right">المهام</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.monthlyGrowth.map((row) => {
                        const date = new Date(row.monthStart);
                        return (
                          <TableRow key={row.monthStart}>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium">{formatHijriDate(date, { month: "long", year: "numeric" })}</span>
                                <span className="text-xs text-muted-foreground">{format(date, "MMMM yyyy", { locale: ar })}</span>
                              </div>
                            </TableCell>
                            <TableCell className="font-bold text-sidebar-primary">{formatNumber(row.publications)}</TableCell>
                            <TableCell>{formatNumber(row.completedTasks)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </section>

            <Card className="border-border/60 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <LineChart className="h-5 w-5 text-sidebar-primary" />
                  النمو الشهري
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.monthlyGrowth.map((row) => {
                  const date = new Date(row.monthStart);
                  return (
                    <div key={`growth-${row.monthStart}`} className="grid gap-2 sm:grid-cols-[180px_1fr_80px] sm:items-center">
                      <div className="text-sm font-semibold">
                        {formatHijriDate(date, { month: "long", year: "numeric" })}
                      </div>
                      <Progress value={(row.publications / maxMonthly) * 100} className="h-3" />
                      <div className="text-sm font-bold text-sidebar-primary sm:text-left">{formatNumber(row.publications)}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
