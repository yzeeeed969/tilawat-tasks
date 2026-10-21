import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/lib/roles";
import { useState } from "react";
import { Input } from "@/components/ui/input";

// لوحة متابعة الرفع التلقائي يوتيوب ← فيسبوك (للمدير): مفتاح التشغيل، والربط قناة↔صفحة، وآخر ما رُفع والإخفاقات.
type Overview = {
  enabled: boolean;
  enabledAt: string | null;
  lastMachinePollAt: string | null;
  machineKeyConfigured: boolean;
  channels: Array<{ channelId: string; displayName: string; reciterName: string | null; fbPageId: string | null; fbPageName: string | null; status: "mapped" | "disabled"; reason: string | null; baselineVideoId: string | null; baselinePublishedAt: string | null; baselineSetAt: string | null }>;
  uploads: Array<{ videoId: string; channelName: string; pageName: string; title: string; status: string; fbVideoId: string | null; error: string | null; attempts: number; fileSize: number | null; startedAt: string; uploadedAt: string | null }>;
};

const when = (value: string | null) => (value ? new Date(value).toLocaleString("ar-SA-u-nu-latn", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) : "—");
const STATUS: Record<string, { label: string; cls: string }> = {
  uploaded: { label: "رُفع ونُشر", cls: "bg-green-100 text-green-800 border-green-200" },
  failed: { label: "فشل", cls: "bg-red-100 text-red-800 border-red-200" },
  uploading: { label: "يُرفع الآن", cls: "bg-amber-100 text-amber-800 border-amber-200" },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? "فشلت العملية");
  return body as T;
}

type ManualLinks = { links: Array<{ channelId: string; channelTitle: string; channelHandle: string | null; fbPageId: string; pageName: string | null; pageStatus: string | null }>; pages: Array<{ fbPageId: string; name: string }> };

