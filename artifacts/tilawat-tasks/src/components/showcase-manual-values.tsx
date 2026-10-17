import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// إدارة صفحة «منصات المشروع» العامة (/achievements): روابط المتاجر لكل تطبيق — الشيء اليدوي الوحيد (روابط
// ثابتة، ليست أرقامًا) — وتقرير تشخيص. كل الأرقام آلية من مصدرها الرسمي فقط، ولا إدخال يدوي لأي رقم.

type Diagnostics = {
  youtube: Array<{ pageId: number; pageName: string; pageUrl: string | null; status: "ok" | "missing"; channelId: string | null; problem: string | null; hiddenByAdmin?: boolean }>;
  hiddenPages: Array<{ pageId: number; platformName: string; name: string }>;
  hidden: Array<{ what: string; why: string }>;
  followers: Array<{ platform: string; account: string; automatic: boolean; reason: string | null }>;
  youtubeBreakdown: { channels: Array<{ channelId: string; title: string; subscribers: number | null; views: number | null; pages: string[] }>; totalViews: number; totalSubscribers: number };
  apps: string[];
  facebookViews?: { metric: string; shown: boolean; reason: string | null; pages: Array<{ account: string; value: number | null; problem: string | null }> };
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
  // أخطاء/نجاح الحفظ لكل تطبيق (يبقى ما كتبه المستخدم كما هو ليصحّحه).
  const [appErrors, setAppErrors] = useState<Record<number, { iosUrl?: string; androidUrl?: string; general?: string }>>({});
  const [appSaved, setAppSaved] = useState<Record<number, boolean>>({});
  const onError = (err: Error) => toast({ title: err.message, variant: "destructive" });
  const saveApp = useMutation({
    mutationFn: async (v: { id: number; name: string; iosUrl: string; androidUrl: string }) => {
      const res = await fetch(`/api/showcase/manual/platforms/${v.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iosUrl: v.iosUrl || null, androidUrl: v.androidUrl || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body?.message ?? "فشل الحفظ"), { fieldErrors: body?.errors });
      return body;
    },
    onSuccess: (_body, v) => {
      setAppErrors((s) => ({ ...s, [v.id]: {} }));
      setAppSaved((s) => ({ ...s, [v.id]: true }));
      queryClient.invalidateQueries({ queryKey: ["showcase-manual"] });
      toast({ title: `تم حفظ روابط «${v.name}»`, description: "تظهر في صفحة المنصات خلال دقائق (أو فورًا بزر «تحديث الآن»)" });
    },
    onError: (err: Error & { fieldErrors?: { iosUrl?: string; androidUrl?: string } }, v) => {
      setAppSaved((s) => ({ ...s, [v.id]: false }));
      setAppErrors((s) => ({ ...s, [v.id]: err.fieldErrors ?? { general: err.message } }));
      toast({ title: err.message, variant: "destructive" });
    },
  });
  // نفس قاعدة الخادم: فارغ مسموح، وإلا رابط صالح يبدأ بـ https://
  const checkUrl = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!/^https:\/\//i.test(trimmed)) return "يجب أن يبدأ الرابط بـ https://";
    try { const url = new URL(trimmed); if (!url.hostname.includes(".")) throw new Error(); } catch { return "الرابط غير صالح — انسخه كاملًا من صفحة التطبيق في المتجر"; }
    return undefined;
  };
  const submitApp = (app: { id: number; name: string; iosUrl: string | null; androidUrl: string | null }) => {
    const iosUrl = value(`ios-${app.id}`, app.iosUrl).trim();
    const androidUrl = value(`android-${app.id}`, app.androidUrl).trim();
    const errors = { iosUrl: checkUrl(iosUrl), androidUrl: checkUrl(androidUrl) };
    if (errors.iosUrl || errors.androidUrl) {
      setAppSaved((s) => ({ ...s, [app.id]: false }));
      setAppErrors((s) => ({ ...s, [app.id]: errors }));
      return;
    }
    saveApp.mutate({ id: app.id, name: app.name, iosUrl, androidUrl });
  };
  const visibility = useMutation({
    mutationFn: (v: { pageId: number; hidden: boolean }) => api(`/api/showcase/pages/${v.pageId}/visibility`, { method: "PUT", body: JSON.stringify({ hidden: v.hidden }) }),
    onSuccess: () => refresh.mutate(),
    onError,
  });
  const refresh = useMutation({
    mutationFn: () => api<Diagnostics>("/api/showcase/refresh", { method: "POST" }),
    onSuccess: (fresh) => { queryClient.setQueryData(["showcase-diagnostics"], fresh); toast({ title: "تم تحديث بيانات الصفحة" }); },
    onError,
  });

  if (!data) return null;
  // الخادم يرسل تطبيقات الصفحة العامة نفسها (اسم يبدأ بـ«تطبيق» أو «تشمل كل القرّاء»).
  const apps = data.platforms;
  const value = (key: string, fallback: string | number | null) => draft[key] ?? (fallback == null ? "" : String(fallback));
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((s) => ({ ...s, [key]: e.target.value }));
    const id = Number(key.split("-")[1]);
    setAppSaved((s) => ({ ...s, [id]: false }));
  };

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
              {row.hiddenByAdmin && <span className="text-amber-700"> — مخفية من الصفحة العامة</span>}{" "}
              <button type="button" className="text-sidebar-primary hover:underline" disabled={visibility.isPending} onClick={() => visibility.mutate({ pageId: row.pageId, hidden: !row.hiddenByAdmin })}>
                {row.hiddenByAdmin ? "إظهار" : "إخفاء من الصفحة العامة"}
              </button>
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
          {diagnostics?.facebookViews && (
            <div className="pt-2">
              <div className="text-sm font-semibold">فيسبوك: مشاهدات آخر 90 يومًا (المقياس {diagnostics.facebookViews.metric})</div>
              <div className={`text-xs ${diagnostics.facebookViews.shown ? "text-green-700" : "text-amber-700"}`}>
                {diagnostics.facebookViews.shown ? "✔ يُعرض في الصفحة العامة (رجع كاملًا لكل الصفحات)" : `✘ ${diagnostics.facebookViews.reason ?? "لا يُعرض"}`}
              </div>
              {diagnostics.facebookViews.pages.map((row, i) => (
                <div key={i} className="text-xs">
                  <span className={row.value != null ? "text-green-700" : "text-red-700"}>{row.value != null ? "✔" : "✘"}</span>{" "}
                  <b>{row.account}</b>: {row.value != null ? num(row.value) : <span className="text-muted-foreground">{row.problem}</span>}
                </div>
              ))}
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
          {diagnostics && diagnostics.hiddenPages.filter((p) => !diagnostics.youtube.some((y) => y.pageId === p.pageId)).length > 0 && (
            <div className="pt-2 text-xs">
              <div className="text-sm font-semibold">صفحات مخفية من الصفحة العامة (باقية في النظام)</div>
              {diagnostics.hiddenPages.filter((p) => !diagnostics.youtube.some((y) => y.pageId === p.pageId)).map((p) => (
                <div key={p.pageId}>{p.platformName} — {p.name}{" "}
                  <button type="button" className="text-sidebar-primary hover:underline" onClick={() => visibility.mutate({ pageId: p.pageId, hidden: false })}>إظهار</button>
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
          <p className="text-xs text-muted-foreground">كل تطبيق يظهر في الصفحة العامة. الرابطان اختياريان (قد يكون التطبيق على متجر واحد)، ويجب أن يبدأ كل رابط بـ https://.</p>
          {apps.length === 0 && <p className="text-xs text-muted-foreground">لا توجد تطبيقات (منصات تبدأ بـ«تطبيق» أو معلّمة «تشمل كل القرّاء»).</p>}
          {apps.map((app) => {
            const errors = appErrors[app.id] ?? {};
            return (
              <div key={app.id} className="flex flex-wrap items-start gap-2">
                <span className="w-48 pt-1.5 text-sm">{app.name}</span>
                <div className="w-64 space-y-1">
                  <Input dir="ltr" className={`h-8 ${errors.iosUrl ? "border-red-500 focus-visible:ring-red-500" : ""}`} placeholder="رابط App Store (https://…)" value={value(`ios-${app.id}`, app.iosUrl)} onChange={set(`ios-${app.id}`)} aria-invalid={Boolean(errors.iosUrl)} />
                  {errors.iosUrl && <p className="text-xs text-red-600">{errors.iosUrl}</p>}
                </div>
                <div className="w-64 space-y-1">
                  <Input dir="ltr" className={`h-8 ${errors.androidUrl ? "border-red-500 focus-visible:ring-red-500" : ""}`} placeholder="رابط Google Play (https://…)" value={value(`android-${app.id}`, app.androidUrl)} onChange={set(`android-${app.id}`)} aria-invalid={Boolean(errors.androidUrl)} />
                  {errors.androidUrl && <p className="text-xs text-red-600">{errors.androidUrl}</p>}
                </div>
                <div className="space-y-1">
                  <Button size="sm" variant="outline" disabled={saveApp.isPending} onClick={() => submitApp(app)}>حفظ</Button>
                  {appSaved[app.id] && <p className="text-xs text-green-700">✓ تم الحفظ</p>}
                  {errors.general && <p className="text-xs text-red-600">{errors.general}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
