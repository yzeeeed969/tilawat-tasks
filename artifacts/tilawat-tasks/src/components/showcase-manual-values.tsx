import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// إدارة صفحة «منصات المشروع» العامة (/achievements): روابط المتاجر لكل تطبيق — الشيء اليدوي الوحيد (روابط
// ثابتة، ليست أرقامًا) — وتقرير تشخيص. كل الأرقام آلية من مصدرها الرسمي فقط، ولا إدخال يدوي لأي رقم.

type Diagnostics = {
  youtube: Array<{ pageId: number; pageName: string; pageUrl: string | null; status: "ok" | "missing"; channelId: string | null; problem: string | null }>;
  hidden: Array<{ what: string; why: string }>;
  followers: Array<{ platform: string; account: string; automatic: boolean; reason: string | null }>;
  youtubeBreakdown: { channels: Array<{ channelId: string; title: string; subscribers: number | null; views: number | null; pages: string[] }>; totalViews: number; totalSubscribers: number };
  apps: string[];
};
const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("ar-EG"));
const PLATFORM_LABEL: Record<string, string> = { instagram: "انستقرام", facebook: "فيسبوك", telegram: "تيليجرام", twitter: "تويتر / X", designs: "تصاميم (تيليجرام)" };
type Manual = {
  platforms: Array<{ id: number; name: string; iosUrl: string | null; androidUrl: string | null }>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? "فشلت العملية");
  return body as T;
}

