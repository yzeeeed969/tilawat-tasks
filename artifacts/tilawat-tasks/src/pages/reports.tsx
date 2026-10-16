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
} from "date-fns";
import { ar } from "date-fns/locale";
import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  BarChart3,
  Copy,
  Check,
  CalendarDays,
  TrendingUp,
  Users,
  Printer,
  Eye,
  EyeOff,
  Filter,
  Download,
  FileSpreadsheet,
  FileText,
  ExternalLink,
  Link2Off,
  Layers,
  Package,
} from "lucide-react";
import { PlatformIcon, getPlatformEmoji } from "@/lib/platform-icon";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatHijriDate, useHijriPreference } from "@/lib/hijri-date";

const WEEK_OPTS = { weekStartsOn: 0 as const };

type Period = "today" | "week" | "month" | "all";
type ProofPeriod = "today" | "week" | "month" | "custom";
type ProofCoverage = "with_proof" | "missing_proof" | "all_tasks";
type ProofTaskStatus = "all" | "completed" | "incomplete";

function taskAssignees(task: TaskWithDetails) {
  return task.members && task.members.length > 0 ? task.members : [task.member];
}

type TaskProof = {
  id?: number;
  url?: string | null;
  createdAt?: string | null;
};

function taskProofLinks(task: TaskWithDetails): string[] {
  const proofs = Array.isArray((task as any).proofs) ? ((task as any).proofs as TaskProof[]) : [];
  const proofUrls = proofs.map((proof) => proof.url).filter((url): url is string => Boolean(url));
  if (proofUrls.length > 0) return proofUrls;
  return task.submissionUrl ? [task.submissionUrl] : [];
}

