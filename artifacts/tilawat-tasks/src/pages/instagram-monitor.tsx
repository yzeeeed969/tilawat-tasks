import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Link2, Loader2, Plus, RefreshCw, Undo2, Unplug } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

// «مراقبة إنستقرام» (للمدير): ربط حساب إنستقرام احترافي لكل قارئ (عبر تسجيل الدخول بإنستقرام)،
// ومتابعة حالة الربط وعدد منشورات الأسبوع وسجل المنشورات. المطابقة بالحساب وحده: أول منشور في الأسبوع
// يُنشئ مهمة الأسبوع من القالب ويوثّقها، والمنشورات التالية شواهد إضافية.

type Account = {
  id: number;
  pageId: number;
  pageName: string;
  reciterName: string;
  memberId: number;
  memberName: string;
  enabled: boolean;
  username: string | null;
  status: "not_connected" | "connected" | "needs_reconnect";
  lastError: string | null;
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  currentWeekPosts: number;
};
type Setup = {
  settings: { enabled: boolean; trialMode: boolean };
  meta: { configured: boolean; missingEnv: string[]; redirectUri: string | null; scopes: string[] };
  accounts: Account[];
  pages: Array<{ id: number; name: string; reciterId: number | null; reciterName: string | null }>;
  members: Array<{ id: number; name: string }>;
};
type Media = {
  id: number;
  reciterName: string;
  username: string | null;
  permalink: string | null;
  caption: string | null;
  mediaProductType: string | null;
  publishedAt: string;
  weekStart: string;
  status: string;
  reason: string | null;
  taskId: number | null;
};

const MEDIA_STATUS: Record<string, { label: string; className: string }> = {
  documented: { label: "أنشأ مهمة الأسبوع ووثّقها", className: "bg-green-50 text-green-700 border-green-200" },
  extra_proof: { label: "شاهد إضافي", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  trial_would_create: { label: "تجربة: سيُنشئ المهمة", className: "bg-sky-50 text-sky-700 border-sky-200" },
  trial_would_add: { label: "تجربة: شاهد إضافي", className: "bg-sky-50 text-sky-700 border-sky-200" },
  historical: { label: "قبل الربط", className: "bg-muted text-muted-foreground border-border" },
  ignored: { label: "متجاهَل", className: "bg-muted text-muted-foreground border-border" },
  needs_review: { label: "بحاجة مراجعة", className: "bg-orange-50 text-orange-700 border-orange-200" },
  reverted: { label: "تراجع عنه", className: "bg-red-50 text-red-700 border-red-200" },
  processing: { label: "قيد المعالجة", className: "bg-muted text-muted-foreground border-border" },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? "فشلت العملية");
  return body as T;
}

const riyadh = (value: string | null) => value ? new Date(value).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) : "—";
const riyadhDate = (value: string | null) => value ? new Date(value).toLocaleDateString("ar-SA", { timeZone: "Asia/Riyadh", dateStyle: "medium" }) : "—";

function AccountStatus({ account }: { account: Account }) {
  if (account.status === "connected") return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">مربوط</Badge>;
  if (account.status === "needs_reconnect") return <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">يحتاج إعادة ربط</Badge>;
  return <Badge variant="outline" className="bg-muted text-muted-foreground border-border">غير مربوط</Badge>;
}

