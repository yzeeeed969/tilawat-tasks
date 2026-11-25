import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useIsAdmin } from "@/lib/roles";

// «المكتب» (الإصدار 89): الأعضاء كموظفين جالسين على طاولات في مكتب مفتوح، مرسوم من الأعلى.
// للمدير فقط. الضغط على طاولة يفتح لوحة الموظف: مهامه الحالية وما أنجزه في الفترة (أسبوع افتراضيًا، أو شهر).

type Item = { id: number; title: string; due: string | null; doneAt: string | null; platform: string | null; reciter: string | null; proof: string | null; shared: boolean };
type Member = {
  id: number; name: string; role: string; avatarUrl: string | null; lastLoginAt: string | null;
  doneCount: number; doneToday: number; openCount: number; overdueCount: number; light: "green" | "yellow" | "grey";
  open: Item[]; done: Item[]; gender: "m" | "f" | null;
};

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

type Office = { period: { kind: "week" | "month"; start: string; end: string; today: string }; members: Member[]; manager: Manager | null };

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

type Manager = {
  id: number; name: string; avatarUrl: string | null;
  overdue: Array<{ id: number; name: string; count: number }>;
  idle: Array<{ id: number; name: string; days: number | null }>;
  stars: Array<{ id: number; name: string; count: number }>;
  compare: { current: number; previous: number; days: number };
};

// غرفة المدير: جدران زجاجية، طاولة تنفيذية، شاشة حال الفريق، طاولة اجتماعات ومكتبة.
function ManagerRoom({ x, y, w, h, mgr, stats, onPick }: { x: number; y: number; w: number; h: number; mgr: Manager; stats: { done: number; active: number; total: number; overdue: number }; onPick: () => void }) {
  const cx = x + w / 2;
  const deskY = y + 120;
  return (
    <g>
      {/* أرضية سجاد فاخر وجدار زجاجي */}
      <rect x={x} y={y} width={w} height={h} rx={10} fill="#1e3a5f" />
      <rect x={x + 8} y={y + 8} width={w - 16} height={h - 16} rx={6} fill="#27466e" />
      <rect x={x} y={y} width={w} height={h} rx={10} fill="none" stroke="#7dd3fc" strokeWidth={5} opacity={0.85} />
      {/* باب زجاجي */}
      <rect x={cx - 45} y={y + h - 4} width={90} height={8} fill="#bae6fd" />
      {/* الشاشة على الجدار */}
      <g>
        <rect x={cx - 150} y={y + 18} width={300} height={62} rx={6} fill="#0b1220" stroke="#334155" strokeWidth={3} />
        <text x={cx + 120} y={y + 42} textAnchor="end" fontSize={13} fill="#93c5fd" direction="rtl">حال الفريق اليوم</text>
        <text x={cx + 120} y={y + 66} textAnchor="end" fontSize={14} fontWeight={700} fill="#fff" direction="rtl">
          {`عملوا: ${stats.active} من ${stats.total}   ·   أُنجز: ${stats.done}   ·   متأخرة: ${stats.overdue}`}
        </text>
      </g>
      {/* مكتبة على اليمين */}
      <g>
        <rect x={x + w - 70} y={y + 100} width={44} height={150} rx={4} fill="#5b3a1e" />
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <rect x={x + w - 66} y={y + 106 + i * 36} width={36} height={4} fill="#3f2713" />
            {[0, 1, 2, 3, 4].map((j) => <rect key={j} x={x + w - 64 + j * 7} y={y + 110 + i * 36} width={5} height={26} fill={["#b91c1c", "#1d4ed8", "#047857", "#a16207", "#6d28d9"][(i + j) % 5]} />)}
          </g>
        ))}
      </g>
      {/* طاولة الاجتماعات على اليسار */}
      <g>
        <ellipse cx={x + 120} cy={y + h / 2 + 20} rx={70} ry={42} fill="#7c4a24" stroke="#4a2c14" strokeWidth={2} />
        {[[-80, 0], [80, 0], [0, -56], [0, 56], [-50, -44], [50, 44]].map(([dx, dy], i) => (
          <circle key={i} cx={x + 120 + dx} cy={y + h / 2 + 20 + dy} r={13} fill="#111827" />
        ))}
      </g>
      <Plant x={x + w - 45} y={y + h - 45} r={24} />
      <Plant x={x + 40} y={y + 40} r={20} />
      {/* الطاولة التنفيذية والكرسي */}
      <g onClick={onPick} style={{ cursor: "pointer" }} role="button" aria-label="مكتب المدير">
        <ellipse cx={cx} cy={deskY - 34} rx={42} ry={36} fill="#111827" />
        <ellipse cx={cx} cy={deskY - 38} rx={32} ry={22} fill="#0f172a" />
        <clipPath id="mgr-av"><circle cx={cx} cy={deskY - 36} r={22} /></clipPath>
        <circle cx={cx} cy={deskY - 36} r={25} fill="#fde7c7" stroke="#fbbf24" strokeWidth={3} />
        {mgr.avatarUrl
          ? <image href={mgr.avatarUrl} x={cx - 22} y={deskY - 58} width={44} height={44} clipPath="url(#mgr-av)" preserveAspectRatio="xMidYMid slice" />
          : <text x={cx} y={deskY - 30} textAnchor="middle" fontSize={16} fontWeight={800} fill="#7c2d12">{initials(mgr.name)}</text>}
        <path d={`M ${cx - 150} ${deskY} h 300 a 14 14 0 0 1 14 14 v 46 a 14 14 0 0 1 -14 14 h -300 a 14 14 0 0 1 -14 -14 v -46 a 14 14 0 0 1 14 -14 z`} fill="#4a2c14" stroke="#2b1909" strokeWidth={2} />
        <rect x={cx - 140} y={deskY + 6} width={280} height={60} rx={8} fill="#5f3a1c" />
        <rect x={cx - 50} y={deskY + 10} width={100} height={12} rx={3} fill="#111827" />
        <rect x={cx - 120} y={deskY + 14} width={40} height={30} rx={2} fill="#fff" stroke="#cbd5e1" />
        <circle cx={cx + 110} cy={deskY + 30} r={8} fill="#fff" stroke="#78716c" />
        {/* لوحة الاسم */}
        <rect x={cx - 70} y={deskY + 42} width={140} height={22} rx={4} fill="#d4af37" stroke="#a07f1a" />
        <text x={cx} y={deskY + 58} textAnchor="middle" fontSize={13} fontWeight={800} fill="#1f2937" direction="rtl">{mgr.name} — المدير</text>
      </g>
    </g>
  );
}

