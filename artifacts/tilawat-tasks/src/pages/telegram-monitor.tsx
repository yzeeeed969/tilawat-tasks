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
type Channel = {
  id: number;
  kind: "recitations" | "designs";
  chatId: string;
  title: string | null;
  username: string | null;
  enabled: boolean;
  trialMode: boolean;
  telegramPlatformId: number | null;
  appPlatformId: number | null;
  pageId: number | null;
  monitoringStartedAt: string | null;
};
type SettingsData = {
  settings: Settings;
  channels: Channel[];
  pages: Array<{ id: number; name: string; platformId: number; reciterId: number | null }>;
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
  dayOfWeek: number | null;
  extraIndex: number | null;
};
type Candidate = { id: number; title: string; prayer: string | null; mosque: string | null; dueDate: string };

const STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "قيد المعالجة", className: "bg-muted text-muted-foreground border-border" },
  processing: { label: "قيد المعالجة", className: "bg-muted text-muted-foreground border-border" },
  not_applicable: { label: "لا ينطبق", className: "bg-muted text-muted-foreground border-border" },
  documented: { label: "موثّق", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  documented_extra: { label: "شاهد إضافي", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  trial_would_extra: { label: "تجربة: كان سيُضاف شاهدًا إضافيًا", className: "bg-sky-50 text-sky-700 border-sky-200" },
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
const DAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

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

// منشور قناة التصاميم: جانب واحد (مهمة اليوم على صفحة القناة) — أول منشور أو شاهد إضافي.
function DesignPostCard({ post, onDone }: { post: Post; onDone: () => void }) {
  const { toast } = useToast();
  const [linking, setLinking] = useState(false);
  const [taskId, setTaskId] = useState("");
  const candidates = useQuery({
    queryKey: ["telegram-monitor-candidates", post.id, "designs"],
    queryFn: () => api<Array<Candidate & { status: string }>>(`/api/telegram-monitor/posts/${post.id}/candidates`),
    enabled: linking,
  });
  const act = async (action: "link" | "ignore" | "revert" | "reprocess", body: Record<string, unknown> = {}) => {
    try {
      await api(`/api/telegram-monitor/posts/${post.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
      setLinking(false);
      onDone();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" });
    }
  };
  const documented = post.telegramStatus === "documented" || post.telegramStatus === "documented_extra";
  return (
    <div className={cn("rounded-md border p-3 space-y-2", post.kind === "other" && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{new Date(post.publishedAt).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" })}</span>
        <div className="flex items-center gap-2">
          {post.postUrl && <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline"><Send className="h-3 w-3" />المنشور</a>}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => act("reprocess")}>إعادة معالجة</Button>
        </div>
      </div>
      <p className="text-sm whitespace-pre-wrap">{(post.caption ?? "—").slice(0, 200)}</p>
      {post.kind === "other" ? (
        <p className="text-xs text-muted-foreground">متجاهَل: {post.ignoreReason}</p>
      ) : (
        <div className="rounded-md border p-2 space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="font-semibold">
              {post.dayOfWeek !== null && post.dayOfWeek !== undefined ? `يوم ${DAY_LABELS[post.dayOfWeek]}` : "اليوم غير معروف"}
              {post.extraIndex ? ` · منشور إضافي ${post.extraIndex}` : ""}
            </span>
            <StatusBadge status={post.telegramStatus} />
          </div>
          {post.telegramTaskTitle && <p>المهمة: {post.telegramTaskTitle}</p>}
          {post.telegramReason && <p className="text-muted-foreground">{post.telegramReason}</p>}
          <div className="flex flex-wrap gap-1">
            {documented ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => {
                const message = post.telegramStatus === "documented_extra"
                  ? "تراجع عن هذا الشاهد الإضافي؟ يُحذف شاهده فقط وتبقى المهمة مكتملة."
                  : "تراجع عن توثيق هذا المنشور؟ يُحذف شاهده، وتعود المهمة معلّقة إن لم يبقَ لها شاهد آخر.";
                if (confirm(message)) act("revert");
              }}>تراجع</Button>
            ) : (
              <>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLinking((v) => !v)}>ربط يدوي</Button>
                {post.telegramStatus !== "ignored_manual" && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => act("ignore")}>تجاهل</Button>}
              </>
            )}
          </div>
          {linking && (
            <div className="flex flex-col gap-1.5 sm:flex-row">
              <Select value={taskId} onValueChange={setTaskId}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={candidates.isLoading ? "…" : "اختر مهمة على صفحة القناة"} /></SelectTrigger>
                <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
                  {(candidates.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.dueDate} · {c.title} · {c.status === "completed" ? "مكتملة (يُضاف شاهدًا إضافيًا)" : "معلّقة"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8 text-xs" disabled={!taskId} onClick={() => act("link", { taskId: Number(taskId) })}>ربط</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RegisterChannel({ data, onDone }: { data: SettingsData; onDone: () => void }) {
  const { toast } = useToast();
  const [chatId, setChatId] = useState("");
  const [kind, setKind] = useState<"designs" | "recitations">("designs");
  const registered = new Set(data.channels.map((c) => c.chatId));
  const options = data.seenChats.filter((c) => c.type === "channel" && !registered.has(c.chatId));
  if (options.length === 0) return <p className="text-[11px] text-muted-foreground">لتسجيل قناة جديدة: أضف البوت مشرفًا فيها لتظهر هنا.</p>;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-2 sm:flex-row sm:items-center">
      <span className="text-xs font-medium">تسجيل قناة:</span>
      <Select value={chatId} onValueChange={setChatId}>
        <SelectTrigger className="h-8 text-xs sm:w-64"><SelectValue placeholder="اختر القناة" /></SelectTrigger>
        <SelectContent dir="rtl">{options.map((c) => <SelectItem key={c.chatId} value={c.chatId}>{c.title ?? c.chatId}{c.username ? ` (@${c.username})` : ""}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={kind} onValueChange={(v) => setKind(v as "designs" | "recitations")}>
        <SelectTrigger className="h-8 text-xs sm:w-40"><SelectValue /></SelectTrigger>
        <SelectContent dir="rtl">
          <SelectItem value="designs">قناة تصاميم</SelectItem>
          <SelectItem value="recitations">قناة تلاوات</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" className="h-8 text-xs" disabled={!chatId} onClick={async () => {
        if (!confirm("تسجيل هذه القناة؟ المنشورات قبل لحظة التسجيل لن تُعالَج، ووضع التجربة يبدأ مفعّلًا.")) return;
        try {
          await api("/api/telegram-monitor/channels", { method: "POST", body: JSON.stringify({ chatId, kind }) });
          toast({ title: "تم تسجيل القناة" });
          setChatId("");
          onDone();
        } catch (err) { toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" }); }
      }}>تسجيل</Button>
    </div>
  );
}

export default function TelegramMonitorPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [kindFilter, setKindFilter] = useState("relevant");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const settingsQuery = useQuery({ queryKey: ["telegram-monitor-settings"], queryFn: () => api<SettingsData>("/api/telegram-monitor/settings") });
  const webhookQuery = useQuery({ queryKey: ["telegram-monitor-webhook"], queryFn: () => api<Webhook>("/api/telegram-monitor/webhook") });
  const data = settingsQuery.data;
  const channel = data?.channels.find((c) => c.id === selectedId) ?? data?.channels[0] ?? null;
  const isDesigns = channel?.kind === "designs";
  const effectiveKind = kindFilter === "relevant" ? (isDesigns ? "design" : "recitation") : kindFilter;
  const postsQuery = useQuery({
    queryKey: ["telegram-monitor-posts", channel?.id, statusFilter, effectiveKind],
    queryFn: () => api<Post[]>(`/api/telegram-monitor/posts?limit=150&channelId=${channel!.id}${statusFilter !== ALL ? `&status=${statusFilter}` : ""}${effectiveKind !== ALL ? `&kind=${effectiveKind}` : ""}`),
    enabled: Boolean(channel),
  });
  const withoutPostQuery = useQuery({
    queryKey: ["telegram-monitor-without", channel?.id],
    queryFn: () => api<Array<{ id: number; title: string; side: Side; dueDate: string; prayer: string | null; mosque: string | null }>>(`/api/telegram-monitor/tasks-without-post?channelId=${channel!.id}`),
    enabled: Boolean(channel),
  });
  const dateCheckQuery = useQuery({
    queryKey: ["telegram-monitor-date-check", channel?.id, channel?.pageId],
    queryFn: () => api<{ tasks: number; notMidnight: number }>(`/api/telegram-monitor/channels/${channel!.id}/date-check`),
    enabled: Boolean(channel && isDesigns && channel.pageId),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-posts"] });
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-without"] });
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-settings"] });
    queryClient.invalidateQueries({ queryKey: ["telegram-monitor-date-check"] });
  };
  const saveChannel = useMutation({
    mutationFn: (patch: Partial<Channel>) => api(`/api/telegram-monitor/channels/${channel!.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
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
  const webhook = webhookQuery.data;
  const telegramPages = (data?.pages ?? []).filter((p) => !channel?.telegramPlatformId || p.platformId === channel.telegramPlatformId);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">مراقبة تلقرام</h2>
          <p className="text-muted-foreground mt-2">توثيق تلقائي من قنوات تلقرام: قناة التلاوات (مهمة تلقرام العامة + مهمة التطبيق)، وقناة التصاميم (مهمة اليوم بهاشتاق اليوم).</p>
        </div>
        <Button variant="outline" className="gap-1" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
          {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}افحص الآن
        </Button>
      </div>

      {!data ? (
        <div className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>القنوات</CardTitle>
            <div className="flex flex-wrap gap-2 pt-2">
              {data.channels.map((c) => (
                <Button key={c.id} size="sm" variant={channel?.id === c.id ? "default" : "outline"} className="h-8 gap-1 text-xs" onClick={() => { setSelectedId(c.id); setStatusFilter(ALL); setKindFilter("relevant"); }}>
                  {c.kind === "designs" ? "🎨" : "🎙️"} {c.title ?? c.chatId}
                  {c.trialMode && <span className="rounded-full bg-sky-100 px-1.5 text-[10px] text-sky-700">تجربة</span>}
                  {!c.enabled && <span className="rounded-full bg-muted px-1.5 text-[10px]">متوقفة</span>}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <RegisterChannel data={data} onDone={refresh} />
            {channel && (
              <>
                <p className="text-sm text-muted-foreground">
                  {channel.kind === "designs" ? "قناة تصاميم" : "قناة تلاوات"} · {channel.trialMode ? "وضع التجربة مفعّل: يُسجَّل ما كان سيحدث دون توثيق فعلي." : "التوثيق الفعلي مفعّل."}
                </p>
                <div className="flex flex-wrap gap-6">
                  <label className="flex items-center gap-2 text-sm"><Switch checked={channel.enabled} onCheckedChange={(v) => saveChannel.mutate({ enabled: v })} />تشغيل المراقبة</label>
                  <label className="flex items-center gap-2 text-sm"><Switch checked={channel.trialMode} onCheckedChange={(v) => {
                    if (!v && !confirm("إطفاء وضع التجربة يبدأ التوثيق الفعلي لمهام هذه القناة. متابعة؟")) return;
                    saveChannel.mutate({ trialMode: v });
                  }} />وضع التجربة</label>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-xs font-medium">منصة تلقرام</p>
                    <Select value={channel.telegramPlatformId ? String(channel.telegramPlatformId) : undefined} onValueChange={(v) => saveChannel.mutate({ telegramPlatformId: Number(v) })}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="اختر المنصة" /></SelectTrigger>
                      <SelectContent dir="rtl">{data.platforms.filter((p) => !p.coversAllReciters).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {channel.kind === "recitations" ? (
                    <div className="space-y-1">
                      <p className="text-xs font-medium">منصة التطبيق (تشمل كل القرّاء)</p>
                      <Select value={channel.appPlatformId ? String(channel.appPlatformId) : undefined} onValueChange={(v) => saveChannel.mutate({ appPlatformId: Number(v) })}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="اختر المنصة" /></SelectTrigger>
                        <SelectContent dir="rtl">{data.platforms.filter((p) => p.coversAllReciters).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-xs font-medium">صفحة التصاميم (المطابقة مقصورة عليها)</p>
                      <Select value={channel.pageId ? String(channel.pageId) : undefined} onValueChange={(v) => saveChannel.mutate({ pageId: Number(v) })}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="اختر الصفحة" /></SelectTrigger>
                        <SelectContent dir="rtl">{telegramPages.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name} (#{p.id})</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                {isDesigns && dateCheckQuery.data && dateCheckQuery.data.notMidnight > 0 && (
                  <p className="flex gap-1 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />تنبيه وقائي: {dateCheckQuery.data.notMidnight} من {dateCheckQuery.data.tasks} مهمة على هذه الصفحة تاريخها المخزَّن ليس عند منتصف الليل — قد تكون مزاحة بيوم فلا تُطابَق.</p>
                )}
                {isDesigns && <p className="text-[11px] text-muted-foreground">التصميم = فيديو + هاشتاق اليوم (#الأحد…#السبت). يُقبل من يوم المهمة حتى نهاية اليوم التالي. أول منشور يكمل المهمة، والبقية شواهد إضافية دون إشعار.</p>}
              </>
            )}
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
            {channel?.kind === "recitations" && data.aliases.length > 0 && (
              <div className="text-xs text-muted-foreground">مرادفات الهاشتاق: {data.aliases.map((a) => `#${a.hashtag} ← ${a.reciterName}`).join("، ")}</div>
            )}
          </CardContent>
        </Card>
      )}

      {channel && (
        <Card>
          <CardHeader>
            <CardTitle>المنشورات — {channel.title ?? channel.chatId}</CardTitle>
            <div className="flex flex-wrap gap-2 pt-2">
              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent dir="rtl">
                  <SelectItem value="relevant">{isDesigns ? "منشورات التصاميم" : "منشورات التلاوة"}</SelectItem>
                  <SelectItem value="other">المتجاهَلة</SelectItem>
                  <SelectItem value={ALL}>الكل</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-8 w-56 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent dir="rtl">
                  <SelectItem value={ALL}>كل الحالات</SelectItem>
                  {(isDesigns
                    ? ["needs_review", "no_task", "documented", "documented_extra", "trial_would_document", "trial_would_extra", "trial_no_task", "reverted", "ignored_manual"]
                    : ["needs_review", "no_task", "documented", "trial_would_document", "trial_would_review", "trial_no_task", "reverted", "ignored_manual"]
                  ).map((k) => (
                    <SelectItem key={k} value={k}>{STATUS[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {postsQuery.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (postsQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">لا توجد منشورات.</p>
            ) : (postsQuery.data ?? []).map((post) => isDesigns
              ? <DesignPostCard key={post.id} post={post} onDone={refresh} />
              : <PostCard key={post.id} post={post} reciters={data?.reciters ?? []} onDone={refresh} />)}
          </CardContent>
        </Card>
      )}

      {channel && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">مهام بلا منشور</CardTitle>
            <CardDescription>{isDesigns
              ? "مهام صفحة التصاميم المعلّقة التي انتهت مهلتها (نهاية اليوم التالي) خلال آخر 14 يومًا."
              : "مهام الجانبين المعلّقة التي انتهت نافذتها (72 ساعة) خلال آخر 14 يومًا — قد تكون منشوراتها فاتت أثناء انقطاع."}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y text-sm">
            {(withoutPostQuery.data ?? []).length === 0 ? <p className="text-muted-foreground">لا شيء.</p> : (withoutPostQuery.data ?? []).map((t) => (
              <div key={t.id} className="flex flex-wrap justify-between gap-2 py-1.5 text-xs">
                <span>{t.title}</span>
                <span className="text-muted-foreground">{isDesigns ? "تصاميم" : t.side === "telegram" ? "تلقرام" : "التطبيق"} · {t.dueDate}{t.prayer ? ` · ${PRAYER[t.prayer] ?? t.prayer}` : ""}{t.mosque ? ` · ${MOSQUE[t.mosque] ?? t.mosque}` : ""}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
