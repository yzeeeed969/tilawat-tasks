import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Clock, Loader2, RotateCcw, SendHorizontal, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCanManageMuezzins } from "@/lib/roles";
import { cn } from "@/lib/utils";

/**
 * «محاكي الرسائل»: يعرض ما يصل للمؤذن والمشرف والبديل في كل حالة، بنفس نصوص النظام الفعلية
 * (من الخادم — المصدر نفسه الذي يرسل منه النظام). لا يرسل أي رسالة حقيقية.
 */

const BASE = "/api/muezzin-schedule";
type Slot = "fajr1" | "fajr2" | "dhuhr" | "asr" | "maghrib" | "isha" | "jumuah1" | "jumuah2";
type Role = "muezzin" | "mulazim" | "reserve";
type Version = "draft" | "live";
type Phone = "m" | "s" | "b";

type Bundle = {
  version: Version;
  active: Version;
  main: Record<"duty" | "reminder" | "ackReply" | "apologyPrompt" | "reasonReminder" | "apologyRecorded" | "alreadyApologized" | "replacedAfterApology" | "supAck" | "supApology" | "pickListHeader" | "assigned" | "alreadyAssigned" | "reservePick", string>;
  sub: Record<"duty" | "reminder" | "ackReply" | "apologyPrompt" | "apologyRecorded" | "supAck" | "supApology", string>;
  summaries: Record<"ack" | "none" | "apologyPending" | "apology" | "subNone" | "subAck", string>;
  pickLists: Array<{ header: string; names: string[] }>;
};
type Muezzin = { id: number; name: string; isActive: boolean };

type Bubble = {
  id: number;
  phone: Phone;
  from: "sys" | "user" | "note";
  text: string;
  kind?: "template" | "text" | "list";
  buttons?: Array<{ label: string; action: string }>;
  used?: boolean;
};

const SLOTS: Array<{ key: Slot; label: string }> = [
  { key: "fajr1", label: "الأذان الأول للفجر" }, { key: "fajr2", label: "الأذان الثاني للفجر" },
  { key: "dhuhr", label: "الظهر" }, { key: "asr", label: "العصر" }, { key: "maghrib", label: "المغرب" }, { key: "isha", label: "العشاء" },
  { key: "jumuah1", label: "الأذان الأول للجمعة" }, { key: "jumuah2", label: "الأذان الثاني للجمعة" },
];
const ROLES: Array<{ key: Role; label: string }> = [{ key: "muezzin", label: "مؤذن أساسي" }, { key: "mulazim", label: "ملازم" }, { key: "reserve", label: "احتياطي" }];

async function api<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const p = await r.json().catch(() => null);
  if (!r.ok) throw new Error(p?.message ?? "حدث خطأ");
  return p as T;
}

function tomorrowKey() {
  const now = new Date(Date.now() + 3 * 3600_000); // توقيت مكة
  now.setUTCDate(now.getUTCDate() + 1);
  return now.toISOString().slice(0, 10);
}

/* ───────── جوال واتساب ───────── */

