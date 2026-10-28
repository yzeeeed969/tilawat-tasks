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

type Slot = "fajr1" | "fajr2" | "dhuhr" | "asr" | "maghrib" | "isha" | "jumuah1" | "jumuah2";
type Role = "muezzin" | "mulazim";
const SLOTS: Array<{ key: Slot; label: string }> = [
  { key: "fajr1", label: "الفجر 1" },
  { key: "fajr2", label: "الفجر 2" },
  { key: "dhuhr", label: "الظهر" },
  { key: "asr", label: "العصر" },
  { key: "maghrib", label: "المغرب" },
  { key: "isha", label: "العشاء" },
];
const ROLES: Array<{ key: Role; label: string }> = [
  { key: "muezzin", label: "مؤذن" },
  { key: "mulazim", label: "ملازم" },
];
const FRIDAY = 5;

type Muezzin = { id: number; name: string; phone: string | null; isActive: boolean };
type Settings = { sendHour: number; testMode: boolean; testPhone: string | null; autoSendEnabled: boolean; lastAutoRunDate: string | null };
type Setup = {
  today: string;
  settings: Settings;
  status: { vision: boolean; whatsapp: boolean };
  muezzins: Muezzin[];
  upcoming: Array<{ dateKey: string; slot: Slot; role: Role; name: string }>;
  log: Array<{ id: number; dateKey: string; name: string; phone: string | null; testMode: boolean; ok: boolean; detail: string; createdAt: string }>;
};
type Cell = { raw: string; muezzinId: number | null };
type PreviewDay = { day: string; date: string; slots: Record<Slot, Record<Role, Cell>> };
type Preview = { title: string; days: PreviewDay[]; hasMulazim: boolean; suggestedWeekStart: string | null };
type Grid = Array<Record<Slot, Record<Role, string>>>; // قيمة الخانة: معرّف المؤذن كنص، أو "" للفارغ
const ALL_SLOT_KEYS: Slot[] = ["fajr1", "fajr2", "dhuhr", "asr", "maghrib", "isha", "jumuah1", "jumuah2"];

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
        <p className="text-muted-foreground mt-2">ارفع الجدول الأسبوعي (صورة أو PDF)، راجع القراءة بجانبه، ثم «إنشاء». يصل كل مؤذن مهامه يوميًا على واتساب.</p>
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

