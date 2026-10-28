import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ImageUp, Loader2, Megaphone, Plus, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/lib/roles";
import { cn } from "@/lib/utils";

// «جدول المؤذنين» (للمدير): رفع صورة الجدول الأسبوعي الرسمي ← قراءة آلية ← معاينة بجانب الصورة ← إنشاء.
// الإرسال اليومي لكل مؤذن بمهامه فقط عبر واتساب الرسمي — وضع التجربة مفعّل افتراضيًا.

type Slot = "fajr1" | "fajr2" | "dhuhr" | "asr" | "maghrib" | "isha";
const SLOTS: Array<{ key: Slot; label: string }> = [
  { key: "fajr1", label: "الفجر 1" },
  { key: "fajr2", label: "الفجر 2" },
  { key: "dhuhr", label: "الظهر" },
  { key: "asr", label: "العصر" },
  { key: "maghrib", label: "المغرب" },
  { key: "isha", label: "العشاء" },
];
const SLOT_LABEL = Object.fromEntries(SLOTS.map((s) => [s.key, s.label])) as Record<Slot, string>;

type Muezzin = { id: number; name: string; phone: string | null; isActive: boolean };
type Settings = { sendHour: number; testMode: boolean; testPhone: string | null; autoSendEnabled: boolean; lastAutoRunDate: string | null };
type Setup = {
  today: string;
  settings: Settings;
  status: { vision: boolean; whatsapp: boolean };
  muezzins: Muezzin[];
  upcoming: Array<{ dateKey: string; slot: Slot; name: string }>;
  log: Array<{ id: number; dateKey: string; name: string; phone: string | null; testMode: boolean; ok: boolean; detail: string; createdAt: string }>;
};
type PreviewDay = { day: string; date: string; slots: Record<Slot, { raw: string; muezzinId: number | null }> };
type Preview = { title: string; days: PreviewDay[] };
type Grid = Array<Record<Slot, string>>; // قيمة الخانة: معرّف المؤذن كنص، أو "" للفارغ

const BASE = "/api/muezzin-schedule";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: init?.body instanceof Blob ? init?.headers : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? "حدث خطأ");
  return payload as T;
}

function addDays(key: string, days: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nextSunday(today: string) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (7 - dow) % 7 || 7);
}
const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** يصغّر الصورة في المتصفح (أسرع وأرخص قراءة) ويعيدها JPEG. */
async function shrinkImage(file: File): Promise<{ blob: Blob; url: string }> {
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("تعذّر فتح الصورة"));
    i.src = url;
  });
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("تعذّر تجهيز الصورة"))), "image/jpeg", 0.92),
  );
  return { blob, url };
}

function StatusPill({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
      ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {ok ? on : off}
    </span>
  );
}

export default function MuezzinSchedulePage() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ["muezzin-setup"], queryFn: () => api<Setup>(`${BASE}/setup`), enabled: isAdmin });
  const refresh = () => qc.invalidateQueries({ queryKey: ["muezzin-setup"] });

  if (!isAdmin) return <div className="p-10 text-center text-muted-foreground">هذه الصفحة للمدير فقط.</div>;
  if (setup.isLoading) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>;
  if (setup.isError || !setup.data) return <div className="p-10 text-center text-destructive">{(setup.error as Error)?.message ?? "تعذّر التحميل"}</div>;
  const data = setup.data;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">جدول المؤذنين</h2>
        <p className="text-muted-foreground mt-2">ارفع صورة الجدول الأسبوعي، راجع القراءة بجانب الصورة، ثم «إنشاء». يصل كل مؤذن مهامه يوميًا على واتساب.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusPill ok={data.status.vision} on="قراءة الصور جاهزة" off="قراءة الصور غير مفعّلة" />
          <StatusPill ok={data.status.whatsapp} on="واتساب مربوط" off="واتساب غير مربوط" />
          <StatusPill ok={!data.settings.testMode} on="التشغيل الفعلي" off="وضع التجربة" />
          <StatusPill ok={data.settings.autoSendEnabled} on={`الإرسال اليومي مفعّل — ${data.settings.sendHour}:00`} off="الإرسال اليومي متوقف" />
        </div>
      </div>

      <Tabs defaultValue="upload" dir="rtl">
        <TabsList>
          <TabsTrigger value="upload">الإدخال الأسبوعي</TabsTrigger>
          <TabsTrigger value="muezzins">المؤذنون ({data.muezzins.length})</TabsTrigger>
          <TabsTrigger value="send">الإرسال والسجل</TabsTrigger>
        </TabsList>
        <TabsContent value="upload"><UploadTab data={data} onSaved={refresh} toast={toast} /></TabsContent>
        <TabsContent value="muezzins"><MuezzinsTab data={data} onChange={refresh} toast={toast} /></TabsContent>
        <TabsContent value="send"><SendTab data={data} onChange={refresh} toast={toast} /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ───────────────────────── الإدخال الأسبوعي ───────────────────────── */

