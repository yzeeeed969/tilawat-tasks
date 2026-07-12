import { format } from "date-fns";
import { ar } from "date-fns/locale";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

// لوحة ألوان احترافية متناسقة مع هوية الصفحة (أخضر عميق/ذهبي/تركوازي/زيتي...).
const CHART_COLORS = [
  "#0f5b3d",
  "#c59226",
  "#2b6f7d",
  "#7a8450",
  "#b8874a",
  "#3a6ea5",
  "#5c5470",
  "#8a9b8e",
];

type PlatformRow = {
  platformId: number;
  name: string;
  publications: number;
};

type MonthRow = {
  monthStart: string;
  publications: number;
  completedTasks: number;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("ar-SA").format(Math.round(value));
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-[#eadfcd] bg-[#fbf8ef] py-10 text-center text-sm font-bold text-[#6f8378]">
      {text}
    </p>
  );
}

function DonutTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number }>;
  total?: number;
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  const value = Number(item?.value ?? 0);
  const pct = total && total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-md border border-[#eadfcd] bg-white/95 px-3 py-2 text-xs shadow-md" dir="rtl">
      <div className="font-black text-[#103c2d]">{item?.name}</div>
      <div className="mt-0.5 text-[#5f796d]">{formatNumber(value)} منشور · {pct}%</div>
    </div>
  );
}

function GrowthTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { label?: string; publications?: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-md border border-[#eadfcd] bg-white/95 px-3 py-2 text-xs shadow-md" dir="rtl">
      <div className="font-black text-[#103c2d]">{row?.label}</div>
      <div className="mt-0.5 text-[#5f796d]">{formatNumber(Number(row?.publications ?? 0))} منشور</div>
    </div>
  );
}

export function PlatformDistributionDonutChart({ rows }: { rows: PlatformRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.publications, 0);
  if (rows.length === 0 || total <= 0) {
    return <EmptyState text="لا توجد بيانات منصات للعرض." />;
  }

  const data = rows.map((row, index) => ({
    ...row,
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr] md:items-center">
      <div className="relative mx-auto h-52 w-52 md:h-56 md:w-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="publications"
              nameKey="name"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="#fffdf8"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((entry) => (
                <Cell key={entry.platformId} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[10px] font-bold text-[#6f8378]">الإجمالي</span>
          <span className="text-xl font-black text-[#103c2d]">{formatNumber(total)}</span>
          <span className="text-[10px] font-bold text-[#6f8378]">منشور</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {data.map((entry) => (
          <div key={entry.platformId} className="flex min-w-0 items-center gap-2 rounded-md border border-[#efe6d8] bg-[#fffdf8] px-2 py-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="truncate text-xs font-black text-[#103c2d]">{entry.name}</span>
            <span className="ms-auto shrink-0 text-xs font-black text-[#5f796d]">{formatNumber(entry.publications)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthlyGrowthAreaChart({ rows }: { rows: MonthRow[] }) {
  if (rows.length === 0) {
    return <EmptyState text="لا توجد بيانات نمو لهذه الفترة." />;
  }

  const data = rows.map((row) => ({
    ...row,
    label: format(new Date(row.monthStart), "MMM yyyy", { locale: ar }),
  }));

  return (
    <div className="h-[260px] w-full overflow-hidden rounded-lg border border-[#efe6d8] bg-[#fffdf8] p-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 16, right: 14, left: 2, bottom: 4 }}>
          <defs>
            <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0f5b3d" stopOpacity={0.28} />
              <stop offset="100%" stopColor="#0f5b3d" stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="4 8" stroke="#eadfcd" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 12, fill: "#6f8378", fontWeight: 700 }}
            tickLine={false}
            axisLine={{ stroke: "#eadfcd" }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            allowDecimals={false}
            width={42}
            tick={{ fontSize: 12, fill: "#6f8378", fontWeight: 700 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => formatNumber(Number(value))}
          />
          <Tooltip content={<GrowthTooltip />} cursor={{ stroke: "#c59226", strokeWidth: 1, strokeDasharray: "4 4" }} />
          <Area
            type="monotone"
            dataKey="publications"
            stroke="#0f5b3d"
            strokeWidth={3}
            fill="url(#growthFill)"
            dot={{ r: 4, fill: "#c59226", stroke: "#fffaf0", strokeWidth: 2 }}
            activeDot={{ r: 6, fill: "#c59226", stroke: "#fffaf0", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
