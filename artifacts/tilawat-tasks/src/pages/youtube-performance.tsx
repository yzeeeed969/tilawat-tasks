import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useIsAdmin } from "@/lib/roles";
import { RefreshCw } from "lucide-react";

// أداء مقاطع يوتيوب — نسخة مبسطة (الإصدار 71): جمل واضحة بدل الرموز والجداول.
// المقارنة دائمًا مع «المقطع العادي» في قناة الشيخ نفسها، حتى لا تظلم القنوات الصغيرة.
type PerfVideo = { videoId: string; title: string; channel: string; type: string; publishedAt: string; ageDays: number; views: number; score: number | null };
type Perf = {
  generatedAt: string;
  types: Array<{ type: string; count: number; totalViews: number; medianScore: number | null }>;
  features: Array<{ label: string; withMedian: number | null; withoutMedian: number | null }>;
  videos: PerfVideo[];
};

const fmt = (n: number) => n.toLocaleString("en-US");
const when = (v: string) => new Date(v).toLocaleString("ar-SA-u-nu-latn", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" });

// تحويل النسبة إلى عبارة عربية مفهومة.
function compare(r: number | null): string {
  if (r == null) return "لا توجد بيانات كافية بعد";
  if (r >= 10) return `${Math.round(r)} ضعفًا من المقطع العادي`;
  if (r >= 2.5) return `${Math.round(r)} أضعاف المقطع العادي`;
  if (r >= 1.75) return "ضعف المقطع العادي تقريبًا";
  if (r >= 1.2) return "أكثر قليلًا من المقطع العادي";
  if (r >= 0.8) return "مثل المقطع العادي";
  if (r >= 0.4) return "أقل من المقطع العادي";
  return "أقل بكثير من المقطع العادي";
}
const good = (r: number | null) => r != null && r >= 1.2;
const bad = (r: number | null) => r != null && r < 0.8;

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? "تعذّر جلب البيانات");
  return body as T;
}

export default function YoutubePerformancePage() {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ["yt-performance"], queryFn: () => api<Perf>("/api/youtube/performance?days=30"), enabled: isAdmin });

  const refresh = async () => {
    setRefreshing(true);
    try { queryClient.setQueryData(["yt-performance"], await api<Perf>("/api/youtube/performance?days=30&refresh=1")); } finally { setRefreshing(false); }
  };

  if (!isAdmin) return <div className="p-6 text-muted-foreground">هذه الصفحة للمدير فقط.</div>;

  const types = (data?.types ?? []).filter((t) => t.type !== "مقطع صلاة" && t.type !== "بث مباشر" && t.medianScore != null);
  const winners = types.filter((t) => good(t.medianScore));
  const losers = types.filter((t) => bad(t.medianScore));
  const morning = data?.features.find((f) => f.label.includes("6 صباحًا"));
  const top = (data?.videos ?? []).filter((v) => v.ageDays >= 4 && v.score != null).slice(0, 5);
  const all = [...(data?.videos ?? [])].sort((a, b) => b.views - a.views);

  return (
    <div dir="rtl" className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">أداء مقاطع يوتيوب</h1>
          <p className="text-sm text-muted-foreground">آخر 30 يومًا في قنوات المشايخ. نقارن كل مقطع بالمقطع العادي في قناة الشيخ نفسه.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}><RefreshCw className={`ml-1 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />تحديث</Button>
      </div>

      {isLoading && <div className="text-muted-foreground">جارٍ جلب المقاطع…</div>}
      {error && <div className="text-red-500">{(error as Error).message}</div>}

      {data && (
        <>
          <Card>
            <CardHeader><CardTitle>الخلاصة</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-base leading-8">
              {winners.map((t) => (
                <p key={t.type}><b className="text-emerald-700 dark:text-emerald-400">{t.type}</b>: مشاهداتها {compare(t.medianScore)}.</p>
              ))}
              {losers.map((t) => (
                <p key={t.type}><b className="text-red-600 dark:text-red-400">{t.type}</b>: مشاهداتها {compare(t.medianScore)}.</p>
              ))}
              {morning && good(morning.withMedian) && (
                <p><b>أفضل وقت للنشر</b>: من 6 صباحًا إلى 12 ظهرًا. مقاطع الصلاة المنشورة فيه أخذت {compare(morning.withMedian)}.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>أكثر 5 مقاطع انتشارًا</CardTitle></CardHeader>
            <CardContent>
              <ol className="space-y-4">
                {top.map((v, i) => (
                  <li key={v.videoId} className="flex gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
                    <div className="min-w-0">
                      <a href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer" className="font-semibold leading-7 hover:underline">{v.title}</a>
                      <div className="text-sm text-muted-foreground">الشيخ {v.channel} · {fmt(v.views)} مشاهدة · {compare(v.score)} في قناته</div>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>كل المقاطع ({all.length})</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>{showAll ? "إخفاء" : "عرض"}</Button>
            </CardHeader>
            {showAll && (
              <CardContent className="max-h-[32rem] space-y-2 overflow-auto">
                {all.map((v) => (
                  <div key={v.videoId} className="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-0">
                    <div className="min-w-0">
                      <a href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer" className="hover:underline">{v.title}</a>
                      <div className="text-xs text-muted-foreground">الشيخ {v.channel}</div>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums">{fmt(v.views)}</span>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>

          <p className="text-xs text-muted-foreground">آخر تحديث: {when(data.generatedAt)}. تتحدث تلقائيًا كل 6 ساعات.</p>
        </>
      )}
    </div>
  );
}
