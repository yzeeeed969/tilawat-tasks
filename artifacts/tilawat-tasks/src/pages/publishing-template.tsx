import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/lib/platform-icon";
import { cn } from "@/lib/utils";

// صفحة «قالب النشر» (للمدير): إدارة صفوف القالب.
// القالب: قارئ ← منصة ← نوع تصوير ← العضو المسؤول. يُستخدم فقط عند «إنشاء الجدول الأسبوعي».

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

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? "حدث خطأ");
  return payload as T;
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
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["publishing-template"] });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">قالب النشر</h2>
          <p className="text-muted-foreground mt-2">لكل قارئ: منصاته ونوع التصوير والعضو المسؤول. يُطبَّق عند «إنشاء الجدول الأسبوعي» فقط، ولا يغيّر أي مهمة منشأة.</p>
        </div>
      </div>


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
