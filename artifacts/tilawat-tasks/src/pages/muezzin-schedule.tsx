import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, ImageUp, Loader2, Megaphone, MessageSquareReply, Plus, RefreshCw, Send, Smartphone, XCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useCanManageMuezzins, useIsAdmin } from "@/lib/roles";
import { cn } from "@/lib/utils";

// «جدول المؤذنين» (للمدير): رفع صورة الجدول الأسبوعي الرسمي ← قراءة آلية ← معاينة بجانب الصورة ← إنشاء.
// الإرسال اليومي لكل مؤذن بمهامه فقط عبر واتساب الرسمي — وضع التجربة مفعّل افتراضيًا.

type Slot = "fajr1" | "fajr2" | "dhuhr" | "asr" | "maghrib" | "isha" | "jumuah1" | "jumuah2";
type Role = "muezzin" | "mulazim";
/** يشمل «الاحتياطي» الذي يُضاف يدويًا من الجدول المعتمد (لا يأتي من ملف الجدول). */
type AnyRole = Role | "reserve";
const ROLE_NAME: Record<AnyRole, string> = { muezzin: "مؤذن", mulazim: "ملازم", reserve: "احتياطي" };
const SLOTS: Array<{ key: Slot; label: string }> = [
  { key: "fajr1", label: "الفجر الأول" },
  { key: "fajr2", label: "الفجر الثاني" },
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
type Wording = { duty: "a" | "b" | "c" | "d"; buttons: "a" | "b" | "c"; form: "a" | "b"; substitute: "a" | "b" };
type Settings = {
  sendHour: number; sendMinute: number; testMode: boolean; testPhone: string | null; autoSendEnabled: boolean; lastAutoRunDate: string | null;
  supervisorPhone: string | null; supervisorPhones: string[]; confirmMode: boolean; wording: Wording; verifyToken: string | null;
  meta: {
    rev?: number; templates?: Record<string, string>; preparedAt?: string; wording?: Wording;
    textVersion?: "live" | "draft";
    v2?: { templates: Record<string, string>; preparedAt?: string; promotedAt?: string };
  };
  summaryEnabled: boolean; summaryHour: number; summaryMinute: number; lastSummaryDate: string | null;
  remindEnabled: boolean; remindAfterMin: number; remindSubAfterMin: number;
};
type Setup = {
  today: string;
  settings: Settings;
  status: { vision: boolean; whatsapp: boolean; appSecret: boolean; webhookUrl: string };
  muezzins: Muezzin[];
  upcoming: Array<{ dateKey: string; slot: Slot; role: AnyRole; muezzinId: number; name: string }>;
  sentDates?: string[];
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
/** 15:00 ← «3:00 م» */
function hhmm(h: number, m: number) {
  const suffix = h < 12 ? "ص" : "م";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

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
  // المدير أو من مُنح صلاحية «إدارة جدول المؤذنين».
  const isAdmin = useCanManageMuezzins();
  const { toast } = useToast();
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ["muezzin-setup"], queryFn: () => api<Setup>(`${BASE}/setup`), enabled: isAdmin });
  const refresh = () => qc.invalidateQueries({ queryKey: ["muezzin-setup"] });

  if (!isAdmin) return <div className="p-10 text-center text-muted-foreground">هذه الصفحة لمن لديه صلاحية «إدارة جدول المؤذنين».</div>;
  if (setup.isLoading) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>;
  if (setup.isError || !setup.data) return <div className="p-10 text-center text-destructive">{(setup.error as Error)?.message ?? "تعذّر التحميل"}</div>;
  const data = setup.data;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-3xl font-bold text-foreground tracking-tight">جدول المؤذنين</h2>
          <Link href="/muezzin-schedule/simulator"><Button variant="outline" size="sm"><Smartphone className="ml-1 h-4 w-4" />محاكي الرسائل</Button></Link>
        </div>
        <p className="text-muted-foreground mt-2">ارفع الجدول الأسبوعي (صورة أو PDF)، راجع القراءة بجانبه، ثم «إنشاء». يصل كل مؤذن مهامه يوميًا على واتساب.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusPill ok={data.status.vision} on="قراءة الصور جاهزة" off="قراءة الصور غير مفعّلة" />
          <StatusPill ok={data.status.whatsapp} on="واتساب مربوط" off="واتساب غير مربوط" />
          <StatusPill ok={!data.settings.testMode} on="التشغيل الفعلي" off="وضع التجربة" />
          <StatusPill ok={data.settings.autoSendEnabled} on={`الإرسال اليومي مفعّل — ${hhmm(data.settings.sendHour, data.settings.sendMinute)}`} off="الإرسال اليومي متوقف" />
          <StatusPill ok={data.settings.confirmMode} on="التأكيد بالأزرار مفعّل" off="التأكيد بالأزرار غير مفعّل" />
        </div>
      </div>

      {/* ثلاثة تبويبات: الجدول (يومي) — الردود (متابعة) — الإعدادات (نادرًا). */}
      <Tabs defaultValue="schedule" dir="rtl">
        <TabsList>
          <TabsTrigger value="schedule">الجدول</TabsTrigger>
          <TabsTrigger value="replies">الردود</TabsTrigger>
          <TabsTrigger value="settings">الإعدادات</TabsTrigger>
        </TabsList>
        <TabsContent value="schedule"><UploadTab data={data} onSaved={refresh} toast={toast} /></TabsContent>
        <TabsContent value="replies">
          <div className="space-y-4">
            <RepliesTab data={data} toast={toast} />
          </div>
        </TabsContent>
        <TabsContent value="settings">
          <div className="space-y-6">
            <section className="space-y-2">
              <h2 className="text-lg font-bold">المؤذنون ({data.muezzins.length})</h2>
              <MuezzinsTab data={data} onChange={refresh} toast={toast} />
            </section>
            <section className="space-y-2">
              <h2 className="text-lg font-bold">الإرسال اليومي</h2>
              <SendTab data={data} onChange={refresh} toast={toast} part="settings" />
            </section>
            <section className="space-y-2">
              <h2 className="text-lg font-bold">المشرفون وربط واتساب</h2>
              <ConfirmTab data={data} onChange={refresh} toast={toast} />
            </section>
          </div>
        </TabsContent>
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
  const [showUpload, setShowUpload] = useState(false);
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
      setPreview(null); setGrid(null); setUpload(null); setFileUrl(null); setAutoDate(false); setShowUpload(false);
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
      <UpcomingCard data={data} onChanged={onSaved} toast={toast} />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant={showUpload ? "secondary" : "default"} onClick={() => setShowUpload((v) => !v)}>
          <ImageUp className="ml-2 h-4 w-4" />{showUpload ? "إخفاء رفع الجدول" : "رفع جدول أسبوع جديد"}
        </Button>
        {!showUpload && <span className="text-xs text-muted-foreground">صورة أو PDF — تُقرأ تلقائيًا، تراجعها، ثم تعتمدها.</span>}
      </div>

      {showUpload && <>
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
      </>}
    </div>
  );
}

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
/** «15 – 21 نوفمبر» */
function weekLabel(sunday: string) {
  const sat = addDays(sunday, 6);
  const [, m1, d1] = sunday.split("-").map(Number);
  const [, m2, d2] = sat.split("-").map(Number);
  return m1 === m2 ? `${d1} – ${d2} ${MONTHS_AR[m1 - 1]}` : `${d1} ${MONTHS_AR[m1 - 1]} – ${d2} ${MONTHS_AR[m2 - 1]}`;
}

