import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarPlus, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { formatHijriDate } from "@/lib/hijri-date";
import { cn } from "@/lib/utils";

// «إنشاء الجدول الأسبوعي» (للمدير): إمام واحد لكل صلاة × مسجد للأسبوع كامل (الأحد → السبت)،
// والنظام يطبّق قالب النشر وينشئ كل المهام. للإنشاء فقط — لا تعديل لأي مهمة قائمة هنا
// (تعديل المهام وتغيير القارئ يبقيان حصريًا عبر «النيابة»).

type Mosque = "haram" | "nabawi";
type Prayer = "fajr" | "maghrib" | "isha";
type Setup = {
  settings: { previewEnabled: boolean; templateImportedAt: string | null };
  defaultWeekStart: string;
  reciters: Array<{ id: number; name: string; mosque: Mosque; templateRows: number }>;
  recentBatches: Array<{ id: number; weekStart: string; weekEnd: string; createdTasks: number; skippedDuplicates: number; createdAt: string }>;
};
type CountRow = { label: string; total: number; toCreate: number };
type Preview = {
  weekStart: string;
  weekEnd: string;
  summary: { total: number; toCreate: number; duplicates: number; byPrayer: CountRow[]; byPlatform: CountRow[]; byMember: CountRow[] };
  warnings: string[];
};

const PRAYERS: Array<{ key: Prayer; label: string }> = [
  { key: "fajr", label: "الفجر" },
  { key: "maghrib", label: "المغرب" },
  { key: "isha", label: "العشاء" },
];
const MOSQUES: Array<{ key: Mosque; label: string }> = [
  { key: "haram", label: "🕋 المسجد الحرام" },
  { key: "nabawi", label: "🕌 المسجد النبوي" },
];
const NONE = "none";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? "حدث خطأ");
  return payload as T;
}