export function ShowcaseManualValues() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["showcase-manual"], queryFn: () => api<Manual>("/api/showcase/manual") });
  const { data: diagnostics } = useQuery({ queryKey: ["showcase-diagnostics"], queryFn: () => api<Diagnostics>("/api/showcase/diagnostics") });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const onError = (err: Error) => toast({ title: err.message, variant: "destructive" });
  const done = () => { queryClient.invalidateQueries({ queryKey: ["showcase-manual"] }); toast({ title: "تم الحفظ — يظهر في صفحة المنصات خلال دقائق" }); };
  const saveApp = useMutation({
    mutationFn: (v: { id: number; iosUrl: string; androidUrl: string }) => api(`/api/showcase/manual/platforms/${v.id}`, { method: "PUT", body: JSON.stringify({ iosUrl: v.iosUrl || null, androidUrl: v.androidUrl || null }) }),
    onSuccess: done,
    onError,
  });
  const refresh = useMutation({
    mutationFn: () => api<Diagnostics>("/api/showcase/refresh", { method: "POST" }),
    onSuccess: (fresh) => { queryClient.setQueryData(["showcase-diagnostics"], fresh); toast({ title: "تم تحديث بيانات الصفحة" }); },
    onError,
  });

  if (!data) return null;
  const apps = data.platforms.filter((p) => /^تطبيق/.test(p.name.trim()));
  const value = (key: string, fallback: string | number | null) => draft[key] ?? (fallback == null ? "" : String(fallback));
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((s) => ({ ...s, [key]: e.target.value }));

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">بيانات صفحة «منصات المشروع» العامة</CardTitle>
        <CardDescription>
          كل الأرقام (المتابعون والمشتركون والمشاهدات والمنشورات) تُجلب آليًا من مصادرها الرسمية — لا إدخال يدوي.
          اليدوي الوحيد هنا روابط المتاجر لكل تطبيق.{" "}
          <a href="/achievements" target="_blank" rel="noopener noreferrer" className="text-sidebar-primary hover:underline">فتح الصفحة ↗</a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* التشخيص: الصفحة العامة تعرض فقط ما في صفحة المنصات — وهنا ما ينقص وما لم يعد يظهر. */}
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold">قنوات يوتيوب المسجّلة</div>
            <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>تحديث الآن</Button>
          </div>
          {diagnostics && diagnostics.youtube.length === 0 && (
            <p className="text-xs text-amber-700">لا توجد صفحات على منصة يوتيوب في صفحة المنصات — قسم يوتيوب لن يظهر. أضف صفحة لكل قناة برابطها.</p>
          )}
          {diagnostics?.youtube.map((row) => (
            <div key={row.pageId} className="text-xs">
              <span className={row.status === "ok" ? "text-green-700" : "text-red-700"}>{row.status === "ok" ? "✔" : "✘"}</span>{" "}
              <b>{row.pageName}</b>{" "}
              {row.status === "ok" ? <span className="text-muted-foreground" dir="ltr">({row.channelId})</span> : <span className="text-red-700">— ينقصها: {row.problem}</span>}
            </div>
          ))}
          {diagnostics && diagnostics.youtubeBreakdown.channels.length > 0 && (
            <div className="overflow-x-auto pt-2">
              <div className="text-sm font-semibold">تفصيل مجموع يوتيوب (كل قناة تُحسب مرة واحدة)</div>
              <table className="w-full min-w-[560px] text-xs">
                <thead><tr className="text-muted-foreground"><th className="p-1 text-right font-medium">القناة</th><th className="p-1 text-right font-medium">المعرّف</th><th className="p-1 text-right font-medium">المشتركون</th><th className="p-1 text-right font-medium">المشاهدات</th><th className="p-1 text-right font-medium">مسجّلة في</th></tr></thead>
                <tbody>
                  {diagnostics.youtubeBreakdown.channels.map((c) => (
                    <tr key={c.channelId} className="border-t">
                      <td className="p-1">{c.title}</td>
                      <td className="p-1 font-mono" dir="ltr">{c.channelId}</td>
                      <td className="p-1">{num(c.subscribers)}</td>
                      <td className="p-1">{num(c.views)}</td>
                      <td className="p-1">{c.pages.join("، ")}{c.pages.length > 1 && <span className="text-amber-700"> (أكثر من صفحة — حُسبت مرة واحدة)</span>}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-semibold"><td className="p-1" colSpan={2}>المجموع ({num(diagnostics.youtubeBreakdown.channels.length)} قنوات)</td><td className="p-1">{num(diagnostics.youtubeBreakdown.totalSubscribers)}</td><td className="p-1">{num(diagnostics.youtubeBreakdown.totalViews)}</td><td /></tr>
                </tbody>
              </table>
            </div>
          )}
          {diagnostics && (
            <div className="pt-2 text-xs">
              <span className="text-sm font-semibold">التطبيقات المحسوبة في العدّاد ({num(diagnostics.apps.length)}): </span>
              {diagnostics.apps.join("، ") || "لا شيء"}
            </div>
          )}
          {diagnostics && diagnostics.followers.length > 0 && (
            <div className="pt-2">
              <div className="text-sm font-semibold">أرقام المتابعين لكل حساب</div>
              {diagnostics.followers.map((row, i) => (
                <div key={i} className="text-xs">
                  <span className={row.automatic ? "text-green-700" : "text-red-700"}>{row.automatic ? "✔ آلي" : "✘ بلا رقم"}</span>{" "}
                  <span className="text-muted-foreground">{PLATFORM_LABEL[row.platform] ?? row.platform}</span> — <b>{row.account}</b>
                  {!row.automatic && row.reason && <span className="text-muted-foreground"> — {row.reason}</span>}
                </div>
              ))}
            </div>
          )}
          {diagnostics && diagnostics.hidden.length > 0 && (
            <div className="pt-2">
              <div className="text-sm font-semibold">لا يظهر في الصفحة العامة (غير مسجّل في صفحة المنصات)</div>
              <ul className="list-disc pr-5 text-xs text-muted-foreground">
                {diagnostics.hidden.map((item, i) => <li key={i}><b>{item.what}</b>: {item.why}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-sm font-semibold">التطبيقات</div>
          {apps.length === 0 && <p className="text-xs text-muted-foreground">لا توجد منصات تبدأ بـ«تطبيق».</p>}
          {apps.map((app) => (
            <div key={app.id} className="flex flex-wrap items-center gap-2">
              <span className="w-48 text-sm">{app.name}</span>
              <Input dir="ltr" className="h-8 w-64" placeholder="رابط App Store" value={value(`ios-${app.id}`, app.iosUrl)} onChange={set(`ios-${app.id}`)} />
              <Input dir="ltr" className="h-8 w-64" placeholder="رابط Google Play" value={value(`android-${app.id}`, app.androidUrl)} onChange={set(`android-${app.id}`)} />
              <Button size="sm" variant="outline" disabled={saveApp.isPending} onClick={() => saveApp.mutate({ id: app.id, iosUrl: value(`ios-${app.id}`, app.iosUrl).trim(), androidUrl: value(`android-${app.id}`, app.androidUrl).trim() })}>حفظ</Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
