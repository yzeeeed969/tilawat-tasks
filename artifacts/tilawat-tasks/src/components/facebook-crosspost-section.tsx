import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Link2, Loader2, Undo2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

// نسخة فيسبوك لمنشورات إنستقرام (الاتجاه إنستقرام ← فيسبوك فقط): ربط فيسبوك مرة واحدة، ربط كل حساب
// إنستقرام بصفحة فيسبوك المقابلة، الإعدادات (وضع التجربة + نافذة التوقيت)، وسجل المطابقات مع الإرفاق
// اليدوي والتراجع. رابط فيسبوك شاهد تكميلي: لا يغيّر الحالة ولا العدّاد.

type FacebookSetup = {
  configured: boolean;
  missingEnv: string[];
  redirectUri: string | null;
  scopes: string[];
  connection: { status: "not_connected" | "connected" | "needs_reconnect"; userName: string | null; tokenExpiresAt: string | null; lastError: string | null; connectedAt: string | null };
  pages: Array<{ fbPageId: string; name: string; status: string; lastError: string | null }>;
};
type AccountLite = { id: number; reciterName: string; username: string | null; fbPageId?: string | null };
type Link = {
  id: number;
  status: string;
  fbUrl: string | null;
  taskId: number | null;
  candidates: Array<{ id: string; kind: string; url: string; createdAt: string; text: string }> | null;
  reason: string | null;
  attempts: number;
  igPermalink: string | null;
  igCaption: string | null;
  igPublishedAt: string;
  reciterName: string;
};

const LINK_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "بانتظار نسخة فيسبوك", className: "bg-muted text-muted-foreground border-border" },
  linked: { label: "أُرفقت تلقائيًا", className: "bg-green-50 text-green-700 border-green-200" },
  manual: { label: "أُرفقت يدويًا", className: "bg-green-50 text-green-700 border-green-200" },
  trial_would_link: { label: "تجربة: سيُرفق", className: "bg-sky-50 text-sky-700 border-sky-200" },
  ambiguous: { label: "أكثر من تطابق — اختر", className: "bg-orange-50 text-orange-700 border-orange-200" },
  not_found: { label: "لم يُعثر على نسخة فيسبوك", className: "bg-red-50 text-red-700 border-red-200" },
  reverted: { label: "تراجع عنه", className: "bg-muted text-muted-foreground border-border" },
  skipped: { label: "تُخطّي", className: "bg-muted text-muted-foreground border-border" },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? "فشلت العملية");
  return body as T;
}

const riyadh = (value: string | null) => value ? new Date(value).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) : "—";
const normalizeName = (value: string) => value.replace(/\s+/g, "").replace(/[أإآ]/g, "ا");