function UploadTab({ data, onSaved, toast }: { data: Setup; onSaved: () => void; toast: any }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [weekStart, setWeekStart] = useState(() => nextSunday(data.today));
  // كل المؤذنين في القائمة (الموقوف يظهر بعلامة) — كي لا تختفي خانة مطابَقة لمؤذن موقوف.
  const options = [...data.muezzins].sort((a, b) => Number(b.isActive) - Number(a.isActive));

  const read = useMutation({
    mutationFn: () => api<Preview>(`${BASE}/read`, { method: "POST", body: blob!, headers: { "Content-Type": "image/jpeg" } }),
    onSuccess: (p) => {
      setPreview(p);
      setGrid(p.days.map((d) => Object.fromEntries(SLOTS.map((s) => [s.key, d.slots[s.key].muezzinId ? String(d.slots[s.key].muezzinId) : ""])) as Record<Slot, string>));
    },
    onError: (e: Error) => toast({ title: "تعذّرت القراءة", description: e.message, variant: "destructive" }),
  });

  const save = useMutation({
    mutationFn: () => api<{ entries: number; weekStart: string; weekEnd: string }>(`${BASE}/week`, {
      method: "POST",
      body: JSON.stringify({
        weekStart,
        title: preview?.title ?? null,
        days: grid!.map((row) => ({ slots: Object.fromEntries(SLOTS.map((s) => [s.key, row[s.key] ? Number(row[s.key]) : null])) })),
      }),
    }),
    onSuccess: (r) => {
      toast({ title: "تم إنشاء الجدول ✓", description: `${r.entries} أذانًا من ${r.weekStart} إلى ${r.weekEnd}` });
      setPreview(null); setGrid(null); setBlob(null); setImageUrl(null);
      onSaved();
    },
    onError: (e: Error) => toast({ title: "تعذّر الإنشاء", description: e.message, variant: "destructive" }),
  });

  // خانة «تحتاج تصحيح»: الصورة فيها اسم لكن لم يُختر مؤذن.
  const problems = useMemo(() => {
    if (!preview || !grid) return 0;
    let n = 0;
    preview.days.forEach((d, i) => SLOTS.forEach((s) => { if (d.slots[s.key].raw && !grid[i][s.key]) n++; }));
    return n;
  }, [preview, grid]);
  const isSunday = new Date(`${weekStart}T12:00:00Z`).getUTCDay() === 0;

  async function onFile(file?: File) {
    if (!file) return;
    try {
      const r = await shrinkImage(file);
      setBlob(r.blob); setImageUrl(r.url); setPreview(null); setGrid(null);
    } catch (e) {
      toast({ title: "تعذّر فتح الصورة", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ImageUp className="h-5 w-5 text-sidebar-primary" />١) صورة الجدول الأسبوعي</CardTitle>
          <CardDescription>الصورة الرسمية كما تُنشر (من الأحد إلى السبت).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input type="file" accept="image/*" className="max-w-xs" onChange={(e) => onFile(e.target.files?.[0])} />
          <Button disabled={!blob || read.isPending || !data.status.vision} onClick={() => read.mutate()}>
            {read.isPending ? <><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ القراءة…</> : "قراءة ومعاينة"}
          </Button>
          {!data.status.vision && <span className="text-sm text-amber-700">أضف مفتاح ANTHROPIC_API_KEY في Railway لتفعيل القراءة.</span>}
        </CardContent>
      </Card>

      {preview && grid && (
        <Card>
          <CardHeader>
            <CardTitle>٢) المعاينة — قارن بالصورة وصحّح أي خانة</CardTitle>
            <CardDescription>
              {preview.title && <span className="block">المقروء: {preview.title}</span>}
              الخانة الحمراء: اسم في الصورة لم يُطابَق مع قائمة المؤذنين — اختر الاسم الصحيح.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              {imageUrl && <img src={imageUrl} alt="صورة الجدول" className="w-full rounded-md border" />}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-muted/40">
                      <th className="border p-1.5">اليوم</th>
                      {SLOTS.map((s) => <th key={s.key} className="border p-1.5">{s.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.days.map((d, i) => (
                      <tr key={d.day}>
                        <th className="border bg-muted/20 p-1.5 whitespace-nowrap">{d.day}<div className="text-xs font-normal text-muted-foreground">{addDays(weekStart, i)}</div></th>
                        {SLOTS.map((s) => {
                          const cell = d.slots[s.key];
                          const bad = Boolean(cell.raw) && !grid[i][s.key];
                          return (
                            <td key={s.key} className={cn("border p-1", bad && "bg-red-50")}>
                              <select
                                className={cn("w-full min-w-[104px] rounded border bg-background px-1 py-1 text-sm", bad && "border-red-400 text-red-700")}
                                value={grid[i][s.key]}
                                onChange={(e) => setGrid((g) => g!.map((row, ri) => (ri === i ? { ...row, [s.key]: e.target.value } : row)))}
                              >
                                <option value="">— فارغ —</option>
                                {options.map((m) => <option key={m.id} value={String(m.id)}>{m.name}{m.isActive ? "" : " (موقوف)"}</option>)}
                              </select>
                              {bad && <div className="mt-0.5 text-[11px] text-red-700">المقروء: {cell.raw}</div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <label className="text-sm font-medium">تاريخ يوم الأحد (بداية الأسبوع):</label>
              <Input type="date" className="w-44" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
              {!isSunday && <span className="text-sm text-red-700">التاريخ المختار ليس يوم أحد</span>}
              <Button
                className="bg-amber-600 hover:bg-amber-700"
                disabled={problems > 0 || !isSunday || save.isPending}
                onClick={() => {
                  if (window.confirm(`هل راجعت الجدول مع الصورة وتأكدت أنه صحيح؟\nسيُعتمد للأسبوع ${weekStart} ← ${addDays(weekStart, 6)}`)) save.mutate();
                }}
              >
                {save.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}إنشاء
              </Button>
              <span className={cn("text-sm", problems ? "text-red-700" : "text-emerald-700")}>
                {problems ? `باقي ${problems} خانة تحتاج تصحيح` : "كل الخانات مطابقة ✓"}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <UpcomingCard data={data} />
    </div>
  );
}

function UpcomingCard({ data }: { data: Setup }) {
  const byDate = new Map<string, Array<{ slot: Slot; name: string }>>();
  data.upcoming.forEach((u) => byDate.set(u.dateKey, [...(byDate.get(u.dateKey) ?? []), { slot: u.slot, name: u.name }]));
  const dates = Array.from({ length: 8 }, (_, i) => addDays(data.today, i));
  return (
    <Card>
      <CardHeader><CardTitle>الجدول المعتمد للأيام القادمة</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr className="bg-muted/40"><th className="border p-1.5">اليوم</th>{SLOTS.map((s) => <th key={s.key} className="border p-1.5">{s.label}</th>)}</tr></thead>
          <tbody>
            {dates.map((d) => {
              const rows = byDate.get(d) ?? [];
              return (
                <tr key={d} className={cn(!rows.length && "text-muted-foreground")}>
                  <th className="border p-1.5 whitespace-nowrap">{DAY_NAMES[new Date(`${d}T12:00:00Z`).getUTCDay()]}<div className="text-xs font-normal">{d}</div></th>
                  {SLOTS.map((s) => <td key={s.key} className="border p-1.5 text-center">{rows.find((r) => r.slot === s.key)?.name ?? (rows.length ? "—" : "")}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!data.upcoming.length && <p className="mt-2 text-sm text-amber-700">لا يوجد جدول معتمد للأيام القادمة.</p>}
      </CardContent>
    </Card>
  );
}

/* ───────────────────────── المؤذنون ───────────────────────── */

function MuezzinsTab({ data, onChange, toast }: { data: Setup; onChange: () => void; toast: any }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const add = useMutation({
    mutationFn: () => api(`${BASE}/muezzins`, { method: "POST", body: JSON.stringify({ name, phone: phone || null }) }),
    onSuccess: () => { setName(""); setPhone(""); onChange(); toast({ title: "أُضيف المؤذن" }); },
    onError: (e: Error) => toast({ title: "تعذّرت الإضافة", description: e.message, variant: "destructive" }),
  });
  const missing = data.muezzins.filter((m) => m.isActive && !m.phone).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>قائمة المؤذنين</CardTitle>
        <CardDescription>الرقم بصيغة 9665XXXXXXXX أو 05XXXXXXXX. المؤذن الموقوف لا تُرسل له رسائل.{missing ? ` — ${missing} بلا رقم.` : ""}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="divide-y rounded-md border">
          {data.muezzins.map((m) => <MuezzinRow key={m.id} m={m} onChange={onChange} toast={toast} />)}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Input placeholder="اسم مؤذن جديد" className="w-56" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="رقم الجوال" className="w-44" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Button variant="outline" disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}><Plus className="ml-1 h-4 w-4" />إضافة</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MuezzinRow({ m, onChange, toast }: { m: Muezzin; onChange: () => void; toast: any }) {
  const [phone, setPhone] = useState(m.phone ?? "");
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`${BASE}/muezzins/${m.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { onChange(); toast({ title: "تم الحفظ" }); },
    onError: (e: Error) => { setPhone(m.phone ?? ""); toast({ title: "تعذّر الحفظ", description: e.message, variant: "destructive" }); },
  });
  return (
    <div className={cn("flex flex-wrap items-center gap-3 px-3 py-2", !m.isActive && "opacity-60")}>
      <span className="w-44 font-medium">{m.name}</span>
      <Input dir="ltr" className="w-44" placeholder="9665XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <Button size="sm" variant="outline" disabled={phone === (m.phone ?? "") || patch.isPending} onClick={() => patch.mutate({ phone: phone || null })}>حفظ الرقم</Button>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={m.isActive} onCheckedChange={(v) => patch.mutate({ isActive: v })} />
        {m.isActive ? "فعّال" : "موقوف"}
      </label>
      {!m.phone && m.isActive && <span className="text-xs text-amber-700">بلا رقم</span>}
    </div>
  );
}

/* ───────────────────────── الإرسال والسجل ───────────────────────── */

function SendTab({ data, onChange, toast }: { data: Setup; onChange: () => void; toast: any }) {
  const s = data.settings;
  const [hour, setHour] = useState(String(s.sendHour));
  const [testPhone, setTestPhone] = useState(s.testPhone ?? "");
  const [sendDate, setSendDate] = useState(addDays(data.today, 1));

  const saveSettings = useMutation({
    mutationFn: (body: Partial<Settings>) => api(`${BASE}/settings`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { onChange(); toast({ title: "تم حفظ الإعدادات" }); },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, variant: "destructive" }),
  });
  const sendNow = useMutation({
    mutationFn: () => api<{ sent: number; failed: number; skipped: number; testMode: boolean; noSchedule: boolean }>(`${BASE}/send`, { method: "POST", body: JSON.stringify({ date: sendDate }) }),
    onSuccess: (r) => {
      onChange();
      toast({
        title: r.noSchedule ? "لا يوجد جدول لهذا اليوم" : `أُرسلت ${r.sent} رسالة${r.testMode ? " (تجربة — إلى رقمك فقط)" : ""}`,
        description: r.noSchedule ? undefined : `فشل ${r.failed} · تُخطّي ${r.skipped} (مرسلة مسبقًا أو موقوف)`,
        variant: r.failed || r.noSchedule ? "destructive" : undefined,
      });
    },
    onError: (e: Error) => toast({ title: "تعذّر الإرسال", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>إعدادات الإرسال</CardTitle><CardDescription>كل يوم في الساعة المحددة (بتوقيت الرياض) يُرسل جدول اليوم التالي.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-40 text-sm font-medium">ساعة الإرسال (0–23)</label>
            <Input type="number" min={0} max={23} className="w-24" value={hour} onChange={(e) => setHour(e.target.value)} />
            <Button size="sm" variant="outline" disabled={hour === String(s.sendHour)} onClick={() => saveSettings.mutate({ sendHour: Number(hour) })}>حفظ</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-40 text-sm font-medium">رقم التجربة (رقمك)</label>
            <Input dir="ltr" className="w-44" placeholder="9665XXXXXXXX" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
            <Button size="sm" variant="outline" disabled={testPhone === (s.testPhone ?? "")} onClick={() => saveSettings.mutate({ testPhone: testPhone || null })}>حفظ</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-40 text-sm font-medium">وضع التجربة</label>
            <Switch
              checked={s.testMode}
              onCheckedChange={(v) => {
                if (!v && !window.confirm("إيقاف وضع التجربة يعني أن الرسائل ستصل للمؤذنين فعليًا. هل أنت متأكد؟")) return;
                saveSettings.mutate({ testMode: v });
              }}
            />
            <span className="text-sm text-muted-foreground">{s.testMode ? "كل الرسائل تصل لرقم التجربة فقط" : "الرسائل تصل للمؤذنين فعليًا"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-40 text-sm font-medium">الإرسال اليومي التلقائي</label>
            <Switch checked={s.autoSendEnabled} onCheckedChange={(v) => saveSettings.mutate({ autoSendEnabled: v })} />
            <span className="text-sm text-muted-foreground">{s.lastAutoRunDate ? `آخر تشغيل: ${s.lastAutoRunDate}` : "لم يعمل بعد"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Megaphone className="h-5 w-5 text-sidebar-primary" />إرسال يدوي ليوم محدد</CardTitle><CardDescription>لا يُكرر الرسالة لمن وصلته مسبقًا في نفس اليوم.</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input type="date" className="w-44" value={sendDate} onChange={(e) => setSendDate(e.target.value)} />
          <Button
            disabled={sendNow.isPending || !data.status.whatsapp}
            onClick={() => {
              if (window.confirm(`إرسال جدول ${sendDate}${s.testMode ? " إلى رقم التجربة فقط" : " إلى المؤذنين فعليًا"}؟`)) sendNow.mutate();
            }}
          >
            {sendNow.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />}إرسال
          </Button>
          {!data.status.whatsapp && <span className="text-sm text-amber-700">اربط واتساب أولًا.</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>السجل</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {!data.log.length ? <p className="text-sm text-muted-foreground">لا توجد رسائل بعد.</p> : (
            <table className="w-full border-collapse text-sm">
              <thead><tr className="bg-muted/40"><th className="border p-1.5">اليوم</th><th className="border p-1.5">المؤذن</th><th className="border p-1.5">الرقم</th><th className="border p-1.5">النتيجة</th><th className="border p-1.5">التفاصيل</th></tr></thead>
              <tbody>
                {data.log.map((l) => (
                  <tr key={l.id}>
                    <td className="border p-1.5 whitespace-nowrap">{l.dateKey}</td>
                    <td className="border p-1.5">{l.name}</td>
                    <td className="border p-1.5" dir="ltr">{l.phone ?? "—"}</td>
                    <td className="border p-1.5 whitespace-nowrap">
                      {l.ok ? <span className="text-emerald-700"><CheckCircle2 className="inline h-4 w-4" /> تم</span> : <span className="text-red-700"><XCircle className="inline h-4 w-4" /> فشل</span>}
                      {l.testMode && <span className="mr-1 text-xs text-muted-foreground">(تجربة)</span>}
                    </td>
                    <td className="border p-1.5 text-xs text-muted-foreground">{l.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
