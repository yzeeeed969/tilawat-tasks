import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, RefreshCw, Youtube as YoutubeIcon, Link2, Ban, Undo2, Plus, Pencil, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useListPlatforms, getListPlatformsQueryKey, useListReciters, getListRecitersQueryKey } from "@workspace/api-client-react";
import { useIsAdmin } from "@/lib/roles";

// صفحة إدارية للمدير فقط: مراقبة قنوات يوتيوب والتوثيق التلقائي (وضع التجربة/التفعيل).
// كل الاتصالات هنا عبر fetch مباشر إلى مسارات /api/youtube/* الجديدة — بلا OpenAPI/codegen،
// لأنها ميزة معزولة جديدة كليًا ولا تستدعي تعديل مواصفة الـAPI العامة.

type YoutubeSettingsData = { id: number; enabled: boolean; trialMode: boolean; checkIntervalMinutes: number };

type YoutubeChannel = {
  id: number;
  handle: string;
  displayName: string;
  reciterNameConstant: string;
  platformId: number;
  platformName: string | null;
  reciterId: number;
  reciterName: string | null;
  enabled: boolean;
  channelId: string | null;
  lastCheckedAt: string | null;
  monitoringStartedAt: string;
};

type YoutubeVideo = {
  id: number;
  channelRowId: number;
  videoId: string;
  title: string;
  publishedAt: string;
  url: string;
  hasMarker: boolean;
  extractedPrayer: string | null;
  extractedHijriDay: number | null;
  extractedHijriMonth: number | null;
  matchedTaskId: number | null;
  status: string;
  decisionReason: string | null;
  processedAt: string;
};

type TaskWithoutVideo = { id: number; title: string; dueDate: string | null };

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  historical: { label: "سجل قديم", className: "bg-muted text-muted-foreground border-border" },
  ignored: { label: "تجاهل تلقائي", className: "bg-muted text-muted-foreground border-border" },
  ignored_manual: { label: "تجاهله المدير", className: "bg-muted text-muted-foreground border-border" },
  no_marker: { label: "بلا علامة *1 بعد", className: "bg-amber-50 text-amber-700 border-amber-200" },
  needs_review: { label: "بحاجة مراجعة", className: "bg-orange-50 text-orange-700 border-orange-200" },
  no_task: { label: "بلا مهمة مطابقة", className: "bg-orange-50 text-orange-700 border-orange-200" },
  documented: { label: "وُثِّق", className: "bg-green-50 text-green-700 border-green-200" },
  reverted: { label: "تراجع عنه", className: "bg-red-50 text-red-700 border-red-200" },
  trial_would_document: { label: "تجربة: سيُوثَّق", className: "bg-sky-50 text-sky-700 border-sky-200" },
  trial_would_review: { label: "تجربة: سيُراجَع", className: "bg-sky-50 text-sky-700 border-sky-200" },
  trial_no_task: { label: "تجربة: بلا مهمة", className: "bg-sky-50 text-sky-700 border-sky-200" },
};

const PRAYER_LABELS: Record<string, string> = {
  fajr: "الفجر", maghrib: "المغرب", isha: "العشاء", jumuah: "الجمعة",
};

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error("فشل تحميل البيانات");
  return res.json();
}

async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed?.error ?? "فشلت العملية");
  return parsed;
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_LABELS[status] ?? { label: status, className: "bg-muted text-muted-foreground border-border" };
  return <Badge variant="outline" className={meta.className}>{meta.label}</Badge>;
}

type ChannelFormValue = { handle: string; displayName: string; reciterNameConstant: string; platformId: string; reciterId: string };