function addDays(key: string, days: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayText(key: string) {
  const anchor = new Date(`${key}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ar-SA", { timeZone: "Asia/Riyadh", weekday: "long" }).format(anchor);
  return `${weekday} ${key} (${formatHijriDate(anchor)})`;
}

function CountTable({ title, rows }: { title: string; rows: CountRow[] }) {
  return (
    <div className="rounded-md border">
      <div className="border-b bg-muted/30 px-3 py-1.5 text-xs font-semibold">{title}</div>
      <div className="divide-y text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between px-3 py-1.5">
            <span>{row.label}</span>
            <span className="font-medium">
              {row.toCreate}
              {row.toCreate !== row.total && <span className="text-muted-foreground"> / {row.total}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function WeeklySchedulePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: setup, isLoading } = useQuery({ queryKey: ["weekly-schedule-setup"], queryFn: () => api<Setup>("/api/weekly-schedule/setup") });
  const [weekStart, setWeekStart] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (setup && !weekStart) setWeekStart(setup.defaultWeekStart);
  }, [setup, weekStart]);

  // أي تغيير في المدخلات يُبطل المعاينة السابقة.
  useEffect(() => setPreview(null), [weekStart, picks]);

  const isSunday = useMemo(() => Boolean(weekStart) && new Date(`${weekStart}T12:00:00Z`).getUTCDay() === 0, [weekStart]);
  const assignments = useMemo(
    () => Object.entries(picks)
      .filter(([, value]) => value && value !== NONE)
      .map(([key, value]) => {
        const [mosque, prayer] = key.split("|") as [Mosque, Prayer];
        return { mosque, prayer, reciterId: Number(value) };
      }),
    [picks],
  );
  const body = () => JSON.stringify({ weekStart, assignments });

  const previewMutation = useMutation({
    mutationFn: () => api<Preview>("/api/weekly-schedule/preview", { method: "POST", body: body() }),
    onSuccess: setPreview,
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  const createMutation = useMutation({
    mutationFn: () => api<{ createdTasks: number; skippedDuplicates: number; warnings: string[] }>("/api/weekly-schedule/create", { method: "POST", body: body() }),
    onSuccess: (result) => {
      toast({
        title: result.createdTasks > 0 ? `تم إنشاء ${result.createdTasks} مهمة` : "لم تُنشأ مهام جديدة",
        description: result.skippedDuplicates > 0 ? `تُخطّيت ${result.skippedDuplicates} مهمة موجودة مسبقًا (منع التكرار).` : undefined,
      });
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["weekly-schedule-setup"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  const settingsMutation = useMutation({
    mutationFn: (value: boolean) => api("/api/weekly-schedule/settings", { method: "PATCH", body: JSON.stringify({ previewEnabled: value }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["weekly-schedule-setup"] }),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  if (isLoading || !setup) {
    return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>;
  }

  const previewEnabled = setup.settings.previewEnabled;
  const canSubmit = isSunday && assignments.length > 0;
  const createDirect = () => {
    if (!confirm(`إنشاء مهام أسبوع ${weekStart} → ${addDays(weekStart, 6)} لـ ${assignments.length} صلاة؟\nالمهام الموجودة مسبقًا لن تُنشأ مرة أخرى.`)) return;
    createMutation.mutate();
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">إنشاء الجدول الأسبوعي</h2>
        <p className="text-muted-foreground mt-2">اختر إمام كل صلاة للأسبوع، ويطبّق النظام <Link href="/publishing-template" className="text-sidebar-primary underline">قالب النشر</Link> وينشئ كل المهام. للإنشاء فقط — تغيير قارئ مهمة قائمة يتم عبر «النيابة».</p>
      </div>

      {!setup.settings.templateImportedAt && setup.reciters.every((r) => r.templateRows === 0) && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          لا يوجد قالب نشر بعد. ابدأ من صفحة <Link href="/publishing-template" className="underline font-medium">قالب النشر</Link> واستورد القالب الأولي.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarPlus className="h-5 w-5 text-sidebar-primary" />الأسبوع والأئمة</CardTitle>
          <CardDescription>الأسبوع من الأحد إلى السبت. الظهر والعصر مستبعدان، والجمعة لاحقًا.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-[220px_1fr] sm:items-center">
            <label className="text-sm font-medium">بداية الأسبوع (الأحد)</label>
            <div className="space-y-1">
              <Input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} className="w-full sm:w-56" dir="ltr" />
              {weekStart && (isSunday
                ? <p className="text-xs text-muted-foreground">من {dayText(weekStart)} إلى {dayText(addDays(weekStart, 6))}</p>
                : <p className="text-xs text-red-600">اختر يوم أحد — الأسبوع يبدأ الأحد.</p>)}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="p-2 text-right font-medium">الصلاة</th>
                  {MOSQUES.map((m) => <th key={m.key} className="p-2 text-right font-medium">{m.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {PRAYERS.map((prayer) => (
                  <tr key={prayer.key} className="border-t">
                    <td className="p-2 font-medium">{prayer.label}</td>
                    {MOSQUES.map((mosque) => {
                      const key = `${mosque.key}|${prayer.key}`;
                      const options = setup.reciters.filter((r) => r.mosque === mosque.key);
                      return (
                        <td key={key} className="p-2">
                          <Select value={picks[key] ?? NONE} onValueChange={(v) => setPicks((prev) => ({ ...prev, [key]: v }))}>
                            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                            <SelectContent dir="rtl" className="max-h-72 overflow-y-auto">
                              <SelectItem value={NONE}><span className="text-muted-foreground">— بلا —</span></SelectItem>
                              {options.map((r) => (
                                <SelectItem key={r.id} value={String(r.id)}>
                                  {r.name}{r.templateRows === 0 ? " (بلا قالب)" : ` · ${r.templateRows} منصة`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={previewEnabled} onCheckedChange={(v) => settingsMutation.mutate(v)} disabled={settingsMutation.isPending} />
              المعاينة قبل الإنشاء
            </label>
            {previewEnabled ? (
              <Button onClick={() => previewMutation.mutate()} disabled={!canSubmit || previewMutation.isPending}>
                {previewMutation.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}معاينة
              </Button>
            ) : (
              <Button onClick={createDirect} disabled={!canSubmit || createMutation.isPending}>
                {createMutation.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}إنشاء المهام
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>المعاينة</CardTitle>
            <CardDescription>أسبوع {preview.weekStart} → {preview.weekEnd}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">ستُنشأ<br /><b className="text-lg">{preview.summary.toCreate}</b></div>
              <div className="rounded-md border bg-muted/40 p-2">موجودة مسبقًا<br /><b className="text-lg">{preview.summary.duplicates}</b></div>
              <div className="rounded-md border p-2">الإجمالي<br /><b className="text-lg">{preview.summary.total}</b></div>
            </div>
            {preview.warnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800">
                {preview.warnings.map((w) => <p key={w} className="flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{w}</p>)}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              <CountTable title="حسب الصلاة والإمام" rows={preview.summary.byPrayer} />
              <CountTable title="حسب المنصة" rows={preview.summary.byPlatform} />
              <CountTable title="حسب العضو" rows={preview.summary.byMember} />
            </div>
            <p className="text-xs text-muted-foreground">الرقم «ستُنشأ / الإجمالي» يظهر حين توجد مهام مسبقة لا تُكرَّر. سيصل لكل عضو إشعار واحد بمهام أسبوعه.</p>
            <div className="flex justify-end">
              <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || preview.summary.toCreate === 0}>
                {createMutation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
                تأكيد وإنشاء {preview.summary.toCreate} مهمة
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {setup.recentBatches.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">آخر الأسابيع المُنشأة</CardTitle></CardHeader>
          <CardContent className="divide-y text-sm">
            {setup.recentBatches.map((batch) => (
              <div key={batch.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2")}>
                <span>{batch.weekStart} → {batch.weekEnd}</span>
                <span className="text-xs text-muted-foreground">
                  {batch.createdTasks} مهمة{batch.skippedDuplicates > 0 ? ` · تُخطّي ${batch.skippedDuplicates} مكرّرة` : ""} · {new Date(batch.createdAt).toLocaleString("ar-SA")}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
