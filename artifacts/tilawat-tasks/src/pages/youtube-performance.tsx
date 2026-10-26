import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useIsAdmin } from "@/lib/roles";
import { RefreshCw, ExternalLink } from "lucide-react";

// أداء مقاطع يوتيوب وأسباب انتشارها (الإصدار 70). الأرقام من واجهة يوتيوب الرسمية بمفتاح الموقع.
// «مؤشر الانتشار» = مشاهدات المقطع ÷ مشاهدات المقطع المعتاد في قناته (1 = معتاد، 3 = ثلاثة أضعاف المعتاد).
type PerfVideo = { videoId: string; title: string; channel: string; type: string; publishedAt: string; ageDays: number; hourRiyadh: number; durationSec: number; views: number; likes: number; comments: number; viewsPerDay: number; score: number | null };
type Perf = {
  generatedAt: string; days: number;
  channels: Array<{ channel: string; baseline: number; videos: number; totalViews: number }>;
  types: Array<{ type: string; count: number; totalViews: number; medianScore: number | null }>;
  features: Array<{ label: string; withCount: number; withMedian: number | null; withoutCount: number; withoutMedian: number | null }>;
  videos: PerfVideo[]; errors: string[];
};

const fmt = (n: number) => n.toLocaleString("en-US");
const when = (v: string) => new Date(v).toLocaleString("ar-SA-u-nu-latn", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" });
const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const scoreCls = (s: number | null) => (s == null ? "text-muted-foreground" : s >= 3 ? "text-emerald-600 font-bold" : s >= 1.5 ? "text-emerald-600" : s < 0.5 ? "text-red-500" : "");

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? "تعذّر جلب البيانات");
  return body as T;
}