// حقول نموذج القناة — مشتركة بين "إضافة قناة" و"تعديل قناة" حتى لا يتكرر التصميم.
function ChannelFormFields({
  value, onChange, platforms, reciters,
}: {
  value: ChannelFormValue;
  onChange: (patch: Partial<ChannelFormValue>) => void;
  platforms: { id: number; name: string }[] | undefined;
  reciters: { id: number; name: string }[] | undefined;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Input placeholder="المعرّف @handle" value={value.handle} onChange={(e) => onChange({ handle: e.target.value })} dir="ltr" />
      <Input placeholder="اسم وصفي للقناة" value={value.displayName} onChange={(e) => onChange({ displayName: e.target.value })} />
      <Input placeholder='الاسم الثابت في العناوين (مثل بندر بليلة، بلا علامات اقتباس)' value={value.reciterNameConstant} onChange={(e) => onChange({ reciterNameConstant: e.target.value })} />
      <Select value={value.platformId} onValueChange={(v) => onChange({ platformId: v })}>
        <SelectTrigger><SelectValue placeholder="المنصة" /></SelectTrigger>
        <SelectContent dir="rtl">
          {(platforms ?? []).map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={value.reciterId} onValueChange={(v) => onChange({ reciterId: v })}>
        <SelectTrigger><SelectValue placeholder="القارئ" /></SelectTrigger>
        <SelectContent dir="rtl">
          {(reciters ?? []).map((r: any) => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function SettingsAndChannelsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["youtube-settings"], queryFn: () => apiGet<YoutubeSettingsData>("/api/youtube/settings") });
  const { data: channels } = useQuery({ queryKey: ["youtube-channels"], queryFn: () => apiGet<YoutubeChannel[]>("/api/youtube/channels") });
  const { data: platforms } = useListPlatforms({ query: { queryKey: getListPlatformsQueryKey() } });
  const { data: reciters } = useListReciters({}, { query: { queryKey: getListRecitersQueryKey() } });

  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newChannel, setNewChannel] = useState<ChannelFormValue>({ handle: "", displayName: "", reciterNameConstant: "", platformId: "", reciterId: "" });
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<number | null>(null);
  const [editChannel, setEditChannel] = useState<ChannelFormValue>({ handle: "", displayName: "", reciterNameConstant: "", platformId: "", reciterId: "" });

  const saveSettings = useMutation({
    mutationFn: (update: Partial<Pick<YoutubeSettingsData, "enabled" | "trialMode">>) => apiSend("/api/youtube/settings", "PATCH", update),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["youtube-settings"] });
      toast({ title: "تم حفظ الإعداد" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const scanNow = useMutation({
    mutationFn: () => apiSend<{ processed: number; skippedNoKey: boolean; channelsChecked: number }>("/api/youtube/scan-now", "POST"),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["youtube-videos"] });
      queryClient.invalidateQueries({ queryKey: ["youtube-channels"] });
      if (result.skippedNoKey) {
        setScanResult("المفتاح YOUTUBE_API_KEY غير مضبوط بعد — لا شيء تم فحصه.");
      } else {
        setScanResult(`فُحصت ${result.channelsChecked} قناة، وعُولج ${result.processed} مقطع.`);
      }
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const toggleChannel = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => apiSend(`/api/youtube/channels/${id}`, "PATCH", { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["youtube-channels"] }),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const saveChannelEdit = useMutation({
    mutationFn: ({ id, data }: { id: number; data: ChannelFormValue }) => apiSend<{ reprocessed: number }>(`/api/youtube/channels/${id}`, "PATCH", {
      handle: data.handle,
      displayName: data.displayName,
      reciterNameConstant: data.reciterNameConstant,
      platformId: Number(data.platformId),
      reciterId: Number(data.reciterId),
    }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["youtube-channels"] });
      queryClient.invalidateQueries({ queryKey: ["youtube-videos"] });
      toast({
        title: result.reprocessed > 0
          ? `تم حفظ التعديلات — وأُعيد فحص ${result.reprocessed} مقطع بناءً على البيانات الجديدة`
          : "تم حفظ التعديلات",
      });
      setEditingChannelId(null);
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const startEditChannel = (channel: YoutubeChannel) => {
    setEditingChannelId(channel.id);
    setEditChannel({
      handle: channel.handle,
      displayName: channel.displayName,
      reciterNameConstant: channel.reciterNameConstant,
      platformId: String(channel.platformId),
      reciterId: String(channel.reciterId),
    });
  };

  const createChannel = useMutation({
    mutationFn: () => apiSend("/api/youtube/channels", "POST", {
      handle: newChannel.handle,
      displayName: newChannel.displayName,
      reciterNameConstant: newChannel.reciterNameConstant,
      platformId: Number(newChannel.platformId),
      reciterId: Number(newChannel.reciterId),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["youtube-channels"] });
      toast({ title: "تمت إضافة القناة" });
      setShowAddChannel(false);
      setNewChannel({ handle: "", displayName: "", reciterNameConstant: "", platformId: "", reciterId: "" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="bg-sidebar/5 border-b border-border/50 pb-6">
        <CardTitle className="flex items-center gap-2">
          <YoutubeIcon className="h-5 w-5 text-sidebar-primary" />
          مراقبة يوتيوب — الإعدادات والقنوات
        </CardTitle>
        <CardDescription className="text-base mt-2">
          التحكم العام، ووضع التجربة، وقائمة القنوات المراقَبة.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        {!settings ? (
          <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-3">
                <Switch checked={settings.enabled} onCheckedChange={(v) => saveSettings.mutate({ enabled: v })} />
                <span className="text-sm font-medium">التشغيل العام</span>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={settings.trialMode} onCheckedChange={(v) => saveSettings.mutate({ trialMode: v })} />
                <span className="text-sm font-medium">وضع التجربة (تسجيل بلا توثيق فعلي)</span>
              </div>
              <Button type="button" variant="outline" onClick={() => scanNow.mutate()} disabled={scanNow.isPending}>
                {scanNow.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <RefreshCw className="h-4 w-4 ml-2" />}
                افحص الآن
              </Button>
              {scanResult && <span className="text-sm text-muted-foreground">{scanResult}</span>}
            </div>

            {!settings.trialMode && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800">
                وضع التجربة مُطفأ — أي تطابق واضح يُوثَّق فعليًا الآن (شاهد + إكمال + إشعارات).
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">القنوات المراقَبة</p>
              {(channels ?? []).map((channel) => (
                <div key={channel.id} className="rounded-md border border-border bg-background p-3 text-sm space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="font-medium">{channel.displayName} — {channel.handle}</div>
                      <div className="text-xs text-muted-foreground">
                        الثابت: "{channel.reciterNameConstant}" · المنصة: {channel.platformName ?? "—"} · القارئ: {channel.reciterName ?? "—"}
                        {" · "}{channel.channelId ? "مربوطة بمعرّف يوتيوب" : "لم تُربَط بعد (بانتظار أول فحص ناجح)"}
                        {channel.lastCheckedAt && ` · آخر فحص: ${new Date(channel.lastCheckedAt).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" })}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button" size="sm" variant="ghost"
                        onClick={() => editingChannelId === channel.id ? setEditingChannelId(null) : startEditChannel(channel)}
                      >
                        {editingChannelId === channel.id ? <X className="h-3.5 w-3.5 ml-1" /> : <Pencil className="h-3.5 w-3.5 ml-1" />}
                        {editingChannelId === channel.id ? "إلغاء" : "تعديل"}
                      </Button>
                      <span className="text-xs text-muted-foreground">{channel.enabled ? "مفعَّلة" : "معطَّلة"}</span>
                      <Switch checked={channel.enabled} onCheckedChange={(v) => toggleChannel.mutate({ id: channel.id, enabled: v })} />
                    </div>
                  </div>

                  {editingChannelId === channel.id && (
                    <div className="space-y-3 rounded-md border border-dashed border-border p-3 bg-muted/20">
                      <ChannelFormFields
                        value={editChannel}
                        onChange={(patch) => setEditChannel((s) => ({ ...s, ...patch }))}
                        platforms={platforms}
                        reciters={reciters}
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button" size="sm"
                          onClick={() => saveChannelEdit.mutate({ id: channel.id, data: editChannel })}
                          disabled={saveChannelEdit.isPending}
                        >
                          {saveChannelEdit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin ml-2" />}
                          حفظ التعديلات
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingChannelId(null)} disabled={saveChannelEdit.isPending}>إلغاء</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {(channels ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">لا توجد قنوات بعد.</p>
              )}
            </div>

            {!showAddChannel ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setShowAddChannel(true)}>
                <Plus className="h-4 w-4 ml-2" /> إضافة قناة يدويًا
              </Button>
            ) : (
              <div className="space-y-3 rounded-md border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">
                  استخدم هذا فقط إن لم يُفعَّل صف القناة تلقائيًا (تعذّر إيجاد منصة أو قارئ مطابق بوضوح).
                </p>
                <ChannelFormFields
                  value={newChannel}
                  onChange={(patch) => setNewChannel((s) => ({ ...s, ...patch }))}
                  platforms={platforms}
                  reciters={reciters}
                />
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={() => createChannel.mutate()} disabled={createChannel.isPending}>
                    {createChannel.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin ml-2" />}
                    حفظ القناة
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowAddChannel(false)}>إلغاء</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VideosTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [linkTaskIdByVideo, setLinkTaskIdByVideo] = useState<Record<number, string>>({});

  const { data: videos, isLoading } = useQuery({
    queryKey: ["youtube-videos", statusFilter],
    queryFn: () => apiGet<YoutubeVideo[]>(`/api/youtube/videos${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`),
  });

  const linkMutation = useMutation({
    mutationFn: ({ id, taskId }: { id: number; taskId: number }) => apiSend(`/api/youtube/videos/${id}/link`, "POST", { taskId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["youtube-videos"] }); toast({ title: "تم الربط والتوثيق" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  const ignoreMutation = useMutation({
    mutationFn: (id: number) => apiSend(`/api/youtube/videos/${id}/ignore`, "POST"),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["youtube-videos"] }); toast({ title: "تم التجاهل" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  const revertMutation = useMutation({
    mutationFn: (id: number) => apiSend(`/api/youtube/videos/${id}/revert`, "POST"),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["youtube-videos"] }); toast({ title: "تم التراجع — تنبيه: الإشعارات المُرسَلة سابقًا لم تُسحَب" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const filterOptions = [
    { value: "all", label: "الكل" },
    { value: "needs_review", label: "بحاجة مراجعة" },
    { value: "no_task", label: "بلا مهمة" },
    { value: "documented", label: "وُثِّق" },
    { value: "trial_would_document", label: "تجربة: سيُوثَّق" },
    { value: "trial_would_review", label: "تجربة: سيُراجَع" },
    { value: "no_marker", label: "بلا علامة" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">تصفية:</span>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent dir="rtl">
            {filterOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
      ) : (videos ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground p-4">لا توجد مقاطع بهذه الحالة.</p>
      ) : (
        <div className="space-y-3">
          {(videos ?? []).map((video) => {
            const canLink = ["needs_review", "no_task", "trial_would_review", "trial_no_task", "trial_would_document"].includes(video.status);
            const canIgnore = !["ignored_manual", "documented"].includes(video.status);
            const canRevert = video.status === "documented";
            return (
              <div key={video.id} className="rounded-md border border-border bg-background p-3 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <a href={video.url} target="_blank" rel="noreferrer" className="font-medium text-sm hover:underline break-words">{video.title}</a>
                    <div className="text-xs text-muted-foreground">
                      نُشر: {new Date(video.publishedAt).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" })}
                      {video.extractedPrayer && ` · الصلاة: ${PRAYER_LABELS[video.extractedPrayer] ?? video.extractedPrayer}`}
                      {video.extractedHijriDay && ` · التاريخ: ${video.extractedHijriDay}-${video.extractedHijriMonth}-1448هـ`}
                      {video.matchedTaskId && ` · مهمة #${video.matchedTaskId}`}
                    </div>
                  </div>
                  <StatusBadge status={video.status} />
                </div>
                {video.decisionReason && <p className="text-xs text-muted-foreground">{video.decisionReason}</p>}
                {(canLink || canIgnore || canRevert) && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {canLink && (
                      <>
                        <Input
                          type="number"
                          placeholder="رقم المهمة"
                          className="h-8 w-28"
                          value={linkTaskIdByVideo[video.id] ?? (video.matchedTaskId ? String(video.matchedTaskId) : "")}
                          onChange={(e) => setLinkTaskIdByVideo((s) => ({ ...s, [video.id]: e.target.value }))}
                        />
                        <Button
                          type="button" size="sm" variant="outline"
                          onClick={() => {
                            const taskId = Number(linkTaskIdByVideo[video.id] ?? video.matchedTaskId);
                            if (!Number.isInteger(taskId) || taskId <= 0) { toast({ title: "أدخل رقم مهمة صحيح", variant: "destructive" }); return; }
                            linkMutation.mutate({ id: video.id, taskId });
                          }}
                        >
                          <Link2 className="h-3.5 w-3.5 ml-1" /> اربط ووثّق
                        </Button>
                      </>
                    )}
                    {canIgnore && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => ignoreMutation.mutate(video.id)}>
                        <Ban className="h-3.5 w-3.5 ml-1" /> تجاهل
                      </Button>
                    )}
                    {canRevert && (
                      <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("تراجع عن التوثيق؟ الإشعارات المُرسَلة سابقًا لن تُسحَب.")) revertMutation.mutate(video.id); }}>
                        <Undo2 className="h-3.5 w-3.5 ml-1" /> تراجع
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TasksWithoutVideoTab() {
  const { data, isLoading } = useQuery({ queryKey: ["youtube-tasks-without-video"], queryFn: () => apiGet<TaskWithoutVideo[]>("/api/youtube/tasks-without-video") });

  if (isLoading) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>;
  if (!data || data.length === 0) return <p className="text-sm text-muted-foreground p-4">لا توجد مهام يوتيوب معلّقة فات موعدها بلا مقطع.</p>;

  return (
    <div className="space-y-2">
      {data.map((task) => (
        <div key={task.id} className="flex items-center justify-between rounded-md border border-border bg-background p-3 text-sm">
          <span>{task.title}</span>
          <span className="text-xs text-muted-foreground">
            {task.dueDate ? new Date(task.dueDate).toLocaleDateString("ar-SA", { timeZone: "Asia/Riyadh" }) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function YoutubeMonitorPage() {
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<"videos" | "without-video">("videos");

  if (!isAdmin) {
    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">مراقبة يوتيوب</h2>
        </div>
        <Card className="border-border/50 shadow-sm">
          <CardContent className="p-6 text-sm text-muted-foreground">
            ليست لديك صلاحية الوصول إلى هذه الصفحة.
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs = useMemo(() => [
    { value: "videos" as const, label: "المقاطع" },
    { value: "without-video" as const, label: "مهام بلا مقطع" },
  ], []);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">مراقبة يوتيوب</h2>
        <p className="text-muted-foreground mt-2 text-lg">مراقبة القنوات وتوثيق المهام تلقائيًا من مقاطع يوتيوب</p>
      </div>

      <SettingsAndChannelsCard />

      <Card className="border-border/50 shadow-sm">
        <CardContent className="p-6 space-y-4">
          <div className="flex gap-2 border-b border-border pb-3">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  tab === t.value ? "bg-sidebar-primary text-sidebar-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "videos" ? <VideosTab /> : <TasksWithoutVideoTab />}
        </CardContent>
      </Card>
    </div>
  );
}
