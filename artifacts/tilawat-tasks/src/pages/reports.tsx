import {
  useListTasks,
  getListTasksQueryKey,
  useGetMemberStats,
  getGetMemberStatsQueryKey,
  useGetPlatformStats,
  getGetPlatformStatsQueryKey,
} from "@workspace/api-client-react";
import type { TaskWithDetails } from "@workspace/api-client-react";
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfDay,
  endOfDay,
  isWithinInterval,
  format,
  subWeeks,
  addWeeks,
  subMonths,
  addMonths,
  isSameWeek,
  isSameMonth,
  isSameDay,
} from "date-fns";
import { ar } from "date-fns/locale";
import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  AlertCircle,
  ListTodo,
  BarChart3,
  Share2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  CalendarDays,
  TrendingUp,
  Users,
  Printer,
  Mic2,
} from "lucide-react";
import { PlatformIcon, getPlatformEmoji } from "@/lib/platform-icon";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const WEEK_OPTS = { weekStartsOn: 0 as const };

type Period = "today" | "week" | "month" | "all";

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  subtitle,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
  subtitle?: string;
}) {
  return (
    <Card className="border-border/60 shadow-sm">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground font-medium">{label}</p>
            <p className={cn("text-3xl font-bold mt-1", color)}>{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
          </div>
          <div className="p-2 rounded-lg bg-muted/50">
            <Icon className={cn("h-5 w-5", color)} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function taskAssignees(task: TaskWithDetails) {
  return task.members && task.members.length > 0 ? task.members : [task.member];
}

function isAssignedToMember(task: TaskWithDetails, memberId: number) {
  return taskAssignees(task).some((member) => member.id === memberId);
}

function isCompletedLate(task: TaskWithDetails) {
  if (task.status !== "completed" || !task.dueDate || !task.completedAt) return false;
  return startOfDay(new Date(task.completedAt)).getTime() > startOfDay(new Date(task.dueDate)).getTime();
}

function isCompletedOnTime(task: TaskWithDetails) {
  return task.status === "completed" && !isCompletedLate(task);
}

function isIncompleteOverdue(task: TaskWithDetails, today: Date) {
  return Boolean(
    task.status !== "completed" &&
      task.dueDate &&
      startOfDay(new Date(task.dueDate)).getTime() < today.getTime()
  );
}

function CompletionTimingBadge({ task }: { task: TaskWithDetails }) {
  if (isCompletedLate(task)) {
    return <Badge className="bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-50">مكتملة متأخرة</Badge>;
  }

  return <Badge className="bg-green-50 text-green-700 border-green-200 hover:bg-green-50">مكتملة في الوقت</Badge>;
}

export default function Reports() {
  const [period, setPeriod] = useState<Period>("week");
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [expandedMember, setExpandedMember] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const { data: allTasks } = useListTasks(
    {},
    { query: { queryKey: getListTasksQueryKey({}) } }
  );
  const { data: memberStats } = useGetMemberStats({
    query: { queryKey: getGetMemberStatsQueryKey() },
  });
  const { data: platformStats } = useGetPlatformStats({
    query: { queryKey: getGetPlatformStatsQueryKey() },
  });
  const now = new Date();
  const today = useMemo(() => startOfDay(now), []);

  const referenceWeek = useMemo(() => {
    if (weekOffset === 0) return now;
    if (weekOffset > 0) return addWeeks(now, weekOffset);
    return subWeeks(now, Math.abs(weekOffset));
  }, [weekOffset]);

  const referenceMonth = useMemo(() => {
    if (monthOffset === 0) return now;
    if (monthOffset > 0) return addMonths(now, monthOffset);
    return subMonths(now, Math.abs(monthOffset));
  }, [monthOffset]);

  const weekStart = useMemo(() => startOfWeek(referenceWeek, WEEK_OPTS), [referenceWeek]);
  const weekEnd = useMemo(() => endOfWeek(referenceWeek, WEEK_OPTS), [referenceWeek]);
  const monthStart = useMemo(() => startOfMonth(referenceMonth), [referenceMonth]);
  const monthEnd = useMemo(() => endOfMonth(referenceMonth), [referenceMonth]);
  const dayStart = useMemo(() => startOfDay(now), []);
  const dayEnd = useMemo(() => endOfDay(now), []);

  const isCurrentWeek = isSameWeek(now, referenceWeek, WEEK_OPTS);
  const isCurrentMonth = isSameMonth(now, referenceMonth);

  const periodInterval = useMemo(() => {
    if (period === "today") return { start: dayStart, end: dayEnd };
    if (period === "week") return { start: weekStart, end: weekEnd };
    if (period === "month") return { start: monthStart, end: monthEnd };
    return null;
  }, [period, dayStart, dayEnd, weekStart, weekEnd, monthStart, monthEnd]);

  const periodStats = useMemo(() => {
    if (!allTasks) return null;
    const inPeriod = (date: string | null | undefined) =>
      date
        ? periodInterval
          ? isWithinInterval(new Date(date), periodInterval)
          : true
        : false;

    const completed = allTasks.filter(
      (t) => t.status === "completed" && (period === "all" ? true : inPeriod(t.completedAt))
    );
    const created = allTasks.filter(
      (t) => period === "all" ? true : isWithinInterval(new Date(t.createdAt), periodInterval!)
    );
    const overdue = allTasks.filter(
      (t) => isIncompleteOverdue(t, today) && (period === "all" ? true : inPeriod(t.dueDate))
    );
    const completedOnTime = completed.filter(isCompletedOnTime);
    const completedLate = completed.filter(isCompletedLate);

    return { completed, completedOnTime, completedLate, created, overdue };
  }, [allTasks, period, periodInterval, today]);

  const memberRows = useMemo(() => {
    if (!memberStats || !allTasks) return [];
    return memberStats
      .map((stat) => {
        const inPeriod = (date: string | null | undefined) =>
          date
            ? periodInterval
              ? isWithinInterval(new Date(date), periodInterval)
              : true
            : false;

        const completedTasks = allTasks.filter(
          (t) => isAssignedToMember(t, stat.member.id) &&
            t.status === "completed" &&
            (period === "all" ? true : inPeriod(t.completedAt))
        );
        const completedOnTimeTasks = completedTasks.filter(isCompletedOnTime);
        const completedLateTasks = completedTasks.filter(isCompletedLate);
        const overdueTasks = allTasks.filter(
          (t) => isAssignedToMember(t, stat.member.id) &&
            isIncompleteOverdue(t, today) &&
            (period === "all" ? true : inPeriod(t.dueDate))
        );
        const createdTasks = allTasks.filter(
          (t) => isAssignedToMember(t, stat.member.id) &&
            (period === "all"
              ? true
              : isWithinInterval(new Date(t.createdAt), periodInterval!))
        );

        return {
          ...stat,
          periodCompleted: completedTasks.length,
          periodCompletedOnTime: completedOnTimeTasks.length,
          periodCompletedLate: completedLateTasks.length,
          periodOverdue: overdueTasks.length,
          periodCreated: createdTasks.length,
          completedTasksList: completedTasks,
        };
      })
      .sort((a, b) => b.periodCompleted - a.periodCompleted);
  }, [memberStats, allTasks, period, periodInterval, today]);

  const platformRows = useMemo(() => {
    if (!platformStats || !allTasks) return [];
    return platformStats.map((stat) => {
      const inPeriod = (date: string | null | undefined) =>
        date
          ? periodInterval
            ? isWithinInterval(new Date(date), periodInterval)
            : true
          : false;

      const completed = allTasks.filter(
        (t) => t.platform.id === stat.platform.id &&
          t.status === "completed" &&
          (period === "all" ? true : inPeriod(t.completedAt))
      );
      const overdue = allTasks.filter(
        (t) => t.platform.id === stat.platform.id &&
          isIncompleteOverdue(t, today) &&
          (period === "all" ? true : inPeriod(t.dueDate))
      ).length;
      const created = allTasks.filter(
        (t) => t.platform.id === stat.platform.id &&
          (period === "all"
            ? true
            : isWithinInterval(new Date(t.createdAt), periodInterval!))
      ).length;

      return {
        ...stat,
        periodCompleted: completed.length,
        periodCompletedOnTime: completed.filter(isCompletedOnTime).length,
        periodCompletedLate: completed.filter(isCompletedLate).length,
        periodOverdue: overdue,
        periodCreated: created,
      };
    });
  }, [platformStats, allTasks, period, periodInterval, today]);

  const reciterRows = useMemo(() => {
    if (!allTasks) return [];
    const inPeriod = (date: string | null | undefined) =>
      date
        ? periodInterval
          ? isWithinInterval(new Date(date), periodInterval)
          : true
        : false;

    const reciterMap = new Map<number, { reciter: NonNullable<TaskWithDetails["reciter"]>; tasks: TaskWithDetails[] }>();
    for (const task of allTasks) {
      if (!task.reciter) continue;
      if (!reciterMap.has(task.reciter.id)) {
        reciterMap.set(task.reciter.id, { reciter: task.reciter, tasks: [] });
      }
      reciterMap.get(task.reciter.id)!.tasks.push(task);
    }

    return [...reciterMap.values()]
      .map(({ reciter, tasks }) => {
        const periodTasks = tasks.filter((task) =>
          period === "all" ? true : task.dueDate ? inPeriod(task.dueDate) : inPeriod(task.createdAt)
        );
        const completed = tasks.filter(
          (task) => task.status === "completed" && (period === "all" ? true : inPeriod(task.completedAt))
        );
        const overdue = tasks.filter(
          (task) => isIncompleteOverdue(task, today) && (period === "all" ? true : inPeriod(task.dueDate))
        );
        const totalTasks = period === "all" ? tasks.length : periodTasks.length;
        const completionRate = totalTasks > 0 ? (completed.length / totalTasks) * 100 : 0;

        return {
          reciter,
          totalTasks,
          completedTasks: completed.length,
          completedOnTimeTasks: completed.filter(isCompletedOnTime).length,
          completedLateTasks: completed.filter(isCompletedLate).length,
          pendingTasks: periodTasks.filter((task) => task.status === "pending").length,
          overdueTasksCount: overdue.length,
          completionRate,
        };
      })
      .filter((row) => row.totalTasks > 0 || row.completedTasks > 0 || row.overdueTasksCount > 0)
      .sort((a, b) => b.completedTasks - a.completedTasks);
  }, [allTasks, period, periodInterval, today]);

  // WhatsApp export (weekly mode)
  const buildWhatsAppText = useCallback(() => {
    if (!periodStats || !memberRows || !platformRows) return "";

    const periodLabel =
      period === "today"
        ? format(now, "EEEE، d MMMM yyyy", { locale: ar })
        : period === "week"
        ? `${format(weekStart, "d MMM", { locale: ar })} — ${format(weekEnd, "d MMM yyyy", { locale: ar })}`
        : period === "month"
        ? format(referenceMonth, "MMMM yyyy", { locale: ar })
        : "إجمالي كل الوقت";

    const periodTitle =
      period === "today" ? "اليومي" :
      period === "week" ? "الأسبوعي" :
      period === "month" ? "الشهري" : "الإجمالي";

    const completionRate =
      periodStats.created.length > 0
        ? Math.round((periodStats.completed.length / periodStats.created.length) * 100)
        : 0;

    const lines: string[] = [];
    lines.push(`📊 *التقرير ${periodTitle} — تلاوة الحرمين*`);
    lines.push(`🗓️ الفترة: ${periodLabel}`);
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push(`📈 *ملخص الفترة*`);
    lines.push(`✅ مهام مكتملة: ${periodStats.completed.length}`);
    lines.push(`🟢 مكتملة في الوقت: ${periodStats.completedOnTime.length}`);
    lines.push(`🟠 مكتملة متأخرة: ${periodStats.completedLate.length}`);
    lines.push(`📝 مهام منشأة: ${periodStats.created.length}`);
    lines.push(`⚠️ متأخرة غير مكتملة: ${periodStats.overdue.length}`);
    lines.push(`📊 نسبة الإنجاز: ${completionRate}%`);
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("👥 *أداء الأعضاء*");
    for (const row of memberRows) {
      const lateStr = row.periodCompletedLate > 0 ? ` | 🟠 مكتملة متأخرة: ${row.periodCompletedLate}` : "";
      const overdueStr = row.periodOverdue > 0 ? ` | ⚠️ غير مكتملة متأخرة: ${row.periodOverdue}` : "";
      lines.push(`• *${row.member.name}*: ✅ ${row.periodCompleted} مكتملة | 🟢 في الوقت: ${row.periodCompletedOnTime}${lateStr}${overdueStr}`);
    }

    const activePlatforms = platformRows.filter(
      (r) => r.periodCompleted > 0 || r.periodCreated > 0 || r.periodOverdue > 0
    );
    if (activePlatforms.length > 0) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━");
      lines.push("📱 *أداء المنصات*");
      for (const row of activePlatforms) {
        const emoji = getPlatformEmoji(row.platform.name, row.platform.icon ?? "");
        lines.push(`${emoji} *${row.platform.name}*: ✅ ${row.periodCompleted} مكتملة | 🟢 ${row.periodCompletedOnTime} في الوقت | 🟠 ${row.periodCompletedLate} متأخرة | ⚠️ ${row.periodOverdue} غير مكتملة`);
      }
    }

    if (periodStats.completed.length > 0) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━");
      lines.push("✅ *المهام المنجزة*");
      for (const task of periodStats.completed) {
        const emoji = getPlatformEmoji(task.platform.name);
        const timing = isCompletedLate(task) ? "مكتملة متأخرة" : "مكتملة في الوقت";
        lines.push(`${emoji} ${task.title} — ${taskAssignees(task).map((member) => member.name).join("، ")} — ${timing}`);
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("_تم إنشاء هذا التقرير تلقائياً من نظام إدارة مهام تلاوة الحرمين_ 🕌");

    return lines.join("\n");
  }, [periodStats, memberRows, platformRows, period, weekStart, weekEnd, referenceMonth]);

  const handleCopy = useCallback(async () => {
    const text = buildWhatsAppText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ title: "تم النسخ!", description: "الملخص جاهز للإرسال على واتساب" });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast({ title: "تعذّر النسخ", description: "حاول مجدداً", variant: "destructive" });
    }
  }, [buildWhatsAppText, toast]);

  const handleWhatsApp = useCallback(() => {
    const text = buildWhatsAppText();
    if (!text) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  }, [buildWhatsAppText]);

  const dayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  const completionRate =
    periodStats && periodStats.created.length > 0
      ? Math.round((periodStats.completed.length / periodStats.created.length) * 100)
      : null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">الإحصائيات</h2>
          <p className="text-muted-foreground mt-1">تقارير أداء الفريق بحسب الفترة الزمنية</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            className="flex items-center gap-2 font-medium print:hidden"
          >
            <Printer className="h-4 w-4" />
            طباعة / PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="flex items-center gap-2 font-medium print:hidden"
          >
            {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            {copied ? "تم النسخ!" : "نسخ الملخص"}
          </Button>
          <Button
            size="sm"
            onClick={handleWhatsApp}
            className="flex items-center gap-2 font-medium bg-[#25D366] hover:bg-[#1ebe5d] text-white border-0 print:hidden"
          >
            <Share2 className="h-4 w-4" />
            إرسال واتساب
          </Button>
        </div>
      </div>

      {/* Period tabs */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="flex rounded-xl border border-border bg-card p-1 gap-1 shadow-sm">
          {(
            [
              { key: "today", label: "اليوم", icon: CalendarDays },
              { key: "week", label: "الأسبوع", icon: TrendingUp },
              { key: "month", label: "الشهر", icon: BarChart3 },
              { key: "all", label: "الإجمالي", icon: Users },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                period === key
                  ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Date navigator */}
        {period === "week" && (
          <div className="flex items-center gap-1 bg-card border border-border rounded-xl px-3 py-2 shadow-sm">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setWeekOffset((o) => o + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <div className="text-center min-w-[180px]">
              <p className="text-sm font-bold text-foreground">
                {format(weekStart, "d MMM", { locale: ar })} — {format(weekEnd, "d MMM yyyy", { locale: ar })}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {dayNames[weekStart.getDay()]} — {dayNames[weekEnd.getDay()]}
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setWeekOffset((o) => o - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {!isCurrentWeek && (
              <Button variant="outline" size="sm" className="text-xs mr-1" onClick={() => setWeekOffset(0)}>
                الحالي
              </Button>
            )}
          </div>
        )}

        {period === "month" && (
          <div className="flex items-center gap-1 bg-card border border-border rounded-xl px-3 py-2 shadow-sm">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMonthOffset((o) => o + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <div className="text-center min-w-[140px]">
              <p className="text-sm font-bold text-foreground">
                {format(referenceMonth, "MMMM yyyy", { locale: ar })}
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMonthOffset((o) => o - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {!isCurrentMonth && (
              <Button variant="outline" size="sm" className="text-xs mr-1" onClick={() => setMonthOffset(0)}>
                الحالي
              </Button>
            )}
          </div>
        )}

        {period === "today" && (
          <div className="flex items-center gap-2 bg-card border border-border rounded-xl px-4 py-2 shadow-sm">
            <CalendarDays className="h-4 w-4 text-sidebar-primary" />
            <span className="text-sm font-bold text-foreground">
              {format(now, "EEEE، d MMMM yyyy", { locale: ar })}
            </span>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          label="مكتملة"
          value={periodStats?.completed.length ?? 0}
          icon={CheckCircle2}
          color="text-green-600"
          subtitle={period === "today" ? "اليوم" : period === "week" ? "هذا الأسبوع" : period === "month" ? "هذا الشهر" : "إجمالي"}
        />
        <StatCard
          label="في الوقت"
          value={periodStats?.completedOnTime.length ?? 0}
          icon={CheckCircle2}
          color="text-emerald-600"
          subtitle="مكتملة قبل أو في موعدها"
        />
        <StatCard
          label="مكتملة متأخرة"
          value={periodStats?.completedLate.length ?? 0}
          icon={AlertCircle}
          color="text-orange-600"
          subtitle="أُكملت بعد موعدها"
        />
        <StatCard
          label="منشأة"
          value={periodStats?.created.length ?? 0}
          icon={ListTodo}
          color="text-sidebar-primary"
          subtitle="مهام جديدة"
        />
        <StatCard
          label="متأخرة غير مكتملة"
          value={periodStats?.overdue.length ?? 0}
          icon={AlertCircle}
          color="text-red-500"
          subtitle="تجاوزت الموعد ولم تكتمل"
        />
        <StatCard
          label="نسبة الإنجاز"
          value={completionRate !== null ? `${completionRate}%` : "—"}
          icon={BarChart3}
          color="text-amber-600"
          subtitle="من المهام المنشأة"
        />
      </div>

      {/* Member breakdown */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Users className="h-5 w-5 text-sidebar-primary" />
            أداء الأعضاء
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="text-right font-bold w-8"></TableHead>
                <TableHead className="text-right font-bold">العضو</TableHead>
                <TableHead className="text-right font-bold">الدور</TableHead>
                <TableHead className="text-right font-bold text-green-600">مكتملة</TableHead>
                <TableHead className="text-right font-bold text-emerald-600">في الوقت</TableHead>
                <TableHead className="text-right font-bold text-orange-600">مكتملة متأخرة</TableHead>
                <TableHead className="text-right font-bold text-sidebar-primary">منشأة</TableHead>
                <TableHead className="text-right font-bold text-red-500">متأخرة غير مكتملة</TableHead>
                <TableHead className="text-right font-bold w-[180px]">الإنجاز الكلي</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memberRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                    لا توجد بيانات لهذه الفترة
                  </TableCell>
                </TableRow>
              ) : (
                memberRows.map((row) => (
                  <>
                    <TableRow
                      key={row.member.id}
                      className={cn(
                        "hover:bg-muted/20 transition-colors cursor-pointer",
                        expandedMember === row.member.id && "bg-muted/10"
                      )}
                      onClick={() =>
                        setExpandedMember(expandedMember === row.member.id ? null : row.member.id)
                      }
                    >
                      <TableCell>
                        <button className="text-muted-foreground hover:text-foreground transition-colors">
                          {expandedMember === row.member.id ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="font-semibold">{row.member.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{row.member.role}</TableCell>
                      <TableCell>
                        <span className="font-bold text-green-600">{row.periodCompleted}</span>
                      </TableCell>
                      <TableCell>
                        <span className="font-bold text-emerald-600">{row.periodCompletedOnTime}</span>
                      </TableCell>
                      <TableCell>
                        {row.periodCompletedLate > 0 ? (
                          <Badge className="bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-50 text-xs font-bold">{row.periodCompletedLate}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="font-bold text-sidebar-primary">{row.periodCreated}</span>
                      </TableCell>
                      <TableCell>
                        {row.periodOverdue > 0 ? (
                          <Badge variant="destructive" className="text-xs font-bold">{row.periodOverdue}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={row.completionRate} className="h-2 flex-1" />
                          <span className="text-xs font-bold text-sidebar-primary w-10 text-left">
                            {Math.round(row.completionRate)}%
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>

                    {expandedMember === row.member.id && (
                      <TableRow key={`${row.member.id}-expanded`} className="bg-muted/5">
                        <TableCell colSpan={9} className="p-0">
                          <div className="px-6 py-4 space-y-2">
                            {row.completedTasksList.length === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-3">
                                لا توجد مهام مكتملة في هذه الفترة
                              </p>
                            ) : (
                              <>
                                <p className="text-xs font-bold text-muted-foreground mb-3 uppercase tracking-wide">
                                  المهام المنجزة ({row.completedTasksList.length})
                                </p>
                                <div className="grid gap-2">
                                  {row.completedTasksList.map((task) => (
                                    <div
                                      key={task.id}
                                      className="flex items-center gap-3 rounded-lg bg-green-50 border border-green-100 px-4 py-2.5"
                                    >
                                      <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-foreground truncate">{task.title}</p>
                                        <div className="flex items-center gap-2 mt-0.5">
                                          <PlatformIcon name={task.platform.name} className="h-3 w-3" />
                                          <span className="text-xs text-muted-foreground">{task.platform.name}</span>
                                          {task.completedAt && (
                                            <>
                                              <span className="text-muted-foreground/40">·</span>
                                              <span className="text-xs text-muted-foreground">
                                                {format(new Date(task.completedAt), "d MMM", { locale: ar })}
                                              </span>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                      <CompletionTimingBadge task={task} />
                                      {task.submissionUrl && (
                                        <a
                                          href={task.submissionUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="text-xs text-sidebar-primary hover:underline shrink-0"
                                        >
                                          رابط الشاهد
                                        </a>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Reciter breakdown */}
      {reciterRows.length > 0 && (
        <Card className="border-border/60 shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-bold flex items-center gap-2">
              <Mic2 className="h-5 w-5 text-sidebar-primary" />
              أداء القراء
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="text-right font-bold">القارئ</TableHead>
                  <TableHead className="text-right font-bold text-green-600">مكتملة</TableHead>
                  <TableHead className="text-right font-bold text-emerald-600">في الوقت</TableHead>
                  <TableHead className="text-right font-bold text-orange-600">مكتملة متأخرة</TableHead>
                  <TableHead className="text-right font-bold text-muted-foreground">قيد الانتظار</TableHead>
                  <TableHead className="text-right font-bold text-red-500">متأخرة غير مكتملة</TableHead>
                  <TableHead className="text-right font-bold w-[180px]">الإنجاز</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reciterRows.map((row) => (
                  <TableRow key={row.reciter.id} className="hover:bg-muted/20 transition-colors">
                    <TableCell className="font-semibold">{row.reciter.name}</TableCell>
                    <TableCell><span className="font-bold text-green-600">{row.completedTasks}</span></TableCell>
                    <TableCell><span className="font-bold text-emerald-600">{row.completedOnTimeTasks}</span></TableCell>
                    <TableCell>
                      {row.completedLateTasks > 0 ? (
                        <Badge className="bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-50 text-xs font-bold">{row.completedLateTasks}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell><span className="text-muted-foreground">{row.pendingTasks}</span></TableCell>
                    <TableCell>
                      {row.overdueTasksCount > 0 ? (
                        <Badge variant="destructive" className="text-xs font-bold">{row.overdueTasksCount}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Progress value={row.completionRate} className="h-2 flex-1" />
                        <span className="text-xs font-bold text-sidebar-primary w-10 text-left">
                          {Math.round(row.completionRate)}%
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Platform breakdown */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-bold">أداء المنصات</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {platformRows.map((row) => (
              <div
                key={row.platform.id}
                className="rounded-xl border border-border bg-muted/20 p-4 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <PlatformIcon name={row.platform.name} icon={row.platform.icon ?? undefined} className="h-4 w-4" />
                  <span className="font-semibold text-sm leading-tight">{row.platform.name}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="bg-green-50 rounded-lg py-2 border border-green-100">
                    <p className="text-xl font-bold text-green-600">{row.periodCompleted}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">مكتملة</p>
                  </div>
                  <div className="bg-emerald-50 rounded-lg py-2 border border-emerald-100">
                    <p className="text-xl font-bold text-emerald-600">{row.periodCompletedOnTime}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">في الوقت</p>
                  </div>
                  <div className="bg-orange-50 rounded-lg py-2 border border-orange-100">
                    <p className="text-xl font-bold text-orange-600">{row.periodCompletedLate}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">مكتملة متأخرة</p>
                  </div>
                  <div className="bg-red-50 rounded-lg py-2 border border-red-100">
                    <p className="text-xl font-bold text-red-600">{row.periodOverdue}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">غير مكتملة متأخرة</p>
                  </div>
                  <div className="bg-sidebar-primary/5 rounded-lg py-2 border border-sidebar-primary/10">
                    <p className="text-xl font-bold text-sidebar-primary">{row.periodCreated}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">منشأة</p>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>الإنجاز</span>
                    <span className="font-bold">{Math.round(row.completionRate)}%</span>
                  </div>
                  <Progress value={row.completionRate} className="h-1.5" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Completed tasks list */}
      {periodStats && periodStats.completed.length > 0 && (
        <Card className="border-border/60 shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg font-bold">
                المهام المنجزة ({periodStats.completed.length})
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="text-right font-bold">المهمة</TableHead>
                  <TableHead className="text-right font-bold">المنصة</TableHead>
                  <TableHead className="text-right font-bold">المسؤول</TableHead>
                  <TableHead className="text-right font-bold">تاريخ الاستحقاق</TableHead>
                  <TableHead className="text-right font-bold">تاريخ الإنجاز</TableHead>
                  <TableHead className="text-right font-bold">توقيت الإنجاز</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periodStats.completed.map((task) => (
                  <TableRow key={task.id} className="hover:bg-green-50/30 transition-colors">
                    <TableCell className="font-medium">{task.title}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <PlatformIcon name={task.platform.name} />
                        <span className="text-sm">{task.platform.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {taskAssignees(task).map((member) => member.name).join("، ")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task.dueDate
                        ? format(new Date(task.dueDate), "EEEE، d MMM", { locale: ar })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task.completedAt
                        ? format(new Date(task.completedAt), "EEEE، d MMM", { locale: ar })
                        : "—"}
                    </TableCell>
                    <TableCell><CompletionTimingBadge task={task} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