function Hall({ x, y, cols, members, starId, selectedId, onPick, offset }: { x: number; y: number; cols: number; members: Member[]; starId: number | null; selectedId: number | null; onPick: (m: Member) => void; offset: number }) {
  const pods = Math.max(1, Math.ceil(members.length / 4));
  return (
    <g>
      {Array.from({ length: pods }).map((_, pi) => {
        const col = pi % cols, row = Math.floor(pi / cols);
        const px = x + (cols - 1 - col) * (POD_W + AISLE_X); // من اليمين لليسار
        const py = y + row * (POD_H + AISLE_Y);
        const seats = members.slice(pi * 4, pi * 4 + 4);
        const deskTop = py + SEAT;
        return (
          <g key={pi}>
            <rect x={px - 22} y={py - 22} width={POD_W + 44} height={POD_H + 44} rx={22} fill="#e0f2fe" opacity={0.55} />
            {seats.map((m, si) => {
              const right = si % 2 === 0;
              const dx = right ? px + DESK_W + GAP : px;
              const dy = si < 2 ? deskTop : deskTop + DESK_H + 6;
              return <Desk key={m.id} m={m} index={offset + pi * 4 + si} x={dx} y={dy} facing={si < 2 ? "down" : "up"} star={m.id === starId} selected={m.id === selectedId} onPick={() => onPick(m)} />;
            })}
          </g>
        );
      })}
    </g>
  );
}

