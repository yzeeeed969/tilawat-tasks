import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useIsAdmin } from "@/lib/roles";

// «المكتب» (الإصدار 89): الأعضاء كموظفين جالسين على طاولات في مكتب مفتوح، مرسوم من الأعلى.
// للمدير فقط. الضغط على طاولة يفتح لوحة الموظف: مهامه الحالية وما أنجزه في الفترة (أسبوع افتراضيًا، أو شهر).

type Item = { id: number; title: string; due: string | null; doneAt: string | null; platform: string | null; reciter: string | null; proof: string | null; shared: boolean };
type Member = {
  id: number; name: string; role: string; avatarUrl: string | null; lastLoginAt: string | null;
  doneCount: number; doneToday: number; openCount: number; overdueCount: number; light: "green" | "yellow" | "grey";
  open: Item[]; done: Item[];
};
type Office = { period: { kind: "week" | "month"; start: string; end: string; today: string }; members: Member[] };

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? "تعذّر جلب البيانات");
  return body as T;
}

const LIGHT = { green: "#22c55e", yellow: "#f59e0b", grey: "#9ca3af" } as const;
const LIGHT_LABEL = { green: "أنجز اليوم", yellow: "عنده مهام متأخرة", grey: "لم ينجز اليوم" } as const;
const SHIRTS = ["#2563eb", "#0d9488", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#4f46e5", "#65a30d"];
const dayLabel = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("ar-SA-u-nu-latn-ca-gregory", { weekday: "long", day: "numeric", month: "long" });
const when = (v: string) => new Date(v.replace(" ", "T") + (v.includes("Z") ? "" : "Z")).toLocaleString("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join(" ");

// ── أبعاد الرسم ─────────────────────────────────────────────────────────────
const DESK_W = 170, DESK_H = 78, SEAT = 62, GAP = 10;
const POD_W = DESK_W * 2 + GAP, POD_H = SEAT + DESK_H * 2 + 6 + SEAT;
const PODS_PER_ROW = 3, AISLE_X = 90, AISLE_Y = 70, WALL = 18, TOP = 120;

function Plant({ x, y, r = 22 }: { x: number; y: number; r?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r + 6} fill="#a16207" opacity={0.25} />
      <circle cx={x} cy={y} r={r} fill="#15803d" />
      <circle cx={x - r * 0.35} cy={y - r * 0.3} r={r * 0.55} fill="#22c55e" />
      <circle cx={x + r * 0.4} cy={y + r * 0.2} r={r * 0.45} fill="#16a34a" />
    </g>
  );
}

// طاولة واحدة: الموظف جالس من جهة (أعلى أو أسفل) والشاشة أمامه.
function Desk({ m, x, y, facing, star, selected, onPick, index }: {
  m: Member; x: number; y: number; facing: "down" | "up"; star: boolean; selected: boolean; onPick: () => void; index: number;
}) {
  // facing=down: الموظف فوق الطاولة وينظر للأسفل.
  const personY = facing === "down" ? y - SEAT / 2 + 4 : y + DESK_H + SEAT / 2 - 4;
  const monitorY = facing === "down" ? y + 8 : y + DESK_H - 8 - 10;
  const clip = `av-${m.id}`;
  const shirt = SHIRTS[index % SHIRTS.length];
  const nameY = facing === "down" ? personY - 34 : personY + 44;
  return (
    <g onClick={onPick} style={{ cursor: "pointer" }} role="button" aria-label={m.name}>
      {/* الطاولة */}
      <rect x={x} y={y} width={DESK_W} height={DESK_H} rx={8} fill={selected ? "#fde68a" : "#d6a46c"} stroke={selected ? "#d97706" : "#a16207"} strokeWidth={selected ? 3 : 1.5} />
      <rect x={x + 4} y={y + 4} width={DESK_W - 8} height={DESK_H - 8} rx={6} fill="none" stroke="#e7c193" strokeWidth={1} />
      {/* الشاشة ولوحة المفاتيح */}
      <rect x={x + DESK_W / 2 - 34} y={monitorY} width={68} height={10} rx={3} fill="#1f2937" />
      <rect x={x + DESK_W / 2 - 22} y={facing === "down" ? monitorY + 16 : monitorY - 12} width={44} height={7} rx={2} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.6} />
      {/* كوب */}
      <circle cx={x + DESK_W - 18} cy={y + DESK_H / 2} r={6} fill="#fff" stroke="#78716c" strokeWidth={1.2} />
      {/* المهام الحالية: كومة أوراق */}
      <g>
        <rect x={x + 10} y={y + DESK_H / 2 - 12} width={30} height={24} rx={2} fill="#fff" stroke="#cbd5e1" transform={`rotate(-6 ${x + 25} ${y + DESK_H / 2})`} />
        <rect x={x + 12} y={y + DESK_H / 2 - 11} width={30} height={24} rx={2} fill="#fff" stroke="#94a3b8" />
        <text x={x + 27} y={y + DESK_H / 2 + 5} textAnchor="middle" fontSize={13} fontWeight={700} fill={m.overdueCount ? "#b45309" : "#334155"}>{m.openCount}</text>
      </g>
      {/* المنجز */}
      <g>
        <rect x={x + 48} y={y + DESK_H / 2 - 11} width={36} height={22} rx={11} fill="#dcfce7" stroke="#22c55e" />
        <text x={x + 66} y={y + DESK_H / 2 + 5} textAnchor="middle" fontSize={12} fontWeight={700} fill="#15803d">✓{m.doneCount}</text>
      </g>
      {/* الكرسي والموظف */}
      <ellipse cx={x + DESK_W / 2} cy={personY} rx={30} ry={26} fill="#374151" />
      <ellipse cx={x + DESK_W / 2} cy={personY + (facing === "down" ? -4 : 4)} rx={24} ry={16} fill={shirt} />
      <clipPath id={clip}><circle cx={x + DESK_W / 2} cy={personY} r={17} /></clipPath>
      <circle cx={x + DESK_W / 2} cy={personY} r={19} fill="#fde7c7" stroke="#fff" strokeWidth={2} />
      {m.avatarUrl
        ? <image href={m.avatarUrl} x={x + DESK_W / 2 - 17} y={personY - 17} width={34} height={34} clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" />
        : <text x={x + DESK_W / 2} y={personY + 5} textAnchor="middle" fontSize={13} fontWeight={700} fill="#7c2d12">{initials(m.name)}</text>}
      {/* ضوء الحالة */}
      <circle cx={x + DESK_W / 2 + 16} cy={personY - 15} r={7} fill={LIGHT[m.light]} stroke="#fff" strokeWidth={2} />
      {star && <text x={x + DESK_W / 2 - 22} y={personY - 12} fontSize={16}>⭐</text>}
      {/* الاسم */}
      <rect x={x + DESK_W / 2 - 62} y={nameY - 13} width={124} height={19} rx={9.5} fill="#ffffffd9" />
      <text x={x + DESK_W / 2} y={nameY + 1} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#111827" direction="rtl">
        {m.name.length > 18 ? m.name.slice(0, 17) + "…" : m.name}
      </text>
    </g>
  );
}

