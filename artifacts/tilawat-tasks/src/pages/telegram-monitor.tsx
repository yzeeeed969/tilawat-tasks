import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// «مراقبة تلقرام» (للمدير): توثيق تلقائي من قناة تلقرام العامة. كل منشور تلاوة يوثّق جانبين مستقلين:
// مهمة تلقرام العامة (بالمسجد) ومهمة التطبيق (بالقارئ) — لكل جانب حالته وإجراءاته.

type Side = "telegram" | "app";
type Settings = {
  enabled: boolean;
  trialMode: boolean;
  channelChatId: string | null;
  channelTitle: string | null;
  channelUsername: string | null;
  telegramPlatformId: number | null;
  appPlatformId: number | null;
  monitoringStartedAt: string | null;
};
type SettingsData = {
  settings: Settings;
  platforms: Array<{ id: number; name: string; coversAllReciters: boolean }>;
  reciters: Array<{ id: number; name: string; mosque: string }>;
  seenChats: Array<{ chatId: string; title: string | null; username: string | null; type: string | null; botStatus: string | null }>;
  aliases: Array<{ id: number; hashtag: string; reciterName: string }>;
};
type Webhook = {
  ok: boolean;
  error?: string;
  url?: string;
  hasUrl?: boolean;
  allowedUpdates?: string[];
  usesDefault?: boolean;
  missing?: string[];
  pendingUpdateCount?: number;
  lastErrorMessage?: string | null;
};
type Post = {
  id: number;
  publishedAt: string;
  caption: string | null;
  hashtags: string[] | null;
  siteUrl: string | null;
  postUrl: string | null;
  kind: string;
  ignoreReason: string | null;
  reciterName: string | null;
  mosque: string | null;
  extractedPrayer: string | null;
  hijriDay: number | null;
  hijriMonth: number | null;
  hijriYear: number | null;
  parseError: string | null;
  editedAfterDocumented: boolean;
  telegramStatus: string;
  telegramReason: string | null;
  telegramTaskTitle: string | null;
  appStatus: string;
  appReason: string | null;
  appTaskTitle: string | null;
};
type Candidate = { id: number; title: string; prayer: string | null; mosque: string | null; dueDate: string };

const STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "قيد المعالجة", className: "bg-muted text-muted-foreground border-border" },
  processing: { label: "قيد المعالجة", className: "bg-muted text-muted-foreground border-border" },
  not_applicable: { label: "لا ينطبق", className: "bg-muted text-muted-foreground border-border" },
  documented: { label: "موثّق", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  needs_review: { label: "بحاجة مراجعة", className: "bg-amber-50 text-amber-700 border-amber-200" },
  no_task: { label: "بلا مهمة", className: "bg-slate-100 text-slate-700 border-slate-300" },
  ignored_manual: { label: "متجاهَل يدويًا", className: "bg-muted text-muted-foreground border-border" },
  reverted: { label: "تم التراجع", className: "bg-red-50 text-red-700 border-red-200" },
  trial_would_document: { label: "تجربة: كان سيوثّق", className: "bg-sky-50 text-sky-700 border-sky-200" },
  trial_would_review: { label: "تجربة: كان سيُراجَع", className: "bg-sky-50 text-sky-700 border-sky-200" },
  trial_no_task: { label: "تجربة: بلا مهمة", className: "bg-sky-50 text-sky-700 border-sky-200" },
};
const PRAYER: Record<string, string> = { fajr: "الفجر", maghrib: "المغرب", isha: "العشاء", jumuah: "الجمعة" };
const MOSQUE: Record<string, string> = { haram: "الحرام", nabawi: "النبوي" };
const ALL = "__all__";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? "حدث خطأ");
  return payload as T;
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, className: "bg-muted text-muted-foreground border-border" };
  return <span className={cn("inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", s.className)}>{s.label}</span>;
}