export function FacebookCrosspostSection({ facebook, accounts, settings, onChanged }: {
  facebook: FacebookSetup;
  accounts: AccountLite[];
  settings: { fbTrialMode: boolean; fbMatchWindowHours: number };
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: links } = useQuery({ queryKey: ["facebook-links"], queryFn: () => api<Link[]>("/api/instagram/facebook-links?limit=100") });
  const [manualUrl, setManualUrl] = useState<Record<number, string>>({});
  const refresh = () => { onChanged(); queryClient.invalidateQueries({ queryKey: ["facebook-links"] }); };
  const onError = (err: Error) => toast({ title: err.message, variant: "destructive" });

  // نتيجة العودة من تفويض فيسبوك (?fb=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fb = params.get("fb");
    if (!fb) return;
    if (fb === "connected") toast({ title: `تم ربط فيسبوك — ${params.get("pages") ?? 0} صفحة` });
    else toast({ title: "تعذّر ربط فيسبوك", description: params.get("message") ?? undefined, variant: "destructive" });
    window.history.replaceState(null, "", window.location.pathname);
  }, [toast]);

  const connectMutation = useMutation({
    mutationFn: () => api<{ url: string }>("/api/instagram/facebook/connect", { method: "POST" }),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError,
  });
  const settingsMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api("/api/instagram/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: refresh,
    onError,
  });
  const pageMutation = useMutation({
    mutationFn: ({ id, fbPageId }: { id: number; fbPageId: string | null }) => api(`/api/instagram/accounts/${id}/facebook-page`, { method: "PUT", body: JSON.stringify({ fbPageId }) }),
    onSuccess: refresh,
    onError,
  });
  const manualMutation = useMutation({
    mutationFn: ({ id, url }: { id: number; url: string }) => api(`/api/instagram/facebook-links/${id}/manual`, { method: "POST", body: JSON.stringify({ url }) }),
    onSuccess: () => { refresh(); toast({ title: "أُرفق رابط فيسبوك (شاهد تكميلي)" }); },
    onError,
  });
  const revertMutation = useMutation({
    mutationFn: (id: number) => api(`/api/instagram/facebook-links/${id}/revert`, { method: "POST" }),
    onSuccess: () => { refresh(); toast({ title: "تم التراجع عن رابط فيسبوك" }); },
    onError,
  });

  const connection = facebook.connection;
  const availablePages = facebook.pages.filter((page) => page.status !== "missing");
  // اقتراح الصفحة باسم القارئ (الأسماء واضحة) — للمساعدة فقط، الربط يبقى اختيارًا صريحًا.
  const suggestedFor = (account: AccountLite) => availablePages.find((page) => normalizeName(page.name).includes(normalizeName(account.reciterName)));

  return (
    <>
      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">نسخة فيسبوك (إنستقرام ← فيسبوك)</CardTitle>
          <CardDescription>
            لكل منشور إنستقرام موثَّق يُبحث عن نسخته التلقائية في صفحة فيسبوك المقابلة (نفس النص، ضمن نافذة التوقيت)،
            ويُرفق رابطها شاهدًا تكميليًا على نفس المهمة — لا يغيّر الحالة ولا العدّاد ولا يُرسل إشعارًا. محتوى فيسبوك بلا أصل إنستقرام لا يُمس.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!facebook.configured && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              إعدادات فيسبوك غير مكتملة — أضف في Railway: {facebook.missingEnv.map((name) => <code key={name} className="mx-1 rounded bg-amber-100 px-1">{name}</code>)}
            </div>
          )}
          {connection.status === "needs_reconnect" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div><p className="font-semibold">ربط فيسبوك يحتاج إعادة تفويض</p>{connection.lastError && <p>{connection.lastError}</p>}</div>
              </div>
              <Button size="sm" variant="destructive" disabled={!facebook.configured || connectMutation.isPending} onClick={() => connectMutation.mutate()}>إعادة الربط</Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Badge variant="outline" className={connection.status === "connected" ? "bg-green-50 text-green-700 border-green-200" : "bg-muted text-muted-foreground border-border"}>
              {connection.status === "connected" ? `مربوط${connection.userName ? ` — ${connection.userName}` : ""}` : connection.status === "needs_reconnect" ? "يحتاج إعادة ربط" : "غير مربوط"}
            </Badge>
            {connection.status === "connected" && <span className="text-xs text-muted-foreground">{availablePages.length} صفحة · مفتاح المستخدم ينتهي {riyadh(connection.tokenExpiresAt)}</span>}
            <Button size="sm" variant={connection.status === "connected" ? "outline" : "default"} disabled={!facebook.configured || connectMutation.isPending} onClick={() => connectMutation.mutate()}>
              <Link2 className="ml-1 h-4 w-4" /> {connection.status === "not_connected" ? "ربط فيسبوك" : "تحديث الربط والصفحات"}
            </Button>
          </div>
          {facebook.redirectUri && <p className="text-xs text-muted-foreground">رابط إعادة التوجيه: <code dir="ltr" className="rounded bg-muted px-1">{facebook.redirectUri}</code></p>}
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={settings.fbTrialMode} onCheckedChange={(v) => settingsMutation.mutate({ fbTrialMode: v })} />
              وضع التجربة لفيسبوك (يسجّل المطابقات دون إرفاق شواهد)
            </label>
            <label className="flex items-center gap-2">
              نافذة التوقيت ±
              <Input type="number" min={1} max={48} className="h-8 w-16" defaultValue={settings.fbMatchWindowHours}
                onBlur={(e) => { const v = Number(e.target.value); if (v !== settings.fbMatchWindowHours) settingsMutation.mutate({ fbMatchWindowHours: v }); }} />
              ساعات
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead><tr className="text-muted-foreground"><th className="p-2 text-right font-medium">حساب إنستقرام</th><th className="p-2 text-right font-medium">صفحة فيسبوك المقابلة</th></tr></thead>
              <tbody>
                {accounts.map((account) => {
                  const suggestion = !account.fbPageId ? suggestedFor(account) : undefined;
                  return (
                    <tr key={account.id} className="border-t">
                      <td className="p-2">{account.reciterName}{account.username ? <span dir="ltr" className="mr-1 text-xs text-muted-foreground">@{account.username}</span> : null}</td>
                      <td className="p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Select value={account.fbPageId ?? "none"} onValueChange={(v) => pageMutation.mutate({ id: account.id, fbPageId: v === "none" ? null : v })} disabled={facebook.pages.length === 0}>
                            <SelectTrigger className="h-8 w-64"><SelectValue placeholder="اختر الصفحة" /></SelectTrigger>
                            <SelectContent dir="rtl" className="max-h-72 overflow-y-auto">
                              <SelectItem value="none"><span className="text-muted-foreground">— بلا صفحة —</span></SelectItem>
                              {facebook.pages.map((page) => <SelectItem key={page.fbPageId} value={page.fbPageId}>{page.name}{page.status !== "connected" ? " (غير متاحة)" : ""}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          {suggestion && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => pageMutation.mutate({ id: account.id, fbPageId: suggestion.fbPageId })}>
                              اقتراح: {suggestion.name}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {facebook.pages.length === 0 && <p className="text-xs text-muted-foreground">اربط فيسبوك أولًا لتظهر صفحاتك هنا.</p>}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">سجل نسخ فيسبوك</CardTitle>
          <CardDescription>إعادة المحاولة تلقائيًا حتى 48 ساعة (قد يتأخر النشر في فيسبوك)، ثم «لم يُعثر» مع إرفاق يدوي.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(links ?? []).length === 0 && <p className="text-sm text-muted-foreground">لا شيء بعد.</p>}
          {(links ?? []).map((link) => {
            const meta = LINK_STATUS[link.status] ?? { label: link.status, className: "bg-muted text-muted-foreground border-border" };
            const canManual = ["pending", "ambiguous", "not_found", "reverted"].includes(link.status) && link.taskId;
            const canRevert = link.status === "linked" || link.status === "manual";
            return (
              <div key={link.id} className="space-y-1 rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium">{link.reciterName}{link.taskId ? ` · مهمة #${link.taskId}` : ""}</div>
                    <div className="text-xs text-muted-foreground">إنستقرام: {riyadh(link.igPublishedAt)} {link.igPermalink && <a href={link.igPermalink} target="_blank" rel="noreferrer" className="text-sidebar-primary hover:underline">فتح</a>}</div>
                    {link.igCaption && <p className="line-clamp-1 text-xs text-muted-foreground">{link.igCaption}</p>}
                  </div>
                  <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
                </div>
                {link.reason && <p className="text-xs text-muted-foreground">{link.reason}{link.attempts > 1 ? ` (محاولة ${link.attempts})` : ""}</p>}
                {link.fbUrl && <a href={link.fbUrl} target="_blank" rel="noreferrer" dir="ltr" className="block truncate text-xs text-sidebar-primary hover:underline">{link.fbUrl}</a>}
                {link.status === "ambiguous" && link.candidates && (
                  <div className="flex flex-wrap gap-2">
                    {link.candidates.map((candidate) => (
                      <Button key={candidate.id} size="sm" variant="outline" className="h-7 text-xs" disabled={manualMutation.isPending} onClick={() => manualMutation.mutate({ id: link.id, url: candidate.url })}>
                        اختر {candidate.kind === "reel" ? "الريل" : "المنشور"} ({riyadh(candidate.createdAt)})
                      </Button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {canManual && (
                    <>
                      <Input dir="ltr" placeholder="https://www.facebook.com/reel/…" className="h-8 w-72" value={manualUrl[link.id] ?? ""} onChange={(e) => setManualUrl((s) => ({ ...s, [link.id]: e.target.value }))} />
                      <Button size="sm" variant="outline" className="h-8" disabled={!manualUrl[link.id] || manualMutation.isPending} onClick={() => manualMutation.mutate({ id: link.id, url: manualUrl[link.id] })}>
                        {manualMutation.isPending ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : null} أضف رابط فيسبوك يدويًا
                      </Button>
                    </>
                  )}
                  {canRevert && (
                    <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => { if (confirm("تراجع عن رابط فيسبوك؟ (العدّاد لا يتأثر)")) revertMutation.mutate(link.id); }}>
                      <Undo2 className="ml-1 h-3.5 w-3.5" /> تراجع
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