// ربط يدوي قناة ← صفحة (الإصدار 64): لقنوات عامة لا قارئ لها، مثل @Haramayn ← «تطبيق تلاوات الحرمين».
function ManualLinksCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState("");
  const [pageId, setPageId] = useState("");
  const q = useQuery({ queryKey: ["crosspost-manual-links"], queryFn: () => api<ManualLinks>("/api/crosspost/manual-links") });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["crosspost-manual-links"] }); queryClient.invalidateQueries({ queryKey: ["crosspost-overview"] }); };
  const add = useMutation({
    mutationFn: () => api<{ channelTitle: string; pageName: string }>("/api/crosspost/manual-links", { method: "POST", body: JSON.stringify({ channel, fbPageId: pageId }) }),
    onSuccess: (r) => { toast({ title: "تم الربط", description: `«${r.channelTitle}» ← «${r.pageName}». يُرفع الجديد فقط من الآن.` }); setChannel(""); refresh(); },
    onError: (e: Error) => toast({ title: "تعذّر الربط", description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/crosspost/manual-links/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "أُلغي الربط" }); refresh(); },
    onError: (e: Error) => toast({ title: "تعذّر الإلغاء", description: e.message, variant: "destructive" }),
  });
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">ربط يدوي: قناة عامة ← صفحة</CardTitle>
        <CardDescription>لقناة يوتيوب لا تخص قارئًا واحدًا (مثل @Haramayn). كل مقطع جديد فيها يُرفع إلى الصفحة المختارة. الجديد فقط، ولا يُرفع البث المباشر.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {q.isLoading ? <p className="text-muted-foreground">جارٍ التحميل…</p> : q.error ? <p className="text-destructive">{(q.error as Error).message}</p> : (
          <>
            {(q.data?.links ?? []).length === 0 ? <p className="text-muted-foreground">لا يوجد ربط يدوي بعد.</p> : (
              <ul className="space-y-2">
                {q.data!.links.map((l) => (
                  <li key={l.channelId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                    <span><b>{l.channelTitle}</b> {l.channelHandle && <span className="text-muted-foreground">({l.channelHandle})</span>} ← <b>{l.pageName ?? l.fbPageId}</b>
                      {l.pageStatus !== "connected" && <Badge variant="outline" className="ms-2 border-amber-300 text-amber-700">الصفحة تحتاج ربطًا</Badge>}</span>
                    <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(l.channelId)}>إلغاء الربط</Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">رابط قناة يوتيوب أو اسمها</span>
                <Input dir="ltr" placeholder="https://www.youtube.com/@Haramayn" value={channel} onChange={(e) => setChannel(e.target.value)} />
              </label>
              <label className="flex min-w-[12rem] flex-col gap-1">
                <span className="text-xs text-muted-foreground">صفحة فيسبوك</span>
                <select className="h-9 rounded-md border bg-background px-2" value={pageId} onChange={(e) => setPageId(e.target.value)}>
                  <option value="">اختر الصفحة</option>
                  {(q.data?.pages ?? []).map((p) => <option key={p.fbPageId} value={p.fbPageId}>{p.name}</option>)}
                </select>
              </label>
              <Button disabled={!channel.trim() || !pageId || add.isPending} onClick={() => add.mutate()}>{add.isPending ? "جارٍ الربط…" : "ربط"}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function CrosspostMonitor() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["crosspost-overview"], queryFn: () => api<Overview>("/api/crosspost/overview"), enabled: isAdmin, refetchInterval: 60_000 });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<{ ok: boolean; message?: string }>("/api/crosspost/settings", { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: (_r, enabled) => {
      queryClient.invalidateQueries({ queryKey: ["crosspost-overview"] });
      toast({ title: enabled ? "تم التشغيل — سُجّل خط الأساس لكل قناة، ولن يُرفع إلا الجديد" : "تم الإيقاف" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  if (!isAdmin) return <p className="text-sm text-muted-foreground">للمدير فقط.</p>;
  if (isLoading) return <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>;
  if (error || !data) return <p className="text-sm text-red-600">{(error as Error)?.message ?? "تعذّر التحميل"}</p>;

  const mapped = data.channels.filter((c) => c.status === "mapped");
  const failures = data.uploads.filter((u) => u.status === "failed");
  const switchOn = () => {
    if (!confirm(`تشغيل الرفع التلقائي؟\n\nسيُسجَّل أحدث فيديو حالي لكل قناة مربوطة (${mapped.length}) كخط أساس، ولن يُرفع أي فيديو قديم — فقط ما يُنشر بعد التشغيل، ويُنشر مباشرة على صفحة فيسبوك المقابلة.`)) return;
    toggle.mutate(true);
  };

  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">الرفع التلقائي: يوتيوب ← فيسبوك</h2>
        <p className="text-muted-foreground mt-1">كل تلاوة جديدة على قناة يوتيوب تُرفع فيديو ناتيف منشورًا على صفحة فيسبوك المقابلة لنفس الشيخ. التنزيل يتم على جهاز الماك ميني، والرفع من الخادم.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">الحالة</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Badge className={data.enabled ? "bg-green-100 text-green-800 border-green-200" : "bg-muted text-muted-foreground"}>{data.enabled ? "مُشغَّل" : "معطّل"}</Badge>
            {data.enabled
              ? <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>إيقاف</Button>
              : <Button size="sm" disabled={toggle.isPending || !data.machineKeyConfigured || mapped.length === 0} onClick={switchOn}>تشغيل الرفع التلقائي</Button>}
            {data.enabledAt && <span className="text-muted-foreground">آخر تشغيل: {when(data.enabledAt)}</span>}
          </div>
          <div className={data.machineKeyConfigured ? "text-green-700" : "text-red-700"}>
            {data.machineKeyConfigured ? "✔ المفتاح السري لجهاز التنزيل مضبوط على الخادم" : "✘ المفتاح السري CROSSPOST_API_KEY غير مضبوط على الخادم — لا يمكن التشغيل قبل ضبطه في Railway"}
          </div>
          <div className="text-muted-foreground">آخر استعلام من جهاز التنزيل: {when(data.lastMachinePollAt)}</div>
          <p className="text-xs text-muted-foreground">كل تشغيل يسجّل خط أساس جديدًا؛ فما يُنشر أثناء الإيقاف لا يُرفع. الفيديو الواحد لا يُرفع مرتين أبدًا، والفاشل يُعاد حتى 3 محاولات.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">الربط: قناة يوتيوب ↔ صفحة فيسبوك</CardTitle>
          <CardDescription>عبر القارئ: قناة القارئ ← صفحة فيسبوك المربوطة له في «مراقبة إنستقرام». بلا تخمين — ما لا يتّضح يبقى معطّلًا مع السبب.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="text-muted-foreground text-xs"><th className="p-2 text-right font-medium">القناة</th><th className="p-2 text-right font-medium">القارئ</th><th className="p-2 text-right font-medium">صفحة فيسبوك</th><th className="p-2 text-right font-medium">الحالة</th><th className="p-2 text-right font-medium">خط الأساس</th></tr></thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.channelId} className="border-t align-top">
                  <td className="p-2"><b>{c.displayName}</b><span className="block font-mono text-[10px] text-muted-foreground" dir="ltr">{c.channelId}</span></td>
                  <td className="p-2">{c.reciterName ?? "—"}</td>
                  <td className="p-2">{c.fbPageName ?? "—"}{c.fbPageId && <span className="block font-mono text-[10px] text-muted-foreground" dir="ltr">{c.fbPageId}</span>}</td>
                  <td className="p-2">{c.status === "mapped" ? <span className="text-green-700">✔ مربوطة</span> : <span className="text-amber-700">✘ معطّلة — {c.reason}</span>}</td>
                  <td className="p-2 text-xs text-muted-foreground">{c.baselineVideoId ? <><span dir="ltr" className="font-mono">{c.baselineVideoId}</span><span className="block">{when(c.baselineSetAt)}</span></> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <ManualLinksCard />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">آخر ما رُفع</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.uploads.length === 0 && <p className="text-sm text-muted-foreground">لا شيء بعد.</p>}
          {data.uploads.map((u) => (
            <div key={u.videoId} className="rounded-md border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={STATUS[u.status]?.cls ?? ""}>{STATUS[u.status]?.label ?? u.status}</Badge>
                <b dir="auto">{u.title}</b>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {u.channelName} ← {u.pageName} · {when(u.uploadedAt ?? u.startedAt)} · المحاولات: {u.attempts}
                {" · "}<a className="underline" href={`https://www.youtube.com/watch?v=${u.videoId}`} target="_blank" rel="noopener noreferrer">يوتيوب</a>
                {u.fbVideoId && <>{" · "}<a className="underline" href={`https://www.facebook.com/${u.fbVideoId}`} target="_blank" rel="noopener noreferrer">فيسبوك</a></>}
              </div>
              {u.error && <div className="mt-1 text-xs text-red-700 break-all" dir="auto">{u.error}</div>}
            </div>
          ))}
          {failures.length > 0 && <p className="text-xs text-red-700">إخفاقات حالية: {failures.length} — السبب تحت كل فيديو.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