function taskPublicationCount(task: TaskWithDetails) {
  return Math.max(taskProofLinks(task).length, task.status === "completed" ? 1 : 0);
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

function parseDateInput(value: string, boundary: "start" | "end") {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return boundary === "start" ? startOfDay(date) : endOfDay(date);
}

function statusLabel(status: string | null | undefined) {
  return status === "completed" ? "مكتملة" : "قيد التنفيذ";
}

function escapeCsvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadTextFile(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatHijriRange(start: Date, end: Date, showHijri: boolean) {
  if (!showHijri) return "";
  return `${formatHijriDate(start, { day: "numeric", month: "long" })} — ${formatHijriDate(end, { day: "numeric", month: "long", year: "numeric" })}`;
}

function formatDateForExport(date: string, hijriDate: string, showHijri: boolean) {
  if (!showHijri || !hijriDate) return date;
  return `${date}\n(${hijriDate})`;
}

function CompletionTimingBadge({ task }: { task: TaskWithDetails }) {
  if (isCompletedLate(task)) {
    return <Badge className="bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-50">مكتملة متأخرة</Badge>;
  }

  return <Badge className="bg-green-50 text-green-700 border-green-200 hover:bg-green-50">مكتملة في الوقت</Badge>;
}

function DateWithHijri({
  date,
  formatPattern,
  showHijri,
}: {
  date: Date | string | null | undefined;
  formatPattern: string;
  showHijri: boolean;
}) {
  if (!date) return <span>—</span>;
  const value = new Date(date);
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span>{format(value, formatPattern, { locale: ar })}</span>
      {showHijri && <span className="text-[10px] font-medium text-sidebar-primary/80">{formatHijriDate(value)}</span>}
    </span>
  );
}

function CountCell({ value, tone }: { value: number; tone: "green" | "emerald" | "orange" | "red" | "primary" }) {
  if (value === 0 && (tone === "orange" || tone === "red")) return <span className="text-muted-foreground text-sm">—</span>;
  const color = {
    green: "text-green-600",
    emerald: "text-emerald-600",
    orange: "text-orange-600",
    red: "text-red-600",
    primary: "text-sidebar-primary",
  }[tone];
  return <span className={cn("font-bold", color)}>{value}</span>;
}

export default function Reports() {
  const [period, setPeriod] = useState<Period>("month");
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [copied, setCopied] = useState(false);
  const [hideMemberNames, setHideMemberNames] = useState(false);
  const [selectedReportMemberIds, setSelectedReportMemberIds] = useState<number[]>([]);
  const [proofPeriod, setProofPeriod] = useState<ProofPeriod>("month");
  const [proofStartDate, setProofStartDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [proofEndDate, setProofEndDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [showProofMemberNames, setShowProofMemberNames] = useState(false);
  const [proofCoverage, setProofCoverage] = useState<ProofCoverage>("with_proof");
  const [proofPlatformFilter, setProofPlatformFilter] = useState("all");
  const [proofReciterFilter, setProofReciterFilter] = useState("all");
  const [proofMemberFilter, setProofMemberFilter] = useState("all");
  const [proofStatusFilter, setProofStatusFilter] = useState<ProofTaskStatus>("all");
  const { toast } = useToast();
  const { showHijri } = useHijriPreference();

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
  const reportMemberOptions = useMemo(() => memberStats?.map((stat) => stat.member) ?? [], [memberStats]);
  const selectedReportMemberIdSet = useMemo(() => new Set(selectedReportMemberIds), [selectedReportMemberIds]);
  const reportTasks = useMemo(() => {
    if (!allTasks) return [];
    if (selectedReportMemberIdSet.size === 0) return allTasks;
    return allTasks.filter((task) =>
      taskAssignees(task).some((member) => selectedReportMemberIdSet.has(member.id))
    );
  }, [allTasks, selectedReportMemberIdSet]);

  const toggleReportMember = useCallback((memberId: number) => {
    setSelectedReportMemberIds((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId]
    );
  }, []);

  // ── إخفاء الأسماء: تسمية ثابتة لكل عضو («عضو 1، عضو 2…») تُستخدم في كل أقسام الصفحة والتصدير والنسخ ──
  const anonymousMemberLabels = useMemo(() => {
    const labels = new Map<number, string>();
    reportMemberOptions.forEach((member, index) => labels.set(member.id, `عضو ${index + 1}`));
    (allTasks ?? []).forEach((task) => {
      taskAssignees(task).forEach((member) => {
        if (member && !labels.has(member.id)) labels.set(member.id, `عضو ${labels.size + 1}`);
      });
    });
    return labels;
  }, [reportMemberOptions, allTasks]);

  const getDisplayMemberName = useCallback((member: { id: number; name: string }) => {
    return hideMemberNames ? anonymousMemberLabels.get(member.id) ?? "عضو" : member.name;
  }, [anonymousMemberLabels, hideMemberNames]);

  // ── الفترة العامة (أعلى الصفحة) ────────────────────────────────────────────
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

  const inPeriod = useCallback((date: string | null | undefined) =>
    date ? (periodInterval ? isWithinInterval(new Date(date), periodInterval) : true) : false,
  [periodInterval]);

  const periodLabel = useMemo(() => {
    if (period === "today") return format(now, "EEEE، d MMMM yyyy", { locale: ar });
    if (period === "week") return `${format(weekStart, "d MMM", { locale: ar })} — ${format(weekEnd, "d MMM yyyy", { locale: ar })}`;
    if (period === "month") return format(referenceMonth, "MMMM yyyy", { locale: ar });
    return "إجمالي كل الوقت";
  }, [period, weekStart, weekEnd, referenceMonth]);

  const periodHijriLabel = useMemo(() => {
    if (!showHijri) return "";
    if (period === "today") return formatHijriDate(now);
    if (period === "week") return formatHijriRange(weekStart, weekEnd, showHijri);
    if (period === "month") return formatHijriDate(referenceMonth, { month: "long", year: "numeric" });
    return "";
  }, [period, weekStart, weekEnd, referenceMonth, showHijri]);

  // ── ملخّص الإنجاز ──────────────────────────────────────────────────────────
  const periodStats = useMemo(() => {
    const completed = reportTasks
      .filter((t) => t.status === "completed" && (period === "all" ? true : inPeriod(t.completedAt)))
      .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());
    const overdue = reportTasks.filter(
      (t) => isIncompleteOverdue(t, today) && (period === "all" ? true : inPeriod(t.dueDate))
    );
    const totalPublications = completed.reduce((sum, task) => sum + taskPublicationCount(task), 0);
    const activePlatformIds = new Set(completed.map((task) => task.platform.id));
    return { completed, overdue, totalPublications, activePlatforms: activePlatformIds.size };
  }, [reportTasks, period, inPeriod, today]);

  // ── إنجاز المنصّات (أعداد فقط، وتُخفى المنصة إن كانت كل أرقامها صفرًا) ──────────────
  const platformRows = useMemo(() => {
    if (!platformStats) return [];
    return platformStats
      .map((stat) => {
        const mine = reportTasks.filter((t) => t.platform.id === stat.platform.id);
        const completed = mine.filter((t) => t.status === "completed" && (period === "all" ? true : inPeriod(t.completedAt)));
        return {
          platform: stat.platform,
          completed: completed.length,
          publications: completed.reduce((sum, task) => sum + taskPublicationCount(task), 0),
          onTime: completed.filter(isCompletedOnTime).length,
          late: completed.filter(isCompletedLate).length,
          overdue: mine.filter((t) => isIncompleteOverdue(t, today) && (period === "all" ? true : inPeriod(t.dueDate))).length,
        };
      })
      .filter((row) => row.completed > 0 || row.overdue > 0)
      .sort((a, b) => b.publications - a.publications || b.completed - a.completed);
  }, [platformStats, reportTasks, period, inPeriod, today]);

  // ── أداء الأعضاء (أعداد فقط) ─────────────────────────────────────────────────
  const memberRows = useMemo(() => {
    if (!memberStats) return [];
    return memberStats
      .filter((stat) => selectedReportMemberIdSet.size === 0 || selectedReportMemberIdSet.has(stat.member.id))
      .map((stat) => {
        const mine = reportTasks.filter((t) => isAssignedToMember(t, stat.member.id));
        const completed = mine.filter((t) => t.status === "completed" && (period === "all" ? true : inPeriod(t.completedAt)));
        return {
          member: stat.member,
          completed: completed.length,
          onTime: completed.filter(isCompletedOnTime).length,
          late: completed.filter(isCompletedLate).length,
          created: mine.filter((t) => (period === "all" ? true : inPeriod(t.createdAt))).length,
          overdue: mine.filter((t) => isIncompleteOverdue(t, today) && (period === "all" ? true : inPeriod(t.dueDate))).length,
        };
      })
      .sort((a, b) => b.completed - a.completed);
  }, [memberStats, reportTasks, selectedReportMemberIdSet, period, inPeriod, today]);

  // ── تصدير الشواهد: فترة مستقلة تمامًا عن أسهم التنقّل العلوية (تُحسب دائمًا من تاريخ اليوم) ──
  const proofInterval = useMemo(() => {
    const current = new Date();
    if (proofPeriod === "today") return { start: startOfDay(current), end: endOfDay(current) };
    if (proofPeriod === "week") return { start: startOfWeek(current, WEEK_OPTS), end: endOfWeek(current, WEEK_OPTS) };
    if (proofPeriod === "month") return { start: startOfMonth(current), end: endOfMonth(current) };
    const start = parseDateInput(proofStartDate, "start");
    const end = parseDateInput(proofEndDate, "end");
    if (!start || !end || start.getTime() > end.getTime()) return null;
    return { start, end };
  }, [proofPeriod, proofStartDate, proofEndDate]);

  const proofPlatformOptions = useMemo(() => {
    const map = new Map<number, string>();
    reportTasks.forEach((task) => {
      if (task.platform?.id) map.set(task.platform.id, task.platform.name);
    });
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [reportTasks]);

  const proofReciterOptions = useMemo(() => {
    const map = new Map<number, string>();
    reportTasks.forEach((task) => {
      if (task.reciter?.id) map.set(task.reciter.id, task.reciter.name);
    });
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [reportTasks]);

  const proofMemberOptions = useMemo(() => {
    const map = new Map<number, { id: number; name: string }>();
    reportTasks.forEach((task) => {
      taskAssignees(task).forEach((member) => map.set(member.id, member));
    });
    return [...map.values()]
      .map((member) => ({ id: member.id, name: getDisplayMemberName(member) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [reportTasks, getDisplayMemberName]);

  const proofRows = useMemo(() => {
    if (!proofInterval) return [];
    return reportTasks
      .filter((task) => Boolean(task.dueDate))
      .filter((task) => isWithinInterval(new Date(task.dueDate!), proofInterval))
      .filter((task) => {
        if (proofPlatformFilter !== "all" && String(task.platform?.id ?? "") !== proofPlatformFilter) return false;
        if (proofReciterFilter !== "all" && String(task.reciter?.id ?? "") !== proofReciterFilter) return false;
        if (proofMemberFilter !== "all" && !taskAssignees(task).some((member) => String(member.id) === proofMemberFilter)) return false;
        if (proofStatusFilter === "completed" && task.status !== "completed") return false;
        if (proofStatusFilter === "incomplete" && task.status === "completed") return false;
        const hasProof = taskProofLinks(task).length > 0;
        if (proofCoverage === "with_proof" && !hasProof) return false;
        if (proofCoverage === "missing_proof" && hasProof) return false;
        return true;
      })
      .flatMap((task) => {
        const proofLinks = taskProofLinks(task);
        const links = proofLinks.length > 0 ? proofLinks : [null];
        const taskDateValue = task.dueDate ? new Date(task.dueDate) : null;
        return links.map((proofUrl) => ({
          taskDate: taskDateValue ? format(taskDateValue, "yyyy-MM-dd") : "—",
          taskHijriDate: taskDateValue ? formatHijriDate(taskDateValue) : "",
          taskTitle: task.title,
          proofUrl,
          platform: task.platform?.name ?? "—",
          reciter: task.reciter?.name ?? "—",
          status: statusLabel(task.status),
          hasProof: Boolean(proofUrl),
          members: taskAssignees(task).map(getDisplayMemberName).join("، "),
        }));
      })
      .sort((a, b) => a.taskDate.localeCompare(b.taskDate));
  }, [
    proofInterval,
    reportTasks,
    proofCoverage,
    proofPlatformFilter,
    proofReciterFilter,
    proofMemberFilter,
    proofStatusFilter,
    getDisplayMemberName,
  ]);

  const proofExportRows = useMemo(() => {
    const headers = ["تاريخ المهمة", "اسم المهمة", "رابط الشاهد", "المنصة", "القارئ", "حالة المهمة"];
    if (showProofMemberNames) headers.push("اسم العضو");
    const rows = proofRows.map((row) => {
      const values = [
        formatDateForExport(row.taskDate, row.taskHijriDate, showHijri),
        row.taskTitle,
        row.proofUrl ?? "لا يوجد شاهد",
        row.platform,
        row.reciter,
        row.status,
      ];
      if (showProofMemberNames) values.push(row.members);
      return values;
    });
    return { headers, rows };
  }, [proofRows, showProofMemberNames, showHijri]);

  const handleProofCsvExport = useCallback(() => {
    const csv = [
      proofExportRows.headers.map(escapeCsvCell).join(","),
      ...proofExportRows.rows.map((row) => row.map(escapeCsvCell).join(",")),
    ].join("\n");
    downloadTextFile(`﻿${csv}`, `tilawat-proofs-${format(new Date(), "yyyy-MM-dd")}.csv`, "text/csv;charset=utf-8");
  }, [proofExportRows]);

  const handleProofExcelExport = useCallback(() => {
    const headerHtml = proofExportRows.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
    const rowsHtml = proofExportRows.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table border="1"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;
    downloadTextFile(html, `tilawat-proofs-${format(new Date(), "yyyy-MM-dd")}.xls`, "application/vnd.ms-excel;charset=utf-8");
  }, [proofExportRows]);

  // ── زر النسخ الوحيد: يجمع ما كانت تنسخه الأزرار الثلاثة، ويحترم «إخفاء الأسماء» ──────────
  const buildReportText = useCallback(() => {
    const periodTitle =
      period === "today" ? "اليومي" :
      period === "week" ? "الأسبوعي" :
      period === "month" ? "الشهري" : "الإجمالي";

    const lines: string[] = [];
    lines.push(`📊 *تقرير الإنجاز ${periodTitle} — تلاوات الحرمين*`);
    lines.push(`🗓️ الفترة: ${periodLabel}`);
    if (periodHijriLabel) lines.push(`(${periodHijriLabel})`);
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("📈 *ملخّص الإنجاز*");
    lines.push(`✅ المهام المكتملة: ${periodStats.completed.length}`);
    lines.push(`📦 إجمالي المنشورات: ${periodStats.totalPublications}`);
    lines.push(`📱 المنصات النشطة: ${periodStats.activePlatforms}`);
    lines.push(`⚠️ متأخرة غير مكتملة: ${periodStats.overdue.length}`);

    if (platformRows.length > 0) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━");
      lines.push("📱 *إنجاز المنصّات*");
      for (const row of platformRows) {
        const emoji = getPlatformEmoji(row.platform.name, row.platform.icon ?? "");
        const overdueStr = row.overdue > 0 ? ` | ⚠️ ${row.overdue} متأخرة غير مكتملة` : "";
        lines.push(`${emoji} *${row.platform.name}*: ✅ ${row.completed} مكتملة | 📦 ${row.publications} منشور${overdueStr}`);
      }
    }

    if (memberRows.length > 0) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━");
      lines.push("👥 *أداء الأعضاء*");
      for (const row of memberRows) {
        const lateStr = row.late > 0 ? ` | 🟠 متأخرة: ${row.late}` : "";
        const overdueStr = row.overdue > 0 ? ` | ⚠️ غير مكتملة متأخرة: ${row.overdue}` : "";
        lines.push(`• *${getDisplayMemberName(row.member)}*: ✅ ${row.completed} مكتملة | 🟢 في الوقت: ${row.onTime}${lateStr}${overdueStr}`);
      }
    }

    if (periodStats.completed.length > 0) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━");
      lines.push("✅ *المهام المنجزة*");
      for (const task of periodStats.completed) {
        const emoji = getPlatformEmoji(task.platform.name);
        const timing = isCompletedLate(task) ? "مكتملة متأخرة" : "مكتملة في الوقت";
        const assignees = ` — ${taskAssignees(task).map(getDisplayMemberName).join("، ")}`;
        const completedDate = task.completedAt ? new Date(task.completedAt) : task.dueDate ? new Date(task.dueDate) : null;
        const completedDateText = completedDate
          ? ` — ${format(completedDate, "d MMM yyyy", { locale: ar })}${showHijri ? ` (${formatHijriDate(completedDate)})` : ""}`
          : "";
        lines.push(`${emoji} ${task.title}${assignees} — ${timing}${completedDateText}`);
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("_تم إنشاء هذا التقرير تلقائياً من نظام إدارة مهام تلاوة الحرمين_ 🕌");
    return lines.join("\n");
  }, [period, periodLabel, periodHijriLabel, periodStats, platformRows, memberRows, getDisplayMemberName, showHijri]);

  const handleCopy = useCallback(async () => {
    const text = buildReportText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ title: "تم نسخ التقرير", description: "جاهز للصق في واتساب أو أي مكان" });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast({ title: "تعذّر النسخ", description: "حاول مجدداً", variant: "destructive" });
    }
  }, [buildReportText, toast]);

  const dayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* العنوان */}
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">التقارير</h2>
        <p className="text-muted-foreground mt-1">حجم الإنجاز والمتأخرات بحسب الفترة الزمنية</p>
      </div>

      {/* ── 1) الأدوات العلوية ───────────────────────────────────────── */}
      <div className="space-y-3 print:hidden">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex rounded-xl border border-border bg-card p-1 gap-1 shadow-sm w-fit">
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
                  "flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all",
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

          {period === "week" && (
            <div className="flex items-center gap-1 bg-card border border-border rounded-xl px-3 py-2 shadow-sm w-fit">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setWeekOffset((o) => o + 1)} aria-label="الأسبوع التالي">
                <ChevronRight className="h-4 w-4" />
              </Button>
              <div className="text-center min-w-[180px]">
                <p className="text-sm font-bold text-foreground">
                  {format(weekStart, "d MMM", { locale: ar })} — {format(weekEnd, "d MMM yyyy", { locale: ar })}
                </p>
                {showHijri && (
                  <p className="text-[11px] font-medium text-sidebar-primary/80">{formatHijriRange(weekStart, weekEnd, showHijri)}</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {dayNames[weekStart.getDay()]} — {dayNames[weekEnd.getDay()]}
                </p>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setWeekOffset((o) => o - 1)} aria-label="الأسبوع السابق">
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
            <div className="flex items-center gap-1 bg-card border border-border rounded-xl px-3 py-2 shadow-sm w-fit">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMonthOffset((o) => o + 1)} aria-label="الشهر التالي">
                <ChevronRight className="h-4 w-4" />
              </Button>
              <div className="text-center min-w-[140px]">
                <p className="text-sm font-bold text-foreground">{format(referenceMonth, "MMMM yyyy", { locale: ar })}</p>
                {showHijri && (
                  <p className="text-[11px] font-medium text-sidebar-primary/80">
                    {formatHijriDate(referenceMonth, { month: "long", year: "numeric" })}
                  </p>
                )}
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMonthOffset((o) => o - 1)} aria-label="الشهر السابق">
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
            <div className="flex items-center gap-2 bg-card border border-border rounded-xl px-4 py-2 shadow-sm w-fit">
              <CalendarDays className="h-4 w-4 text-sidebar-primary" />
              <span className="text-sm font-bold text-foreground">{format(now, "EEEE، d MMMM yyyy", { locale: ar })}</span>
              {showHijri && <span className="text-xs font-medium text-sidebar-primary/80">{formatHijriDate(now)}</span>}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap lg:mr-auto">
            <Button
              type="button"
              variant={hideMemberNames ? "default" : "outline"}
              size="sm"
              onClick={() => setHideMemberNames((value) => !value)}
              className={cn(
                "gap-2 font-medium",
                hideMemberNames && "bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
              )}
            >
              {hideMemberNames ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {hideMemberNames ? "الأسماء مخفية" : "إخفاء الأسماء"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-2 font-medium">
              <Printer className="h-4 w-4" />
              طباعة / PDF
            </Button>
            <Button size="sm" onClick={handleCopy} className="gap-2 font-medium bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "تم النسخ" : "نسخ التقرير"}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-sm text-foreground">
              <Filter className="h-4 w-4 text-sidebar-primary" />
              فلترة حسب الأعضاء
              <Badge variant="outline" className="font-medium">
                {selectedReportMemberIds.length > 0 ? `${selectedReportMemberIds.length} محدد` : "الكل"}
              </Badge>
            </div>
            {selectedReportMemberIds.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedReportMemberIds([])} className="h-7 text-xs">
                مسح الاختيار
              </Button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {reportMemberOptions.map((member) => {
              const selected = selectedReportMemberIdSet.has(member.id);
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => toggleReportMember(member.id)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    selected
                      ? "border-sidebar-primary bg-sidebar-primary text-sidebar-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  {getDisplayMemberName(member)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── 2) ملخّص الإنجاز (بلا أسماء) ─────────────────────────────── */}
      <Card className="border-sidebar-primary/20 bg-sidebar-primary/5 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <FileText className="h-5 w-5 text-sidebar-primary" />
            ملخّص الإنجاز
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            الفترة: <span className="font-semibold text-foreground">{periodLabel}</span>
            {periodHijriLabel && <span className="text-sidebar-primary/80"> ({periodHijriLabel})</span>}
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
            <div className="rounded-xl border border-green-200 bg-background/90 p-5 md:row-span-2 flex flex-col justify-center">
              <p className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                إجمالي المهام المكتملة
              </p>
              <p className="mt-2 text-5xl md:text-6xl font-extrabold text-green-700 leading-none">{periodStats.completed.length}</p>
            </div>
            <div className="rounded-xl border border-border bg-background/90 p-4">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5 text-sidebar-primary" />
                إجمالي المنشورات
              </p>
              <p className="mt-1.5 text-3xl font-bold text-sidebar-primary">{periodStats.totalPublications}</p>
            </div>
            <div className="rounded-xl border border-border bg-background/90 p-4">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-amber-700" />
                المنصات النشطة
              </p>
              <p className="mt-1.5 text-3xl font-bold text-amber-700">{periodStats.activePlatforms}</p>
            </div>
            <div className="md:col-span-2 rounded-xl border border-red-100 bg-background/70 px-4 py-2.5 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                متأخرات غير مكتملة
              </p>
              <p className={cn("text-lg font-bold", periodStats.overdue.length > 0 ? "text-red-600" : "text-muted-foreground")}>
                {periodStats.overdue.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 3) إنجاز المنصّات (أعداد فقط) ─────────────────────────────── */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Layers className="h-5 w-5 text-sidebar-primary" />
            إنجاز المنصّات
          </CardTitle>
        </CardHeader>
        <CardContent>
          {platformRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">لا يوجد إنجاز أو متأخرات على أي منصة في هذه الفترة.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {platformRows.map((row) => (
                <div key={row.platform.id} className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <PlatformIcon name={row.platform.name} icon={row.platform.icon ?? undefined} className="h-5 w-5" />
                    <span className="font-semibold text-sm leading-tight">{row.platform.name}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="bg-green-50 dark:bg-green-950/30 rounded-lg py-2 border border-green-100 dark:border-green-900">
                      <p className="text-2xl font-bold text-green-600">{row.completed}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">مكتملة</p>
                    </div>
                    <div className="bg-sidebar-primary/5 rounded-lg py-2 border border-sidebar-primary/10">
                      <p className="text-2xl font-bold text-sidebar-primary">{row.publications}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">منشور</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>في الوقت: <b className="text-emerald-600">{row.onTime}</b></span>
                    <span>مكتملة متأخرة: <b className="text-orange-600">{row.late}</b></span>
                    <span>متأخرة غير مكتملة: <b className={row.overdue > 0 ? "text-red-600" : ""}>{row.overdue}</b></span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 4) أداء الأعضاء (أعداد فقط) ───────────────────────────────── */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Users className="h-5 w-5 text-sidebar-primary" />
            أداء الأعضاء
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="text-right font-bold">العضو</TableHead>
                <TableHead className="text-right font-bold">الدور</TableHead>
                <TableHead className="text-right font-bold text-green-600">مكتملة</TableHead>
                <TableHead className="text-right font-bold text-emerald-600">في الوقت</TableHead>
                <TableHead className="text-right font-bold text-orange-600">مكتملة متأخرة</TableHead>
                <TableHead className="text-right font-bold text-sidebar-primary">منشأة</TableHead>
                <TableHead className="text-right font-bold text-red-500">متأخرة غير مكتملة</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memberRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">لا توجد بيانات لهذه الفترة</TableCell>
                </TableRow>
              ) : (
                memberRows.map((row) => (
                  <TableRow key={row.member.id}>
                    <TableCell className="font-semibold">{getDisplayMemberName(row.member)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{hideMemberNames ? "—" : row.member.role}</TableCell>
                    <TableCell><CountCell value={row.completed} tone="green" /></TableCell>
                    <TableCell><CountCell value={row.onTime} tone="emerald" /></TableCell>
                    <TableCell><CountCell value={row.late} tone="orange" /></TableCell>
                    <TableCell><CountCell value={row.created} tone="primary" /></TableCell>
                    <TableCell><CountCell value={row.overdue} tone="red" /></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── 5) قائمة المهام المنجزة (مرة واحدة فقط) ───────────────────── */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            قائمة المهام المنجزة ({periodStats.completed.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="text-right font-bold">المهمة</TableHead>
                <TableHead className="text-right font-bold">المنصة</TableHead>
                <TableHead className="text-right font-bold">المسؤول</TableHead>
                <TableHead className="text-right font-bold">تاريخ الاستحقاق</TableHead>
                <TableHead className="text-right font-bold">تاريخ الإنجاز</TableHead>
                <TableHead className="text-right font-bold">توقيت الإنجاز</TableHead>
                <TableHead className="text-right font-bold">الشاهد</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {periodStats.completed.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">لا توجد مهام مكتملة في هذه الفترة</TableCell>
                </TableRow>
              ) : (
                periodStats.completed.map((task) => {
                  const proofs = taskProofLinks(task);
                  return (
                    <TableRow key={task.id} className="hover:bg-green-50/30 transition-colors">
                      <TableCell className="font-medium">{task.title}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <PlatformIcon name={task.platform.name} />
                          <span className="text-sm">{task.platform.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{taskAssignees(task).map(getDisplayMemberName).join("، ")}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <DateWithHijri date={task.dueDate} formatPattern="EEEE، d MMM" showHijri={showHijri} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <DateWithHijri date={task.completedAt} formatPattern="EEEE، d MMM" showHijri={showHijri} />
                      </TableCell>
                      <TableCell><CompletionTimingBadge task={task} /></TableCell>
                      <TableCell>
                        {proofs.length === 0 ? (
                          <span className="text-muted-foreground text-sm">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {proofs.map((proofUrl, proofIndex) => (
                              <a
                                key={`${task.id}-proof-${proofIndex}`}
                                href={proofUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100"
                              >
                                <ExternalLink className="h-3 w-3" />
                                {proofs.length > 1 ? `شاهد ${proofIndex + 1}` : "رابط"}
                              </a>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── 6) تصدير الشواهد (فترته مستقلة عن أعلى الصفحة) ─────────────── */}
      <Card className="border-border/60 shadow-sm print:hidden">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Download className="h-5 w-5 text-sidebar-primary" />
            تصدير الشواهد
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            لهذا القسم فترته الخاصة (لا تتأثر باختيار الفترة أعلى الصفحة):{" "}
            {proofInterval ? (
              <span className="font-semibold text-foreground">
                {format(proofInterval.start, "d MMM yyyy", { locale: ar })} — {format(proofInterval.end, "d MMM yyyy", { locale: ar })}
              </span>
            ) : (
              <span className="font-semibold text-red-600">النطاق المخصص غير صحيح</span>
            )}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Select value={proofPeriod} onValueChange={(value) => setProofPeriod(value as ProofPeriod)}>
              <SelectTrigger>
                <SelectValue placeholder="الفترة" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="today">اليوم</SelectItem>
                <SelectItem value="week">الأسبوع الحالي</SelectItem>
                <SelectItem value="month">الشهر الحالي</SelectItem>
                <SelectItem value="custom">نطاق مخصص</SelectItem>
              </SelectContent>
            </Select>
            {proofPeriod === "custom" && (
              <>
                <Input type="date" value={proofStartDate} onChange={(event) => setProofStartDate(event.target.value)} aria-label="من تاريخ" />
                <Input type="date" value={proofEndDate} onChange={(event) => setProofEndDate(event.target.value)} aria-label="إلى تاريخ" />
              </>
            )}
            <Select value={proofCoverage} onValueChange={(value) => setProofCoverage(value as ProofCoverage)}>
              <SelectTrigger>
                <SelectValue placeholder="نوع الشواهد" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="with_proof">الشواهد الموجودة فقط</SelectItem>
                <SelectItem value="missing_proof">المهام بدون شاهد</SelectItem>
                <SelectItem value="all_tasks">الكل</SelectItem>
              </SelectContent>
            </Select>
            <Select value={proofStatusFilter} onValueChange={(value) => setProofStatusFilter(value as ProofTaskStatus)}>
              <SelectTrigger>
                <SelectValue placeholder="حالة المهمة" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="all">كل الحالات</SelectItem>
                <SelectItem value="completed">مكتملة</SelectItem>
                <SelectItem value="incomplete">غير مكتملة</SelectItem>
              </SelectContent>
            </Select>
            <Select value={proofPlatformFilter} onValueChange={setProofPlatformFilter}>
              <SelectTrigger>
                <SelectValue placeholder="المنصة" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="all">كل المنصات</SelectItem>
                {proofPlatformOptions.map((platform) => (
                  <SelectItem key={platform.id} value={String(platform.id)}>{platform.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={proofReciterFilter} onValueChange={setProofReciterFilter}>
              <SelectTrigger>
                <SelectValue placeholder="القارئ" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="all">كل القراء</SelectItem>
                {proofReciterOptions.map((reciter) => (
                  <SelectItem key={reciter.id} value={String(reciter.id)}>{reciter.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={proofMemberFilter} onValueChange={setProofMemberFilter}>
              <SelectTrigger>
                <SelectValue placeholder="العضو" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="all">كل الأعضاء</SelectItem>
                {proofMemberOptions.map((member) => (
                  <SelectItem key={member.id} value={String(member.id)}>{member.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={showProofMemberNames ? "default" : "outline"}
              onClick={() => setShowProofMemberNames((value) => !value)}
              className={cn(
                "gap-2",
                showProofMemberNames && "bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
              )}
            >
              {showProofMemberNames ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              إظهار عمود العضو
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setProofCoverage("with_proof");
                setProofPlatformFilter("all");
                setProofReciterFilter("all");
                setProofMemberFilter("all");
                setProofStatusFilter("all");
              }}
              className="gap-2"
            >
              مسح فلاتر الشواهد
            </Button>
          </div>

          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="text-right font-bold">تاريخ المهمة</TableHead>
                  <TableHead className="text-right font-bold">اسم المهمة</TableHead>
                  <TableHead className="text-right font-bold">رابط الشاهد</TableHead>
                  <TableHead className="text-right font-bold">المنصة</TableHead>
                  <TableHead className="text-right font-bold">القارئ</TableHead>
                  <TableHead className="text-right font-bold">الحالة</TableHead>
                  {showProofMemberNames && <TableHead className="text-right font-bold">العضو</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {proofRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={showProofMemberNames ? 7 : 6} className="text-center text-muted-foreground py-8">
                      لا توجد شواهد في الفترة المحددة
                    </TableCell>
                  </TableRow>
                ) : (
                  proofRows.map((row, index) => (
                    <TableRow key={`${row.taskDate}-${row.proofUrl}-${index}`}>
                      <TableCell className="text-sm text-muted-foreground">
                        <DateWithHijri date={row.taskDate} formatPattern="yyyy-MM-dd" showHijri={showHijri} />
                      </TableCell>
                      <TableCell className="font-medium">{row.taskTitle}</TableCell>
                      <TableCell>
                        {row.proofUrl ? (
                          <a href={row.proofUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100">
                            <ExternalLink className="h-3 w-3" />
                            رابط
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                            <Link2Off className="h-3 w-3" />
                            لا يوجد
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{row.platform}</TableCell>
                      <TableCell>{row.reciter}</TableCell>
                      <TableCell>{row.status}</TableCell>
                      {showProofMemberNames && <TableCell>{row.members}</TableCell>}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">النتائج: {proofRows.length} شاهد</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="gap-2" onClick={handleProofExcelExport} disabled={proofRows.length === 0}>
                <FileSpreadsheet className="h-4 w-4" />
                تصدير Excel
              </Button>
              <Button variant="outline" className="gap-2" onClick={handleProofCsvExport} disabled={proofRows.length === 0}>
                <FileText className="h-4 w-4" />
                تصدير CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