export default function YoutubePerformancePage() {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const [channel, setChannel] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<"score" | "views" | "date">("score");
  const [refreshing, setRefreshing] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ["yt-performance", days], queryFn: () => api<Perf>(`/api/youtube/performance?days=${days}`), enabled: isAdmin });

  const refresh = async () => {
    setRefreshing(true);
    try { queryClient.setQueryData(["yt-performance", days], await api<Perf>(`/api/youtube/performance?days=${days}&refresh=1`)); } finally { setRefreshing(false); }
  };

  const list = useMemo(() => {
    const v = (data?.videos ?? []).filter((x) => (!channel || x.channel === channel) && (!type || x.type === type));
    return [...v].sort((a, b) => (sort === "views" ? b.views - a.views : sort === "date" ? b.publishedAt.localeCompare(a.publishedAt) : (b.score ?? 0) - (a.score ?? 0)));
  }, [data, channel, type, sort]);

  if (!isAdmin) return <div className="p-6 text-muted-foreground">هذه الصفحة للمدير فقط.</div>;

  return (
    <div dir="rtl" className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">أداء مقاطع يوتيوب</h1>
          <p className="text-sm text-muted-foreground">أي المقاطع انتشرت أكثر من المعتاد في قناتها، ولماذا. تتحدث تلقائيًا كل 6 ساعات.</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="المدة">
            <option value={14}>آخر 14 يومًا</option>
            <option value={30}>آخر 30 يومًا</option>
            <option value={60}>آخر 60 يومًا</option>
          </select>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}><RefreshCw className={`ml-1 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />تحديث الآن</Button>
        </div>
      </div>

      {isLoading && <div className="text-muted-foreground">جارٍ جلب المقاطع من يوتيوب…</div>}
      {error && <div className="text-red-500">{(error as Error).message}</div>}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>ما الذي ينتشر؟ حسب نوع المقطع</CardTitle>
              <CardDescription>«مؤشر الانتشار» = مشاهدات المقطع مقسومة على مشاهدات المقطع المعتاد في قناته. 1 يعني معتادًا، و3 يعني ثلاثة أضعاف المعتاد. لا تُحسب المقاطع الأحدث من 4 أيام في المؤشر.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.types.map((t) => (
                <button key={t.type} type="button" onClick={() => setType(type === t.type ? "" : t.type)} className={`rounded-lg border p-3 text-right transition hover:bg-muted ${type === t.type ? "border-primary bg-muted" : ""}`}>
                  <div className="text-sm font-semibold">{t.type}</div>
                  <div className={`text-2xl ${scoreCls(t.medianScore)}`}>{t.medianScore == null ? "—" : `×${t.medianScore}`}</div>
                  <div className="text-xs text-muted-foreground">{t.count} مقطعًا · {fmt(t.totalViews)} مشاهدة</div>
                </button>
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>أثر العنوان ووقت النشر</CardTitle>
                <CardDescription>في مقاطع الصلاة العادية فقط، مقارنة المؤشر مع الصفة وبدونها.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {data.features.map((f) => (
                  <div key={f.label} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0">
                    <span>{f.label}</span>
                    <span className="tabular-nums">معها <b className={scoreCls(f.withMedian)}>{f.withMedian == null ? "—" : `×${f.withMedian}`}</b> ({f.withCount}) · بدونها <b>{f.withoutMedian == null ? "—" : `×${f.withoutMedian}`}</b> ({f.withoutCount})</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>القنوات</CardTitle>
                <CardDescription>«المعتاد» = مشاهدات مقطع الصلاة العادي في القناة، وعليه يُقاس الانتشار.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {data.channels.map((c) => (
                  <button key={c.channel} type="button" onClick={() => setChannel(channel === c.channel ? "" : c.channel)} className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-right hover:bg-muted ${channel === c.channel ? "bg-muted font-semibold" : ""}`}>
                    <span>{c.channel}</span>
                    <span className="tabular-nums text-muted-foreground">المعتاد {fmt(c.baseline)} · {c.videos} مقطعًا · {fmt(c.totalViews)} مشاهدة</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>المقاطع ({list.length})</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {(channel || type) && <Button variant="ghost" size="sm" onClick={() => { setChannel(""); setType(""); }}>إزالة التصفية</Button>}
                  <select className="h-8 rounded-md border bg-background px-2" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="الترتيب">
                    <option value="score">الأكثر انتشارًا</option>
                    <option value="views">الأكثر مشاهدة</option>
                    <option value="date">الأحدث</option>
                  </select>
                </div>
              </div>
              <CardDescription>آخر تحديث: {when(data.generatedAt)}{channel && ` · ${channel}`}{type && ` · ${type}`}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[36rem] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr className="border-b text-right"><th className="p-2">المؤشر</th><th className="p-2">العنوان</th><th className="p-2">الشيخ</th><th className="p-2">النوع</th><th className="p-2">المشاهدات</th><th className="p-2">المدة</th><th className="p-2">النشر</th></tr>
                  </thead>
                  <tbody>
                    {list.map((v) => (
                      <tr key={v.videoId} className="border-b align-top">
                        <td className={`p-2 tabular-nums ${scoreCls(v.ageDays >= 4 ? v.score : null)}`}>{v.score == null ? "—" : `×${v.score}`}{v.ageDays < 4 && <div className="text-[10px] text-muted-foreground">جديد</div>}</td>
                        <td className="p-2"><a href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer" className="hover:underline">{v.title}<ExternalLink className="mr-1 inline h-3 w-3" /></a></td>
                        <td className="whitespace-nowrap p-2">{v.channel}</td>
                        <td className="p-2"><Badge variant="outline" className="whitespace-nowrap">{v.type}</Badge></td>
                        <td className="p-2 tabular-nums">{fmt(v.views)}<div className="text-[10px] text-muted-foreground">{fmt(v.viewsPerDay)} يوميًا</div></td>
                        <td className="p-2 tabular-nums">{dur(v.durationSec)}</td>
                        <td className="whitespace-nowrap p-2 text-xs">{when(v.publishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          {data.errors.length > 0 && <div className="text-sm text-red-500">{data.errors.join(" · ")}</div>}
        </>
      )}
    </div>
  );
}