function NameSelect({ value, options, bad, raw, onChange }: { value: string; options: Muezzin[]; bad: boolean; raw: string; onChange: (v: string) => void }) {
  return (
    <div>
      <select
        className={cn(
          "w-full min-w-0 appearance-none rounded border bg-background px-1.5 py-1 text-center text-xs leading-tight",
          bad && "border-red-400 bg-red-50 text-red-700",
          !value && !bad && "text-muted-foreground",
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={raw ? `المقروء: ${raw}` : undefined}
      >
        <option value="">—</option>
        {options.map((m) => <option key={m.id} value={String(m.id)}>{m.name}{m.isActive ? "" : " (موقوف)"}</option>)}
      </select>
      {bad && <div className="mt-0.5 truncate text-[10px] text-red-700" title={raw}>المقروء: {raw}</div>}
    </div>
  );
}

function UploadTab({ data, onSaved, toast }: { data: Setup; onSaved: () => void; toast: any }) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(false);
  const [upload, setUpload] = useState<{ blob: Blob; type: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [weekStart, setWeekStart] = useState(() => nextSunday(data.today));
  const [autoDate, setAutoDate] = useState(false);
  // كل المؤذنين في القائمة (الموقوف يظهر بعلامة) — كي لا تختفي خانة مطابَقة لمؤذن موقوف.
  const options = [...data.muezzins].sort((a, b) => Number(b.isActive) - Number(a.isActive));

  const read = useMutation({
    mutationFn: () => api<Preview>(`${BASE}/read`, { method: "POST", body: upload!.blob, headers: { "Content-Type": upload!.type } }),
    onSuccess: (p) => {
      setPreview(p);
      setGrid(p.days.map((d) => Object.fromEntries(ALL_SLOT_KEYS.map((s) => [s, {
        muezzin: d.slots[s]?.muezzin?.muezzinId ? String(d.slots[s].muezzin.muezzinId) : "",
        mulazim: d.slots[s]?.mulazim?.muezzinId ? String(d.slots[s].mulazim.muezzinId) : "",
      }])) as Grid[number]));
      if (p.suggestedWeekStart) { setWeekStart(p.suggestedWeekStart); setAutoDate(true); } else setAutoDate(false);
    },
    onError: (e: Error) => toast({ title: "تعذّرت القراءة", description: e.message, variant: "destructive" }),
  });

  const save = useMutation({
    mutationFn: () => api<{ entries: number; weekStart: string; weekEnd: string }>(`${BASE}/week`, {
      method: "POST",
      body: JSON.stringify({
        weekStart,
        title: preview?.title ?? null,
        days: grid!.map((row, i) => ({
          slots: Object.fromEntries(ALL_SLOT_KEYS
            .filter((s) => i === FRIDAY || (s !== "jumuah1" && s !== "jumuah2"))
            .map((s) => [s, {
              muezzin: row[s].muezzin ? Number(row[s].muezzin) : null,
              mulazim: s.startsWith("jumuah") ? null : row[s].mulazim ? Number(row[s].mulazim) : null,
            }])),
        })),
      }),
    }),
    onSuccess: (r) => {
      toast({ title: "تم إنشاء الجدول ✓", description: `${r.entries} خانة من ${r.weekStart} إلى ${r.weekEnd}` });
      setPreview(null); setGrid(null); setUpload(null); setFileUrl(null); setAutoDate(false);
      onSaved();
    },
    onError: (e: Error) => toast({ title: "تعذّر الإنشاء", description: e.message, variant: "destructive" }),
  });

  const roles = preview?.hasMulazim ? ROLES : ROLES.slice(0, 1);
  // خانة «تحتاج تصحيح»: الملف فيه اسم لكن لم يُختر مؤذن.
  const isBad = (i: number, s: Slot, r: Role) => Boolean(preview?.days[i]?.slots[s]?.[r]?.raw) && !grid?.[i]?.[s]?.[r];
  const problems = useMemo(() => {
    if (!preview || !grid) return 0;
    let n = 0;
    preview.days.forEach((_, i) => ALL_SLOT_KEYS.forEach((s) => ROLES.forEach((r) => { if (isBad(i, s, r.key)) n++; })));
    return n;
  }, [preview, grid]);
  const isSunday = new Date(`${weekStart}T12:00:00Z`).getUTCDay() === 0;
  const setCell = (i: number, s: Slot, r: Role, v: string) =>
    setGrid((g) => g!.map((row, ri) => (ri === i ? { ...row, [s]: { ...row[s], [r]: v } } : row)));

  async function onFile(file?: File) {
    if (!file) return;
    try {
      setPreview(null); setGrid(null); setAutoDate(false);
      if (file.type === "application/pdf") {
        if (file.size > 18 * 1024 * 1024) throw new Error("ملف PDF أكبر من 18MB");
        setUpload({ blob: file, type: "application/pdf" }); setFileUrl(URL.createObjectURL(file)); setIsPdf(true);
      } else {
        const r = await shrinkImage(file);
        setUpload({ blob: r.blob, type: "image/jpeg" }); setFileUrl(r.url); setIsPdf(false);
      }
    } catch (e) {
      toast({ title: "تعذّر فتح الملف", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ImageUp className="h-5 w-5 text-sidebar-primary" />١) ملف الجدول الأسبوعي</CardTitle>
          <CardDescription>صورة أو PDF — بالمؤذن فقط، أو بالمؤذن والملازم. الأسماء المختصرة («خوجة»، «الدغريري») تُطابَق تلقائيًا.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input type="file" accept="image/*,application/pdf" className="max-w-xs" onChange={(e) => onFile(e.target.files?.[0])} />
          <Button disabled={!upload || read.isPending || !data.status.vision} onClick={() => read.mutate()}>
            {read.isPending ? <><Loader2 className="ml-2 h-4 w-4 animate-spin" />جارٍ القراءة…</> : "قراءة ومعاينة"}
          </Button>
          {!data.status.vision && <span className="text-sm text-amber-700">أضف مفتاح ANTHROPIC_API_KEY في Railway لتفعيل القراءة.</span>}
        </CardContent>
      </Card>

      {preview && grid && (
        <Card>
          <CardHeader>
            <CardTitle>٢) المعاينة — قارن بالملف وصحّح أي خانة</CardTitle>
            <CardDescription>
              {preview.title && <span className="block">المقروء: {preview.title}</span>}
              الخانة الحمراء: اسم لم يُطابَق مع مؤذن واحد بعينه (غير موجود أو يحتمل أكثر من مؤذن) — اختر الاسم الصحيح.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              {fileUrl && (
                <div className="xl:sticky xl:top-4 xl:self-start">
                  {isPdf
                    ? <iframe src={fileUrl} title="ملف الجدول" className="h-[640px] w-full rounded-md border" />
                    : <img src={fileUrl} alt="صورة الجدول" className="w-full rounded-md border" />}
                </div>
              )}
              <div>
                <table className="w-full table-fixed border-collapse text-xs">
                  <colgroup>
                    <col className="w-[64px]" />
                    {preview.hasMulazim && <col className="w-[44px]" />}
                    {SLOTS.map((s) => <col key={s.key} />)}
                  </colgroup>
                  <thead>
                    <tr className="bg-muted/40">
                      <th className="border p-1">اليوم</th>
                      {preview.hasMulazim && <th className="border p-1">الدور</th>}
                      {SLOTS.map((s) => <th key={s.key} className="border p-1">{s.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.days.map((d, i) => roles.map((r, ri) => (
                      <tr key={`${d.day}-${r.key}`} className={cn(ri === roles.length - 1 && "border-b-2")}>
                        {ri === 0 && (
                          <th rowSpan={roles.length} className="border bg-muted/20 p-1 font-semibold">
                            {d.day}<div className="text-[10px] font-normal text-muted-foreground">{addDays(weekStart, i)}</div>
                          </th>
                        )}
                        {preview.hasMulazim && <td className={cn("border p-1 text-center", r.key === "mulazim" && "text-muted-foreground")}>{r.label}</td>}
                        {SLOTS.map((s) => (
                          <td key={s.key} className={cn("border p-0.5", isBad(i, s.key, r.key) && "bg-red-50")}>
                            <NameSelect
                              value={grid[i][s.key][r.key]}
                              options={options}
                              bad={isBad(i, s.key, r.key)}
                              raw={d.slots[s.key][r.key].raw}
                              onChange={(v) => setCell(i, s.key, r.key, v)}
                            />
                          </td>
                        ))}
                      </tr>
                    )))}
                  </tbody>
                </table>

                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border p-2 text-xs">
                  <span className="font-semibold">أذان الجمعة ({addDays(weekStart, FRIDAY)}):</span>
                  {(["jumuah1", "jumuah2"] as const).map((s, k) => (
                    <label key={s} className="flex items-center gap-1.5">
                      {k === 0 ? "الأول" : "الثاني"}
                      <div className="w-36">
                        <NameSelect
                          value={grid[FRIDAY][s].muezzin}
                          options={options}
                          bad={isBad(FRIDAY, s, "muezzin")}
                          raw={preview.days[FRIDAY].slots[s].muezzin.raw}
                          onChange={(v) => setCell(FRIDAY, s, "muezzin", v)}
                        />
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <label className="text-sm font-medium">تاريخ يوم الأحد (بداية الأسبوع):</label>
              <Input type="date" className="w-44" value={weekStart} onChange={(e) => { setWeekStart(e.target.value); setAutoDate(false); }} />
              {!isSunday && <span className="text-sm text-red-700">التاريخ المختار ليس يوم أحد</span>}
              {autoDate && isSunday && <span className="text-sm text-emerald-700">حُدِّد تلقائيًا من التاريخ الهجري المكتوب في الجدول ✓</span>}
              {!autoDate && isSunday && <span className="text-sm text-amber-700">تأكد أن هذا هو أحد الأسبوع المكتوب في الجدول</span>}
              <Button
                className="bg-amber-600 hover:bg-amber-700"
                disabled={problems > 0 || !isSunday || save.isPending}
                onClick={() => {
                  if (window.confirm(`هل راجعت الجدول مع الملف وتأكدت أنه صحيح؟\nسيُعتمد للأسبوع ${weekStart} ← ${addDays(weekStart, 6)}`)) save.mutate();
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
  const find = (d: string, s: Slot, r: Role) => data.upcoming.find((u) => u.dateKey === d && u.slot === s && u.role === r)?.name;
  const dates = Array.from({ length: 8 }, (_, i) => addDays(data.today, i));
  return (
    <Card>
      <CardHeader><CardTitle>الجدول المعتمد للأيام القادمة</CardTitle></CardHeader>
      <CardContent>
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup><col className="w-[84px]" />{SLOTS.map((s) => <col key={s.key} />)}</colgroup>
          <thead><tr className="bg-muted/40"><th className="border p-1.5">اليوم</th>{SLOTS.map((s) => <th key={s.key} className="border p-1.5">{s.label}</th>)}</tr></thead>
          <tbody>
            {dates.map((d) => {
              const any = data.upcoming.some((u) => u.dateKey === d);
              const isFriday = new Date(`${d}T12:00:00Z`).getUTCDay() === FRIDAY;
              return (
                <tr key={d} className={cn(!any && "text-muted-foreground")}>
                  <th className="border p-1.5">{DAY_NAMES[new Date(`${d}T12:00:00Z`).getUTCDay()]}<div className="text-[10px] font-normal">{d}</div></th>
                  {SLOTS.map((s) => {
                    const m = find(d, s.key, "muezzin");
                    const z = find(d, s.key, "mulazim");
                    const j1 = s.key === "dhuhr" && isFriday ? find(d, "jumuah1", "muezzin") : undefined;
                    const j2 = s.key === "dhuhr" && isFriday ? find(d, "jumuah2", "muezzin") : undefined;
                    return (
                      <td key={s.key} className="border p-1.5 text-center">
                        {m ?? (any && !j1 ? "—" : "")}
                        {z && <div className="text-[10px] text-muted-foreground">ملازم: {z}</div>}
                        {(j1 || j2) && <div className="text-[10px]">الجمعة: {j1 ?? "—"} / {j2 ?? "—"}</div>}
                      </td>
                    );
                  })}
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