function PhoneView({ title, subtitle, bubbles, onAction, footer, tone }: {
  title: string; subtitle: string; bubbles: Bubble[]; onAction: (b: Bubble, action: string) => void; footer?: React.ReactNode; tone: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [bubbles.length]);
  return (
    <div className="flex h-[620px] flex-col overflow-hidden rounded-[28px] border-[6px] border-zinc-800 bg-zinc-800 shadow-sm dark:border-zinc-700">
      <div className={cn("flex items-center gap-2 px-3 py-2 text-white", tone)}>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20"><Smartphone className="h-4 w-4" /></div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-bold">{title}</div>
          <div className="truncate text-[11px] opacity-80">{subtitle}</div>
        </div>
      </div>
      <div ref={ref} className="flex-1 space-y-2 overflow-y-auto bg-[#efeae2] p-2.5 dark:bg-[#0b141a]">
        {!bubbles.length && <div className="mt-24 text-center text-xs text-zinc-500">لا رسائل بعد</div>}
        {bubbles.map((b) => b.from === "note" ? (
          <div key={b.id} className="mx-auto w-fit max-w-[90%] rounded-lg bg-amber-100 px-2.5 py-1 text-center text-[11px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">{b.text}</div>
        ) : (
          <div key={b.id} className={cn("flex", b.from === "user" ? "justify-end" : "justify-start")}>
            <div className="max-w-[88%]">
              <div className={cn("whitespace-pre-line rounded-lg px-2.5 py-1.5 text-[13.5px] leading-6 shadow-sm",
                b.from === "user" ? "bg-[#d9fdd3] text-zinc-900 dark:bg-[#005c4b] dark:text-white" : "bg-white text-zinc-900 dark:bg-[#202c33] dark:text-zinc-100")}>
                {b.from === "sys" && b.kind && (
                  <div className={cn("mb-1 w-fit rounded px-1.5 text-[10px] font-medium",
                    b.kind === "template" ? "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200")}>
                    {b.kind === "template" ? "قالب ميتا" : b.kind === "list" ? "قائمة اختيار" : "رسالة نصية"}
                  </div>
                )}
                {b.text}
              </div>
              {b.buttons?.map((btn) => (
                <button key={btn.action} type="button" disabled={b.used} onClick={() => onAction(b, btn.action)}
                  className={cn("mt-1 w-full rounded-lg bg-white py-1.5 text-center text-sm font-medium text-[#00a884] shadow-sm transition dark:bg-[#202c33]",
                    b.used ? "cursor-default opacity-50" : "hover:bg-emerald-50 active:scale-[0.98] dark:hover:bg-[#2a3942]")}>
                  {btn.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {footer && <div className="bg-zinc-100 p-2 dark:bg-[#1f2c34]">{footer}</div>}
    </div>
  );
}

/* ───────── الصفحة ───────── */

export default function MuezzinSimulatorPage() {
  const canManage = useCanManageMuezzins();
  const setup = useQuery({ queryKey: ["muezzin-setup"], queryFn: () => api<{ muezzins: Muezzin[] }>(`${BASE}/setup`), enabled: canManage });
  const muezzins = (setup.data?.muezzins ?? []).filter((m) => m.isActive);

  const [version, setVersion] = useState<Version>("draft");
  const [role, setRole] = useState<Role>("muezzin");
  const [slot, setSlot] = useState<Slot>("dhuhr");
  const [name, setName] = useState("يزيد");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [waitingReason, setWaitingReason] = useState<null | "main" | "sub">(null);
  const [reason, setReason] = useState("");
  const [sub, setSub] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<keyof Bundle["summaries"] | null>(null);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const date = tomorrowKey();
  const effSlot: Slot = slot.startsWith("jumuah") && role !== "muezzin" ? "dhuhr" : slot;

  // «صاحب المهمة الحالي»: المؤذن الأصلي، ثم كل بديل يُسند إليه (بديل البديل… كما في الواقع).
  type Holder = { name: string; orig: string | null; level: number };
  const holderRef = useRef<Holder>({ name, orig: null, level: 0 });
  const phoneOf = (h: Holder): Phone => (h.level === 0 ? "m" : "b");

  const load = (extra: { reason?: string; sub?: string } = {}, h: Holder = holderRef.current) =>
    api<Bundle>(`${BASE}/simulator?${new URLSearchParams({
      version, role, slot: effSlot, date, name: h.name, ...(h.orig ? { orig: h.orig } : {}),
      reason: extra.reason ?? reason, sub: extra.sub ?? sub ?? "أحمد نحاس",
    })}`);

  const push = (list: Array<Omit<Bubble, "id">>) => setBubbles((prev) => [...prev, ...list.map((b) => ({ ...b, id: nextId.current++ }))]);
  const markUsed = (id: number) => setBubbles((prev) => prev.map((b) => (b.id === id ? { ...b, used: true } : b)));

  const start = async () => {
    setBusy(true);
    try {
      holderRef.current = { name, orig: null, level: 0 };
      const b = await load({}, holderRef.current);
      nextId.current = 1;
      setBubbles([]); setWaitingReason(null); setReason(""); setSub(null); setOutcome("none");
      push([
        { phone: "m", from: "note", text: "الساعة 3:00 عصرًا — يصل المؤذن رسالة مهمة الغد" },
        { phone: "m", from: "sys", kind: "template", text: b.main.duty, buttons: [{ label: "عُلم", action: "ack" }, { label: "أعتذر", action: "apol" }, { label: "⏱ ماذا لو لم يرد ساعتين؟", action: "noreply" }] },
      ]);
    } finally { setBusy(false); }
  };

  // يعيد التشغيل عند تغيير الإعدادات
  useEffect(() => { void start(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [version, role, slot, name]);

  const onAction = async (bubble: Bubble, action: string) => {
    if (bubble.id > 0) markUsed(bubble.id);
    setBusy(true);
    try {
      const h = holderRef.current;
      const ph = phoneOf(h);
      const b = await load();
      const who = h.level === 0 ? `الشيخ ${h.name}` : `البديل ${h.name}`;
      if (action === "ack") {
        push([
          { phone: ph, from: "user", text: "عُلم" },
          { phone: ph, from: "sys", kind: "text", text: b.main.ackReply },
          { phone: "s", from: "note", text: `ضغط ${who} «عُلم»` },
          { phone: "s", from: "sys", kind: "template", text: b.main.supAck },
          { phone: ph, from: "note", text: "في الموقع: تصبح خانته خضراء «✓ عُلم» في تبويب الردود" },
        ]);
        setOutcome(h.level === 0 ? "ack" : "subAck");
      } else if (action === "apol") {
        push([
          { phone: ph, from: "user", text: "أعتذر" },
          { phone: ph, from: "sys", kind: "text", text: b.main.apologyPrompt },
          { phone: "s", from: "note", text: "لا يصل المشرف شيء حتى يُكتب السبب" },
        ]);
        setWaitingReason(ph === "m" ? "main" : "sub"); setOutcome(h.level === 0 ? "apologyPending" : "subNone");
      } else if (action === "pick") {
        if (role === "reserve") {
          push([{ phone: "s", from: "user", text: "اختيار البديل" }, { phone: "s", from: "sys", kind: "text", text: b.main.reservePick }]);
        } else {
          setSub(null);
          // كما في الواقع: تصل المشرفَ عدة قوائم متتالية (10 أسماء لكل قائمة)، بلا اسم المعتذر.
          push([
            { phone: "s", from: "user", text: "اختيار البديل" },
            ...b.pickLists.map((l, i) => ({ phone: "s" as Phone, from: "sys" as const, kind: "list" as const, text: l.header, buttons: [{ label: "☰ قائمة المؤذنين", action: `list:${i}` }] })),
          ]);
        }
      } else if (action.startsWith("list:")) {
        const i = Number(action.slice(5));
        const l = b.pickLists[i];
        if (l) push([{ phone: "s", from: "sys", kind: "list", text: `المؤذنون — القائمة ${i + 1} من ${b.pickLists.length} (اختر واحدًا):`, buttons: l.names.map((n) => ({ label: n, action: `sub:${n}` })) }]);
      } else if (action.startsWith("sub:") && sub) {
        push([{ phone: "s", from: "user", text: action.slice(4) }, { phone: "s", from: "sys", kind: "text", text: b.main.alreadyAssigned }]);
      } else if (action.startsWith("sub:")) {
        const subName = action.slice(4);
        setSub(subName);
        const bb = await load({ sub: subName });
        push([
          { phone: "s", from: "user", text: subName },
          { phone: "s", from: "sys", kind: "text", text: bb.main.assigned, buttons: [{ label: "ماذا لو ضغط المشرف الآخر «اختيار البديل»؟", action: "other" }] },
          { phone: "s", from: "note", text: "في الموقع: يتغير الاسم في الجدول المعتمد تلقائيًا إلى البديل" },
          { phone: "b", from: "note", text: h.level === 0 ? `الشيخ ${subName} — يصله فورًا` : `بديل ثانٍ: الشيخ ${subName} — يصله فورًا` },
          { phone: "b", from: "sys", kind: "template", text: bb.sub.duty, buttons: [{ label: "عُلم", action: "ack" }, { label: "أعتذر", action: "apol" }, { label: "⏱ ماذا لو لم يرد نصف ساعة؟", action: "noreply" }] },
        ]);
        holderRef.current = { name: subName, orig: h.name, level: h.level + 1 };
        setOutcome("subNone");
      } else if (action === "other") {
        push([{ phone: "s", from: "note", text: "المشرف الآخر يضغط «اختيار البديل» بعد الإسناد:" }, { phone: "s", from: "sys", kind: "text", text: b.main.alreadyAssigned }]);
      } else if (action === "noreply") {
        push([
          { phone: ph, from: "note", text: h.level === 0 ? "مرّت ساعتان (الساعة 5:00 م) ولم يضغط شيئًا — تذكير واحد فقط" : "مرّت نصف ساعة ولم يضغط البديل شيئًا — تذكير واحد فقط" },
          { phone: ph, from: "sys", kind: "template", text: b.main.reminder, buttons: [{ label: "عُلم", action: "ack" }, { label: "أعتذر", action: "apol" }] },
        ]);
      } else if (action === "remind") {
        push([{ phone: ph, from: "note", text: "مرّت 30 دقيقة ولم يُكتب السبب — تذكير واحد فقط" }, { phone: ph, from: "sys", kind: "text", text: b.main.reasonReminder }]);
      }
    } finally { setBusy(false); }
  };

  const sendReason = async () => {
    const r = reason.trim();
    if (!r || !waitingReason) return;
    setBusy(true);
    try {
      const h = holderRef.current;
      const ph = phoneOf(h);
      const b = await load({ reason: r });
      push([
        { phone: ph, from: "user", text: r },
        { phone: ph, from: "sys", kind: "text", text: b.main.apologyRecorded },
        { phone: "s", from: "note", text: h.level === 0 ? `اعتذر الشيخ ${h.name} وكتب السبب` : `اعتذر البديل ${h.name} أيضًا وكتب السبب` },
        { phone: "s", from: "sys", kind: "template", text: b.main.supApology, buttons: [{ label: "اختيار البديل", action: "pick" }] },
      ]);
      setOutcome(h.level === 0 ? "apology" : "subNone");
      setWaitingReason(null); setReason("");
    } finally { setBusy(false); }
  };

  const showSummary = async () => {
    const b = await load();
    const key = outcome ?? "none";
    push([{ phone: "s", from: "note", text: "الساعة 9:00 مساءً — الملخص المسائي" }, { phone: "s", from: "sys", kind: "template", text: b.summaries[key] }]);
  };

  if (!canManage) return <div className="p-10 text-center text-muted-foreground">هذه الصفحة لمشرفي جدول المؤذنين.</div>;

  const reasonBox = (who: "main" | "sub") => waitingReason === who ? (
    <div className="flex gap-1.5">
      <input className="h-9 min-w-0 flex-1 rounded-full border-0 bg-white px-3 text-sm text-zinc-900 outline-none dark:bg-[#2a3942] dark:text-zinc-100"
        placeholder="اكتب سبب الاعتذار…" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendReason(); }} />
      <Button size="icon" className="h-9 w-9 shrink-0 rounded-full bg-[#00a884] hover:bg-[#019172]" disabled={!reason.trim() || busy} onClick={() => void sendReason()} aria-label="إرسال">
        <SendHorizontal className="h-4 w-4 rotate-180" />
      </Button>
    </div>
  ) : null;

  const sel = "h-9 rounded-md border bg-background px-2 text-sm";
  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-bold">محاكي رسائل المؤذنين</h2>
          <p className="text-sm text-muted-foreground">جرّب كل حالة واضغط الأزرار كأنك المؤذن أو المشرف — <b>لا تُرسل أي رسالة حقيقية</b>. النصوص من نفس مصدر رسائل النظام، فتتحدث تلقائيًا مع أي تعديل.</p>
        </div>
        <Link href="/muezzin-schedule"><Button variant="outline" size="sm"><ArrowRight className="ml-1 h-4 w-4" />جدول المؤذنين</Button></Link>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex overflow-hidden rounded-md border">
            {(["draft", "live"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setVersion(v)}
                className={cn("px-3 py-1.5 text-sm", version === v ? "bg-sidebar-primary text-white" : "hover:bg-muted")}>
                {v === "draft" ? "صياغة المشرف (الجديدة)" : "الصياغة السابقة"}
              </button>
            ))}
          </div>
          <select className={sel} value={name} onChange={(e) => setName(e.target.value)}>
            <option value="يزيد">يزيد (تجربة)</option>
            {muezzins.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
          <select className={sel} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <select className={sel} value={slot} onChange={(e) => setSlot(e.target.value as Slot)}>
            {SLOTS.filter((s) => role === "muezzin" || !s.key.startsWith("jumuah")).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={() => void start()} disabled={busy}><RotateCcw className="ml-1 h-4 w-4" />من البداية</Button>
          <Button size="sm" variant="outline" onClick={() => void showSummary()} disabled={busy}><Clock className="ml-1 h-4 w-4" />الملخص المسائي</Button>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><span className="rounded bg-sky-100 px-1.5 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200">قالب ميتا</span> تعديله يحتاج موافقة ميتا</span>
        <span><span className="rounded bg-emerald-100 px-1.5 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">رسالة نصية</span> تعديلها فوري</span>
        <span>التاريخ في الأمثلة: الغد</span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <div className="text-sm font-bold">① جوال المؤذن</div>
          <PhoneView title="جدول الأذان" subtitle={`عند الشيخ ${name}`} tone="bg-[#008069]" bubbles={bubbles.filter((b) => b.phone === "m")} onAction={onAction}
            footer={waitingReason === "main" ? (
              <div className="space-y-1.5">
                {reasonBox("main")}
                <button type="button" className="w-full text-[11px] text-zinc-500 underline" onClick={() => void onAction({ id: -1 } as Bubble, "remind")}>ماذا لو لم يكتب السبب 30 دقيقة؟</button>
              </div>
            ) : undefined} />
        </div>
        <div className="space-y-1">
          <div className="text-sm font-bold">② جوال المشرف</div>
          <PhoneView title="جدول الأذان" subtitle="عند المشرف (محمد العمري / حسين شحات)" tone="bg-[#1f6f8b]" bubbles={bubbles.filter((b) => b.phone === "s")} onAction={onAction} />
        </div>
        <div className="space-y-1">
          <div className="text-sm font-bold">③ جوال البديل (الطارئ)</div>
          <PhoneView title="جدول الأذان" subtitle={sub ? `عند الشيخ ${sub}` : "يظهر بعد اختيار المشرف للبديل"} tone="bg-[#b4442f]" bubbles={bubbles.filter((b) => b.phone === "b")} onAction={onAction}
            footer={waitingReason === "sub" ? (
              <div className="space-y-1.5">
                {reasonBox("sub")}
                <button type="button" className="w-full text-[11px] text-zinc-500 underline" onClick={() => void onAction({ id: -1 } as Bubble, "remind")}>ماذا لو لم يكتب السبب 30 دقيقة؟</button>
              </div>
            ) : undefined} />
        </div>
      </div>
    </div>
  );
}