function OfficeFloor({ members, starId, selectedId, onPick }: { members: Member[]; starId: number | null; selectedId: number | null; onPick: (m: Member) => void }) {
  const pods = Math.max(1, Math.ceil(members.length / 4));
  const rows = Math.ceil(pods / PODS_PER_ROW);
  const W = WALL * 2 + AISLE_X + PODS_PER_ROW * (POD_W + AISLE_X);
  const H = TOP + rows * (POD_H + AISLE_Y) + 60;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[880px] select-none" style={{ fontFamily: "inherit" }}>
      <defs>
        <pattern id="planks" width="120" height="28" patternUnits="userSpaceOnUse">
          <rect width="120" height="28" fill="#f1e4cf" />
          <line x1="0" y1="27.5" x2="120" y2="27.5" stroke="#e2cfb0" strokeWidth="1" />
          <line x1="70" y1="0" x2="70" y2="28" stroke="#e7d6bb" strokeWidth="1" />
        </pattern>
      </defs>
      {/* الجدران والأرضية */}
      <rect x={0} y={0} width={W} height={H} rx={14} fill="#6b7280" />
      <rect x={WALL} y={WALL} width={W - WALL * 2} height={H - WALL * 2} rx={6} fill="url(#planks)" />
      {/* نوافذ في الجدار العلوي */}
      {Array.from({ length: 6 }).map((_, i) => (
        <rect key={i} x={WALL + 60 + i * ((W - WALL * 2 - 120) / 6)} y={4} width={(W - WALL * 2 - 120) / 6 - 30} height={10} rx={3} fill="#bae6fd" stroke="#7dd3fc" />
      ))}
      {/* الباب */}
      <rect x={W / 2 - 50} y={H - WALL - 2} width={100} height={WALL + 2} fill="#f1e4cf" />
      <path d={`M ${W / 2 - 50} ${H - WALL} A 50 50 0 0 1 ${W / 2} ${H - WALL - 50}`} fill="none" stroke="#9ca3af" strokeDasharray="4 4" />
      {/* لوحة المكتب */}
      <rect x={W / 2 - 150} y={WALL + 22} width={300} height={44} rx={10} fill="#0f766e" />
      <text x={W / 2} y={WALL + 51} textAnchor="middle" fontSize={20} fontWeight={800} fill="#fff">مكتب تلاوات الحرمين</text>
      {/* نباتات في الزوايا */}
      <Plant x={WALL + 40} y={WALL + 40} />
      <Plant x={W - WALL - 40} y={WALL + 40} />
      <Plant x={WALL + 40} y={H - WALL - 40} />
      <Plant x={W - WALL - 40} y={H - WALL - 40} />
      {/* المجموعات: كل مجموعة 4 طاولات متقابلة على سجادة */}
      {Array.from({ length: pods }).map((_, pi) => {
        const col = pi % PODS_PER_ROW, row = Math.floor(pi / PODS_PER_ROW);
        // ترتيب من اليمين لليسار (عربي)
        const px = W - WALL - AISLE_X - POD_W - col * (POD_W + AISLE_X);
        const py = TOP + row * (POD_H + AISLE_Y);
        const seats = members.slice(pi * 4, pi * 4 + 4);
        const deskTop = py + SEAT;
        return (
          <g key={pi}>
            <rect x={px - 22} y={py - 22} width={POD_W + 44} height={POD_H + 44} rx={22} fill="#e0f2fe" opacity={0.55} />
            {seats.map((m, si) => {
              const right = si % 2 === 0; // المقعد الأول في اليمين
              const dx = right ? px + DESK_W + GAP : px;
              const dy = si < 2 ? deskTop : deskTop + DESK_H + 6;
              return (
                <Desk key={m.id} m={m} index={members.indexOf(m)} x={dx} y={dy} facing={si < 2 ? "down" : "up"}
                  star={m.id === starId} selected={m.id === selectedId} onPick={() => onPick(m)} />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function TaskRow({ t, today, done }: { t: Item; today: string; done: boolean }) {
  const late = !done && t.due && t.due < today;
  return (
    <li className={`rounded-lg border p-3 ${late ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30" : "border-border"}`}>
      <div className="font-medium leading-snug">{t.title}</div>
      <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
        {t.platform && <span>{t.platform}</span>}
        {t.reciter && <span>{t.reciter}</span>}
        {done && t.doneAt && <span>أُنجزت: {when(t.doneAt)}</span>}
        {!done && t.due && <span className={late ? "text-amber-700 font-semibold" : ""}>{late ? "متأخرة — " : "موعدها: "}{dayLabel(t.due)}</span>}
        {t.shared && <span className="rounded bg-muted px-1.5">مشتركة</span>}
      </div>
      {t.proof && (
        <a href={t.proof} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-primary underline underline-offset-2">فتح العمل ↗</a>
      )}
    </li>
  );
}

export default function OfficePage() {
  const isAdmin = useIsAdmin();
  const [period, setPeriod] = useState<"week" | "month">("week");
  const [picked, setPicked] = useState<Member | null>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const { data, isLoading, error } = useQuery({ queryKey: ["office", period], queryFn: () => api<Office>(`/api/office?period=${period}`), enabled: isAdmin, refetchInterval: 5 * 60_000 });

  const members = data?.members ?? [];
  const star = useMemo(() => {
    const best = [...members].sort((a, b) => b.doneCount - a.doneCount)[0];
    return best && best.doneCount > 0 ? best.id : null;
  }, [members]);
  const totals = useMemo(() => ({
    done: members.reduce((s, m) => s + m.doneCount, 0),
    overdue: members.reduce((s, m) => s + m.overdueCount, 0),
    activeToday: members.filter((m) => m.doneToday > 0).length,
  }), [members]);
  const current = picked ? members.find((m) => m.id === picked.id) ?? picked : null;

  if (!isAdmin) return <div className="p-6 text-muted-foreground">هذه الصفحة للمدير فقط.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">المكتب</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${period === "week" ? "هذا الأسبوع" : "هذا الشهر"}: من ${dayLabel(data.period.start)}` : "…"}
          </p>
        </div>
        <div className="inline-flex rounded-lg border bg-muted p-1">
          {(["week", "month"] as const).map((k) => (
            <button key={k} onClick={() => setPeriod(k)}
              className={`px-4 py-1.5 text-sm rounded-md transition ${period === k ? "bg-background shadow font-semibold" : "text-muted-foreground"}`}>
              {k === "week" ? "الأسبوع" : "الشهر"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-xl">
        <div className="rounded-xl border p-3"><div className="text-xs text-muted-foreground">أُنجز {period === "week" ? "هذا الأسبوع" : "هذا الشهر"}</div><div className="text-2xl font-bold text-green-600">{totals.done}</div></div>
        <div className="rounded-xl border p-3"><div className="text-xs text-muted-foreground">عملوا اليوم</div><div className="text-2xl font-bold">{totals.activeToday} <span className="text-sm font-normal text-muted-foreground">من {members.length}</span></div></div>
        <div className="rounded-xl border p-3"><div className="text-xs text-muted-foreground">مهام متأخرة</div><div className="text-2xl font-bold text-amber-600">{totals.overdue}</div></div>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {(Object.keys(LIGHT) as Array<keyof typeof LIGHT>).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-full" style={{ background: LIGHT[k] }} />{LIGHT_LABEL[k]}</span>
        ))}
        <span>📄 الرقم على الأوراق = المهام الحالية</span>
        <span>✓ = ما أنجزه في الفترة</span>
        <span>⭐ = الأكثر إنجازًا</span>
      </div>

      {isLoading && <div className="text-muted-foreground">جارٍ تجهيز المكتب…</div>}
      {error && <div className="text-red-600">{(error as Error).message}</div>}
      {data && (
        <div className="overflow-x-auto rounded-2xl border bg-card p-2">
          <OfficeFloor members={members} starId={star} selectedId={current?.id ?? null} onPick={(m) => { setPicked(m); setTab("open"); }} />
        </div>
      )}

      <Sheet open={!!current} onOpenChange={(o) => !o && setPicked(null)}>
        <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto" dir="rtl">
          {current && data && (
            <>
              <SheetHeader className="text-right">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    {current.avatarUrl
                      ? <img src={current.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
                      : <div className="h-14 w-14 rounded-full bg-orange-100 text-orange-900 flex items-center justify-center font-bold">{initials(current.name)}</div>}
                    <span className="absolute -top-0.5 -left-0.5 h-4 w-4 rounded-full border-2 border-background" style={{ background: LIGHT[current.light] }} />
                  </div>
                  <div>
                    <SheetTitle className="text-right">{current.name}{current.id === star ? " ⭐" : ""}</SheetTitle>
                    <SheetDescription className="text-right">
                      {LIGHT_LABEL[current.light]}{current.lastLoginAt ? ` · آخر دخول: ${when(current.lastLoginAt)}` : ""}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>
              <div className="grid grid-cols-3 gap-2 my-4 text-center">
                <div className="rounded-lg border p-2"><div className="text-xl font-bold text-green-600">{current.doneCount}</div><div className="text-xs text-muted-foreground">أنجز</div></div>
                <div className="rounded-lg border p-2"><div className="text-xl font-bold">{current.openCount}</div><div className="text-xs text-muted-foreground">حالية</div></div>
                <div className="rounded-lg border p-2"><div className="text-xl font-bold text-amber-600">{current.overdueCount}</div><div className="text-xs text-muted-foreground">متأخرة</div></div>
              </div>
              <div className="inline-flex rounded-lg border bg-muted p-1 mb-3">
                <button onClick={() => setTab("open")} className={`px-3 py-1 text-sm rounded-md ${tab === "open" ? "bg-background shadow font-semibold" : "text-muted-foreground"}`}>المهام الحالية</button>
                <button onClick={() => setTab("done")} className={`px-3 py-1 text-sm rounded-md ${tab === "done" ? "bg-background shadow font-semibold" : "text-muted-foreground"}`}>ما أنجزه</button>
              </div>
              <ul className="space-y-2">
                {(tab === "open" ? current.open : current.done).map((t) => <TaskRow key={t.id} t={t} today={data.period.today} done={tab === "done"} />)}
                {(tab === "open" ? current.open : current.done).length === 0 && (
                  <li className="text-sm text-muted-foreground">{tab === "open" ? "لا مهام حالية." : "لم ينجز شيئًا في هذه الفترة بعد."}</li>
                )}
              </ul>
              {(tab === "open" ? current.openCount : current.doneCount) > 25 && <p className="mt-2 text-xs text-muted-foreground">تظهر أول 25 مهمة فقط.</p>}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