function OfficeFloor({ members, manager, stats, starId, selectedId, onPick, onPickManager }: {
  members: Member[]; manager: Manager | null; stats: { done: number; active: number; total: number; overdue: number };
  starId: number | null; selectedId: number | null; onPick: (m: Member) => void; onPickManager: () => void;
}) {
  // قسمان منفصلان بجدار (بلا أسماء على المداخل): النساء يمينًا، والرجال يسارًا. مساحة كل قسم بحجم عدده.
  const women = members.filter((m) => m.gender !== "m");
  const men = members.filter((m) => m.gender === "m");
  const podsW = Math.ceil(women.length / 4), podsM = Math.ceil(men.length / 4);
  const TOTAL_COLS = 3;
  let colsM = podsM ? Math.max(1, Math.round((TOTAL_COLS * podsM) / (podsW + podsM))) : 0;
  if (podsW && colsM >= TOTAL_COLS) colsM = TOTAL_COLS - 1;
  const colsW = podsW ? TOTAL_COLS - colsM : 0;
  const rowsW = colsW ? Math.ceil(podsW / colsW) : 0, rowsM = colsM ? Math.ceil(podsM / colsM) : 0;
  const hallRows = Math.max(rowsW, rowsM, 1);
  const PART = 26; // سماكة الجدار الفاصل
  const hallW = (c: number) => AISLE_X + c * (POD_W + AISLE_X);
  const W = WALL * 2 + hallW(colsW) + (colsM ? PART + hallW(colsM) : 0);
  const MGR_H = 300;
  const hallTop = WALL + MGR_H + 70;
  const H = hallTop + hallRows * (POD_H + AISLE_Y) + 40;
  const partX = W - WALL - hallW(colsW) - PART;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[880px] select-none" style={{ fontFamily: "inherit" }}>
      <defs>
        <pattern id="planks" width="120" height="28" patternUnits="userSpaceOnUse">
          <rect width="120" height="28" fill="#f1e4cf" />
          <line x1="0" y1="27.5" x2="120" y2="27.5" stroke="#e2cfb0" strokeWidth="1" />
          <line x1="70" y1="0" x2="70" y2="28" stroke="#e7d6bb" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x={0} y={0} width={W} height={H} rx={14} fill="#6b7280" />
      <rect x={WALL} y={WALL} width={W - WALL * 2} height={H - WALL * 2} rx={6} fill="url(#planks)" />
      {Array.from({ length: 6 }).map((_, i) => (
        <rect key={i} x={WALL + 60 + i * ((W - WALL * 2 - 120) / 6)} y={4} width={(W - WALL * 2 - 120) / 6 - 30} height={10} rx={3} fill="#bae6fd" stroke="#7dd3fc" />
      ))}
      {/* مكتب المدير في الأعلى يطل على القسمين */}
      {manager && <ManagerRoom x={W / 2 - 380} y={WALL + 20} w={760} h={MGR_H} mgr={manager} stats={stats} onPick={onPickManager} />}
      <Plant x={WALL + 40} y={WALL + 40} />
      <Plant x={W - WALL - 40} y={WALL + 40} />
      {/* الجدار الفاصل بين القسمين، بفتحة باب عند الممر */}
      {colsM > 0 && colsW > 0 && (
        <g>
          <rect x={partX} y={hallTop - 30} width={PART} height={H - WALL - (hallTop - 30)} fill="#9ca3af" />
          <rect x={partX + 4} y={hallTop - 30} width={PART - 8} height={H - WALL - (hallTop - 30)} fill="#d1d5db" />
        </g>
      )}
      {/* الممر بين مكتب المدير والقسمين */}
      <rect x={WALL} y={hallTop - 34} width={W - WALL * 2} height={6} fill="#a8a29e" opacity={0.5} />
      {colsW > 0 && (
        <Hall x={W - WALL - hallW(colsW) + AISLE_X} y={hallTop + 20} cols={colsW} members={women} starId={starId} selectedId={selectedId} onPick={onPick} offset={0} />
      )}
      {colsM > 0 && (
        <Hall x={WALL + AISLE_X} y={hallTop + 20} cols={colsM} members={men} starId={starId} selectedId={selectedId} onPick={onPick} offset={women.length} />
      )}
      <Plant x={WALL + 40} y={H - WALL - 40} />
      <Plant x={W - WALL - 40} y={H - WALL - 40} />
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
  const [mgrOpen, setMgrOpen] = useState(false);
  const floorRef = useRef<HTMLDivElement>(null);
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
  // على الشاشات الضيقة: يبدأ العرض من المنتصف ليظهر مكتب المدير كاملًا.
  const hasData = !!data;
  useEffect(() => {
    const el = floorRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const mid = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollLeft = getComputedStyle(el).direction === "rtl" ? -mid : mid;
  }, [hasData]);
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
        <div ref={floorRef} className="overflow-x-auto rounded-2xl border bg-card p-2">
          <OfficeFloor members={members} manager={data.manager} stats={{ done: totals.done, active: totals.activeToday, total: members.length, overdue: totals.overdue }}
            starId={star} selectedId={current?.id ?? null} onPick={(m) => { setPicked(m); setTab("open"); }} onPickManager={() => setMgrOpen(true)} />
        </div>
      )}


      <Sheet open={mgrOpen} onOpenChange={setMgrOpen}>
        <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto" dir="rtl">
          {data?.manager && (() => {
            const g = data.manager;
            const diff = g.compare.current - g.compare.previous;
            const pick = (id: number) => { const m = members.find((x) => x.id === id); if (m) { setMgrOpen(false); setPicked(m); setTab("open"); } };
            return (
              <>
                <SheetHeader className="text-right">
                  <SheetTitle className="text-right">مكتب المدير</SheetTitle>
                  <SheetDescription className="text-right">{g.name} · {period === "week" ? "هذا الأسبوع" : "هذا الشهر"}</SheetDescription>
                </SheetHeader>
                <section className="mt-5 rounded-xl border p-4">
                  <h3 className="font-bold mb-2">📈 مقارنة بالفترة السابقة</h3>
                  <p className="text-sm leading-7">
                    أُنجز <b>{g.compare.current}</b> مهمة، مقابل <b>{g.compare.previous}</b> في نفس الأيام ({g.compare.days}) من {period === "week" ? "الأسبوع الماضي" : "الشهر الماضي"}.
                    {" "}<span className={diff >= 0 ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>{diff >= 0 ? `زيادة ${diff}` : `نقص ${-diff}`}</span>
                  </p>
                </section>
                <section className="mt-4 rounded-xl border p-4">
                  <h3 className="font-bold mb-2">⭐ نجوم {period === "week" ? "الأسبوع" : "الشهر"}</h3>
                  {g.stars.length === 0 ? <p className="text-sm text-muted-foreground">لا إنجاز بعد.</p> : (
                    <ol className="space-y-1 text-sm">{g.stars.map((s, i) => (
                      <li key={s.id}><button className="hover:underline" onClick={() => pick(s.id)}>{["🥇", "🥈", "🥉"][i]} {s.name} — {s.count} مهمة</button></li>
                    ))}</ol>
                  )}
                </section>
                <section className="mt-4 rounded-xl border border-amber-300 p-4">
                  <h3 className="font-bold mb-2">⚠️ عندهم مهام متأخرة</h3>
                  {g.overdue.length === 0 ? <p className="text-sm text-muted-foreground">لا أحد. ممتاز.</p> : (
                    <ul className="space-y-1 text-sm">{g.overdue.map((o) => (
                      <li key={o.id}><button className="hover:underline" onClick={() => pick(o.id)}>{o.name} — {o.count} متأخرة</button></li>
                    ))}</ul>
                  )}
                </section>
                <section className="mt-4 rounded-xl border p-4">
                  <h3 className="font-bold mb-2">💤 لم يُنجزوا شيئًا منذ 3 أيام أو أكثر</h3>
                  {g.idle.length === 0 ? <p className="text-sm text-muted-foreground">الكل يعمل.</p> : (
                    <ul className="space-y-1 text-sm">{g.idle.map((o) => (
                      <li key={o.id}><button className="hover:underline" onClick={() => pick(o.id)}>{o.name} — {o.days === null ? "لا إنجاز منذ أكثر من شهرين" : `منذ ${o.days} أيام`}</button></li>
                    ))}</ul>
                  )}
                </section>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
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
