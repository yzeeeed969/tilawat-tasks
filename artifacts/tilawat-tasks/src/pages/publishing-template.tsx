import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, Loader2, Plus, Trash2, AlertTriangle, HelpCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/lib/platform-icon";
import { cn } from "@/lib/utils";

// صفحة «قالب النشر» (للمدير): استيراد القالب الأولي بمطابقة أسماء بلا تخمين، ثم إدارة صفوفه.
// القالب: قارئ ← منصة ← نوع تصوير ← العضو المسؤول. يُستخدم فقط عند «إنشاء الجدول الأسبوعي».

type MatchStatus = "exact" | "suggested" | "ambiguous" | "missing";
type Candidate = { id: number; name: string };
type EntityMatch = { key: string; label: string; status: MatchStatus; matchId: number | null; candidates: Candidate[] };
type ImportPreview = {
  reciters: EntityMatch[];
  members: EntityMatch[];
  platforms: EntityMatch[];
  allReciters: Array<{ id: number; name: string; mosque: string }>;
  allMembers: Array<{ id: number; name: string; isActive: boolean }>;
  allPlatforms: Array<{ id: number; name: string }>;
  seedRowCount: number;
  templateImportedAt: string | null;
  existingTemplateRows: number;
};
type TemplateRow = {
  id: number;
  reciterId: number;
  platformId: number;
  filmingType: "affairs" | "tv" | null;
  memberId: number;
  pageId: number | null;
  isActive: boolean;
  platformName: string;
  memberName: string;
  memberActive: boolean;
};
type TemplateData = {
  rows: TemplateRow[];
  reciters: Array<{ id: number; name: string; mosque: "haram" | "nabawi" }>;
  members: Array<{ id: number; name: string; isActive: boolean }>;
  platforms: Array<{ id: number; name: string; coversAllReciters: boolean; supportsFilmingType: boolean }>;
  pages: Array<{ id: number; name: string; platformId: number; reciterId: number | null }>;
  templateImportedAt: string | null;
};

const FILMING_LABEL: Record<string, string> = { affairs: "تصوير الشؤون", tv: "تصوير التلفزيون" };
const SKIP = "__skip__";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? "حدث خطأ");
  return payload as T;
}