export default function InstagramMonitorPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: setup, isLoading } = useQuery({ queryKey: ["instagram-setup"], queryFn: () => api<Setup>("/api/instagram/setup") });
  const { data: media } = useQuery({ queryKey: ["instagram-media"], queryFn: () => api<Media[]>("/api/instagram/media?limit=100") });
  const [newPageId, setNewPageId] = useState("");
  const [newMemberId, setNewMemberId] = useState("");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["instagram-setup"] });
    queryClient.invalidateQueries({ queryKey: ["instagram-media"] });
  };

  // نتيجة العودة من صفحة تسجيل الدخول في إنستقرام (?ig=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ig = params.get("ig");
    if (!ig) return;
    if (ig === "connected") toast({ title: `تم ربط ${params.get("username") ? `@${params.get("username")}` : "الحساب"}` });
    else toast({ title: "تعذّر الربط", description: params.get("message") ?? undefined, variant: "destructive" });
    window.history.replaceState(null, "", window.location.pathname);
  }, [toast]);

  const onError = (err: Error) => toast({ title: err.message, variant: "destructive" });
  const settingsMutation = useMutation({
    mutationFn: (patch: Partial<Setup["settings"]>) => api("/api/instagram/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: refresh,
    onError,
  });
  const createMutation = useMutation({
    mutationFn: () => api("/api/instagram/accounts", { method: "POST", body: JSON.stringify({ pageId: Number(newPageId), memberId: Number(newMemberId) }) }),
    onSuccess: () => { setNewPageId(""); setNewMemberId(""); refresh(); toast({ title: "أُضيف الحساب — اضغط «ربط» لتسجيل الدخول بإنستقرام" }); },
    onError,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) => api(`/api/instagram/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: refresh,
    onError,
  });
  const connectMutation = useMutation({
    mutationFn: (id: number) => api<{ url: string }>(`/api/instagram/accounts/${id}/connect`, { method: "POST" }),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError,
  });
  const disconnectMutation = useMutation({
    mutationFn: (id: number) => api(`/api/instagram/accounts/${id}/disconnect`, { method: "POST" }),
    onSuccess: refresh,
    onError,
  });
  const checkMutation = useMutation({
    mutationFn: (accountId?: number) => api<{ processed: number; error?: string }>("/api/instagram/check-now", { method: "POST", body: JSON.stringify(accountId ? { accountId } : {}) }),
    onSuccess: (result) => { refresh(); toast({ title: result.error ? result.error : `تم الفحص — ${result.processed} منشور جديد` }); },
    onError,
  });
  const revertMutation = useMutation({
    mutationFn: (id: number) => api(`/api/instagram/media/${id}/revert`, { method: "POST" }),
    onSuccess: () => { refresh(); toast({ title: "تم التراجع عن الشاهد" }); },
    onError,
  });

  const usedPageIds = useMemo(() => new Set(setup?.accounts.map((a) => a.pageId) ?? []), [setup]);
  const availablePages = (setup?.pages ?? []).filter((p) => p.reciterId && !usedPageIds.has(p.id));
  const needsReconnect = (setup?.accounts ?? []).filter((a) => a.status === "needs_reconnect");

  if (isLoading || !setup) {
    return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">مراقبة إنستقرام</h2>
        <p className="text-muted-foreground mt-2 text-lg">أول منشور في الأسبوع من حساب القارئ يُنشئ مهمة الأسبوع ويوثّقها، والمنشورات التالية تُضاف شواهد إضافية</p>
      </div>

      {needsReconnect.map((account) => (
        <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">حساب {account.reciterName}{account.username ? ` (@${account.username})` : ""} يحتاج إعادة ربط</p>
              {account.lastError && <p className="text-sm">{account.lastError}</p>}
            </div>
          </div>
          <Button size="sm" variant="destructive" disabled={connectMutation.isPending || !setup.meta.configured} onClick={() => connectMutation.mutate(account.id)}>
            <Link2 className="ml-1 h-4 w-4" /> إعادة الربط
          </Button>
        </div>
      ))}

      {!setup.meta.configured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-semibold">إعدادات ميتا غير مكتملة — الربط والمراقبة متوقفان.</p>
          <p className="mt-1">أضف في Railway: {setup.meta.missingEnv.map((name) => <code key={name} className="mx-1 rounded bg-amber-100 px-1">{name}</code>)}</p>
        </div>
      )}

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">الإعدادات</CardTitle>
          <CardDescription>
            {setup.meta.redirectUri ? <>رابط إعادة التوجيه المسجّل: <code dir="ltr" className="rounded bg-muted px-1">{setup.meta.redirectUri}</code></> : "رابط إعادة التوجيه غير مضبوط بعد"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={setup.settings.enabled} onCheckedChange={(v) => settingsMutation.mutate({ enabled: v })} />
            المراقبة مفعّلة
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={setup.settings.trialMode} onCheckedChange={(v) => settingsMutation.mutate({ trialMode: v })} />
            وضع التجربة (يسجّل ما كان سيحدث دون إنشاء مهام أو شواهد)
          </label>
          <Button size="sm" variant="outline" disabled={checkMutation.isPending || !setup.meta.configured} onClick={() => checkMutation.mutate(undefined)}>
            {checkMutation.isPending ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-1 h-4 w-4" />} افحص الآن
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">الحسابات</CardTitle>
          <CardDescription>حساب واحد لكل صفحة قارئ على منصة إنستقرام. القالب = الصفحة + العضو المسؤول عن مهمة الأسبوع.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="p-2 text-right font-medium">القارئ / الصفحة</th>
                  <th className="p-2 text-right font-medium">الحساب</th>
                  <th className="p-2 text-right font-medium">العضو المسؤول</th>
                  <th className="p-2 text-right font-medium">منشورات هذا الأسبوع</th>
                  <th className="p-2 text-right font-medium">المفتاح ينتهي</th>
                  <th className="p-2 text-right font-medium">آخر فحص</th>
                  <th className="p-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {setup.accounts.length === 0 && (
                  <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">لا توجد حسابات بعد — أضف حسابًا من الأسفل.</td></tr>
                )}
                {setup.accounts.map((account) => (
                  <tr key={account.id} className="border-t align-top">
                    <td className="p-2">
                      <div className="font-medium">{account.reciterName}</div>
                      <div className="text-xs text-muted-foreground">{account.pageName}</div>
                    </td>
                    <td className="p-2 space-y-1">
                      <AccountStatus account={account} />
                      {account.username && <div dir="ltr" className="text-xs text-right">@{account.username}</div>}
                      {!account.enabled && <div className="text-xs text-muted-foreground">موقوف</div>}
                    </td>
                    <td className="p-2">
                      <Select value={String(account.memberId)} onValueChange={(v) => updateMutation.mutate({ id: account.id, patch: { memberId: Number(v) } })}>
                        <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                        <SelectContent dir="rtl" className="max-h-72 overflow-y-auto">
                          {setup.members.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-2 text-center font-semibold">{account.currentWeekPosts}</td>
                    <td className="p-2 text-xs">{riyadhDate(account.tokenExpiresAt)}</td>
                    <td className="p-2 text-xs">{riyadh(account.lastCheckedAt)}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant={account.status === "connected" ? "ghost" : "default"} disabled={connectMutation.isPending || !setup.meta.configured} onClick={() => connectMutation.mutate(account.id)}>
                          <Link2 className="ml-1 h-3.5 w-3.5" /> {account.status === "not_connected" ? "ربط" : "إعادة الربط"}
                        </Button>
                        {account.status === "connected" && (
                          <Button size="sm" variant="ghost" disabled={checkMutation.isPending} onClick={() => checkMutation.mutate(account.id)}>
                            <RefreshCw className="ml-1 h-3.5 w-3.5" /> افحص
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => updateMutation.mutate({ id: account.id, patch: { enabled: !account.enabled } })}>
                          {account.enabled ? "إيقاف" : "تشغيل"}
                        </Button>
                        {account.status !== "not_connected" && (
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("فصل الحساب؟ يُحذف مفتاح الوصول فقط وتبقى المهام والسجل.")) disconnectMutation.mutate(account.id); }}>
                            <Unplug className="ml-1 h-3.5 w-3.5" /> فصل
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">صفحة القارئ على إنستقرام</div>
              <Select value={newPageId} onValueChange={setNewPageId}>
                <SelectTrigger className="h-9 w-64"><SelectValue placeholder={availablePages.length ? "اختر الصفحة" : "لا توجد صفحات متاحة"} /></SelectTrigger>
                <SelectContent dir="rtl" className="max-h-72 overflow-y-auto">
                  {availablePages.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name} — {p.reciterName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">العضو المسؤول</div>
              <Select value={newMemberId} onValueChange={setNewMemberId}>
                <SelectTrigger className="h-9 w-48"><SelectValue placeholder="اختر العضو" /></SelectTrigger>
                <SelectContent dir="rtl" className="max-h-72 overflow-y-auto">
                  {setup.members.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" disabled={!newPageId || !newMemberId || createMutation.isPending} onClick={() => createMutation.mutate()}>
              <Plus className="ml-1 h-4 w-4" /> إضافة حساب
            </Button>
          </div>
          {setup.pages.length === 0 && (
            <p className="text-xs text-muted-foreground">لا توجد صفحات على منصة إنستقرام — أضف صفحة لكل قارئ (مربوطة بالقارئ) من «المنصات والصفحات».</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">سجل المنشورات</CardTitle>
          <CardDescription>المنشورات والريلز فقط (القصص لا تُقرأ). الأسبوع من الأحد إلى السبت بتوقيت الرياض.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(media ?? []).length === 0 && <p className="text-sm text-muted-foreground">لا منشورات بعد.</p>}
          {(media ?? []).map((item) => {
            const meta = MEDIA_STATUS[item.status] ?? { label: item.status, className: "bg-muted text-muted-foreground border-border" };
            const canRevert = item.status === "documented" || item.status === "extra_proof";
            return (
              <div key={item.id} className="rounded-md border border-border bg-background p-3 space-y-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium">
                      {item.reciterName}{item.username ? ` · @${item.username}` : ""}
                      {item.mediaProductType === "REELS" && <span className="mr-1 text-xs text-muted-foreground">(ريل)</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      نُشر: {riyadh(item.publishedAt)} · أسبوع {item.weekStart}{item.taskId ? ` · مهمة #${item.taskId}` : ""}
                    </div>
                    {item.caption && <p className="line-clamp-2 text-xs text-muted-foreground">{item.caption}</p>}
                  </div>
                  <Badge variant="outline" className={meta.className}>
                    {item.status === "documented" && <CheckCircle2 className="ml-1 h-3 w-3" />}
                    {meta.label}
                  </Badge>
                </div>
                {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
                <div className="flex flex-wrap gap-2 pt-1">
                  {item.permalink && <a href={item.permalink} target="_blank" rel="noreferrer" className="text-xs text-sidebar-primary hover:underline">فتح المنشور</a>}
                  {canRevert && (
                    <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => { if (confirm("تراجع عن هذا الشاهد؟ إن كان آخر شاهد تعود مهمة الأسبوع معلّقة.")) revertMutation.mutate(item.id); }}>
                      <Undo2 className="ml-1 h-3.5 w-3.5" /> تراجع
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