function SidePanel({ post, side, onDone }: { post: Post; side: Side; onDone: () => void }) {
  const { toast } = useToast();
  const [linking, setLinking] = useState(false);
  const [taskId, setTaskId] = useState("");
  const status = side === "telegram" ? post.telegramStatus : post.appStatus;
  const reason = side === "telegram" ? post.telegramReason : post.appReason;
  const taskTitle = side === "telegram" ? post.telegramTaskTitle : post.appTaskTitle;
  const candidates = useQuery({
    queryKey: ["telegram-monitor-candidates", post.id, side],
    queryFn: () => api<Candidate[]>(`/api/telegram-monitor/posts/${post.id}/candidates?side=${side}`),
    enabled: linking,
  });
  const act = async (action: "link" | "ignore" | "revert", body: Record<string, unknown> = {}) => {
    try {
      await api(`/api/telegram-monitor/posts/${post.id}/${action}`, { method: "POST", body: JSON.stringify({ side, ...body }) });
      toast({ title: action === "link" ? "تم الربط والتوثيق" : action === "ignore" ? "تم التجاهل" : "تم التراجع" });
      setLinking(false);
      onDone();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" });
    }
  };
  if (status === "not_applicable") return null;

  return (
    <div className="rounded-md border p-2 space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="font-semibold">{side === "telegram" ? "مهمة تلقرام (عامة)" : "مهمة التطبيق"}</span>
        <StatusBadge status={status} />
      </div>
      {taskTitle && <p>المهمة: {taskTitle}</p>}
      {reason && <p className="text-muted-foreground">{reason}</p>}
      <div className="flex flex-wrap gap-1">
        {status === "documented" ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => {
            if (confirm("تراجع عن توثيق هذا الجانب؟ الإشعارات المُرسَلة سابقًا لن تُسحَب، والجانب الآخر لا يتأثر.")) act("revert");
          }}>تراجع</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLinking((v) => !v)}>ربط يدوي</Button>
            {status !== "ignored_manual" && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => act("ignore")}>تجاهل</Button>}
          </>
        )}
      </div>
      {linking && (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <Select value={taskId} onValueChange={setTaskId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={candidates.isLoading ? "…" : "اختر مهمة معلّقة"} /></SelectTrigger>
            <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
              {(candidates.data ?? []).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.dueDate} · {c.title}{c.prayer ? ` · ${PRAYER[c.prayer] ?? c.prayer}` : ""}{c.mosque ? ` · ${MOSQUE[c.mosque] ?? c.mosque}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 text-xs" disabled={!taskId} onClick={() => act("link", { taskId: Number(taskId) })}>ربط وتوثيق</Button>
        </div>
      )}
      {linking && candidates.data && candidates.data.length === 0 && <p className="text-muted-foreground">لا توجد مهام معلّقة قريبة على منصة هذا الجانب.</p>}
    </div>
  );
}

function PostCard({ post, reciters, onDone }: { post: Post; reciters: SettingsData["reciters"]; onDone: () => void }) {
  const { toast } = useToast();
  const [aliasReciter, setAliasReciter] = useState("");
  const [expanded, setExpanded] = useState(false);
  const showAlias = post.kind === "recitation" && !post.reciterName && (post.hashtags?.length ?? 0) > 0;
  const date = new Date(post.publishedAt);
  return (
    <div className={cn("rounded-md border p-3 space-y-2", post.kind === "other" && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{date.toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" })}</span>
        <div className="flex items-center gap-2">
          {post.postUrl && <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline"><Send className="h-3 w-3" />المنشور</a>}
          {post.siteUrl && <a href={post.siteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline"><ExternalLink className="h-3 w-3" />الرابط</a>}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={async () => {
            try { await api(`/api/telegram-monitor/posts/${post.id}/reprocess`, { method: "POST" }); onDone(); } catch (err) { toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" }); }
          }}>إعادة معالجة</Button>
        </div>
      </div>
      <button type="button" className="block w-full text-right text-sm whitespace-pre-wrap" onClick={() => setExpanded((v) => !v)}>
        {expanded ? post.caption : (post.caption ?? "—").slice(0, 160) + ((post.caption?.length ?? 0) > 160 ? "…" : "")}
      </button>
      {post.kind === "other" ? (
        <p className="text-xs text-muted-foreground">متجاهَل: {post.ignoreReason}</p>
      ) : (
        <>
          <p className="text-xs">
            {post.reciterName ? <b>{post.reciterName}</b> : <span className="text-amber-700">الشيخ غير معروف</span>}
            {post.mosque && ` · ${MOSQUE[post.mosque] ?? post.mosque}`}
            {post.extractedPrayer && ` · ${PRAYER[post.extractedPrayer] ?? post.extractedPrayer}`}
            {post.hijriDay && ` · ${post.hijriDay}-${post.hijriMonth}-${post.hijriYear}`}
            {post.editedAfterDocumented && <span className="text-amber-700"> · عُدّل بعد التوثيق</span>}
          </p>
          {post.parseError && <p className="flex gap-1 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{post.parseError}</p>}
          {showAlias && (
            <div className="flex flex-col gap-1.5 rounded-md bg-muted/30 p-2 text-xs sm:flex-row sm:items-center">
              <span>اربط الهاشتاق {post.hashtags![0]} بالقارئ:</span>
              <Select value={aliasReciter} onValueChange={setAliasReciter}>
                <SelectTrigger className="h-8 text-xs sm:w-56"><SelectValue placeholder="اختر القارئ" /></SelectTrigger>
                <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
                  {reciters.map((r) => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8 text-xs" disabled={!aliasReciter} onClick={async () => {
                try {
                  await api("/api/telegram-monitor/aliases", { method: "POST", body: JSON.stringify({ hashtag: post.hashtags![0], reciterId: Number(aliasReciter) }) });
                  toast({ title: "تم الربط وإعادة المعالجة" });
                  onDone();
                } catch (err) { toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" }); }
              }}>ربط</Button>
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            <SidePanel post={post} side="telegram" onDone={onDone} />
            <SidePanel post={post} side="app" onDone={onDone} />
          </div>
        </>
      )}
    </div>
  );
}

export default function TelegramMonitorPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [kindFilter, setKindFilter] = useState("recitation");
  const settingsQuery = useQuery({ queryKey: ["telegram-monitor-settings"], queryFn: () => api<SettingsData>("/api/telegram-monitor/settings") });
  const webhookQuery = useQuery({ queryKey: ["telegram-monitor-webhook"], queryFn: () => api<Webhook>("/api/telegram-monitor/webhook") });
  const postsQuery = useQuery({
    queryKey: ["telegram-monitor-posts", statusFilter, kindFilter],
    queryFn: () => api<Post[]>(`/api/telegram-monitor/posts?limit=150${statusFilter !== ALL ? `&status=${statusFilter}` : ""}${kindFilter !== ALL ? `&kind=${kindFilter}` : ""}`),
  });
  const withoutPostQuery = useQuery({ queryKey: ["telegram-monitor-without"], queryFn: () => api<Array<{ id: number; title: string; side: Side; dueDate: string; prayer: string | null; mosque: string | null }>>("/api/telegram-monitor/tasks-without-post") });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-posts"] });
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-without"] });
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-settings"] });
  };
  const saveSettings = useMutation({
    mutationFn: (patch: Partial<Settings>) => api("/api/telegram-monitor/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => { toast({ title: "تم الحفظ" }); refresh(); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  const fixWebhook = useMutation({
    mutationFn: () => api("/api/telegram-monitor/webhook/allowed-updates", { method: "POST" }),
    onSuccess: () => { toast({ title: "تم تحديث أنواع التحديثات" }); queryClient.invalidateQueries({ queryKey: ["telegram-monitor-webhook"] }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  const runNow = useMutation({
    mutationFn: () => api<{ processed: number }>("/api/telegram-monitor/run-now", { method: "POST" }),
    onSuccess: (r) => { toast({ title: `تم الفحص — عولج ${r.processed}` }); refresh(); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const data = settingsQuery.data;
  const s = data?.settings;
  const webhook = webhookQuery.data;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">مراقبة تلقرام</h2>
          <p className="text-muted-foreground mt-2">توثيق تلقائي من قناة تلقرام العامة: كل منشور تلاوة يوثّق مهمة تلقرام العامة ومهمة التطبيق، كلًّا على حدة.</p>
        </div>
        <Button variant="outline" className="gap-1" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
          {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}افحص الآن
        </Button>
      </div>

      {!data || !s ? (
        <div className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>الإعدادات</CardTitle>
            <CardDescription>{s.trialMode ? "وضع التجربة مفعّل: يُسجَّل ما كان سيحدث دون توثيق فعلي." : "التوثيق الفعلي مفعّل."}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm"><Switch checked={s.enabled} onCheckedChange={(v) => saveSettings.mutate({ enabled: v })} />تشغيل المراقبة</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={s.trialMode} onCheckedChange={(v) => {
                if (!v && !confirm("إطفاء وضع التجربة يبدأ التوثيق الفعلي للمهام. متابعة؟")) return;
                saveSettings.mutate({ trialMode: v });
              }} />وضع التجربة</label>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <p className="text-xs font-medium">القناة</p>
                <Select value={s.channelChatId ?? undefined} onValueChange={(v) => {
                  if (confirm("تسجيل هذه القناة؟ المنشورات قبل لحظة التسجيل لن تُعالَج.")) saveSettings.mutate({ channelChatId: v });
                }}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="اختر القناة" /></SelectTrigger>
                  <SelectContent dir="rtl">
                    {data.seenChats.filter((c) => c.type === "channel" || c.chatId === s.channelChatId).map((c) => (
                      <SelectItem key={c.chatId} value={c.chatId}>{c.title ?? c.chatId}{c.username ? ` (@${c.username})` : ""}{c.botStatus ? ` · ${c.botStatus}` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {data.seenChats.filter((c) => c.type === "channel").length === 0 && <p className="text-[11px] text-muted-foreground">أضف البوت مشرفًا في القناة لتظهر هنا.</p>}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">منصة تلقرام (المهام العامة)</p>
                <Select value={s.telegramPlatformId ? String(s.telegramPlatformId) : undefined} onValueChange={(v) => saveSettings.mutate({ telegramPlatformId: Number(v) })}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="اختر المنصة" /></SelectTrigger>
                  <SelectContent dir="rtl">{data.platforms.filter((p) => !p.coversAllReciters).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">منصة التطبيق (تشمل كل القرّاء)</p>
                <Select value={s.appPlatformId ? String(s.appPlatformId) : undefined} onValueChange={(v) => saveSettings.mutate({ appPlatformId: Number(v) })}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="اختر المنصة" /></SelectTrigger>
                  <SelectContent dir="rtl">{data.platforms.filter((p) => p.coversAllReciters).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="rounded-md border p-3 text-sm space-y-1.5">
              <p className="font-medium">حالة الـ webhook</p>
              {!webhook ? <Loader2 className="h-4 w-4 animate-spin" /> : !webhook.ok ? (
                <p className="text-xs text-destructive">تعذّر قراءة حالة الـ webhook: {webhook.error}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground" dir="ltr">{webhook.url || "—"}</p>
                  <p className="text-xs">أنواع التحديثات: {webhook.usesDefault ? "الافتراضي (يشمل channel_post)" : webhook.allowedUpdates?.join(", ")}</p>
                  {webhook.missing && webhook.missing.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />ناقص: {webhook.missing.join(", ")}</span>
                      <Button size="sm" className="h-7 text-xs" onClick={() => fixWebhook.mutate()} disabled={fixWebhook.isPending}>تحديث (يبقى message لربط الأعضاء)</Button>
                    </div>
                  ) : <p className="flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />يستقبل منشورات القنوات</p>}
                  {webhook.lastErrorMessage && <p className="text-xs text-amber-700">آخر خطأ: {webhook.lastErrorMessage}</p>}
                </>
              )}
            </div>
            {data.aliases.length > 0 && (
              <div className="text-xs text-muted-foreground">مرادفات الهاشتاق: {data.aliases.map((a) => `#${a.hashtag} ← ${a.reciterName}`).join("، ")}</div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>المنشورات</CardTitle>
          <div className="flex flex-wrap gap-2 pt-2">
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="recitation">منشورات التلاوة</SelectItem>
                <SelectItem value="other">المتجاهَلة</SelectItem>
                <SelectItem value={ALL}>الكل</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value={ALL}>كل الحالات</SelectItem>
                {["needs_review", "no_task", "documented", "trial_would_document", "trial_would_review", "trial_no_task", "reverted", "ignored_manual"].map((k) => (
                  <SelectItem key={k} value={k}>{STATUS[k].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {postsQuery.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (postsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد منشورات.</p>
          ) : (postsQuery.data ?? []).map((post) => (
            <PostCard key={post.id} post={post} reciters={data?.reciters ?? []} onDone={refresh} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">مهام بلا منشور</CardTitle>
          <CardDescription>مهام الجانبين المعلّقة التي انتهت نافذتها (72 ساعة) خلال آخر 14 يومًا — قد تكون منشوراتها فاتت أثناء انقطاع.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y text-sm">
          {(withoutPostQuery.data ?? []).length === 0 ? <p className="text-muted-foreground">لا شيء.</p> : (withoutPostQuery.data ?? []).map((t) => (
            <div key={t.id} className="flex flex-wrap justify-between gap-2 py-1.5 text-xs">
              <span>{t.title}</span>
              <span className="text-muted-foreground">{t.side === "telegram" ? "تلقرام" : "التطبيق"} · {t.dueDate}{t.prayer ? ` · ${PRAYER[t.prayer] ?? t.prayer}` : ""}{t.mosque ? ` · ${MOSQUE[t.mosque] ?? t.mosque}` : ""}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