// ألوان هادئة: الأخضر للمؤذن، والأزرق للملازم، والذهبي لأذاني الجمعة (مع الوضع الداكن).
const CHIP = {
  muezzin: "bg-emerald-100/80 text-emerald-950 ring-1 ring-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-100 dark:ring-emerald-800",
  mulazim: "bg-sky-100/80 text-sky-950 ring-1 ring-sky-300 dark:bg-sky-950/50 dark:text-sky-100 dark:ring-sky-800",
  reserve: "bg-violet-100/80 text-violet-950 ring-1 ring-violet-300 dark:bg-violet-950/50 dark:text-violet-100 dark:ring-violet-800",
  jumuah: "bg-amber-100/80 text-amber-950 ring-1 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-800",
} as const;

function NameChip({ kind, name, label, onClick }: { kind: keyof typeof CHIP; name?: string; label?: string; onClick?: () => void }) {
  const body = (
    <>
      {label && <div className="text-[10px] opacity-70">{label}</div>}
      <div className="truncate font-medium" title={name}>{name ?? "—"}</div>
    </>
  );
  if (!onClick) return <div className={cn("rounded-md px-2 py-1 text-center leading-tight", CHIP[kind])}>{body}</div>;
  return (
    <button type="button" onClick={onClick} title="اضغط لتغيير الاسم"
      className={cn("w-full cursor-pointer rounded-md px-2 py-1 text-center leading-tight transition hover:brightness-95 hover:ring-2", CHIP[kind])}>
      {body}
    </button>
  );
}

type EditTarget = { dateKey: string; slot: Slot; role: AnyRole; current?: { id: number; name: string } };