function StatusBadge({ status }: { status: MatchStatus }) {
  const map = {
    exact: { label: "مطابق", className: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
    suggested: { label: "اقتراح يحتاج اعتمادك", className: "bg-amber-50 text-amber-700 border-amber-200", Icon: HelpCircle },
    ambiguous: { label: "أكثر من مرشّح — اختر", className: "bg-amber-50 text-amber-700 border-amber-200", Icon: AlertTriangle },
    missing: { label: "غير موجود — اختر أو تخطَّ", className: "bg-red-50 text-red-700 border-red-200", Icon: XCircle },
  }[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", map.className)}>
      <map.Icon className="h-3 w-3" />{map.label}
    </span>
  );
}

function ImportSection({
  title,
  matches,
  options,
  decisions,
  onDecide,
}: {
  title: string;
  matches: EntityMatch[];
  options: Candidate[];
  decisions: Record<string, string>;
  onDecide: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="divide-y rounded-md border">
        {matches.map((match) => {
          const candidateIds = new Set(match.candidates.map((c) => c.id));
          const ordered = [...match.candidates, ...options.filter((o) => !candidateIds.has(o.id))];
          const value = decisions[match.key];
          return (
            <div key={match.key} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{match.label}</span>
                <StatusBadge status={match.status} />
                {match.status === "suggested" && match.candidates[0] && value !== String(match.candidates[0].id) && (
                  <button type="button" className="text-xs text-sky-700 underline" onClick={() => onDecide(match.key, String(match.candidates[0].id))}>
                    اعتماد «{match.candidates[0].name}»
                  </button>
                )}
              </div>
              <div className="w-full sm:w-64">
                <Select value={value} onValueChange={(v) => onDecide(match.key, v)}>
                  <SelectTrigger className={cn("h-8 text-xs", !value && "border-amber-400")}>
                    <SelectValue placeholder="اختر السجل…" />
                  </SelectTrigger>
                  <SelectContent dir="rtl" className="max-h-72 overflow-y-auto">
                    <SelectItem value={SKIP}><span className="text-muted-foreground">تخطٍّ (لا يُستورد)</span></SelectItem>
                    {ordered.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.name}{candidateIds.has(o.id) && match.status !== "exact" ? " ⟵ مرشّح" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ["publishing-template-import"], queryFn: () => api<ImportPreview>("/api/weekly-schedule/template/import") });
  const [decisions, setDecisions] = useState<{ reciters: Record<string, string>; members: Record<string, string>; platforms: Record<string, string> } | null>(null);

  // القرارات الأولية: المطابق تمامًا فقط يُعبّأ تلقائيًا. الاقتراح والغامض وغير الموجود ينتظر قرارك.
  const current = useMemo(() => {
    if (decisions) return decisions;
    if (!data) return null;
    const init = (matches: EntityMatch[]) => Object.fromEntries(matches.filter((m) => m.status === "exact" && m.matchId).map((m) => [m.key, String(m.matchId)]));
    return { reciters: init(data.reciters), members: init(data.members), platforms: init(data.platforms) };
  }, [data, decisions]);

  const importMutation = useMutation({
    mutationFn: () => {
      const toMapping = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === SKIP ? null : Number(v)]));
      return api<{ inserted: number; updated: number; skipped: Array<{ reciter: string; platform: string; reason: string }> }>("/api/weekly-schedule/template/import", {
        method: "POST",
        body: JSON.stringify({ mapping: { reciters: toMapping(current!.reciters), members: toMapping(current!.members), platforms: toMapping(current!.platforms) } }),
      });
    },
    onSuccess: (result) => {
      toast({ title: "تم استيراد القالب", description: `أُضيف ${result.inserted} · حُدّث ${result.updated} · تُخطّي ${result.skipped.length}` });
      onDone();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>;
  if (error || !data || !current) return <p className="text-sm text-destructive">تعذّر تحميل بيانات الاستيراد</p>;

  const decide = (section: "reciters" | "members" | "platforms") => (key: string, value: string) =>
    setDecisions({ ...current, [section]: { ...current[section], [key]: value } });
  const undecided = [
    ...data.reciters.filter((m) => !current.reciters[m.key]),
    ...data.members.filter((m) => !current.members[m.key]),
    ...data.platforms.filter((m) => !current.platforms[m.key]),
  ].length;

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 leading-6">
        يحتوي القالب الأولي على {data.seedRowCount} صفًا. يُربط كل اسم بسجل فعلي في قاعدة البيانات:
        <b> «مطابق»</b> فقط عند تطابق تام (يُعبّأ تلقائيًا)، وكل ما عداه ينتظر اختيارك — لا ربط بالتخمين.
        اختر «تخطٍّ» لأي اسم لا تريد استيراده. لن يُحفظ شيء حتى تضغط «تأكيد الاستيراد».
        {data.existingTemplateRows > 0 && <span className="block mt-1 font-medium">يوجد قالب سابق ({data.existingTemplateRows} صف): الصفوف المطابقة ستُحدَّث، ولا يُحذف أي صف.</span>}
      </div>
      <ImportSection title="القرّاء" matches={data.reciters} options={data.allReciters} decisions={current.reciters} onDecide={decide("reciters")} />
      <ImportSection title="الأعضاء" matches={data.members} options={data.allMembers.map((m) => ({ id: m.id, name: m.isActive ? m.name : `${m.name} (غير نشط)` }))} decisions={current.members} onDecide={decide("members")} />
      <ImportSection title="المنصات" matches={data.platforms} options={data.allPlatforms} decisions={current.platforms} onDecide={decide("platforms")} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{undecided > 0 ? `بقي ${undecided} اسم بلا قرار` : "كل الأسماء محسومة"}</p>
        <Button onClick={() => importMutation.mutate()} disabled={undecided > 0 || importMutation.isPending}>
          {importMutation.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}تأكيد الاستيراد
        </Button>
      </div>
    </div>
  );
}

function ReciterTemplateCard({ reciter, data, onChanged }: {
  reciter: TemplateData["reciters"][number];
  data: TemplateData;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const rows = data.rows.filter((row) => row.reciterId === reciter.id);
  const [adding, setAdding] = useState(false);
  const [newPlatformId, setNewPlatformId] = useState("");
  const [newType, setNewType] = useState("");
  const [newMemberId, setNewMemberId] = useState("");
  const newPlatform = data.platforms.find((p) => String(p.id) === newPlatformId);
  const typeOptions = reciter.mosque === "nabawi" ? ["tv"] : ["affairs", "tv"];

  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast({ title: success });
      onChanged();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" });
    }
  };

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
        <span className="font-semibold text-sm">{reciter.name}</span>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setAdding((v) => !v)}><Plus className="h-3 w-3" />صف</Button>
      </div>
      {rows.length === 0 && !adding && <p className="px-3 py-2 text-xs text-muted-foreground">لا يوجد قالب لهذا القارئ — لن تُنشأ له مهام في الجدول الأسبوعي.</p>}
      <div className="divide-y">
        {rows.map((row) => (
          <div key={row.id} className={cn("grid gap-2 px-3 py-2 text-xs sm:grid-cols-[1fr_1fr_auto_auto] sm:items-center", !row.isActive && "opacity-50")}>
            <span className="flex items-center gap-1.5">
              <PlatformIcon name={row.platformName} className="h-3.5 w-3.5" />{row.platformName}
              {row.filmingType && <span className="rounded-full border px-1.5 text-[10px]">{FILMING_LABEL[row.filmingType]}</span>}
            </span>
            <Select value={String(row.memberId)} onValueChange={(v) => run(() => api(`/api/weekly-schedule/template/${row.id}`, { method: "PATCH", body: JSON.stringify({ memberId: Number(v) }) }), "تم تحديث العضو")}>
              <SelectTrigger className={cn("h-7 text-xs", !row.memberActive && "border-red-300")}><SelectValue /></SelectTrigger>
              <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
                {data.members.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name}{m.isActive ? "" : " (غير نشط)"}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 text-[11px]">
              <Switch checked={row.isActive} onCheckedChange={(v) => run(() => api(`/api/weekly-schedule/template/${row.id}`, { method: "PATCH", body: JSON.stringify({ isActive: v }) }), v ? "تم التفعيل" : "تم الإيقاف")} />
              نشط
            </label>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => {
              if (confirm(`حذف صف ${row.platformName}${row.filmingType ? ` (${FILMING_LABEL[row.filmingType]})` : ""} من قالب ${reciter.name}؟\nلا يؤثر على أي مهمة منشأة سابقًا.`)) {
                run(() => api(`/api/weekly-schedule/template/${row.id}`, { method: "DELETE" }), "تم حذف الصف");
              }
            }}><Trash2 className="h-3.5 w-3.5" /></Button>
            {!row.memberActive && <span className="text-[10px] text-red-600 sm:col-span-4">العضو غير نشط — لن تُنشأ هذه المهمة حتى تختار عضوًا نشطًا.</span>}
          </div>
        ))}
      </div>
      {adding && (
        <div className="grid gap-2 border-t bg-muted/10 p-3 sm:grid-cols-4">
          <Select value={newPlatformId} onValueChange={(v) => { setNewPlatformId(v); setNewType(""); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="المنصة" /></SelectTrigger>
            <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
              {data.platforms.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={newType} onValueChange={setNewType} disabled={!newPlatform?.supportsFilmingType}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={newPlatform?.supportsFilmingType ? "نوع التصوير" : "بلا نوع تصوير"} /></SelectTrigger>
            <SelectContent dir="rtl">
              {typeOptions.map((t) => <SelectItem key={t} value={t}>{FILMING_LABEL[t]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={newMemberId} onValueChange={setNewMemberId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="العضو" /></SelectTrigger>
            <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
              {data.members.filter((m) => m.isActive).map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8" disabled={!newPlatformId || !newMemberId || (newPlatform?.supportsFilmingType && !newType)}
            onClick={() => run(async () => {
              await api("/api/weekly-schedule/template", {
                method: "POST",
                body: JSON.stringify({ reciterId: reciter.id, platformId: Number(newPlatformId), filmingType: newType || null, memberId: Number(newMemberId) }),
              });
              setAdding(false); setNewPlatformId(""); setNewType(""); setNewMemberId("");
            }, "تمت إضافة الصف")}>
            إضافة
          </Button>
        </div>
      )}
    </div>
  );
}

export default function PublishingTemplatePage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["publishing-template"], queryFn: () => api<TemplateData>("/api/weekly-schedule/template") });
  const [showImport, setShowImport] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["publishing-template"] });
    queryClient.invalidateQueries({ queryKey: ["publishing-template-import"] });
  };
  const importOpen = showImport || (data && data.rows.length === 0 && !data.templateImportedAt);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">قالب النشر</h2>
          <p className="text-muted-foreground mt-2">لكل قارئ: منصاته ونوع التصوير والعضو المسؤول. يُطبَّق عند «إنشاء الجدول الأسبوعي» فقط، ولا يغيّر أي مهمة منشأة.</p>
        </div>
        <Button variant="outline" className="gap-1" onClick={() => setShowImport((v) => !v)}>
          <Download className="h-4 w-4" />{importOpen ? "إخفاء الاستيراد" : "استيراد القالب الأولي"}
        </Button>
      </div>

      {importOpen && (
        <Card>
          <CardHeader>
            <CardTitle>استيراد القالب الأولي</CardTitle>
            <CardDescription>راجع ربط كل اسم بسجله الفعلي ثم أكّد.</CardDescription>
          </CardHeader>
          <CardContent>
            <ImportPanel onDone={() => { setShowImport(false); refresh(); }} />
          </CardContent>
        </Card>
      )}

      {isLoading || !data ? (
        <div className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
      ) : (
        (["haram", "nabawi"] as const).map((mosque) => (
          <Card key={mosque}>
            <CardHeader>
              <CardTitle>{mosque === "haram" ? "🕋 أئمة المسجد الحرام" : "🕌 أئمة المسجد النبوي"}</CardTitle>
              <CardDescription>
                {mosque === "haram" ? "يوتيوب وفيسبوك بنوعين: تصوير الشؤون وتصوير التلفزيون." : "يوتيوب وفيسبوك بنوع واحد: تصوير التلفزيون."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.reciters.filter((r) => r.mosque === mosque).map((reciter) => (
                <ReciterTemplateCard key={reciter.id} reciter={reciter} data={data} onChanged={refresh} />
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