/** نافذة تغيير اسم خانة واحدة في الجدول المعتمد. */
function EditSlotDialog({ target, data, onClose, onSaved, toast }: {
  target: EditTarget | null; data: Setup; onClose: () => void; onSaved: () => void; toast: any;
}) {
  const [choice, setChoice] = useState("");
  const options = data.muezzins.filter((m) => m.isActive).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  const save = useMutation({
    mutationFn: () => api(`${BASE}/slot`, {
      method: "PATCH",
      body: JSON.stringify({ dateKey: target!.dateKey, slot: target!.slot, role: target!.role, muezzinId: choice === "none" ? null : Number(choice) }),
    }),
    onSuccess: () => { toast({ title: "تم تعديل الخانة ✓" }); onClose(); onSaved(); },
    onError: (e: Error) => toast({ title: "تعذّر التعديل", description: e.message, variant: "destructive" }),
  });
  if (!target) return null;
  const dow = new Date(`${target.dateKey}T12:00:00Z`).getUTCDay();
  const roleName = target.role === "mulazim" ? "الملازم" : target.role === "reserve" ? "الاحتياطي" : "المؤذن";
  const unchanged = !choice || (target.current && String(target.current.id) === choice) || (!target.current && choice === "none");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent dir="rtl" className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-right">تغيير {roleName}</DialogTitle>
          <DialogDescription className="text-right">
            {SLOT_NAME[target.slot]} — يوم {DAY_NAMES[dow]} {target.dateKey.split("-").reverse().join("/")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>الحالي: <span className="font-semibold">{target.current?.name ?? "— لا أحد —"}</span></div>
          <select className="w-full rounded-md border bg-background p-2" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">اختر البديل…</option>
            {target.role === "mulazim" && <option value="none">— بلا ملازم —</option>}
            {target.role === "reserve" && target.current && <option value="none">— حذف الاحتياطي —</option>}
            {options.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.phone ? "" : " (بلا رقم جوال)"}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">تتغير هذه الخانة وحدها، ولا يتأثر بقية الجدول. تصل الرسالة للاسم الجديد في موعد الإرسال اليومي.</p>
        </div>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button disabled={unchanged || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}حفظ
          </Button>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** «25/05/1448» بتقويم أم القرى. */
function hijriShort(dateKey: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" })
      .formatToParts(new Date(`${dateKey}T12:00:00Z`));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("day")}/${get("month")}/${get("year")}`;
  } catch {
    return "";
  }
}

function UpcomingCard({ data, onChanged, toast }: { data: Setup; onChanged: () => void; toast: any }) {
  const entry = (d: string, s: Slot, r: AnyRole) => data.upcoming.find((u) => u.dateKey === d && u.slot === s && u.role === r);
  const find = (d: string, s: Slot, r: AnyRole) => entry(d, s, r)?.name;
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const sent = new Set(data.sentDates ?? []);
  // يُعدَّل اليوم إن كان له جدول، ولم يمضِ، ولم تُرسل رسائله بعد.
  const editable = (d: string) => d >= data.today && !sent.has(d) && data.upcoming.some((u) => u.dateKey === d);
  const open = (d: string, s: Slot, r: AnyRole) => {
    if (!editable(d)) return undefined;
    return () => { const e = entry(d, s, r); setEdit({ dateKey: d, slot: s, role: r, current: e ? { id: e.muezzinId, name: e.name } : undefined }); };
  };
  // أسابيع كاملة من الأحد إلى السبت: الحالي والقادمان.
  const thisSunday = addDays(data.today, -new Date(`${data.today}T12:00:00Z`).getUTCDay());
  const weeks = [0, 7, 14].map((n) => addDays(thisSunday, n));
  const hasData = (w: string) => data.upcoming.some((u) => u.dateKey >= w && u.dateKey <= addDays(w, 6));
  // الافتراضي: أحدث أسبوع مرفوع (عادةً القادم بعد رفعه).
  const [week, setWeek] = useState(() => [...weeks].reverse().find(hasData) ?? weeks[0]);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  return (
    <Card>
      <CardHeader>
        <CardTitle>الجدول المعتمد</CardTitle>
        <div className="flex flex-wrap gap-2 pt-2">
          {weeks.map((w, i) => (
            <Button key={w} size="sm" variant={w === week ? "default" : "outline"} onClick={() => setWeek(w)}>
              {i === 0 ? "هذا الأسبوع" : i === 1 ? "الأسبوع القادم" : "بعد القادم"} ({weekLabel(w)}){!hasData(w) && " — غير مرفوع"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* مفتاح الألوان */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className={cn("inline-block h-3 w-3 rounded-sm", CHIP.muezzin)} />مؤذن</span>
          <span className="flex items-center gap-1.5"><span className={cn("inline-block h-3 w-3 rounded-sm", CHIP.mulazim)} />ملازم</span>
          <span className="flex items-center gap-1.5"><span className={cn("inline-block h-3 w-3 rounded-sm", CHIP.reserve)} />احتياطي</span>
          <span className="flex items-center gap-1.5"><span className={cn("inline-block h-3 w-3 rounded-sm", CHIP.jumuah)} />أذانا الجمعة</span>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] table-fixed border-collapse text-sm">
            <colgroup><col className="w-[124px]" />{SLOTS.map((s) => <col key={s.key} />)}</colgroup>
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                <th className="border-b p-2 text-right font-semibold">اليوم</th>
                {SLOTS.map((s) => <th key={s.key} className="border-b border-r p-2 font-semibold">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {dates.map((d) => {
                const any = data.upcoming.some((u) => u.dateKey === d);
                const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
                const isFriday = dow === FRIDAY;
                const isToday = d === data.today;
                return (
                  <tr key={d} className={cn("align-top", isToday && "bg-sidebar-primary/5", !any && "text-muted-foreground")}>
                    <th className={cn("border-b p-2 text-right", isToday && "border-r-4 border-r-sidebar-primary")}>
                      <div className="font-bold">{DAY_NAMES[dow]}{isToday && <span className="mr-1 text-[10px] font-normal text-sidebar-primary">اليوم</span>}{sent.has(d) && <span className="mr-1 text-[10px] font-normal" title="أُرسلت رسائل هذا اليوم">🔒</span>}</div>
                      <div className="whitespace-nowrap text-[11px] font-normal text-muted-foreground">{hijriShort(d)} هـ</div>
                      <div className="text-[11px] font-normal text-muted-foreground" dir="ltr">{d.split("-").reverse().join("/")}</div>
                    </th>
                    {SLOTS.map((s) => {
                      const m = find(d, s.key, "muezzin");
                      const z = find(d, s.key, "mulazim");
                      const rv = find(d, s.key, "reserve");
                      const j1 = s.key === "dhuhr" && isFriday ? find(d, "jumuah1", "muezzin") : undefined;
                      const j2 = s.key === "dhuhr" && isFriday ? find(d, "jumuah2", "muezzin") : undefined;
                      return (
                        <td key={s.key} className="border-b border-r p-1.5">
                          <div className="flex flex-col gap-1">
                            {(j1 || j2) && (
                              <>
                                <NameChip kind="jumuah" label="الجمعة ١" name={j1} onClick={open(d, "jumuah1", "muezzin")} />
                                <NameChip kind="jumuah" label="الجمعة ٢" name={j2} onClick={open(d, "jumuah2", "muezzin")} />
                              </>
                            )}
                            {m && <NameChip kind="muezzin" name={m} onClick={open(d, s.key, "muezzin")} />}
                            {z && <NameChip kind="mulazim" name={z} onClick={open(d, s.key, "mulazim")} />}
                            {m && !z && !(isFriday && s.key === "dhuhr") && editable(d) && (
                              <button type="button" onClick={open(d, s.key, "mulazim")} className="rounded-md border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">+ ملازم</button>
                            )}
                            {rv && <NameChip kind="reserve" label="احتياطي" name={rv} onClick={open(d, s.key, "reserve")} />}
                            {m && !rv && !(isFriday && s.key === "dhuhr") && editable(d) && (
                              <button type="button" onClick={open(d, s.key, "reserve")} className="rounded-md border border-dashed border-violet-300 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/40">+ احتياطي</button>
                            )}
                            {!m && !z && !j1 && !j2 && any && <span className="py-1 text-center text-muted-foreground">—</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hasData(week) && (
          <p className="text-xs text-muted-foreground">
            ✏️ لتغيير اسم: اضغط عليه واختر البديل. ولإضافة مؤذن احتياطي: اضغط «+ احتياطي» تحت الصلاة (لا يُحذف عند إعادة رفع الجدول). الأيام التي أُرسلت رسائلها 🔒 تُغيَّر من زر «إسناد» في تبويب «الردود».
          </p>
        )}
        {!hasData(week) && <p className="mt-2 text-sm text-amber-700">لم يُرفع جدول هذا الأسبوع ({weekLabel(week)}) بعد.</p>}
        <EditSlotDialog key={edit ? `${edit.dateKey}-${edit.slot}-${edit.role}` : "none"} target={edit} data={data} onClose={() => setEdit(null)} onSaved={onChanged} toast={toast} />
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

/** اسم العرض لرقم الإرسال: حالته عند ميتا، وإعادة التسجيل لتطبيق الاسم المعتمد (للمدير فقط). */
function DisplayNameCard({ toast }: { toast: any }) {
  type Phone = { verified_name?: string; new_display_name?: string; new_name_status?: string; quality_rating?: string; status?: string };
  const q = useQuery({ queryKey: ["muezzin-phone"], queryFn: () => api<Phone>(`${BASE}/meta/phone`) });
  const [pin, setPin] = useState("");
  const rereg = useMutation({
    mutationFn: () => api<{ after: Phone }>(`${BASE}/meta/reregister`, { method: "POST", body: JSON.stringify({ pin }) }),
    onSuccess: (r) => { setPin(""); q.refetch(); toast({ title: "تمت إعادة التسجيل", description: `الاسم الظاهر الآن: ${r.after?.verified_name ?? "—"}` }); },
    onError: (e: Error) => { setPin(""); toast({ title: "لم تتم إعادة التسجيل", description: e.message, variant: "destructive" }); },
  });
  const p = q.data;
  const ready = p?.new_display_name && ["APPROVED", "AVAILABLE_WITHOUT_REVIEW"].includes(String(p.new_name_status)) && p.new_display_name !== p.verified_name;
  const STATUS: Record<string, string> = { APPROVED: "معتمد", AVAILABLE_WITHOUT_REVIEW: "معتمد (بلا مراجعة)", PENDING_REVIEW: "قيد المراجعة", DECLINED: "مرفوض", EXPIRED: "انتهت مهلته — يُقدَّم من جديد", NONE: "لا يوجد طلب" };
  return (
    <Card>
      <CardHeader>
        <CardTitle>🏷️ اسم العرض لرقم الإرسال</CardTitle>
        <CardDescription>الاسم الذي يظهر للمؤذنين بجانب رقم 0557578627 إن لم يحفظوه.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : q.isError ? <p className="text-red-700">تعذّر جلب الحالة من ميتا.</p> : (
          <ul className="space-y-1">
            <li>الاسم الظاهر الآن: <b>{p?.verified_name ?? "—"}</b></li>
            {p?.new_display_name && <li>الاسم المطلوب: <b>{p.new_display_name}</b> — {STATUS[String(p.new_name_status)] ?? p.new_name_status}</li>}
            <li>تقييم الجودة: {p?.quality_rating === "GREEN" ? "🟢 مرتفع" : p?.quality_rating === "YELLOW" ? "🟡 متوسط" : p?.quality_rating === "RED" ? "🔴 منخفض" : p?.quality_rating ?? "—"}</li>
          </ul>
        )}
        {ready && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <p>لتطبيق الاسم الجديد يلزم <b>إعادة تسجيل الرقم</b> خلال 14 يومًا من الموافقة. اكتب <b>رمز التحقق بخطوتين</b> (6 أرقام) الخاص برقم الإرسال — لا يُحفظ في أي مكان.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="password" inputMode="numeric" autoComplete="off" maxLength={6} className="w-36" dir="ltr" placeholder="••••••"
                value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
              <Button size="sm" disabled={pin.length !== 6 || rereg.isPending}
                onClick={() => { if (window.confirm(`إعادة تسجيل الرقم لتطبيق اسم «${p?.new_display_name}»؟\nإن كان الرمز خاطئًا فلن يتغير شيء.`)) rereg.mutate(); }}>
                {rereg.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}تطبيق الاسم الجديد
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** صياغة المشرف (قوالبها بانتظار ميتا ثم تحول تلقائي) + تذكير من لم يرد. */
function V2Card({ data, onChange, toast, saveSettings }: { data: Setup; onChange: () => void; toast: any; saveSettings: any }) {
  const s = data.settings;
  const v2 = s.meta.v2;
  const statuses = useQuery({
    queryKey: ["muezzin-templates"],
    queryFn: () => api<{ templates: Array<{ name: string; status: string; reason: string | null }> }>(`${BASE}/meta/templates`),
    enabled: Boolean(v2),
  });
  const prepare = useMutation({
    mutationFn: () => api(`${BASE}/meta/prepare-v2`, { method: "POST" }),
    onSuccess: () => { onChange(); statuses.refetch(); toast({ title: "أُرسلت قوالب صياغة المشرف لمراجعة ميتا" }); },
    onError: (e: Error) => toast({ title: "تعذّر الإرسال لميتا", description: e.message, variant: "destructive" }),
  });
  const [after, setAfter] = useState(String(s.remindAfterMin));
  const [subAfter, setSubAfter] = useState(String(s.remindSubAfterMin));
  const st = (n?: string) => statuses.data?.templates.find((t) => t.name === n);
  const label: Record<string, string> = { substitute: "رسالة البديل الطارئ", supAck: "تنبيه «عُلم» للمشرف", supApology: "تنبيه الاعتذار للمشرف", remind: "تذكير من لم يرد" };
  const pill = (n?: string) => {
    const t = st(n);
    const ok = t?.status === "APPROVED";
    return <span className={cn("rounded-full px-2 py-0.5 text-xs", ok ? "bg-emerald-50 text-emerald-700" : t?.status === "REJECTED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800")}>
      {statuses.isLoading ? "…" : TEMPLATE_STATUS[t?.status ?? ""] ?? t?.status ?? "—"}{t?.reason ? ` — ${t.reason}` : ""}
    </span>;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>✍️ صياغة المشرف وتذكير من لم يرد</CardTitle>
        <CardDescription>
          {s.meta.textVersion === "draft"
            ? "✅ الرسائل تُرسل الآن بصياغة المشرف."
            : v2 ? "⏳ الرسائل الحالية مستمرة كما هي، وتتحول كلها إلى صياغة المشرف تلقائيًا فور اعتماد ميتا للقوالب الثلاثة الأولى." : "لم تُرسل قوالب صياغة المشرف لميتا بعد."}
          {" "}جرّبها في <Link href="/muezzin-schedule/simulator" className="underline">محاكي الرسائل</Link>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!v2 ? (
          <Button size="sm" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
            {prepare.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}إرسال قوالب صياغة المشرف لاعتماد ميتا
          </Button>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {(["substitute", "supAck", "supApology", "remind"] as const).map((k) => (
              <li key={k} className="flex flex-wrap items-center gap-2"><span className="w-44">{label[k]}</span>{pill(v2.templates[k])}</li>
            ))}
          </ul>
        )}
        {v2 && statuses.data?.templates.some((t) => Object.values(v2.templates).includes(t.name) && t.status === "REJECTED") && (
          <Button size="sm" variant="outline" disabled={prepare.isPending} onClick={() => prepare.mutate()}>إعادة الإرسال لميتا</Button>
        )}
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-44 text-sm font-medium">تذكير من لم يرد</label>
            <Switch checked={s.remindEnabled} onCheckedChange={(v) => saveSettings.mutate({ remindEnabled: v })} />
            <span className="text-sm text-muted-foreground">{s.meta.templates?.remind ? "يعمل" : "يبدأ بعد اعتماد ميتا لقالبه"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-44 text-sm font-medium">المؤذن الأصلي بعد (دقيقة)</label>
            <Input type="number" min={10} max={720} className="w-24" dir="ltr" value={after} onChange={(e) => setAfter(e.target.value)} />
            <span className="text-xs text-muted-foreground">120 = ساعتان بعد إرسال المهمة</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-44 text-sm font-medium">البديل الطارئ بعد (دقيقة)</label>
            <Input type="number" min={10} max={720} className="w-24" dir="ltr" value={subAfter} onChange={(e) => setSubAfter(e.target.value)} />
            <Button size="sm" variant="outline" disabled={after === String(s.remindAfterMin) && subAfter === String(s.remindSubAfterMin)}
              onClick={() => saveSettings.mutate({ remindAfterMin: Number(after), remindSubAfterMin: Number(subAfter) })}>حفظ</Button>
          </div>
          <p className="text-xs text-muted-foreground">تذكير واحد فقط لكل مهمة، بنفس زرّي «عُلم» و«أعتذر». لا يُرسل لمن ردّ، ولا لمن لم تصله الرسالة الأولى.</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** الملخص المسائي للمشرفين: قالب مستقل يعتمده ميتا مرة، ثم يُرسل يوميًا في وقته. */
function SummaryCard({ data, onChange, toast, saveSettings }: { data: Setup; onChange: () => void; toast: any; saveSettings: any }) {
  const s = data.settings;
  const saved = `${String(s.summaryHour).padStart(2, "0")}:${String(s.summaryMinute).padStart(2, "0")}`;
  const [time, setTime] = useState(saved);
  const [date, setDate] = useState(addDays(data.today, 1));
  const tpl = s.meta.templates?.summary;
  const statuses = useQuery({
    queryKey: ["muezzin-templates"],
    queryFn: () => api<{ templates: Array<{ name: string; status: string; reason: string | null }> }>(`${BASE}/meta/templates`),
    enabled: Boolean(tpl),
  });
  const st = statuses.data?.templates.find((t) => t.name === tpl);
  const prepare = useMutation({
    mutationFn: () => api<{ name: string }>(`${BASE}/summary/prepare`, { method: "POST" }),
    onSuccess: () => { onChange(); statuses.refetch(); toast({ title: "أُرسل قالب الملخص لمراجعة ميتا", description: "الاعتماد يأخذ عادة من ساعات إلى يوم." }); },
    onError: (e: Error) => toast({ title: "تعذّر الإرسال لميتا", description: e.message, variant: "destructive" }),
  });
  const sendNow = useMutation({
    mutationFn: () => api<{ sent: number; failed: number; noDuties?: boolean }>(`${BASE}/summary/send`, { method: "POST", body: JSON.stringify({ date }) }),
    onSuccess: (r) => toast({ title: r.noDuties ? "لا توجد رسائل مهام لهذا اليوم" : `أُرسل الملخص لـ ${r.sent} مشرف${r.failed ? ` · فشل ${r.failed}` : ""}`, variant: r.failed || r.noDuties ? "destructive" : undefined }),
    onError: (e: Error) => toast({ title: "تعذّر إرسال الملخص", description: e.message, variant: "destructive" }),
  });
  const approved = st?.status === "APPROVED";
  return (
    <Card>
      <CardHeader>
        <CardTitle>📋 الملخص المسائي للمشرفين</CardTitle>
        <CardDescription>رسالة واحدة يوميًا لكل مشرف بردود مهام الغد: من ضغط «عُلم»، ومن اعتذر (مع السبب)، ومن لم يرد.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-40 text-sm font-medium">قالب ميتا</span>
          {!tpl ? (
            <Button size="sm" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
              {prepare.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}إرسال القالب لاعتماد ميتا
            </Button>
          ) : (
            <span className={cn("rounded-full px-2 py-0.5 text-sm", approved ? "bg-emerald-50 text-emerald-700" : st?.status === "REJECTED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800")}>
              {statuses.isLoading ? "…" : TEMPLATE_STATUS[st?.status ?? ""] ?? st?.status ?? "—"}{st?.reason ? ` — ${st.reason}` : ""}
            </span>
          )}
          {st?.status === "REJECTED" && <Button size="sm" variant="outline" disabled={prepare.isPending} onClick={() => prepare.mutate()}>إعادة الإرسال</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="w-40 text-sm font-medium">وقت الملخص</label>
          <Input type="time" className="w-36" dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!time || time === saved}
            onClick={() => { const [h, m] = time.split(":").map(Number); saveSettings.mutate({ summaryHour: h, summaryMinute: m }); }}>حفظ</Button>
          <span className="text-sm text-muted-foreground">يوميًا {hhmm(s.summaryHour, s.summaryMinute)} — بعد الإرسال اليومي ({hhmm(s.sendHour, s.sendMinute)})</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="w-40 text-sm font-medium">الإرسال التلقائي للملخص</label>
          <Switch checked={s.summaryEnabled} onCheckedChange={(v) => saveSettings.mutate({ summaryEnabled: v })} />
          <span className="text-sm text-muted-foreground">
            {!approved ? "يبدأ تلقائيًا بعد اعتماد ميتا للقالب" : s.lastSummaryDate ? `آخر إرسال: ${s.lastSummaryDate}` : "لم يُرسل بعد"}
          </span>
        </div>
        {approved && (
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <label className="w-40 text-sm font-medium">إرسال ملخص الآن</label>
            <Input type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
            <Button size="sm" variant="outline" disabled={sendNow.isPending}
              onClick={() => { if (window.confirm(`إرسال ملخص ردود يوم ${DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${date} للمشرفين الآن؟`)) sendNow.mutate(); }}>
              {sendNow.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />}إرسال
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SendTab({ data, onChange, toast, part }: { data: Setup; onChange: () => void; toast: any; part: "settings" }) {
  const isAdmin = useIsAdmin();
  const s = data.settings;
  const [time, setTime] = useState(`${String(s.sendHour).padStart(2, "0")}:${String(s.sendMinute).padStart(2, "0")}`);
  const savedTime = `${String(s.sendHour).padStart(2, "0")}:${String(s.sendMinute).padStart(2, "0")}`;
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
      {part === "settings" && <Card>
        <CardHeader><CardTitle>إعدادات الإرسال</CardTitle><CardDescription>كل يوم في الوقت المحدد يُرسل جدول اليوم التالي. مثال: الاثنين 3:00 م تُرسل مهام الثلاثاء.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="w-40 text-sm font-medium">وقت الإرسال اليومي</label>
            <Input type="time" className="w-36" dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} />
            <Button size="sm" variant="outline" disabled={!time || time === savedTime}
              onClick={() => { const [h, m] = time.split(":").map(Number); saveSettings.mutate({ sendHour: h, sendMinute: m }); }}>حفظ</Button>
            <span className="text-sm text-muted-foreground">يُرسل فيه جدول <b>اليوم التالي</b> ({hhmm(s.sendHour, s.sendMinute)} بتوقيت مكة)</span>
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
            {s.autoSendEnabled && s.meta.templates?.duty && !s.confirmMode && (
              <span className="text-sm text-amber-700">⏸ لن يُرسل شيء حتى يُفعَّل «التأكيد بالأزرار» بعد اعتماد ميتا.</span>
            )}
          </div>
        </CardContent>
      </Card>}
      {part === "settings" && <>
      <V2Card data={data} onChange={onChange} toast={toast} saveSettings={saveSettings} />
      {isAdmin && <DisplayNameCard toast={toast} />}
      <SummaryCard data={data} onChange={onChange} toast={toast} saveSettings={saveSettings} />

      <Card className="border-amber-300 dark:border-amber-800">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Megaphone className="h-5 w-5 text-amber-600" />إرسال طارئ ليوم محدد</CardTitle>
          <CardDescription>
            للطوارئ فقط: إذا رُفع الجدول بعد موعد الإرسال اليومي، أو لم تخرج الرسائل لعطل، أو «لم تصل» لرقم خاطئ ثم صُحّح الرقم. يرسل رسائل ذلك اليوم <b>فورًا</b> لمن لم تصله فقط، ولا يكرّرها لمن وصلته.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input type="date" className="w-44" value={sendDate} onChange={(e) => setSendDate(e.target.value)} />
          <Button
            variant="outline"
            disabled={sendNow.isPending || !data.status.whatsapp}
            onClick={() => {
              const n = data.upcoming.filter((u) => u.dateKey === sendDate).length;
              const day = DAY_NAMES[new Date(`${sendDate}T12:00:00Z`).getUTCDay()];
              const msg = n
                ? `ستُرسل رسائل يوم ${day} ${sendDate} الآن لـ ${n} مهمة${s.testMode ? " (إلى رقم التجربة فقط)" : " — تصل المؤذنين فعليًا"}.\nمن وصلته رسالته مسبقًا لن تتكرر له.\n\nهل أنت متأكد؟`
                : `لا أرى جدولًا معتمدًا ليوم ${day} ${sendDate}. هل تريد المحاولة مع ذلك؟`;
              if (window.confirm(msg)) sendNow.mutate();
            }}
          >
            {sendNow.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />}إرسال الآن
          </Button>
        </CardContent>
      </Card>
      </>}
    </div>
  );
}

/* ───────────────────────── الردود ───────────────────────── */

/** وقت قاعدة البيانات (UTC بلا منطقة) ← توقيت مكة. */
function fmtTime(v: string) {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(" ", "T")}Z`);
  return d.toLocaleString("ar-SA-u-ca-gregory-nu-latn", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" });
}

type DutyRow = {
  id: number; dateKey: string; slot: Slot; role: AnyRole; muezzinId: number | null; name: string; phone: string | null; testMode: boolean;
  sendOk: boolean; sendDetail: string | null; deliveryStatus: string | null; deliveryError: string | null;
  response: string | null; reason: string | null; respondedAt: string | null; substituteForDutyId: number | null; replacedByDutyId: number | null;
};
type RepliesData = {
  duties: DutyRow[];
  stats: Array<{ name: string; total: number; ack: number; apology: number; noReply: number; asSubstitute: number }>;
  events: Array<{ id: number; direction: string; phone: string | null; name: string | null; kind: string; text: string; dutyId: number | null; createdAt: string }>;
};
const SLOT_NAME: Record<Slot, string> = {
  fajr1: "الأذان الأول للفجر", fajr2: "الأذان الثاني للفجر", dhuhr: "الظهر", asr: "العصر", maghrib: "المغرب", isha: "العشاء",
  jumuah1: "الأذان الأول للجمعة", jumuah2: "الأذان الثاني للجمعة",
};
const EVENT_KIND: Record<string, string> = {
  duty: "رسالة مهمة", substitute_duty: "رسالة مهمة (بديل)", ack: "ضغط «عُلم»", apology_tap: "ضغط «أعتذر»", apology_form: "نموذج السبب", apology_prompt: "طلب كتابة السبب", apology_reminder: "تذكير بالسبب", pick_tap: "ضغط «اختيار البديل»", substitute_list: "قائمة البدلاء", list_unknown: "اختيار غير معروف",
  apology_reason: "سبب الاعتذار", supervisor_ack: "تنبيه المشرف (علم)", supervisor_apology: "تنبيه المشرف (اعتذار)",
  substitute_pick: "اختيار البديل", supervisor_summary: "الملخص المسائي", message: "رسالة نصية", button_unknown: "زر غير معروف", form_unknown: "نموذج غير معروف", error: "خطأ",
};

function DutyStatus({ d }: { d: DutyRow }) {
  if (!d.sendOk) return <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">لم تُرسل</span>;
  if (d.replacedByDutyId) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">اعتذر ← استُبدل</span>;
  if (d.response === "ack") return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">✓ عُلم</span>;
  if (d.response === "apology") return <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">اعتذر</span>;
  if (d.response === "apology_pending") return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">ضغط «أعتذر» — لم يكتب السبب</span>;
  if (d.deliveryStatus === "failed") return <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">لم تصل</span>;
  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">لم يرد{d.deliveryStatus === "read" ? " (قرأها)" : d.deliveryStatus === "delivered" ? " (وصلت)" : ""}</span>;
}

const REPLY_SLOT_ORDER: Slot[] = ["fajr1", "fajr2", "dhuhr", "jumuah1", "jumuah2", "asr", "maghrib", "isha"];
const REPLY_ROLES: AnyRole[] = ["muezzin", "mulazim", "reserve"];
type ReplyKind = "ack" | "apology" | "pending" | "none" | "failed" | "replaced";
const replyKind = (d: DutyRow): ReplyKind =>
  !d.sendOk ? "failed" : d.replacedByDutyId ? "replaced" : d.response === "ack" ? "ack" : d.response === "apology" ? "apology" : d.response === "apology_pending" ? "pending" : "none";
const REPLY_TONE: Record<ReplyKind, string> = {
  ack: "bg-emerald-50 ring-emerald-300 dark:bg-emerald-950/40 dark:ring-emerald-800",
  apology: "bg-red-50 ring-red-300 dark:bg-red-950/40 dark:ring-red-800",
  pending: "bg-amber-50 ring-amber-300 dark:bg-amber-950/40 dark:ring-amber-800",
  none: "bg-slate-50 ring-slate-300 dark:bg-slate-900/50 dark:ring-slate-700",
  failed: "bg-red-100 ring-red-400 dark:bg-red-950/60 dark:ring-red-700",
  replaced: "bg-slate-100 ring-slate-300 opacity-70 dark:bg-slate-900/60 dark:ring-slate-700",
};
const timeOnly = (v: string | null) => (v ? fmtTime(v).split(/[،,]\s*/).pop() : "");

/** خانة واحدة (صلاة × دور): الشيخ وحالته وسببه، ومن أُسندت إليه إن وُجد. */
function ReplyCell({ d, all, data, pick, setPick, assign }: {
  d: DutyRow; all: DutyRow[]; data: Setup; pick: Record<number, string>; setPick: (f: (p: Record<number, string>) => Record<number, string>) => void; assign: any;
}) {
  const k = replyKind(d);
  const sub = all.find((x) => x.id === d.replacedByDutyId);
  return (
    <div className="space-y-1">
      <div className={cn("rounded-md px-2 py-1 ring-1", REPLY_TONE[k])}>
        <div className="font-medium leading-tight">{d.name}{d.testMode && <span className="mr-1 text-[10px] text-muted-foreground">(تجربة)</span>}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
          <DutyStatus d={d} />
          {d.respondedAt && (k === "ack" || k === "apology") && <span className="text-muted-foreground">{timeOnly(d.respondedAt)}</span>}
        </div>
        {d.reason && <div className="mt-0.5 text-[11px]">السبب: {d.reason}</div>}
        {!d.sendOk && d.sendDetail && <div className="text-[11px] text-red-700">{d.sendDetail}</div>}
        {d.deliveryError && <div className="text-[11px] text-red-700">{d.deliveryError}</div>}
      </div>
      {sub && (
        <div className="pr-3 text-[11px] text-muted-foreground">↳ البديل:</div>
      )}
      {sub && <ReplyCell d={sub} all={all} data={data} pick={pick} setPick={setPick} assign={assign} />}
      {!sub && d.response === "apology" && d.role !== "reserve" && (
        <div className="flex items-center gap-1">
          <select className="w-full min-w-0 rounded border bg-background px-1 py-0.5 text-xs" value={pick[d.id] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [d.id]: e.target.value }))}>
            <option value="">اختر البديل…</option>
            {data.muezzins.filter((m) => m.isActive && m.id !== d.muezzinId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={!pick[d.id] || assign.isPending}
            onClick={() => { if (window.confirm("إسناد المهمة للبديل وإرسال رسالة المهمة له؟")) assign.mutate({ id: d.id, substituteId: Number(pick[d.id]) }); }}>إسناد</Button>
        </div>
      )}
    </div>
  );
}

function RepliesTab({ data, toast }: { data: Setup; toast: any }) {
  const [date, setDate] = useState(addDays(data.today, 1));
  const q = useQuery({ queryKey: ["muezzin-duties", date], queryFn: () => api<RepliesData>(`${BASE}/duties?date=${date}`), refetchInterval: 30_000 });
  const qc = useQueryClient();
  const [pick, setPick] = useState<Record<number, string>>({});
  const [who, setWho] = useState("");
  const assign = useMutation({
    mutationFn: ({ id, substituteId }: { id: number; substituteId: number }) =>
      api<{ substitute: string; note: string }>(`${BASE}/duties/${id}/substitute`, { method: "POST", body: JSON.stringify({ substituteId }) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["muezzin-duties"] }); toast({ title: `أُسندت المهمة إلى ${r.substitute}`, description: r.note || "وأُرسلت له رسالة المهمة" }); },
    onError: (e: Error) => toast({ title: "تعذّر الإسناد", description: e.message, variant: "destructive" }),
  });

  // شريط الأسبوع (الأحد → السبت) مع التنقل بين الأسابيع.
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekStart = addDays(date, -dow);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const duties = q.data?.duties ?? [];
  // المهمة «الحالية» لكل خانة = آخر من وصلته الخانة (بعد الإسناد)؛ للإحصاء نعدّ المهام الفعلية غير المستبدلة.
  const live = duties.filter((d) => d.sendOk && !d.replacedByDutyId);
  const groups: Array<{ k: ReplyKind; title: string; tone: string }> = [
    { k: "ack", title: "عُلم", tone: "text-emerald-700 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300" },
    { k: "apology", title: "اعتذر", tone: "text-red-700 border-red-300 bg-red-50 dark:bg-red-950/40 dark:text-red-300" },
    { k: "pending", title: "بانتظار السبب", tone: "text-amber-800 border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300" },
    { k: "none", title: "لم يرد", tone: "text-slate-700 border-slate-300 bg-slate-50 dark:bg-slate-900/50 dark:text-slate-300" },
  ];
  const byKind = (k: ReplyKind) => live.filter((d) => replyKind(d) === k);
  const failed = duties.filter((d) => !d.sendOk);
  const doneRatio = live.length ? Math.round((byKind("ack").length / live.length) * 100) : 0;
  const label = (d: DutyRow) => `${SLOT_NAME[d.slot]}${d.role === "muezzin" ? "" : ` (${ROLE_NAME[d.role]})`}`;

  const slots = REPLY_SLOT_ORDER.filter((s) => duties.some((d) => d.slot === s));
  const rolesUsed = REPLY_ROLES.filter((r) => duties.some((d) => d.role === r));
  const roots = (s: Slot, r: AnyRole) => duties.filter((d) => d.slot === s && d.role === r && !d.substituteForDutyId);

  const events = (q.data?.events ?? []).filter((e) => !who || e.name === who);
  const people = [...new Set((q.data?.events ?? []).map((e) => e.name).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "ar"));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><MessageSquareReply className="h-5 w-5 text-sidebar-primary" />ردود يوم {DAY_NAMES[dow]} {hijriShort(date)}</CardTitle>
          <CardDescription>اختر اليوم — كل يوم بردوده وإحصائياته وسجلّه. تتحدّث تلقائيًا كل 30 ثانية.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setDate(addDays(date, -7))} title="الأسبوع السابق">»</Button>
            {weekDays.map((d) => {
              const i = new Date(`${d}T12:00:00Z`).getUTCDay();
              return (
                <Button key={d} size="sm" variant={d === date ? "default" : "outline"} className={cn("h-auto flex-col px-2.5 py-1", d === data.today && d !== date && "ring-2 ring-sidebar-primary/40")} onClick={() => setDate(d)}>
                  <span className="text-xs font-bold">{DAY_NAMES[i]}</span>
                  <span className="text-[10px] opacity-80">{d.slice(8)}/{d.slice(5, 7)}</span>
                </Button>
              );
            })}
            <Button size="sm" variant="ghost" onClick={() => setDate(addDays(date, 7))} title="الأسبوع التالي">«</Button>
            <Button size="sm" variant="outline" className="mr-auto" onClick={() => q.refetch()}><RefreshCw className="ml-1 h-4 w-4" />تحديث</Button>
          </div>

          {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : !duties.length ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              لم تُرسل رسائل هذا اليوم بعد. {date > data.today ? `تُرسل يوم ${DAY_NAMES[(dow + 6) % 7]} الساعة ${hhmm(data.settings.sendHour, data.settings.sendMinute)}.` : ""}
            </p>
          ) : (
            <>
              {/* ملخص اليوم */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {groups.map((g) => (
                  <div key={g.k} className={cn("rounded-lg border p-2 text-center", g.tone)}>
                    <div className="text-2xl font-bold tabular-nums">{byKind(g.k).length}</div>
                    <div className="text-xs font-medium">{g.title}</div>
                  </div>
                ))}
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>نسبة التأكيد</span><span className="tabular-nums">{byKind("ack").length} من {live.length} ({doneRatio}%)</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${doneRatio}%` }} /></div>
              </div>
              {failed.length > 0 && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40">⚠️ لم تصل {failed.length} رسالة: {failed.map((d) => d.name).join("، ")}</p>}

              {/* الأسماء حسب الحالة */}
              <div className="grid gap-2 md:grid-cols-2">
                {groups.filter((g) => g.k !== "ack" || byKind("ack").length).map((g) => byKind(g.k).length > 0 && (
                  <div key={g.k} className={cn("rounded-lg border p-2", g.tone.split(" ").filter((c) => c.startsWith("border")).join(" "))}>
                    <div className={cn("mb-1 text-sm font-bold", g.tone.split(" ").filter((c) => c.startsWith("text") || c.startsWith("dark:text")).join(" "))}>{g.title} ({byKind(g.k).length})</div>
                    <ul className="space-y-0.5 text-sm">
                      {byKind(g.k).map((d) => (
                        <li key={d.id} className="flex flex-wrap gap-x-2">
                          <span className="font-medium">{d.name}</span>
                          <span className="text-muted-foreground">— {label(d)}</span>
                          {d.reason && <span className="text-xs">«{d.reason}»</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {/* جدول اليوم: الصلوات × الأدوار */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead><tr className="bg-muted/40">
                    <th className="w-28 border p-1.5">الصلاة</th>
                    {rolesUsed.map((r) => <th key={r} className={cn("border p-1.5", r === "reserve" && "text-violet-700 dark:text-violet-300")}>{r === "muezzin" ? "المؤذن" : r === "mulazim" ? "الملازم" : "الاحتياطي"}</th>)}
                  </tr></thead>
                  <tbody>
                    {slots.map((s) => (
                      <tr key={s} className="align-top">
                        <td className="border bg-muted/20 p-1.5 font-bold">{SLOT_NAME[s]}</td>
                        {rolesUsed.map((r) => (
                          <td key={r} className="border p-1.5">
                            {roots(s, r).length ? (
                              <div className="space-y-2">{roots(s, r).map((d) => <ReplyCell key={d.id} d={d} all={duties} data={data} pick={pick} setPick={setPick} assign={assign} />)}</div>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>سجل واتساب — يوم {DAY_NAMES[dow]}</CardTitle>
          <CardDescription>رسائل مهام هذا اليوم وردودها وتنبيهات المشرفين، الأحدث أولًا.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {people.length > 0 && (
            <select className="rounded-md border bg-background p-1.5 text-sm" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">كل الأشخاص</option>
              {people.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          {!events.length ? <p className="text-sm text-muted-foreground">لا يوجد شيء لهذا اليوم.</p> : (
            <div className="grid gap-4 md:grid-cols-2">
              {([
                { dir: "in", title: "⬅ الوارد", hint: "ردود المؤذنين والمشرفين", tone: "border-emerald-200 dark:border-emerald-900" },
                { dir: "out", title: "➡ الصادر", hint: "ما أرسله النظام", tone: "border-sky-200 dark:border-sky-900" },
              ] as const).map((col) => {
                const items = events.filter((e) => e.direction === col.dir);
                return (
                  <div key={col.dir} className={cn("rounded-lg border-2", col.tone)}>
                    <div className="flex items-baseline justify-between border-b px-3 py-2">
                      <span className="font-bold">{col.title}</span>
                      <span className="text-xs text-muted-foreground">{col.hint} · {items.length}</span>
                    </div>
                    <ul className="max-h-[480px] space-y-2 overflow-y-auto p-2 text-sm">
                      {!items.length && <li className="p-2 text-muted-foreground">لا يوجد.</li>}
                      {items.map((e) => (
                        <li key={e.id} className="rounded-md bg-muted/30 p-2">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="rounded bg-background px-1.5 py-0.5 font-medium text-foreground">{EVENT_KIND[e.kind] ?? e.kind}</span>
                            {e.name && <span className="font-medium text-foreground">{e.name}</span>}
                            <span>{fmtTime(e.createdAt)}</span>
                          </div>
                          {e.text && <div className="mt-1 whitespace-pre-line">{e.text}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>إحصائيات آخر 30 يومًا لكل شيخ</CardTitle><CardDescription>{data.settings.testMode ? "رسائل التجربة (وضع التجربة مفعّل)" : "الرسائل الفعلية"}</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          {!q.data?.stats.length ? <p className="text-sm text-muted-foreground">لا توجد بيانات بعد.</p> : (
            <table className="w-full border-collapse text-sm">
              <thead><tr className="bg-muted/40"><th className="border p-1.5">الشيخ</th><th className="border p-1.5">المهام</th><th className="border p-1.5">عُلم</th><th className="border p-1.5">اعتذر</th><th className="border p-1.5">لم يرد</th><th className="border p-1.5">كبديل</th></tr></thead>
              <tbody>{q.data.stats.map((r) => (
                <tr key={r.name} className="tabular-nums"><td className="border p-1.5">{r.name}</td><td className="border p-1.5 text-center">{r.total}</td><td className="border p-1.5 text-center text-emerald-700">{r.ack}</td><td className="border p-1.5 text-center text-red-700">{r.apology}</td><td className="border p-1.5 text-center">{r.noReply}</td><td className="border p-1.5 text-center">{r.asSubstitute}</td></tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ───────────────────────── الأزرار والمشرف ───────────────────────── */

const WORDING_OPTIONS: Array<{ key: keyof Wording; title: string; options: Array<{ v: string; label: string }> }> = [
  { key: "duty", title: "١. نص رسالة المهمة", options: [{ v: "d", label: "د — صيغة المدير (هجري + ميلادي)" }, { v: "a", label: "أ — رسمية" }, { v: "b", label: "ب — ودّية" }, { v: "c", label: "ج — مختصرة" }] },
  { key: "buttons", title: "٢. نص الزرّين", options: [{ v: "a", label: "أ — عُلم / أعتذر" }, { v: "b", label: "ب — علم وسأحضر بإذن الله / أعتذر عن المهمة" }, { v: "c", label: "ج — ✅ عُلم / ❌ أعتذر" }] },
  { key: "substitute", title: "٥. رسالة البديل", options: [{ v: "a", label: "أ — مثل رسالة المهمة" }, { v: "b", label: "ب — مع ذكر أنه بديل" }] },
];
const TEMPLATE_STATUS: Record<string, string> = { APPROVED: "معتمد ✓", PENDING: "قيد المراجعة", REJECTED: "مرفوض", PAUSED: "موقوف مؤقتًا", DISABLED: "معطّل", NOT_FOUND: "غير موجود" };

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 text-sm font-medium">{label}</span>
      <code dir="ltr" className="max-w-full break-all rounded bg-muted px-2 py-1 text-xs">{value}</code>
      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => navigator.clipboard?.writeText(value).catch(() => {})}><Copy className="h-3.5 w-3.5" /></Button>
    </div>
  );
}

function ConfirmTab({ data, onChange, toast }: { data: Setup; onChange: () => void; toast: any }) {
  const s = data.settings;
  // عرض الأرقام بصيغة 05… لسهولة القراءة.
  const toLocal = (p: string) => (p.startsWith("966") ? `0${p.slice(3)}` : p);
  const [sups, setSups] = useState<string[]>(s.supervisorPhones.length ? s.supervisorPhones.map(toLocal) : [""]);
  const supsChanged = JSON.stringify(sups.filter(Boolean)) !== JSON.stringify(s.supervisorPhones.map(toLocal));
  const [wording, setWording] = useState<Wording>(s.wording);
  const templates = useQuery({ queryKey: ["muezzin-templates"], queryFn: () => api<{ templates: Array<{ name: string; status: string; reason: string | null }> }>(`${BASE}/meta/templates`), enabled: Boolean(s.meta.templates) });
  const save = useMutation({
    mutationFn: (body: Partial<Settings>) => api(`${BASE}/settings`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { onChange(); toast({ title: "تم الحفظ" }); },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, variant: "destructive" }),
  });
  const prepare = useMutation({
    mutationFn: async () => {
      await api(`${BASE}/settings`, { method: "PATCH", body: JSON.stringify({ wording }) });
      return api<{ steps: string[] }>(`${BASE}/meta/prepare`, { method: "POST", body: "{}" });
    },
    onSuccess: (r) => { onChange(); templates.refetch(); toast({ title: "أُرسلت القوالب لميتا ✓", description: r.steps.join(" · ") }); },
    onError: (e: Error) => toast({ title: "تعذّر الإرسال لميتا", description: e.message, variant: "destructive" }),
  });
  const preview = useMutation({
    mutationFn: () => api<{ to: string; results: Array<{ label: string; ok: boolean; detail: string }> }>(`${BASE}/meta/preview`, { method: "POST", body: JSON.stringify({ wording }) }),
    onSuccess: (r) => {
      const bad = r.results.filter((x) => !x.ok);
      toast({ title: bad.length ? "تعذّرت بعض رسائل المعاينة" : `أُرسلت المعاينة إلى ${r.to} ✓`, description: bad.length ? bad.map((x) => `${x.label}: ${x.detail}`).join(" · ") : r.results.map((x) => x.label).join(" · "), variant: bad.length ? "destructive" : undefined });
    },
    onError: (e: Error) => toast({ title: "تعذّرت المعاينة", description: e.message, variant: "destructive" }),
  });
  const wordingChanged = JSON.stringify(wording) !== JSON.stringify(s.wording);
  const allApproved = Boolean(templates.data?.templates.length) && templates.data!.templates.every((t) => t.status === "APPROVED");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>١) المشرفون</CardTitle><CardDescription>أرقام واتساب شخصية عادية — تصل كلَّ مشرف تنبيهات «عُلم» و«اعتذر»، وأي مشرف يختار البديل (أول اختيار هو المعتمد). في وضع التجربة تذهب لرقم التجربة.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {sups.map((p, i) => {
            const name = data.muezzins.find((m) => m.phone && toLocal(m.phone) === p)?.name;
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-sm text-muted-foreground">مشرف {i + 1}</span>
                <Input dir="ltr" className="w-44" placeholder="05XXXXXXXX" value={p} onChange={(e) => setSups((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
                {name && <span className="text-sm text-muted-foreground">{name}</span>}
                {sups.length > 1 && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-red-700" onClick={() => setSups((xs) => xs.filter((_, j) => j !== i))}>حذف</Button>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={sups.length >= 10} onClick={() => setSups((xs) => [...xs, ""])}><Plus className="ml-1 h-4 w-4" />إضافة مشرف</Button>
            <Button size="sm" disabled={!supsChanged || save.isPending} onClick={() => save.mutate({ supervisorPhones: sups.filter(Boolean) })}>حفظ المشرفين</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>٢) استقبال الردود من ميتا</CardTitle>
          <CardDescription>يُضبط مرة واحدة في إعدادات تطبيق Muezzin Notify في ميتا (Webhooks).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <CopyField label="رابط الاستقبال" value={data.status.webhookUrl} />
          <CopyField label="رمز التحقق" value={s.verifyToken ?? ""} />
          <div className="flex items-center gap-2 text-sm">
            <span className="w-40 font-medium">المفتاح السري للتطبيق</span>
            <StatusPill ok={data.status.appSecret} on="مضاف في Railway" off="غير مضاف — WHATSAPP_APP_SECRET" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>٣) نص الرسائل وإرسالها لاعتماد ميتا</CardTitle><CardDescription>اختر كما في صفحة الخيارات، ثم أرسل. الاعتماد يأخذ عادة من ساعات إلى يوم.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {WORDING_OPTIONS.map((g) => (
            <div key={g.key} className="flex flex-wrap items-center gap-3">
              <span className="w-40 text-sm font-medium">{g.title}</span>
              <select className="rounded border bg-background px-2 py-1 text-sm" value={wording[g.key]} onChange={(e) => setWording((w) => ({ ...w, [g.key]: e.target.value }))}>
                {g.options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">٤. تنبيهات المشرف بنص ثابت كما في صفحة الخيارات.</p>
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/40 p-2">
            <Button variant="outline" disabled={preview.isPending || !data.status.whatsapp || !s.testPhone} onClick={() => preview.mutate()}>
              {preview.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />}معاينة على جوال التجربة
            </Button>
            <span className="text-xs text-muted-foreground">يرسل شكل الرسائل بالنص المختار إلى {s.testPhone ?? "رقم التجربة"}. الأزرار للعرض فقط. شرط ميتا: أرسل أولًا «السلام عليكم» من ذلك الجوال إلى رقم الإرسال 0557578627.</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button disabled={prepare.isPending || !data.status.whatsapp}
              onClick={() => { if (window.confirm("إرسال النماذج والقوالب لمراجعة ميتا بالنص المختار؟")) prepare.mutate(); }}>
              {prepare.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />}إرسال لاعتماد ميتا
            </Button>
            {s.meta.preparedAt && <span className="text-xs text-muted-foreground">آخر إرسال: {new Date(s.meta.preparedAt).toLocaleString("ar-SA-u-ca-gregory", { timeZone: "Asia/Riyadh" })}{wordingChanged ? " — غيّرت الاختيار ولم ترسله بعد" : ""}</span>}
          </div>
          {s.meta.templates && (
            <div className="rounded-md border p-2">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">حالة القوالب
                <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => templates.refetch()}><RefreshCw className={cn("h-3.5 w-3.5", templates.isFetching && "animate-spin")} /></Button>
              </div>
              {templates.isError ? <p className="text-xs text-red-700">{(templates.error as Error).message}</p> : (
                <ul className="space-y-1 text-sm">
                  {(templates.data?.templates ?? []).map((t) => (
                    <li key={t.name} className="flex flex-wrap gap-2"><code dir="ltr" className="text-xs">{t.name}</code>
                      <span className={cn(t.status === "APPROVED" ? "text-emerald-700" : t.status === "REJECTED" ? "text-red-700" : "text-amber-800")}>{TEMPLATE_STATUS[t.status] ?? t.status}</span>
                      {t.reason && <span className="text-xs text-red-700">{t.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>٤) تفعيل التأكيد بالأزرار</CardTitle><CardDescription>بعد اعتماد كل القوالب. عند التفعيل تصل كل مهمة في رسالة مستقلة بزرّي «عُلم / أعتذر».</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Switch checked={s.confirmMode} disabled={save.isPending || (!s.confirmMode && !allApproved)}
            onCheckedChange={(v) => save.mutate({ confirmMode: v })} />
          <span className="text-sm text-muted-foreground">{s.confirmMode ? "مفعّل" : allApproved ? "جاهز للتفعيل" : "بانتظار اعتماد القوالب"}</span>
        </CardContent>
      </Card>
    </div>
  );
}
