import { Component, useState, useEffect, useMemo, useRef, type ErrorInfo, type ReactNode } from "react";
import {
  useListTasks,
  getListTasksQueryKey,
  useListMembers,
  getListMembersQueryKey,
  useListPlatforms,
  getListPlatformsQueryKey,
  useListReciters,
  getListRecitersQueryKey,
  useListPlatformPages,
  getListPlatformPagesQueryKey,
  useUpdateTask,
  useCreateTask,
  useDeleteTask,
  useDuplicateTask,
  useRestoreTask,
  usePermanentDeleteTask,
} from "@workspace/api-client-react";
import { CommentsDialog } from "@/components/comments-dialog";

import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useIsAdmin, useRole } from "@/lib/roles";
import { useAuth } from "@/lib/auth-context";
import { format, isPast, isToday, isBefore, startOfDay, endOfDay, differenceInDays, startOfWeek, endOfWeek, addWeeks, eachDayOfInterval, isSameDay, addDays } from "date-fns";
import { ar } from "date-fns/locale";
import { TaskStatusBadge } from "@/components/task-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useFormContext } from "react-hook-form";
import * as z from "zod";
import { TaskStatus, TaskWithDetails, Reciter } from "@workspace/api-client-react";
import {
  Loader2,
  Plus,
  MoreHorizontal,
  Check,
  CircleDashed,
  CalendarClock,
  Trash2,
  Pencil,
  Users,
  Repeat2,
  BookOpen,
  LayoutList,
  Layers,
  MicVocal,
  Link2,
  ExternalLink,

  MessageSquare,
  Archive,
  Flame,
  ArrowDown,
  Minus,
  TrendingUp,
  X,
  Copy,
  RotateCcw,
  Search,
  ChevronDown,
  ChevronRight,
  CalendarDays,
  ChevronLeft,
} from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/lib/platform-icon";
import { cn } from "@/lib/utils";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { formatHijriDate, useHijriPreference } from "@/lib/hijri-date";

const APP_PRAYER_OPTIONS = ["صلاة الفجر", "صلاة المغرب", "صلاة العشاء", "صلاة الجمعة"] as const;
const ADMIN_LIST_LIMIT_OPTIONS = ["25", "50", "100", "all"] as const;
const WEEKDAY_OPTIONS = [
  { value: "0", label: "الأحد" },
  { value: "1", label: "الاثنين" },
  { value: "2", label: "الثلاثاء" },
  { value: "3", label: "الأربعاء" },
  { value: "4", label: "الخميس" },
  { value: "5", label: "الجمعة" },
  { value: "6", label: "السبت" },
] as const;

function isApplicationPlatformName(name?: string | null) {
  return Boolean(name && (/تطبيق/.test(name) || /app/i.test(name)));
}

function isPlaceholderApplicationReciter(name?: string | null) {
  return Boolean(name && /تطبيق/.test(name));
}

function toPositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeSelectNumberValue(value: unknown, fallback = "none") {
  const n = toPositiveNumber(value);
  return n ? String(n) : fallback;
}

function parseSelectNumberValue(value: string) {
  return value === "none" ? null : toPositiveNumber(value);
}

function toDateInputValue(value: unknown): string {
  if (!value) return "";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "" : format(date, "yyyy-MM-dd");
}

function normalizeTaskStatus(value: unknown): "pending" | "completed" {
  return value === "completed" ? "completed" : "pending";
}

function normalizeTaskPriority(value: unknown): "urgent" | "normal" | "low" {
  return value === "urgent" || value === "low" || value === "normal" ? value : "normal";
}

function normalizeTaskRecurrence(value: unknown): "none" | "daily" | "weekly" | "monthly" | "custom_days" {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "custom_days" ? value : "none";
}

function normalizeTaskSeriesType(value: unknown): "temporary" | "operational" | "weekly_quota" {
  return value === "operational" || value === "weekly_quota" || value === "temporary" ? value : "temporary";
}

function mergeById<T extends { id: number }>(items: Array<T | null | undefined>): T[] {
  const map = new Map<number, T>();
  for (const item of items) {
    if (item && Number.isFinite(item.id) && item.id > 0) map.set(item.id, item);
  }
  return [...map.values()];
}

function taskAssignedMembers(task: TaskWithDetails | null | undefined) {
  const fromMembers = Array.isArray((task as any)?.members) ? (task as any).members : [];
  const fromPrimary = (task as any)?.member ? [(task as any).member] : [];
  return mergeById<{ id: number; name: string; role: string }>([...fromMembers, ...fromPrimary]);
}

function taskAssignedMemberIds(task: TaskWithDetails | null | undefined) {
  return taskAssignedMembers(task).map((member) => member.id);
}

function taskPlatformId(task: TaskWithDetails | null | undefined) {
  return toPositiveNumber((task as any)?.platform?.id) ?? toPositiveNumber((task as any)?.platformId);
}

function taskReciterId(task: TaskWithDetails | null | undefined) {
  return toPositiveNumber((task as any)?.reciter?.id) ?? toPositiveNumber((task as any)?.reciterId);
}

function taskPageId(task: TaskWithDetails | null | undefined) {
  return toPositiveNumber((task as any)?.pageId);
}

function extractAppPrayerFromTitle(title?: string | null) {
  return APP_PRAYER_OPTIONS.find((prayer) => Boolean(title?.includes(prayer))) ?? null;
}

function taskDialogDiagnostic(task: TaskWithDetails | null | undefined) {
  if (!task) return null;
  return {
    id: (task as any).id,
    title: (task as any).title,
    status: (task as any).status,
    recurrence: (task as any).recurrence,
    seriesId: (task as any).seriesId,
    source: (task as any).source,
    platformId: taskPlatformId(task),
    platformName: (task as any).platform?.name,
    pageId: taskPageId(task),
    reciterId: taskReciterId(task),
    reciterName: (task as any).reciter?.name,
    assignedMemberIds: taskAssignedMemberIds(task),
    dueDate: (task as any).dueDate,
    startDate: (task as any).startDate,
    completedAt: (task as any).completedAt,
    hasSubmissionUrl: Boolean((task as any).submissionUrl),
    proofsCount: taskProofs(task).length,
  };
}

function logTaskDialogOpen(dialogName: string, payload?: Record<string, unknown> | null) {
  console.info("[tasks-dialog] open", { dialogName, ...(payload ?? {}) });
}

type TaskDependencyOption = {
  id: number;
  label: string;
  title: string;
  platformName: string;
  reciterName: string;
  responsibleNames: string;
  statusLabel: string;
  dateLabel: string;
  dateKey: string;
  searchText: string;
};

function taskDependencyTitle(task: TaskWithDetails | null | undefined) {
  const id = toPositiveNumber((task as any)?.id);
  return typeof (task as any)?.title === "string" && (task as any).title.trim()
    ? (task as any).title.trim()
    : id
      ? `مهمة #${id}`
      : "مهمة غير معروفة";
}

function taskDependencyDateInfo(task: TaskWithDetails | null | undefined) {
  const dueDate = (task as any)?.dueDate ? new Date((task as any).dueDate) : null;
  if (!dueDate || Number.isNaN(dueDate.getTime())) {
    return { dateLabel: "بدون تاريخ", dateKey: "" };
  }
  return {
    dateLabel: format(dueDate, "EEEE d MMMM yyyy", { locale: ar }),
    dateKey: format(dueDate, "yyyy-MM-dd"),
  };
}

function taskDependencyStatusLabel(task: TaskWithDetails | null | undefined) {
  return (task as any)?.status === "completed" ? "مكتملة" : "قيد الانتظار";
}

function buildTaskDependencyOption(task: TaskWithDetails): TaskDependencyOption {
  const title = taskDependencyTitle(task);
  const platformName = ((task as any)?.platform?.name ?? "").trim();
  const reciterName = ((task as any)?.reciter?.name ?? "").trim();
  const responsibleNames = taskAssignedMembers(task).map((member) => member.name).filter(Boolean).join("، ");
  const statusLabel = taskDependencyStatusLabel(task);
  const { dateLabel, dateKey } = taskDependencyDateInfo(task);
  const label = [title, platformName, reciterName, dateLabel, responsibleNames, statusLabel]
    .filter(Boolean)
    .join(" — ");

  return {
    id: toPositiveNumber((task as any).id) ?? 0,
    label,
    title,
    platformName,
    reciterName,
    responsibleNames,
    statusLabel,
    dateLabel,
    dateKey,
    searchText: [title, platformName, reciterName, responsibleNames, statusLabel, dateLabel]
      .join(" ")
      .toLowerCase(),
  };
}

function buildTaskDependencySelectOptions(
  allTasks: TaskWithDetails[] | undefined,
  excludeTaskId: number | undefined,
  dependsOnTaskId: number | null | undefined
): TaskDependencyOption[] {
  const seen = new Set<number>();
  const options = (allTasks ?? [])
    .map((task) => {
      const id = toPositiveNumber((task as any)?.id);
      return id ? { id, task } : null;
    })
    .filter((entry): entry is { id: number; task: TaskWithDetails } => {
      if (!entry) return false;
      if (excludeTaskId && entry.id === excludeTaskId) return false;
      if ((entry.task as any)?.deletedAt) return false;
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => {
      const aTime = new Date(((a.task as any)?.dueDate ?? (a.task as any)?.createdAt) as any).getTime();
      const bTime = new Date(((b.task as any)?.dueDate ?? (b.task as any)?.createdAt) as any).getTime();
      const safeA = Number.isFinite(aTime) ? aTime : 0;
      const safeB = Number.isFinite(bTime) ? bTime : 0;
      return safeB - safeA;
    })
    .map(({ task }) => buildTaskDependencyOption(task))
    .filter((option) => option.id > 0);

  const currentDependencyId = toPositiveNumber(dependsOnTaskId);
  if (currentDependencyId && !options.some((option) => option.id === currentDependencyId)) {
    return [
      {
        id: currentDependencyId,
        label: `المهمة المرتبطة الحالية #${currentDependencyId}`,
        title: `المهمة المرتبطة الحالية #${currentDependencyId}`,
        platformName: "",
        reciterName: "",
        responsibleNames: "",
        statusLabel: "غير متاحة",
        dateLabel: "غير ظاهرة في القائمة الحالية",
        dateKey: "",
        searchText: `المهمة المرتبطة الحالية #${currentDependencyId}`.toLowerCase(),
      },
      ...options,
    ];
  }

  return options;
}

function uniqueTextOptions(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "ar")
  );
}

function DependencyTaskPicker({
  value,
  onChange,
  options,
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  options: TaskDependencyOption[];
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [reciterFilter, setReciterFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");

  const selectedId = toPositiveNumber(value);
  const selectedOption = selectedId ? options.find((option) => option.id === selectedId) : null;

  const platformFilterOptions = useMemo(
    () => uniqueTextOptions(options.map((option) => option.platformName)),
    [options]
  );
  const reciterFilterOptions = useMemo(
    () => uniqueTextOptions(options.map((option) => option.reciterName)),
    [options]
  );

  const filteredOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return options.filter((option) => {
      if (query && !option.searchText.includes(query)) return false;
      if (platformFilter !== "all" && option.platformName !== platformFilter) return false;
      if (reciterFilter !== "all" && option.reciterName !== reciterFilter) return false;
      if (dateFilter && option.dateKey !== dateFilter) return false;
      return true;
    });
  }, [dateFilter, options, platformFilter, reciterFilter, searchQuery]);

  const resetFilters = () => {
    setSearchQuery("");
    setPlatformFilter("all");
    setReciterFilter("all");
    setDateFilter("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label="اختيار المهمة السابقة المرتبطة"
          className="min-h-[44px] w-full justify-between gap-3 whitespace-normal text-right"
        >
          <span className="min-w-0 flex-1 truncate">
            {selectedOption ? selectedOption.title : "بدون مهمة مرتبطة"}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="z-[120] w-[min(92vw,620px)] p-3"
        dir="rtl"
      >
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-semibold transition-colors",
              !selectedId
                ? "border-sidebar-primary bg-sidebar-primary text-sidebar-primary-foreground"
                : "border-border bg-muted/20 hover:bg-muted"
            )}
          >
            <span>بدون مهمة مرتبطة</span>
            {!selectedId && <Check className="h-4 w-4" />}
          </button>

          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="ابحث عن مهمة..."
              className="pr-9"
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <select
              value={platformFilter}
              onChange={(event) => setPlatformFilter(event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
            >
              <option value="all">كل المنصات</option>
              {platformFilterOptions.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </select>

            <select
              value={reciterFilter}
              onChange={(event) => setReciterFilter(event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
            >
              <option value="all">كل القراء</option>
              {reciterFilterOptions.map((reciter) => (
                <option key={reciter} value={reciter}>
                  {reciter}
                </option>
              ))}
            </select>

            <Input
              type="date"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
              aria-label="فلترة بتاريخ المهمة"
            />
          </div>

          {(searchQuery || platformFilter !== "all" || reciterFilter !== "all" || dateFilter) && (
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={resetFilters}>
              مسح بحث وفلاتر المهام المرتبطة
            </Button>
          )}

          <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {filteredOptions.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
                لا توجد مهام مطابقة للبحث أو الفلاتر الحالية.
              </div>
            ) : (
              filteredOptions.map((option) => {
                const selected = selectedId === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      onChange(option.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-right transition-colors",
                      selected
                        ? "border-sidebar-primary bg-sidebar-primary/10"
                        : "border-border bg-background hover:bg-muted/60"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="break-words text-sm font-semibold leading-6 text-foreground">
                          {option.title}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {option.platformName || "بدون منصة"}
                          {option.reciterName ? ` — ${option.reciterName}` : ""}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {option.dateLabel}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          المسؤول: {option.responsibleNames || "غير محدد"}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        {selected && <Check className="h-4 w-4 text-sidebar-primary" />}
                        <Badge variant={option.statusLabel === "مكتملة" ? "default" : "secondary"}>
                          {option.statusLabel}
                        </Badge>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

async function ensureApplicationReciterPage(platformId: number, reciterId: number, memberIds: number[]) {
  const pagesRes = await fetch(`/api/platforms/${platformId}/pages`, { credentials: "include" });
  if (!pagesRes.ok) throw new Error("Failed to load platform pages");
  const pages = (await pagesRes.json()) as Array<{ id: number; reciterId?: number | null; pageUrl?: string | null }>;
  let page = pages.find((pg) => pg.reciterId === reciterId);

  if (!page) {
    const createRes = await fetch(`/api/platforms/${platformId}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ reciterId }),
    });
    if (!createRes.ok) throw new Error("Failed to create platform page");
    page = await createRes.json();
  }
  if (!page) throw new Error("Failed to resolve platform page");

  const membersRes = await fetch(`/api/platforms/${platformId}/pages/${page.id}/members`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ memberIds }),
  });
  if (!membersRes.ok) throw new Error("Failed to save page members");

  return page.id;
}

const taskSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  platformId: z.coerce.number().min(1, { message: "المنصة مطلوبة" }),
  pageId: z.number().nullable().optional(),
  memberIds: z.array(z.number()).min(1, { message: "اختر عضواً على الأقل" }),
  reciterId: z.number().nullable().optional(),
  appPrayer: z.enum(APP_PRAYER_OPTIONS).optional().nullable(),
  status: z.enum(["pending", "completed"]).optional(),
  priority: z.enum(["urgent", "normal", "low"]).optional(),
  progress: z.coerce.number().min(0).max(100).optional(),
  seriesType: z.enum(["temporary", "operational", "weekly_quota"]).optional(),
  startDate: z.string().min(1, { message: "تاريخ البداية مطلوب" }),
  endDate: z.string().optional(),
  dueDate: z.string().optional(),
  recurrence: z.enum(["none", "daily", "weekly", "monthly", "custom_days"]).optional(),
  recurrenceIntervalDays: z.coerce.number().min(1).max(365).optional().nullable(),
  recurrenceDurationDays: z.coerce.number().min(1).max(365).optional().nullable(),
  recurrenceDays: z.string().optional().nullable(),
  weeklyQuotaRequired: z.coerce.number().min(1, { message: "أدخل عددًا صحيحًا" }).max(50, { message: "الحد الأعلى 50 مرة" }).optional().nullable(),
  submissionUrl: z.string().url({ message: "أدخل رابطاً صحيحاً" }).or(z.literal("")).optional().nullable(),
  dependsOnTaskId: z.coerce.number().optional().nullable(),
}).superRefine((data, ctx) => {
  if ((data.seriesType ?? "temporary") === "operational" && data.recurrence !== "weekly" && data.recurrence !== "monthly") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "اختر تكراراً أسبوعياً أو شهرياً",
      path: ["recurrence"],
    });
  }
  if (data.seriesType === "weekly_quota" && !data.weeklyQuotaRequired) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "حدد عدد مرات الإنجاز المطلوبة في الأسبوع",
      path: ["weeklyQuotaRequired"],
    });
  }
  if (data.startDate && data.endDate && new Date(data.endDate) < new Date(data.startDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو مساويًا له",
      path: ["endDate"],
    });
  }
  if (data.recurrenceDays) {
    const days = data.recurrenceDays.split(",").filter(Boolean);
    const invalidDay = days.some((day) => !/^[0-6]$/.test(day));
    if (invalidDay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "اختر أياماً صحيحة للتكرار",
        path: ["recurrenceDays"],
      });
    }
  }
});

const submissionUrlSchema = z.object({
  url: z.string().url({ message: "أدخل رابطاً صحيحاً (يبدأ بـ https://)" }).or(z.literal("")),
});

type TaskFormValues = z.infer<typeof taskSchema>;
type AdminListLimit = typeof ADMIN_LIST_LIMIT_OPTIONS[number];
type EditTaskScope = "single" | "future" | "series";
const TASK_FORM_STABILITY_MODE = false;
const USE_SAFE_PHASE_ONE_TASK_FORM = true;
const ENABLE_MEMBER_CREATED_TASKS = true;
const ENABLE_TASK_DEPENDENCIES = true;
type UrlDialogState = {
  taskId: number;
  currentUrl: string;
  mode: "task-url" | "proof-create" | "proof-edit";
  proofId?: number | null;
};
type TaskProof = {
  id: number;
  taskId: number;
  url: string;
  note?: string | null;
  createdAt?: string | Date;
};

type TaskDialogErrorBoundaryProps = {
  dialogName: string;
  resetKey?: string | number | null;
  onClose?: () => void;
  children: ReactNode;
};

type TaskDialogErrorBoundaryState = {
  error: Error | null;
};

class TaskDialogErrorBoundary extends Component<TaskDialogErrorBoundaryProps, TaskDialogErrorBoundaryState> {
  state: TaskDialogErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): TaskDialogErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[tasks-dialog] render failed", {
      dialogName: this.props.dialogName,
      error,
      errorInfo,
    });
  }

  componentDidUpdate(previousProps: TaskDialogErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="m-6 rounded-lg border border-red-200 bg-red-50 p-4 text-right" dir="rtl">
        <p className="text-sm font-bold text-red-700">تعذر فتح هذه النافذة</p>
        <p className="mt-1 text-sm leading-6 text-red-700/80">
          حدث خطأ أثناء تجهيز بيانات النموذج. أغلق النافذة وحدّث الصفحة ثم حاول مرة أخرى.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-4 border-red-200 text-red-700 hover:bg-red-100"
          onClick={this.props.onClose}
        >
          إغلاق النافذة
        </Button>
      </div>
    );
  }
}

const EDIT_SCOPE_MESSAGES: Record<EditTaskScope, string> = {
  single: "سيتم تعديل هذه المهمة فقط.",
  future: "سيتم تطبيق هذا التعديل على هذه المهمة وما بعدها ضمن نفس السلسلة.",
  series: "سيتم تطبيق هذا التعديل على جميع المهام التابعة لهذه السلسلة.",
};

const MOSQUE_LABEL: Record<string, string> = {
  nabawi: "المسجد النبوي الشريف",
  haram: "المسجد الحرام",
};
const MOSQUE_ICON: Record<string, string> = { nabawi: "🕌", haram: "🕋" };

function taskProofs(task: TaskWithDetails): TaskProof[] {
  return Array.isArray((task as any).proofs) ? (task as any).proofs : [];
}

function isWeeklyQuotaTask(task: TaskWithDetails) {
  return Number((task as any).weeklyQuotaRequired ?? 0) > 0;
}

function weeklyQuotaInfo(task: TaskWithDetails) {
  const required = Number((task as any).weeklyQuotaRequired ?? 0);
  const proofs = taskProofs(task);
  return {
    required,
    completed: proofs.length,
    remaining: Math.max(required - proofs.length, 0),
    extra: Math.max(proofs.length - required, 0),
    isQuota: required > 0,
  };
}

function WeeklyQuotaBadge({ task }: { task: TaskWithDetails }) {
  const quota = weeklyQuotaInfo(task);
  if (!quota.isQuota) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
      <Repeat2 className="h-2.5 w-2.5" />
      هدف أسبوعي {quota.completed}/{quota.required}
      {quota.extra > 0 && <span>+{quota.extra} إضافي</span>}
    </span>
  );
}

function MemberCreatedTaskBadge({ task }: { task: TaskWithDetails }) {
  if ((task as any).source !== "member_created") return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-green-50 text-green-700 border-green-200">
      <Pencil className="h-2.5 w-2.5" />
      مهمة مقطوعة
    </span>
  );
}

function TaskNoteLine({
  task,
  className,
  compact = false,
}: {
  task: { description?: string | null };
  className?: string;
  compact?: boolean;
}) {
  const note = typeof task.description === "string" ? task.description.trim() : "";
  if (!note) return null;

  return (
    <div
      className={cn(
        "max-w-full whitespace-normal break-words rounded-md border border-amber-200/80 bg-amber-50/80 text-amber-900",
        compact ? "px-1.5 py-0.5 text-[10px] leading-snug" : "px-2 py-1 text-xs leading-relaxed",
        className
      )}
    >
      <span className="font-semibold">ملاحظة: </span>
      <span>{note}</span>
    </div>
  );
}

function TaskDescriptionField({ compact = false }: { compact?: boolean }) {
  return (
    <FormField
      name="description"
      render={({ field }) => (
        <FormItem>
          <FormLabel className={compact ? "text-muted-foreground text-sm" : undefined}>
            ملاحظة تظهر للعضو <span className="text-xs text-muted-foreground">(اختياري)</span>
          </FormLabel>
          <FormControl>
            <Textarea
              value={field.value ?? ""}
              onChange={field.onChange}
              placeholder="اكتب ملاحظة تظهر داخل المهمة للعضو..."
              rows={3}
              className={cn("resize-none", compact && "min-h-[72px]")}
            />
          </FormControl>
          <p className="text-xs leading-5 text-muted-foreground">
            ستظهر هذه الملاحظة داخل صف المهمة للعضو.
          </p>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function TaskProofCell({
  task,
  onAdd,
  onManage,
}: {
  task: TaskWithDetails;
  onAdd: (task: TaskWithDetails) => void;
  onManage: (task: TaskWithDetails) => void;
}) {
  const quota = weeklyQuotaInfo(task);
  if (quota.isQuota) {
    const proofs = taskProofs(task);
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cn(
          "inline-flex items-center gap-1 text-xs font-medium border rounded-full px-2 py-0.5",
          quota.completed >= quota.required
            ? "text-green-700 bg-green-50 border-green-200"
            : "text-amber-700 bg-amber-50 border-amber-200"
        )}>
          {quota.completed}/{quota.required}
        </span>
        {quota.extra > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium border rounded-full px-2 py-0.5 text-blue-700 bg-blue-50 border-blue-200">
            +{quota.extra} إضافي
          </span>
        )}
        {proofs.length > 0 && (
          <button
            onClick={() => onManage(task)}
            className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100 transition-colors"
            title="عرض وتعديل الشواهد"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            الشواهد
          </button>
        )}
        <button
          onClick={() => onAdd(task)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-primary hover:bg-sidebar-primary/10 border border-dashed border-muted-foreground/30 hover:border-sidebar-primary/50 rounded-full px-2 py-0.5 transition-colors"
          title={quota.completed >= quota.required ? "إضافة شاهد إضافي" : "إضافة شاهد"}
        >
          <Link2 className="h-3 w-3" />
          {quota.completed >= quota.required ? "أضف زيادة" : "أضف"}
        </button>
      </div>
    );
  }

  return task.submissionUrl ? (
    <div className="flex items-center gap-1.5">
      <a
        href={task.submissionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100 transition-colors max-w-[80px] truncate"
        title={task.submissionUrl}
      >
        <ExternalLink className="h-3 w-3 shrink-0" />
        <span className="truncate">رابط</span>
      </a>
      <button onClick={() => onAdd(task)} className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  ) : (
    <button onClick={() => onAdd(task)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-primary hover:bg-sidebar-primary/10 border border-dashed border-muted-foreground/30 hover:border-sidebar-primary/50 rounded-full px-2 py-0.5 transition-colors">
      <Link2 className="h-3 w-3" />
      أضف
    </button>
  );
}

function AdminTaskMobileCard({
  task,
  isSelected,
  isOverdue,
  showHijri,
  onToggleSelect,
  onEdit,
  onQuickReciter,
  onComments,
  onProof,
  onManageProofs,
  onDuplicate,
  onStatusChange,
  onDelete,
}: {
  task: TaskWithDetails;
  isSelected: boolean;
  isOverdue: boolean;
  showHijri: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onQuickReciter: () => void;
  onComments: () => void;
  onProof: () => void;
  onManageProofs: () => void;
  onDuplicate: () => void;
  onStatusChange: (status: TaskStatus) => void;
  onDelete: () => void;
}) {
  const reciter = task.reciter as Reciter | null | undefined;
  const taskMembers = task.members && task.members.length > 0 ? task.members : [task.member];

  return (
    <div
      id={`task-${task.id}`}
      className={cn(
        "rounded-lg border bg-card p-3 shadow-sm",
        isOverdue && "border-red-200 bg-red-50/40",
        isSelected && "border-sidebar-primary bg-sidebar-primary/5"
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} className="mt-1" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold leading-6 text-foreground">{task.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <WeeklyQuotaBadge task={task} />
                <MemberCreatedTaskBadge task={task} />
              </div>
            </div>
            <TaskStatusBadge status={task.status} />
          </div>
          <TaskNoteLine task={task} compact />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-muted/40 p-2">
          <span className="block text-muted-foreground">المنصة</span>
          <span className="mt-1 flex items-center gap-1.5 font-medium">
            <PlatformIcon name={task.platform.name} className="h-4 w-4" />
            {task.platform.name}
          </span>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <span className="block text-muted-foreground">القارئ</span>
          <span className="mt-1 block font-medium">{reciter?.name ?? "—"}</span>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <span className="block text-muted-foreground">المسؤولون</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {taskMembers.map((member) => (
              <span key={member.id} className="rounded-full bg-sidebar-primary/10 px-2 py-0.5 font-medium text-sidebar-primary">
                {member.name}
              </span>
            ))}
          </div>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <span className="block text-muted-foreground">التاريخ</span>
          <div className="mt-1 font-medium"><TaskDayDateLabel dueDate={task.dueDate} showHijri={showHijri} /></div>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <span className="block text-muted-foreground">الاستحقاق</span>
          <div className="mt-1"><TaskDueStatusLabel task={task} /></div>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <span className="block text-muted-foreground">الشاهد</span>
          <div className="mt-1"><TaskProofCell task={task} onAdd={() => onProof()} onManage={() => onManageProofs()} /></div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          تعديل
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1" onClick={onProof}>
          <Link2 className="h-3.5 w-3.5" />
          الشاهد
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1" onClick={onQuickReciter}>
          <MicVocal className="h-3.5 w-3.5" />
          القارئ
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="ghost" className="mr-auto h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onComments} className="cursor-pointer flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-sidebar-primary/70" />التعليقات
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate} className="cursor-pointer flex items-center gap-2">
              <Copy className="h-4 w-4 text-violet-500" />نسخ المهمة
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onStatusChange("pending")} className="cursor-pointer flex items-center gap-2">
              <CircleDashed className="h-4 w-4 text-gray-500" />قيد الانتظار
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onStatusChange("completed")} className="cursor-pointer flex items-center gap-2">
              <Check className="h-4 w-4 text-green-600" />مكتمل
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="cursor-pointer flex items-center gap-2 text-red-600 focus:text-red-700 focus:bg-red-50">
              <Trash2 className="h-4 w-4" />نقل إلى السلة
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

type DueStatusTask = {
  dueDate?: string | Date | null;
  status?: TaskStatus | string | null;
  completedAt?: string | Date | null;
};

function TaskDueStatusLabel({ task }: { task: DueStatusTask }) {
  const dueDate = task.dueDate;
  if (!dueDate) return <span className="text-muted-foreground text-xs">—</span>;
  const due = startOfDay(new Date(dueDate));
  const today = startOfDay(new Date());
  const isCompleted = task.status === "completed";

  let label = "قادمة";
  let className = "text-muted-foreground border-transparent";
  let showIcon = false;

  if (isCompleted) {
    if (task.completedAt) {
      const completed = startOfDay(new Date(task.completedAt));
      if (completed.getTime() > due.getTime()) {
        label = "مكتملة متأخرة";
        className = "bg-orange-50 text-orange-700 border-orange-200";
      } else {
        label = "مكتملة في الوقت";
        className = "bg-green-50 text-green-700 border-green-200";
      }
    } else {
      label = "مكتملة";
      className = "bg-green-50 text-green-700 border-green-200";
    }
  } else if (due.getTime() < today.getTime()) {
    label = "متأخرة";
    className = "bg-red-50 text-red-700 border-red-200";
    showIcon = true;
  } else if (due.getTime() === today.getTime()) {
    label = "مستحقة اليوم";
    className = "bg-amber-50 text-amber-700 border-amber-200";
    showIcon = true;
  } else if (differenceInDays(due, today) <= 3) {
    label = "قريبة";
    className = "bg-blue-50 text-blue-700 border-blue-200";
    showIcon = true;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border",
        className
      )}
    >
      {showIcon && <CalendarClock className="h-3 w-3" />}
      {label}
    </span>
  );
}

type DueStatusFilter = "all" | "overdue" | "due_today" | "completed_on_time" | "completed_late";

function getTaskDueStatus(task: DueStatusTask): Exclude<DueStatusFilter, "all"> | null {
  if (!task.dueDate) return null;

  const dueDate = new Date(task.dueDate);
  if (Number.isNaN(dueDate.getTime())) return null;

  const due = startOfDay(dueDate);
  const today = startOfDay(new Date());

  if (task.status !== "completed") {
    if (due.getTime() < today.getTime()) return "overdue";
    if (due.getTime() === today.getTime()) return "due_today";
    return null;
  }

  if (!task.completedAt) return null;
  const completedDate = new Date(task.completedAt);
  if (Number.isNaN(completedDate.getTime())) return null;

  const completed = startOfDay(completedDate);
  return completed.getTime() <= due.getTime() ? "completed_on_time" : "completed_late";
}

function TaskDayDateLabel({
  dueDate,
  showHijri = true,
}: {
  dueDate: string | Date | null | undefined;
  showHijri?: boolean;
}) {
  if (!dueDate) return <span className="text-muted-foreground text-xs">—</span>;
  const date = startOfDay(new Date(dueDate));
  const hijriDate = showHijri ? formatHijriDate(date, { day: "numeric", month: "long", year: "numeric" }) : "";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold text-foreground">{format(date, "EEEE", { locale: ar })}</span>
      <span className="text-xs text-muted-foreground">{format(date, "d MMM yyyy", { locale: ar })}</span>
      {hijriDate && <span className="text-[10px] font-medium text-sidebar-primary/80">{hijriDate}</span>}
    </div>
  );
}

function MemberMultiSelect({
  members,
  value,
  onChange,
}: {
  members: { id: number; name: string; role: string }[] | undefined;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const toggle = (id: number) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  };

  if (!members || members.length === 0) {
    return (
      <div className="border border-dashed border-muted-foreground/30 rounded-md p-4 text-center text-sm text-muted-foreground">
        لا يوجد أعضاء — أضف أعضاء من صفحة الإعدادات أولاً
      </div>
    );
  }

  return (
    <div className="rounded-md border border-input divide-y divide-border">
      {members.map((m) => {
        const checked = value.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => toggle(m.id)}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 text-right transition-colors",
              checked
                ? "bg-sidebar-primary/10 hover:bg-sidebar-primary/15"
                : "bg-background hover:bg-muted/40"
            )}
          >
            <div
              className={cn(
                "h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
                checked
                  ? "bg-sidebar-primary border-sidebar-primary"
                  : "border-muted-foreground/40 bg-background"
              )}
            >
              {checked && <Check className="h-3 w-3 text-sidebar-primary-foreground" />}
            </div>
            <div className="flex-1 min-w-0 text-right">
              <p className={cn("text-sm font-semibold leading-tight", checked && "text-sidebar-primary")}>{m.name}</p>
              {m.role && <p className="text-xs text-muted-foreground mt-0.5">{m.role}</p>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

type PlatformPageOption = {
  id: number;
  name: string;
  reciterId?: number | null;
};

function useTaskFormPlatformPageOptions({
  platformId,
  reciterId,
  pageId,
  currentTask,
}: {
  platformId: number | null;
  reciterId: number | null;
  pageId: number | null;
  currentTask?: TaskWithDetails | null;
}) {
  const { data: pages } = useListPlatformPages(platformId ?? 0, {
    query: { queryKey: getListPlatformPagesQueryKey(platformId ?? 0), enabled: Boolean(platformId) },
  });

  return useMemo(() => {
    const visiblePages = (pages ?? [])
      .map((page: any) => ({
        id: page.id,
        name: page.name ?? `الصفحة #${page.id}`,
        reciterId: toPositiveNumber(page.reciterId),
      }))
      .filter((page) => {
        const pageReciterId = toPositiveNumber(page.reciterId);
        return pageReciterId === null || (reciterId !== null && pageReciterId === reciterId);
      });

    const currentPage = (currentTask as any)?.platformPage;
    const currentPageOption = currentPage?.id
      ? {
          id: currentPage.id,
          name: currentPage.name ?? `الصفحة الحالية #${currentPage.id}`,
          reciterId: toPositiveNumber(currentPage.reciterId),
        }
      : null;

    const selectedPageFallback =
      pageId && !visiblePages.some((page) => page.id === pageId) && currentPageOption?.id !== pageId
        ? {
            id: pageId,
            name: `الصفحة الحالية #${pageId}`,
            reciterId: null,
          }
        : null;

    return mergeById<PlatformPageOption>([
      ...visiblePages,
      currentPageOption,
      selectedPageFallback,
    ]);
  }, [pages, reciterId, pageId, currentTask]);
}

function PlatformPageSelectField({
  pageOptions,
  onLinkedReciterSelect,
}: {
  pageOptions: PlatformPageOption[];
  onLinkedReciterSelect?: (reciterId: number) => void;
}) {
  return (
    <FormField
      name="pageId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>الصفحة / القناة</FormLabel>
          <Select
            onValueChange={(value) => {
              const nextPageId = parseSelectNumberValue(value);
              field.onChange(nextPageId);
              const selectedPage = pageOptions.find((page) => page.id === nextPageId);
              const linkedReciterId = toPositiveNumber(selectedPage?.reciterId);
              if (linkedReciterId !== null) {
                onLinkedReciterSelect?.(linkedReciterId);
              }
            }}
            value={safeSelectNumberValue(field.value)}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="اختر الصفحة أو القناة" />
              </SelectTrigger>
            </FormControl>
            <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
              <SelectItem value="none">بدون تحديد صفحة</SelectItem>
              {pageOptions.map((page) => (
                <SelectItem key={page.id} value={String(page.id)}>
                  <span className="flex flex-col text-right leading-5">
                    <span>{page.name || `الصفحة #${page.id}`}</span>
                    {toPositiveNumber(page.reciterId) === null && (
                      <span className="text-[10px] text-muted-foreground">صفحة عامة</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function BasicTaskFormFields({
  platforms,
  members,
  reciters,
  allTasks,
  excludeTaskId,
  currentTask,
  showDependency = false,
}: {
  platforms: { id: number; name: string }[] | undefined;
  members: { id: number; name: string; role: string }[] | undefined;
  reciters: Reciter[] | undefined;
  allTasks?: TaskWithDetails[];
  excludeTaskId?: number;
  currentTask?: TaskWithDetails | null;
  showDependency?: boolean;
}) {
  const { watch, setValue } = useFormContext<TaskFormValues>();
  const [dependencyOpen, setDependencyOpen] = useState(false);
  const platformId = watch("platformId");
  const reciterId = watch("reciterId");
  const pageId = toPositiveNumber(watch("pageId"));
  const appPrayer = watch("appPrayer");
  const memberIds = watch("memberIds") ?? [];
  const dependsOnTaskId = watch("dependsOnTaskId");
  const seriesType = watch("seriesType") ?? "temporary";
  const recurrence = watch("recurrence") ?? "none";
  const recurrenceDays = watch("recurrenceDays") ?? "";
  const weeklyQuotaRequired = watch("weeklyQuotaRequired");

  const platformOptions = useMemo(() => {
    const currentPlatform = (currentTask as any)?.platform;
    return mergeById<{ id: number; name: string }>([
      ...(platforms ?? []),
      currentPlatform?.id ? { id: currentPlatform.id, name: currentPlatform.name ?? `المنصة الحالية #${currentPlatform.id}` } : null,
      platformId && !(platforms ?? []).some((p) => p.id === platformId)
        ? { id: platformId, name: `المنصة الحالية #${platformId}` }
        : null,
    ]);
  }, [platforms, currentTask, platformId]);

  const reciterOptions = useMemo(() => {
    const currentReciter = (currentTask as any)?.reciter as Reciter | null | undefined;
    return mergeById<Reciter>([
      ...(reciters ?? []),
      currentReciter?.id ? currentReciter : null,
      reciterId && !(reciters ?? []).some((r) => r.id === reciterId)
        ? ({ id: reciterId, name: `القارئ الحالي #${reciterId}` } as Reciter)
        : null,
    ]);
  }, [reciters, currentTask, reciterId]);

  const memberOptions = useMemo(() => {
    return mergeById<{ id: number; name: string; role: string }>([
      ...(members ?? []),
      ...taskAssignedMembers(currentTask),
    ]);
  }, [members, currentTask]);

  const pageOptions = useTaskFormPlatformPageOptions({
    platformId: toPositiveNumber(platformId),
    reciterId: toPositiveNumber(reciterId),
    pageId,
    currentTask,
  });

  const selectedPlatform = platformOptions.find((platform) => platform.id === platformId);
  const selectedPage = pageOptions.find((page) => page.id === pageId);
  const isApplicationPlatform = isApplicationPlatformName(selectedPlatform?.name);

  const dependencyOptions = useMemo(
    () => buildTaskDependencySelectOptions(allTasks, excludeTaskId, dependsOnTaskId),
    [allTasks, excludeTaskId, dependsOnTaskId]
  );

  useEffect(() => {
    if (!showDependency) {
      setValue("dependsOnTaskId", null, { shouldDirty: false });
    }
  }, [showDependency, setValue]);

  useEffect(() => {
    if (seriesType === "temporary" && recurrence !== "none") {
      setValue("recurrence", "none", { shouldDirty: false });
    }
    if (seriesType === "operational" && recurrence !== "weekly" && recurrence !== "monthly") {
      setValue("recurrence", "weekly", { shouldDirty: false });
    }
    if (seriesType === "weekly_quota") {
      if (recurrence !== "weekly") setValue("recurrence", "weekly", { shouldDirty: false });
      if (!weeklyQuotaRequired) setValue("weeklyQuotaRequired", 3, { shouldDirty: false });
    }
    if ((seriesType !== "operational" || recurrence !== "weekly") && recurrenceDays) {
      setValue("recurrenceDays", null, { shouldDirty: false });
    }
  }, [seriesType, recurrence, recurrenceDays, weeklyQuotaRequired, setValue]);

  useEffect(() => {
    const reciter = reciterOptions.find((item) => item.id === reciterId);
    const parts = isApplicationPlatform
      ? [appPrayer, reciter?.name, selectedPlatform?.name]
      : [reciter?.name ?? selectedPage?.name, selectedPlatform?.name];
    const nextTitle = parts.filter(Boolean).join(" — ") || "مهمة جديدة";
    setValue("title", nextTitle, { shouldDirty: false });
  }, [isApplicationPlatform, appPrayer, reciterId, reciterOptions, selectedPage?.name, selectedPlatform?.name, setValue]);

  return (
    <>
      <div className="rounded-md border border-green-200 bg-green-50/70 px-3 py-2 text-xs leading-6 text-green-800">
        نموذج آمن للمرحلة الأولى: يدعم المهام العادية ونطاق التاريخ والتكرار الأسبوعي/الشهري والهدف الأسبوعي، مع إبقاء الميزات المؤجلة مغلقة.
      </div>

      <FormField
        name="platformId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>المنصة</FormLabel>
            <Select
              onValueChange={(value) => {
                field.onChange(parseSelectNumberValue(value) ?? undefined);
                setValue("pageId", null, { shouldDirty: true, shouldValidate: true });
              }}
              value={safeSelectNumberValue(field.value)}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="اختر المنصة" />
                </SelectTrigger>
              </FormControl>
              <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                <SelectItem value="none" disabled>
                  اختر المنصة
                </SelectItem>
                {platformOptions.map((platform) => (
                  <SelectItem key={platform.id} value={String(platform.id)}>
                    <span className="flex items-center gap-2">
                      <PlatformIcon name={platform.name} />
                      <span>{platform.name || `المنصة #${platform.id}`}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        name="reciterId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>القارئ</FormLabel>
            <Select
              onValueChange={(value) => {
                const nextReciterId = parseSelectNumberValue(value);
                field.onChange(nextReciterId);
                const selectedPageReciterId = toPositiveNumber(selectedPage?.reciterId);
                if (selectedPageReciterId !== null && selectedPageReciterId !== nextReciterId) {
                  setValue("pageId", null, { shouldDirty: true, shouldValidate: true });
                }
              }}
              value={safeSelectNumberValue(field.value)}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="اختر القارئ" />
                </SelectTrigger>
              </FormControl>
              <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                <SelectItem value="none">بدون قارئ</SelectItem>
                {reciterOptions.map((reciter) => (
                  <SelectItem key={reciter.id} value={String(reciter.id)}>
                    {reciter.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {!isApplicationPlatform && toPositiveNumber(platformId) !== null && pageOptions.length > 0 && (
        <PlatformPageSelectField
          pageOptions={pageOptions}
          onLinkedReciterSelect={(linkedReciterId) =>
            setValue("reciterId", linkedReciterId, { shouldDirty: true, shouldValidate: true })
          }
        />
      )}

      {isApplicationPlatform && (
        <FormField
          name="appPrayer"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <CalendarClock className="h-3.5 w-3.5 text-sidebar-primary" />
                الصلاة
              </FormLabel>
              <Select
                onValueChange={(value) => field.onChange(value === "none" ? null : value)}
                value={field.value ?? "none"}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الصلاة" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                  <SelectItem value="none">اختر الصلاة</SelectItem>
                  {APP_PRAYER_OPTIONS.map((prayer) => (
                    <SelectItem key={prayer} value={prayer}>
                      {prayer}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        name="memberIds"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5" />
              العضو / المسؤول
              {field.value?.length > 0 && (
                <span className="text-xs text-sidebar-primary font-semibold">
                  ({field.value.length} مختار)
                </span>
              )}
            </FormLabel>
            <MemberMultiSelect
              members={memberOptions}
              value={field.value ?? []}
              onChange={field.onChange}
            />
            <FormMessage />
          </FormItem>
        )}
      />

      <TaskDescriptionField />

      <div className="space-y-3 border border-border/60 rounded-lg p-3 bg-muted/20">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5" />
          تاريخ المهمة
        </p>

        <FormField
          name="seriesType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>نوع المهمة</FormLabel>
              <Select onValueChange={field.onChange} value={normalizeTaskSeriesType(field.value)}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر نوع المهمة" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl">
                  <SelectItem value="temporary">مهمة مؤقتة</SelectItem>
                  <SelectItem value="operational">مهمة تشغيلية متكررة</SelectItem>
                  <SelectItem value="weekly_quota">هدف أسبوعي بعدد مرات</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {seriesType === "operational" && (
          <FormField
            name="recurrence"
            render={({ field }) => (
              <FormItem>
                <FormLabel>نوع التكرار</FormLabel>
                <Select onValueChange={field.onChange} value={field.value === "monthly" ? "monthly" : "weekly"}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر التكرار" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl">
                    <SelectItem value="weekly">أسبوعي - كل أسبوع</SelectItem>
                    <SelectItem value="monthly">شهري - كل شهر</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {seriesType === "operational" && recurrence === "weekly" && (
          <FormField
            name="recurrenceDays"
            render={({ field }) => {
              const selectedDays = new Set((field.value ?? "").split(",").filter(Boolean));
              const toggleDay = (day: string) => {
                const next = new Set(selectedDays);
                if (next.has(day)) {
                  next.delete(day);
                } else {
                  next.add(day);
                }
                const value = [...next].sort((a, b) => Number(a) - Number(b)).join(",");
                field.onChange(value || null);
              };

              return (
                <FormItem>
                  <FormLabel>أيام التكرار الأسبوعي <span className="text-xs text-muted-foreground">(اختياري)</span></FormLabel>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const checked = selectedDays.has(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => toggleDay(day.value)}
                          className={cn(
                            "h-10 rounded-md border text-sm font-semibold transition-colors flex items-center justify-center gap-1.5",
                            checked
                              ? "bg-sidebar-primary text-sidebar-primary-foreground border-sidebar-primary"
                              : "bg-background text-foreground border-input hover:bg-muted"
                          )}
                        >
                          {checked && <Check className="h-3.5 w-3.5" />}
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        )}

        {seriesType === "weekly_quota" && (
          <FormField
            name="weeklyQuotaRequired"
            render={({ field }) => (
              <FormItem>
                <FormLabel>عدد مرات الإنجاز في الأسبوع</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={field.value ?? 3}
                    onChange={(event) => field.onChange(event.target.value ? Number(event.target.value) : null)}
                    placeholder="مثال: 3"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className={cn("grid gap-3", seriesType === "temporary" ? "grid-cols-2" : "grid-cols-1")}>
          <FormField
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-1">
                  البداية <span className="text-[10px] text-red-500 font-normal">مطلوب</span>
                </FormLabel>
                <FormControl>
                  <DatePickerInput
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="اختر تاريخاً"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {seriesType === "temporary" && (
            <FormField
              name="endDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1">
                    النهاية <span className="text-[10px] text-muted-foreground font-normal">(اختياري)</span>
                  </FormLabel>
                  <FormControl>
                    <DatePickerInput
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="اختر تاريخاً"
                      optional
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        <p className="text-[10px] text-sidebar-primary bg-sidebar-primary/5 border border-sidebar-primary/20 rounded px-2.5 py-1.5">
          {seriesType === "operational"
            ? recurrence === "monthly"
              ? "ينشئ النظام مهاماً مستقلة شهرياً ضمن نافذة 60 يوماً قادمة."
              : "ينشئ النظام مهاماً مستقلة أسبوعياً ضمن نافذة 60 يوماً قادمة."
            : seriesType === "weekly_quota"
              ? "ينشئ النظام مهمة واحدة لكل أسبوع، ويضيف العضو الشواهد حتى يصل إلى العدد المطلوب."
              : "إذا تركت النهاية فارغة تُنشأ مهمة ليوم واحد. وإذا اخترت نهاية، ينشئ النظام مهمة مستقلة لكل يوم."}
        </p>
      </div>

      {showDependency && (
        <Collapsible
          open={dependencyOpen}
          onOpenChange={setDependencyOpen}
          className="rounded-lg border border-border/60 bg-muted/10"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right transition-colors hover:bg-muted/30"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-sidebar-foreground">
                <Link2 className="h-4 w-4 text-sidebar-primary" />
                المهام المرتبطة
              </span>
              {dependencyOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 px-3 pb-3">
            <FormField
              name="dependsOnTaskId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    تعتمد على مهمة سابقة
                    <span className="mr-1 text-xs font-normal text-muted-foreground">(اختياري)</span>
                  </FormLabel>
                  <FormControl>
                    <DependencyTaskPicker
                      value={field.value}
                      onChange={field.onChange}
                      options={dependencyOptions}
                    />
                  </FormControl>
                  <p className="text-[10px] leading-5 text-muted-foreground">
                    عند اكتمال المهمة السابقة يصل تنبيه Telegram لمسؤول هذه المهمة. لا يتم قفل المهمة ولا تغيير حالتها.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CollapsibleContent>
        </Collapsible>
      )}

  </>
  );
}

function EditTaskFormFields({
  platforms,
  members,
  reciters,
  allTasks,
  excludeTaskId,
  currentTask,
  showDependency = false,
}: {
  platforms: { id: number; name: string }[] | undefined;
  members: { id: number; name: string; role: string }[] | undefined;
  reciters: Reciter[] | undefined;
  allTasks?: TaskWithDetails[];
  excludeTaskId?: number;
  currentTask?: TaskWithDetails | null;
  showDependency?: boolean;
}) {
  const { watch, setValue } = useFormContext<TaskFormValues>();
  const [dependencyOpen, setDependencyOpen] = useState(false);

  const platformId = toPositiveNumber(watch("platformId"));
  const reciterId = toPositiveNumber(watch("reciterId"));
  const pageId = toPositiveNumber(watch("pageId"));
  const memberIds = Array.isArray(watch("memberIds"))
    ? (watch("memberIds") ?? []).filter((id) => Boolean(toPositiveNumber(id)))
    : [];
  const dependsOnTaskId = toPositiveNumber(watch("dependsOnTaskId"));
  const seriesType = normalizeTaskSeriesType(watch("seriesType"));
  const recurrence = normalizeTaskRecurrence(watch("recurrence"));
  const recurrenceDays = typeof watch("recurrenceDays") === "string" ? watch("recurrenceDays") ?? "" : "";
  const weeklyQuotaRequired = toPositiveNumber(watch("weeklyQuotaRequired")) ?? 3;

  const platformOptions = useMemo(() => {
    const currentPlatform = (currentTask as any)?.platform;
    return mergeById<{ id: number; name: string }>([
      ...(platforms ?? []),
      currentPlatform?.id ? { id: currentPlatform.id, name: currentPlatform.name ?? `المنصة الحالية #${currentPlatform.id}` } : null,
      platformId && !(platforms ?? []).some((platform) => platform.id === platformId)
        ? { id: platformId, name: `المنصة الحالية #${platformId}` }
        : null,
    ]);
  }, [platforms, currentTask, platformId]);

  const reciterOptions = useMemo(() => {
    const currentReciter = (currentTask as any)?.reciter as Reciter | null | undefined;
    return mergeById<Reciter>([
      ...(reciters ?? []),
      currentReciter?.id ? currentReciter : null,
      reciterId && !(reciters ?? []).some((reciter) => reciter.id === reciterId)
        ? ({ id: reciterId, name: `القارئ الحالي #${reciterId}` } as Reciter)
        : null,
    ]);
  }, [reciters, currentTask, reciterId]);

  const memberOptions = useMemo(() => {
    return mergeById<{ id: number; name: string; role: string }>([
      ...(members ?? []),
      ...taskAssignedMembers(currentTask),
    ]);
  }, [members, currentTask]);

  const pageOptions = useTaskFormPlatformPageOptions({
    platformId,
    reciterId,
    pageId,
    currentTask,
  });

  const dependencyOptions = useMemo(
    () => buildTaskDependencySelectOptions(allTasks, excludeTaskId, dependsOnTaskId),
    [allTasks, excludeTaskId, dependsOnTaskId]
  );

  const selectedPlatform = platformOptions.find((platform) => platform.id === platformId);
  const selectedPage = pageOptions.find((page) => page.id === pageId);
  const isApplicationPlatform = isApplicationPlatformName(selectedPlatform?.name);

  const editWarnings = [
    !platformId ? "هذه المهمة لا تحتوي منصة محفوظة؛ اختر منصة قبل الحفظ." : null,
    memberIds.length === 0 ? "هذه المهمة لا تحتوي مسؤولًا محفوظًا؛ اختر مسؤولًا قبل الحفظ." : null,
  ].filter(Boolean);

  return (
    <>
      {editWarnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-6 text-amber-800">
          {editWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      <FormField
        name="platformId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>المنصة</FormLabel>
            <Select
              onValueChange={(value) => {
                field.onChange(parseSelectNumberValue(value) ?? undefined);
                setValue("pageId", null, { shouldDirty: true, shouldValidate: true });
              }}
              value={safeSelectNumberValue(field.value)}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="اختر المنصة" />
                </SelectTrigger>
              </FormControl>
              <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                <SelectItem value="none" disabled>
                  اختر المنصة
                </SelectItem>
                {platformOptions.map((platform) => (
                  <SelectItem key={platform.id} value={String(platform.id)}>
                    <span className="flex items-center gap-2">
                      <PlatformIcon name={platform.name} />
                      <span>{platform.name || `المنصة #${platform.id}`}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        name="reciterId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>القارئ</FormLabel>
            <Select
              onValueChange={(value) => {
                const nextReciterId = parseSelectNumberValue(value);
                field.onChange(nextReciterId);
                const selectedPageReciterId = toPositiveNumber(selectedPage?.reciterId);
                if (selectedPageReciterId !== null && selectedPageReciterId !== nextReciterId) {
                  setValue("pageId", null, { shouldDirty: true, shouldValidate: true });
                }
              }}
              value={safeSelectNumberValue(field.value)}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="اختر القارئ" />
                </SelectTrigger>
              </FormControl>
              <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                <SelectItem value="none">بدون قارئ</SelectItem>
                {reciterOptions.map((reciter) => (
                  <SelectItem key={reciter.id} value={String(reciter.id)}>
                    {reciter.name || `القارئ #${reciter.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {!isApplicationPlatform && platformId !== null && pageOptions.length > 0 && (
        <PlatformPageSelectField
          pageOptions={pageOptions}
          onLinkedReciterSelect={(linkedReciterId) =>
            setValue("reciterId", linkedReciterId, { shouldDirty: true, shouldValidate: true })
          }
        />
      )}

      {isApplicationPlatform && (
        <FormField
          name="appPrayer"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <CalendarClock className="h-3.5 w-3.5 text-sidebar-primary" />
                الصلاة
              </FormLabel>
              <Select
                onValueChange={(value) => field.onChange(value === "none" ? null : value)}
                value={field.value ?? "none"}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الصلاة" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                  <SelectItem value="none">اختر الصلاة</SelectItem>
                  {APP_PRAYER_OPTIONS.map((prayer) => (
                    <SelectItem key={prayer} value={prayer}>
                      {prayer}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        name="memberIds"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5" />
              العضو / المسؤول
              {memberIds.length > 0 && (
                <span className="text-xs text-sidebar-primary font-semibold">
                  ({memberIds.length} مختار)
                </span>
              )}
            </FormLabel>
            <MemberMultiSelect
              members={memberOptions}
              value={memberIds}
              onChange={field.onChange}
            />
            <FormMessage />
          </FormItem>
        )}
      />

      <TaskDescriptionField />

      <div className="space-y-3 border border-border/60 rounded-lg p-3 bg-muted/20">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5" />
          تاريخ المهمة
        </p>

        <FormField
          name="seriesType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>نوع المهمة</FormLabel>
              <Select onValueChange={field.onChange} value={seriesType}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر نوع المهمة" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl">
                  <SelectItem value="temporary">مهمة مؤقتة</SelectItem>
                  <SelectItem value="operational">مهمة تشغيلية متكررة</SelectItem>
                  <SelectItem value="weekly_quota">هدف أسبوعي بعدد مرات</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {seriesType === "operational" && (
          <FormField
            name="recurrence"
            render={({ field }) => (
              <FormItem>
                <FormLabel>نوع التكرار</FormLabel>
                <Select onValueChange={field.onChange} value={recurrence === "monthly" ? "monthly" : "weekly"}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر التكرار" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl">
                    <SelectItem value="weekly">أسبوعي - كل أسبوع</SelectItem>
                    <SelectItem value="monthly">شهري - كل شهر</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {seriesType === "operational" && recurrence === "weekly" && (
          <FormField
            name="recurrenceDays"
            render={({ field }) => {
              const selectedDays = new Set(recurrenceDays.split(",").filter(Boolean));
              const toggleDay = (day: string) => {
                const next = new Set(selectedDays);
                if (next.has(day)) {
                  next.delete(day);
                } else {
                  next.add(day);
                }
                const value = [...next].sort((a, b) => Number(a) - Number(b)).join(",");
                field.onChange(value || null);
              };

              return (
                <FormItem>
                  <FormLabel>أيام التكرار الأسبوعي <span className="text-xs text-muted-foreground">(اختياري)</span></FormLabel>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const checked = selectedDays.has(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => toggleDay(day.value)}
                          className={cn(
                            "h-10 rounded-md border text-sm font-semibold transition-colors flex items-center justify-center gap-1.5",
                            checked
                              ? "bg-sidebar-primary text-sidebar-primary-foreground border-sidebar-primary"
                              : "bg-background text-foreground border-input hover:bg-muted"
                          )}
                        >
                          {checked && <Check className="h-3.5 w-3.5" />}
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        )}

        {seriesType === "weekly_quota" && (
          <FormField
            name="weeklyQuotaRequired"
            render={({ field }) => (
              <FormItem>
                <FormLabel>عدد مرات الإنجاز في الأسبوع</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={weeklyQuotaRequired}
                    onChange={(event) => field.onChange(event.target.value ? Number(event.target.value) : null)}
                    placeholder="مثال: 3"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className={cn("grid gap-3", seriesType === "temporary" ? "grid-cols-2" : "grid-cols-1")}>
          <FormField
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-1">
                  البداية <span className="text-[10px] text-red-500 font-normal">مطلوب</span>
                </FormLabel>
                <FormControl>
                  <DatePickerInput
                    value={typeof field.value === "string" ? field.value : ""}
                    onChange={field.onChange}
                    placeholder="اختر تاريخاً"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {seriesType === "temporary" && (
            <FormField
              name="endDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1">
                    النهاية <span className="text-[10px] text-muted-foreground font-normal">(اختياري)</span>
                  </FormLabel>
                  <FormControl>
                    <DatePickerInput
                      value={typeof field.value === "string" ? field.value : ""}
                      onChange={field.onChange}
                      placeholder="اختر تاريخاً"
                      optional
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        <p className="text-[10px] text-sidebar-primary bg-sidebar-primary/5 border border-sidebar-primary/20 rounded px-2.5 py-1.5">
          هذا مسار تعديل آمن: يحافظ على بيانات المهمة الحالية، ويتعامل مع الحقول الناقصة دون إغلاق النافذة.
        </p>
      </div>

      {showDependency && (
        <Collapsible
          open={dependencyOpen}
          onOpenChange={setDependencyOpen}
          className="rounded-lg border border-border/60 bg-muted/10"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right transition-colors hover:bg-muted/30"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-sidebar-foreground">
                <Link2 className="h-4 w-4 text-sidebar-primary" />
                المهام المرتبطة
              </span>
              {dependencyOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 px-3 pb-3">
            <FormField
              name="dependsOnTaskId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    تعتمد على مهمة سابقة
                    <span className="mr-1 text-xs font-normal text-muted-foreground">(اختياري)</span>
                  </FormLabel>
                  <FormControl>
                    <DependencyTaskPicker
                      value={field.value}
                      onChange={field.onChange}
                      options={dependencyOptions}
                    />
                  </FormControl>
                  <p className="text-[10px] leading-5 text-muted-foreground">
                    عند اكتمال المهمة السابقة يصل تنبيه Telegram لمسؤول هذه المهمة. لا يتم قفل المهمة ولا تغيير حالتها.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}


function TaskFormFields({
  platforms,
  members,
  reciters,
  showStatus,
  allTasks,
  excludeTaskId,
  currentTask,
  isMemberSelfTask = false,
  currentMemberName,
  showDependency = false,
}: {
  platforms: { id: number; name: string }[] | undefined;
  members: { id: number; name: string; role: string }[] | undefined;
  reciters: Reciter[] | undefined;
  showStatus?: boolean;
  allTasks?: TaskWithDetails[];
  excludeTaskId?: number;
  currentTask?: TaskWithDetails | null;
  isMemberSelfTask?: boolean;
  currentMemberName?: string | null;
  showDependency?: boolean;
}) {
  const { watch, setValue, getValues } = useFormContext<TaskFormValues>();
  const platformId = watch("platformId");
  const reciterId = watch("reciterId");
  const pageId = watch("pageId");
  const memberIds = watch("memberIds") ?? [];
  const appPrayer = watch("appPrayer");
  const dependsOnTaskId = watch("dependsOnTaskId");
  const seriesType = watch("seriesType") ?? "temporary";
  const recurrence = watch("recurrence") ?? "none";
  const recurrenceDays = watch("recurrenceDays") ?? "";
  const weeklyQuotaRequired = watch("weeklyQuotaRequired");
  const platformOptions = useMemo(() => {
    const currentPlatform = (currentTask as any)?.platform;
    return mergeById<{ id: number; name: string }>([
      ...(platforms ?? []),
      currentPlatform?.id ? { id: currentPlatform.id, name: currentPlatform.name ?? `المنصة الحالية #${currentPlatform.id}` } : null,
      platformId && !(platforms ?? []).some((p) => p.id === platformId)
        ? { id: platformId, name: `المنصة الحالية #${platformId}` }
        : null,
    ]);
  }, [platforms, currentTask, platformId]);
  const selectedPlatform = platformOptions.find((p) => p.id === platformId);
  const isApplicationPlatform = isApplicationPlatformName(selectedPlatform?.name);
  const applicationReciters = useMemo(
    () => mergeById<Reciter>([
      ...(reciters?.filter((r) => !isPlaceholderApplicationReciter(r.name)) ?? []),
      (() => {
        const currentReciter = (currentTask as any)?.reciter as Reciter | null | undefined;
        return currentReciter && !isPlaceholderApplicationReciter(currentReciter.name) ? currentReciter : null;
      })(),
    ]),
    [reciters, currentTask]
  );
  const dependencyOptions = useMemo(
    () => buildTaskDependencySelectOptions(allTasks, excludeTaskId, dependsOnTaskId),
    [allTasks, excludeTaskId, dependsOnTaskId]
  );
  const previousPlatformIdRef = useRef<number | undefined>(undefined);

  const { data: pages } = useListPlatformPages(platformId ?? 0, {
    query: { queryKey: getListPlatformPagesQueryKey(platformId ?? 0), enabled: !!platformId },
  });

  const selectedApplicationPage = useMemo(
    () => pages?.find((pg) => pg.reciterId === reciterId),
    [pages, reciterId]
  );
  const pageOptions = useMemo(() => {
    const currentPageId = taskPageId(currentTask);
    return mergeById<{ id: number; name: string; reciterId?: number | null }>([
      ...(pages ?? []),
      currentPageId
        ? {
            id: currentPageId,
            name: `الصفحة الحالية #${currentPageId}`,
            reciterId: taskReciterId(currentTask),
          }
        : null,
      pageId && !(pages ?? []).some((pg) => pg.id === pageId)
        ? {
            id: pageId,
            name: `الصفحة الحالية #${pageId}`,
            reciterId: taskReciterId(currentTask),
          }
        : null,
    ]);
  }, [pages, currentTask, pageId]);

  const { data: pageMembers } = useQuery<number[]>({
    queryKey: ["page-members", platformId, pageId],
    queryFn: async () => {
      if (!platformId || !pageId) return [];
      const r = await fetch(`/api/platforms/${platformId}/pages/${pageId}/members`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!platformId && !!pageId,
  });

  const filteredMembers = useMemo(() => {
    const baseMembers = (() => {
      if (isApplicationPlatform) return members ?? [];
      if (!pageId || pageMembers === undefined) return members ?? [];
      if (pageMembers.length === 0) return [];
      return (members ?? []).filter((m) => pageMembers.includes(m.id));
    })();
    const currentAssigned = taskAssignedMembers(currentTask).filter((member) => memberIds.includes(member.id));
    const selectedFromAllMembers = (members ?? []).filter((member) => memberIds.includes(member.id));
    return mergeById<{ id: number; name: string; role: string }>([
      ...baseMembers,
      ...currentAssigned,
      ...selectedFromAllMembers,
    ]);
  }, [isApplicationPlatform, members, pageId, pageMembers, currentTask, memberIds]);

  useEffect(() => {
    if (previousPlatformIdRef.current === undefined) {
      previousPlatformIdRef.current = platformId;
      return;
    }
    if (previousPlatformIdRef.current === platformId) return;
    previousPlatformIdRef.current = platformId;
    setValue("pageId", null);
    setValue("reciterId", null);
    if (!isMemberSelfTask) setValue("memberIds", []);
    setValue("appPrayer", null);
  }, [platformId, isMemberSelfTask, setValue]);

  useEffect(() => {
    if (isMemberSelfTask) {
      if (seriesType !== "temporary") setValue("seriesType", "temporary");
      if (recurrence !== "none") setValue("recurrence", "none");
      if (weeklyQuotaRequired) setValue("weeklyQuotaRequired", null);
      if (recurrenceDays) setValue("recurrenceDays", null);
      setValue("endDate", "");
      setValue("dependsOnTaskId", null);
      return;
    }
    if (seriesType === "temporary" && recurrence !== "none") {
      setValue("recurrence", "none");
    }
    if (seriesType === "operational" && recurrence !== "weekly" && recurrence !== "monthly") {
      setValue("recurrence", "weekly");
    }
    if (seriesType === "weekly_quota") {
      if (recurrence !== "weekly") setValue("recurrence", "weekly");
      if (!weeklyQuotaRequired) setValue("weeklyQuotaRequired", 3);
    }
    if ((seriesType !== "operational" || recurrence !== "weekly") && recurrenceDays) {
      setValue("recurrenceDays", null);
    }
  }, [isMemberSelfTask, seriesType, recurrence, recurrenceDays, weeklyQuotaRequired, setValue]);

  // Auto-set reciterId from page when page changes
  useEffect(() => {
    if (pageId && pageOptions) {
      const page = pageOptions.find((pg) => pg.id === pageId);
      if (page?.reciterId) {
        setValue("reciterId", page.reciterId);
      }
    }
  }, [pageId, pageOptions, setValue]);

  useEffect(() => {
    if (!isApplicationPlatform || !reciterId || pages === undefined) return;
    const currentPageId = taskPageId(currentTask);
    const currentReciterId = taskReciterId(currentTask);
    if (selectedApplicationPage?.id) {
      setValue("pageId", selectedApplicationPage.id);
    } else if (currentPageId && currentReciterId === reciterId) {
      setValue("pageId", currentPageId);
    } else {
      setValue("pageId", null);
    }
  }, [isApplicationPlatform, reciterId, selectedApplicationPage?.id, pages, currentTask, setValue]);

  useEffect(() => {
    if (isMemberSelfTask) return;
    if (!isApplicationPlatform || !pageId || !pageMembers || pageMembers.length === 0 || memberIds.length > 0) return;
    setValue("memberIds", pageMembers);
  }, [isMemberSelfTask, isApplicationPlatform, pageId, pageMembers, memberIds.length, setValue]);

  useEffect(() => {
    const platform = platformOptions.find((p) => p.id === platformId);
    const reciter =
      reciters?.find((r) => r.id === reciterId) ??
      applicationReciters.find((r) => r.id === reciterId) ??
      ((currentTask as any)?.reciter?.id === reciterId ? ((currentTask as any).reciter as Reciter) : undefined);
    const page = pageOptions.find((pg) => pg.id === pageId);
    let nextTitle = "مهمة جديدة";
    if (isApplicationPlatform) {
      const parts = [appPrayer, reciter?.name, platform?.name].filter(Boolean) as string[];
      nextTitle = parts.join(" — ") || "مهمة جديدة";
    } else {
      const location = page?.name || platform?.name || "";
      const parts: string[] = [];
      if (location) parts.push(location);
      if (reciter?.name) parts.push(reciter.name);
      nextTitle = parts.join(" — ") || "مهمة جديدة";
    }
    if (getValues("title") !== nextTitle) {
      setValue("title", nextTitle, { shouldDirty: false });
    }
  }, [platformId, reciterId, pageId, appPrayer, isApplicationPlatform, platformOptions, reciters, applicationReciters, currentTask, pageOptions, setValue, getValues]);

  return (
    <>
      <FormField
        name="platformId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>المنصة</FormLabel>
            <Select
              onValueChange={(v) => field.onChange(parseSelectNumberValue(v) ?? undefined)}
              value={safeSelectNumberValue(field.value)}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="اختر المنصة" />
                </SelectTrigger>
              </FormControl>
              <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                <SelectItem value="none" disabled>
                  <span className="text-muted-foreground">اختر المنصة</span>
                </SelectItem>
                {platformOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id.toString()}>
                    <span className="flex items-center gap-2">
                      <PlatformIcon name={p.name} />
                      <span>{p.name || `المنصة #${p.id}`}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {isApplicationPlatform ? (
        <>
          <FormField
            name="reciterId"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <BookOpen className="h-3.5 w-3.5 text-sidebar-primary" />
                  القارئ داخل التطبيق
                </FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(parseSelectNumberValue(v))}
                  value={safeSelectNumberValue(field.value)}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر القارئ" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                    <SelectItem value="none">
                      <span className="text-muted-foreground">اختر القارئ</span>
                    </SelectItem>
                    {applicationReciters.map((r) => (
                      <SelectItem key={r.id} value={r.id.toString()}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            name="appPrayer"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <CalendarClock className="h-3.5 w-3.5 text-sidebar-primary" />
                  الصلاة
                </FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(v === "none" ? null : v)}
                  value={field.value ?? "none"}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر الصلاة" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                    <SelectItem value="none">
                      <span className="text-muted-foreground">اختر الصلاة</span>
                    </SelectItem>
                    {APP_PRAYER_OPTIONS.map((prayer) => (
                      <SelectItem key={prayer} value={prayer}>
                        {prayer}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      ) : pageOptions.length > 0 ? (
        <FormField
          name="pageId"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <LayoutList className="h-3.5 w-3.5 text-sidebar-primary" />
                الصفحة / القناة
              </FormLabel>
              <Select
                onValueChange={(v) => field.onChange(parseSelectNumberValue(v))}
                value={safeSelectNumberValue(field.value)}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الصفحة (اختياري)" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">بدون تحديد صفحة</span>
                  </SelectItem>
                  {pageOptions.map((pg) => (
                    <SelectItem key={pg.id} value={pg.id.toString()}>
                      {pg.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : null}

      {/* Display-only reciter from selected page */}
      {!isApplicationPlatform && (() => {
	        const page = pageOptions.find((pg) => pg.id === pageId);
        const displayReciter =
          reciters?.find((r) => r.id === page?.reciterId) ??
          ((currentTask as any)?.reciter?.id === page?.reciterId ? ((currentTask as any).reciter as Reciter) : undefined);
        return displayReciter ? (
          <div className="flex items-center gap-2 p-2.5 rounded-md bg-sidebar-primary/5 border border-sidebar-primary/20 text-sm">
            <BookOpen className="h-4 w-4 text-sidebar-primary shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground">القارئ</p>
              <p className="font-semibold text-sidebar-primary">{displayReciter.name}</p>
            </div>
          </div>
        ) : null;
      })()}

      {isMemberSelfTask ? (
        <div className="rounded-md border border-green-200 bg-green-50/60 px-4 py-3 text-sm font-semibold text-green-800">
          ستُسند هذه المهمة لك فقط: {currentMemberName ?? "حسابي"}
        </div>
      ) : (
        <FormField
          name="memberIds"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5" />
                المسؤول عن الإضافة
                {field.value?.length > 0 && (
                  <span className="text-xs text-sidebar-primary font-semibold">
                    ({field.value.length} مختار)
                  </span>
                )}
              </FormLabel>
              <MemberMultiSelect
                members={filteredMembers as { id: number; name: string; role: string }[]}
                value={field.value ?? []}
                onChange={field.onChange}
              />
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <TaskDescriptionField compact />

      {showDependency && (
        <FormField
          name="dependsOnTaskId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>تعتمد على مهمة سابقة <span className="text-xs text-muted-foreground">(اختياري)</span></FormLabel>
              <FormControl>
                <DependencyTaskPicker
                  value={field.value}
                  onChange={field.onChange}
                  options={dependencyOptions}
                />
              </FormControl>
              <p className="text-[10px] text-muted-foreground">
                عند اكتمال المهمة السابقة يصل تنبيه Telegram لمسؤول هذه المهمة.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <div className="space-y-3 border border-border/60 rounded-lg p-3 bg-muted/20">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5" />
          تاريخ المهمة
        </p>
        {!isMemberSelfTask && (
          <FormField
            name="seriesType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>نوع المهمة</FormLabel>
                <Select onValueChange={field.onChange} value={normalizeTaskSeriesType(field.value)}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر نوع المهمة" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl">
                    <SelectItem value="temporary">مهمة مؤقتة</SelectItem>
                    <SelectItem value="operational">مهمة تشغيلية متكررة</SelectItem>
                    <SelectItem value="weekly_quota">هدف أسبوعي بعدد مرات</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {seriesType === "operational" && (
          <FormField
            name="recurrence"
            render={({ field }) => (
              <FormItem>
                <FormLabel>نوع التكرار</FormLabel>
                <Select onValueChange={field.onChange} value={field.value === "monthly" ? "monthly" : "weekly"}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر التكرار" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl">
                    <SelectItem value="weekly">
                      <span className="flex items-center gap-2">
                        <Repeat2 className="h-3.5 w-3.5 text-blue-500" />
                        أسبوعي - كل أسبوع في نفس اليوم
                      </span>
                    </SelectItem>
                    <SelectItem value="monthly">
                      <span className="flex items-center gap-2">
                        <Repeat2 className="h-3.5 w-3.5 text-purple-500" />
                        شهري - كل شهر في نفس التاريخ
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {seriesType === "operational" && recurrence === "weekly" && (
          <FormField
            name="recurrenceDays"
            render={({ field }) => {
              const selectedDays = new Set((field.value ?? "").split(",").filter(Boolean));
              const toggleDay = (day: string) => {
                const next = new Set(selectedDays);
                if (next.has(day)) {
                  next.delete(day);
                } else {
                  next.add(day);
                }
                const value = [...next].sort((a, b) => Number(a) - Number(b)).join(",");
                field.onChange(value || null);
              };

              return (
                <FormItem>
                  <FormLabel>أيام التكرار الأسبوعي <span className="text-xs text-muted-foreground">(اختياري)</span></FormLabel>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {WEEKDAY_OPTIONS.map((day) => {
                      const checked = selectedDays.has(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => toggleDay(day.value)}
                          className={cn(
                            "h-10 rounded-md border text-sm font-semibold transition-colors flex items-center justify-center gap-1.5",
                            checked
                              ? "bg-sidebar-primary text-sidebar-primary-foreground border-sidebar-primary"
                              : "bg-background text-foreground border-input hover:bg-muted"
                          )}
                        >
                          {checked && <Check className="h-3.5 w-3.5" />}
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        )}
        {seriesType === "weekly_quota" && (
          <FormField
            name="weeklyQuotaRequired"
            render={({ field }) => (
              <FormItem>
                <FormLabel>عدد مرات الإنجاز في الأسبوع</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={field.value ?? 3}
                    onChange={(event) => field.onChange(event.target.value ? Number(event.target.value) : null)}
                    placeholder="مثال: 3"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <div className={cn("grid gap-3", isMemberSelfTask || seriesType === "operational" || seriesType === "weekly_quota" ? "grid-cols-1" : "grid-cols-2")}>
        <FormField
          name="startDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-1">
                البداية <span className="text-[10px] text-red-500 font-normal">مطلوب</span>
              </FormLabel>
              <FormControl>
                <DatePickerInput
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  placeholder="اختر تاريخاً"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {!isMemberSelfTask && seriesType === "temporary" && (
          <FormField
            name="endDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-1">
                  النهاية <span className="text-[10px] text-muted-foreground font-normal">(اختياري)</span>
                </FormLabel>
                <FormControl>
                  <DatePickerInput
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    placeholder="اختر تاريخاً"
                    optional
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        </div>
        <p className="text-[10px] text-sidebar-primary bg-sidebar-primary/5 border border-sidebar-primary/20 rounded px-2.5 py-1.5">
          {seriesType === "operational"
            ? recurrence === "monthly"
              ? "ينشئ النظام مهاماً مستقلة شهرياً في نفس تاريخ البداية ضمن نافذة 60 يوماً قادمة."
              : "ينشئ النظام مهاماً مستقلة أسبوعياً في نفس يوم البداية ضمن نافذة 60 يوماً قادمة."
            : seriesType === "weekly_quota"
              ? "ينشئ النظام مهمة واحدة لكل أسبوع. يضيف العضو الشواهد حتى يصل إلى العدد المطلوب، ثم تكتمل المهمة تلقائياً، ويمكنه إضافة شواهد إضافية بعدها دون تغيير العدد المطلوب."
            : isMemberSelfTask
              ? "هذه مهمة مقطوعة ليوم واحد، تظهر للمدير والتقارير ويمكنك إضافة شاهد لها وإكمالها."
              : "إذا تركت النهاية فارغة تُنشأ مهمة ليوم واحد فقط. وإذا اخترت نهاية، ينشئ النظام مهمة مستقلة لكل يوم من البداية حتى النهاية، ولكل يوم شاهد وزر إتمام مستقل."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField
          name="priority"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-1.5">
                <Flame className="h-3.5 w-3.5 text-red-500" />
                الأولوية
              </FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? "normal"}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="عادي" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl">
                  <SelectItem value="urgent">
                    <span className="flex items-center gap-2">
                      <Flame className="h-3.5 w-3.5 text-red-500" />
                      عاجل
                    </span>
                  </SelectItem>
                  <SelectItem value="normal">
                    <span className="flex items-center gap-2">
                      <Minus className="h-3.5 w-3.5 text-blue-500" />
                      عادي
                    </span>
                  </SelectItem>
                  <SelectItem value="low">
                    <span className="flex items-center gap-2">
                      <ArrowDown className="h-3.5 w-3.5 text-gray-400" />
                      منخفض
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        {showStatus && (
          <FormField
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>الحالة</FormLabel>
                <Select onValueChange={field.onChange} value={normalizeTaskStatus(field.value)}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="الحالة" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl">
                    <SelectItem value="pending">قيد الانتظار</SelectItem>
                    <SelectItem value="completed">مكتمل</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Grouped by Reciter view
// ──────────────────────────────────────────────────────────────────────────────
function ReciterGroupedView({
  tasks,
  reciters,
  filterPlatform,
  filterMosque,
  onEdit,
  onDelete,
  onStatusChange,
  updateTaskPending,
}: {
  tasks: TaskWithDetails[] | undefined;
  reciters: Reciter[] | undefined;
  filterPlatform: string;
  filterMosque: string;
  onEdit: (t: TaskWithDetails) => void;
  onDelete: (id: number) => void;
  onStatusChange: (id: number, status: TaskStatus) => void;
  updateTaskPending: boolean;
}) {
  const { showHijri } = useHijriPreference();
  if (!tasks) return null;

  // Filter tasks
  const filtered = tasks.filter((t) => {
    if (filterPlatform !== "all") {
      const platformId = Number(filterPlatform);
      if (!Number.isFinite(platformId)) return false;
      if (t.platform?.id !== platformId) return false;
    }
    if (filterMosque !== "all") {
      const reciter = t.reciter as Reciter | null | undefined;
      if (!reciter || reciter.mosque !== filterMosque) return false;
    }
    return true;
  });

  // Group by mosque → reciter
  const mosques = ["nabawi", "haram"] as const;
  const reciterMap = new Map<number, Reciter>();
  reciters?.forEach((r) => reciterMap.set(r.id, r));

  const grouped: Record<string, Record<string, TaskWithDetails[]>> = {
    nabawi: {},
    haram: {},
    none: {},
  };

  for (const task of filtered) {
    const reciter = task.reciter as Reciter | null | undefined;
    if (reciter) {
      const mosque = reciter.mosque as "nabawi" | "haram";
      if (!grouped[mosque][reciter.id]) grouped[mosque][reciter.id] = [];
      grouped[mosque][reciter.id].push(task);
    } else {
      if (!grouped["none"]["none"]) grouped["none"]["none"] = [];
      grouped["none"]["none"].push(task);
    }
  }

  if (filtered.length === 0) {
    return (
      <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
        <CircleDashed className="h-12 w-12 mb-4 text-muted-foreground/50" />
        <p className="text-lg font-medium">لا توجد مهام مطابقة</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {mosques.map((mosque) => {
        const reciterIds = Object.keys(grouped[mosque]).map(Number).filter(
          (id) => grouped[mosque][id]?.length > 0
        );
        if (reciterIds.length === 0) return null;

        return (
          <div key={mosque}>
            <div className="flex items-center gap-3 mb-4 px-1">
              <span className="text-2xl">{MOSQUE_ICON[mosque]}</span>
              <h3 className="text-xl font-bold text-foreground">{MOSQUE_LABEL[mosque]}</h3>
              <div className="flex-1 h-px bg-border" />
              <Badge variant="outline" className="text-muted-foreground">
                {reciterIds.reduce((s, id) => s + (grouped[mosque][id]?.length ?? 0), 0)} مهمة
              </Badge>
            </div>

            <div className="space-y-4 pr-4">
              {reciterIds.map((rid) => {
                const reciter = reciterMap.get(rid);
                const reciterTasks = grouped[mosque][rid] ?? [];
                return (
                  <ReciterTaskCard
                    key={rid}
                    reciter={reciter}
                    tasks={reciterTasks}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onStatusChange={onStatusChange}
                    updateTaskPending={updateTaskPending}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Tasks without a reciter */}
      {(grouped["none"]["none"]?.length ?? 0) > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-4 px-1">
            <CircleDashed className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-xl font-bold text-muted-foreground">بدون قارئ محدد</h3>
            <div className="flex-1 h-px bg-border" />
          </div>
          <div className="pr-4">
            <ReciterTaskCard
              reciter={undefined}
              tasks={grouped["none"]["none"]}
              onEdit={onEdit}
              onDelete={onDelete}
              onStatusChange={onStatusChange}
              updateTaskPending={updateTaskPending}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ReciterTaskCard({
  reciter,
  tasks,
  onEdit,
  onDelete,
  onStatusChange,
  updateTaskPending,
}: {
  reciter: Reciter | undefined;
  tasks: TaskWithDetails[];
  onEdit: (t: TaskWithDetails) => void;
  onDelete: (id: number) => void;
  onStatusChange: (id: number, status: TaskStatus) => void;
  updateTaskPending: boolean;
}) {
  const isAdmin = useIsAdmin();
  const { showHijri } = useHijriPreference();
  // Group by platform within each reciter
  const platformGroups = new Map<number, { platform: TaskWithDetails["platform"]; tasks: TaskWithDetails[] }>();
  for (const t of tasks) {
    if (!t.platform) continue;
    if (!platformGroups.has(t.platform.id)) {
      platformGroups.set(t.platform.id, { platform: t.platform, tasks: [] });
    }
    platformGroups.get(t.platform.id)!.tasks.push(t);
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="py-3 px-4 bg-muted/30 border-b border-border/40 flex flex-row items-center gap-3">
        <MicVocal className="h-4 w-4 text-sidebar-primary shrink-0" />
        <CardTitle className="text-base font-bold">
          {reciter ? reciter.name : "بدون قارئ"}
        </CardTitle>
        <span className="text-xs text-muted-foreground mr-auto">
          {tasks.length} مهمة
        </span>
      </CardHeader>
      <CardContent className="p-0 divide-y divide-border/40">
        {[...platformGroups.values()].map(({ platform, tasks: ptasks }) => (
          <div key={platform.id} className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <PlatformIcon name={platform.name} className="h-4 w-4" />
              <span className="text-sm font-semibold text-foreground">{platform.name}</span>
              <span className="text-xs text-muted-foreground">({ptasks.length})</span>
            </div>
            <div className="space-y-2 pr-6">
              {ptasks.map((task) => {
                const taskMembers = task.members?.length > 0 ? task.members : [task.member];
                const isOverdue =
                  task.dueDate &&
                  task.status !== "completed" &&
                  isPast(new Date(task.dueDate)) &&
                  !isToday(new Date(task.dueDate));

                return (
                  <div
                    key={task.id}
                    id={`task-${task.id}`}
                    className={cn(
                      "flex items-start gap-3 p-2 rounded-lg border bg-background hover:border-sidebar-primary/30 transition-colors",
                      isOverdue && "border-red-200 bg-red-50/30"
                    )}
                  >
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{task.title}</span>
                        {task.recurrence && task.recurrence !== "none" && (
                          <span className={cn(
                            "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border",
                            task.recurrence === "daily" ? "bg-green-50 text-green-600 border-green-200" :
                            task.recurrence === "weekly" ? "bg-blue-50 text-blue-600 border-blue-200" :
                            task.recurrence === "custom_days" ? "bg-orange-50 text-orange-600 border-orange-200" :
                            "bg-purple-50 text-purple-600 border-purple-200"
                          )}>
                            <Repeat2 className="h-2.5 w-2.5" />
                            {task.recurrence === "daily" ? "يومي" : task.recurrence === "weekly" ? "أسبوعي" : task.recurrence === "custom_days" ? "أيام محددة" : "شهري"}
                          </span>
                        )}
                        <TaskStatusBadge status={task.status} />
                        <TaskDayDateLabel dueDate={task.dueDate} showHijri={showHijri} />
                        <TaskDueStatusLabel task={task} />
                      </div>
                      <TaskNoteLine task={task} className="max-w-[520px]" />
                      <div className="flex flex-wrap gap-1">
                        {taskMembers.map((m) => (
                          <span
                            key={m.id}
                            className="text-xs font-medium bg-sidebar-primary/10 text-sidebar-primary border border-sidebar-primary/20 rounded-full px-2 py-0.5"
                          >
                            {m.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    {isAdmin ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-7 w-7 p-0 hover:bg-muted shrink-0">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => onEdit(task)} className="cursor-pointer flex items-center gap-2">
                            <Pencil className="h-4 w-4 text-sidebar-primary" />تعديل
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onStatusChange(task.id, "pending")} className="cursor-pointer flex items-center gap-2">
                            <CircleDashed className="h-4 w-4 text-gray-500" />قيد الانتظار
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onStatusChange(task.id, "completed")} className="cursor-pointer flex items-center gap-2">
                            <Check className="h-4 w-4 text-green-600" />مكتمل
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onDelete(task.id)} className="cursor-pointer flex items-center gap-2 text-red-600 focus:text-red-700 focus:bg-red-50">
                            <Trash2 className="h-4 w-4" />حذف
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => onStatusChange(task.id, "completed")}
                          title="أنجزت"
                          className={cn(
                            "h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all",
                            task.status === "completed"
                              ? "bg-green-500 border-green-500 text-white"
                              : "border-muted-foreground/30 hover:border-green-400 hover:bg-green-50"
                          )}
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => onStatusChange(task.id, "pending")}
                          title="لم تُنجز"
                          className={cn(
                            "h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all",
                            task.status === "pending"
                              ? "bg-red-400 border-red-400 text-white"
                              : "border-muted-foreground/30 hover:border-red-300 hover:bg-red-50"
                          )}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Tasks page
// ──────────────────────────────────────────────────────────────────────────────
export default function Tasks({ taskId }: { taskId?: number } = {}) {
  const [view, setView] = useState<"list" | "reciter" | "calendar">("list");
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(null);
  const [calendarIncompleteOnly, setCalendarIncompleteOnly] = useState(false);
  const [filterPlatform, setFilterPlatform] = useState<string>("all");
  const [filterMember, setFilterMember] = useState<string>("all");
  const [filterReciter, setFilterReciter] = useState<string>("all");
  const [filterMosque, setFilterMosque] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterDueStatus, setFilterDueStatus] = useState<DueStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [quickDateFilter, setQuickDateFilter] = useState<Date | null>(null);
  const [quickWeekOffset, setQuickWeekOffset] = useState(0);
  const [adminPreviewMemberId, setAdminPreviewMemberId] = useState<string>("none");
  const [activeTab, setActiveTab] = useState<"active" | "trash">("active");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskWithDetails | null>(null);
  const [editTaskScope, setEditTaskScope] = useState<EditTaskScope>("series");
  const [urlDialog, setUrlDialog] = useState<UrlDialogState | null>(null);
  const [proofsDialogTaskId, setProofsDialogTaskId] = useState<number | null>(null);
  const [proofSaving, setProofSaving] = useState(false);
  const [quickReciterTask, setQuickReciterTask] = useState<TaskWithDetails | null>(null);
  const [quickReciterId, setQuickReciterId] = useState("");
  const [quickReciterMemberId, setQuickReciterMemberId] = useState("");
  const [quickReciterMemberOptions, setQuickReciterMemberOptions] = useState<Array<{ id: number; name: string; role?: string | null }>>([]);
  const [quickReciterHasLinkedMembers, setQuickReciterHasLinkedMembers] = useState(false);
  const [quickReciterMembersLoading, setQuickReciterMembersLoading] = useState(false);
  const [quickReciterSaving, setQuickReciterSaving] = useState(false);
  const [pendingCompleteId, setPendingCompleteId] = useState<number | null>(null);
  const [commentsTaskId, setCommentsTaskId] = useState<number | null>(null);
  const [commentsTaskTitle, setCommentsTaskTitle] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);
  const [filterDueDate, setFilterDueDate] = useState<"all" | "today" | "this_week" | "next_week" | "overdue">("all");
  const [adminListLimit, setAdminListLimit] = useState<AdminListLimit>("50");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  const [bulkReassignId, setBulkReassignId] = useState("none");
  const [bulkPending, setBulkPending] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { showHijri } = useHijriPreference();
  const isAdmin = useIsAdmin();
  const role = useRole();
  const [completedCollapsed, setCompletedCollapsed] = useState(true);

  const adminPreviewMemberIdNumber = adminPreviewMemberId !== "none" ? Number(adminPreviewMemberId) : undefined;
  const isAdminMemberPreview =
    isAdmin &&
    typeof adminPreviewMemberIdNumber === "number" &&
    Number.isFinite(adminPreviewMemberIdNumber);

  const selectedMemberId =
    isAdminMemberPreview
      ? adminPreviewMemberIdNumber
      : filterMember === "mine"
      ? user?.memberId ?? undefined
      : filterMember !== "all"
        ? Number(filterMember)
        : undefined;

  const urlForm = useForm<{ url: string }>({
    resolver: zodResolver(submissionUrlSchema),
    defaultValues: { url: "" },
  });

  const queryParams = {
    ...(filterPlatform !== "all" ? { platformId: parseInt(filterPlatform) } : {}),
    ...(typeof selectedMemberId === "number" && Number.isFinite(selectedMemberId) ? { memberId: selectedMemberId } : {}),
    ...(activeTab === "trash" ? { deleted: true } : {}),
  };

  const { data: rawTasks, isLoading: tasksLoading } = useListTasks(queryParams, {
    query: { queryKey: getListTasksQueryKey(queryParams) },
  });
  const dependencyTaskQueryParams = {};
  const { data: dependencyCandidateTasks } = useListTasks(dependencyTaskQueryParams, {
    query: {
      queryKey: getListTasksQueryKey(dependencyTaskQueryParams),
      enabled: isAdmin && ENABLE_TASK_DEPENDENCIES,
    },
  });

  useEffect(() => {
    if (!taskId || tasksLoading) return;

    const handle = window.setTimeout(() => {
      document.getElementById(`task-${taskId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);

    return () => window.clearTimeout(handle);
  }, [taskId, tasksLoading, rawTasks]);

  const linkedTaskClassName = "bg-blue-50/70 ring-2 ring-blue-500/40";
  const isLinkedTask = (id: number) => taskId === id;

  // Client-side search filter
  const searchedTasks = searchQuery.trim()
    ? rawTasks?.filter((t) => {
        const q = searchQuery.toLowerCase();
        return (
          t.title.toLowerCase().includes(q) ||
          (t.platform?.name ?? "").toLowerCase().includes(q) ||
          (t.reciter as Reciter | null | undefined)?.name?.toLowerCase().includes(q) ||
          (t.members && t.members.length > 0 ? t.members : [t.member]).some((m) =>
            m.name.toLowerCase().includes(q)
          )
        );
      })
    : rawTasks;

  // Client-side manager filters and ascending due-date order.
  const tasks = useMemo(() => {
    if (!searchedTasks) return searchedTasks;

    const today = startOfDay(new Date());
    const weekStart = startOfDay(startOfWeek(today, { weekStartsOn: 0 }));
    const weekEnd = endOfDay(addDays(weekStart, 6));
    const nextWeekStart = startOfDay(addDays(weekEnd, 1));
    const nextWeekEnd = endOfDay(addDays(nextWeekStart, 6));

    const filtered = searchedTasks.filter((task) => {
      if (filterPlatform !== "all") {
        const platformId = Number(filterPlatform);
        if (!Number.isFinite(platformId)) return false;
        if (task.platform?.id !== platformId) return false;
      }
      if (filterReciter !== "all") {
        const reciterId = Number(filterReciter);
        if (!Number.isFinite(reciterId)) return false;
        if (task.reciter?.id !== reciterId) return false;
      }
      if (filterStatus !== "all" && task.status !== filterStatus) return false;
      if (filterDueStatus !== "all" && getTaskDueStatus(task) !== filterDueStatus) return false;

      if (quickDateFilter) {
        if (!task.dueDate) return false;
        const due = startOfDay(new Date(task.dueDate));
        if (!isSameDay(due, quickDateFilter)) return false;
      }

      if (filterDueDate !== "all") {
        if (!task.dueDate) return false;
        const due = startOfDay(new Date(task.dueDate));
        if (filterDueDate === "today") return due.getTime() === today.getTime();
        if (filterDueDate === "this_week") return due >= weekStart && due <= weekEnd;
        if (filterDueDate === "next_week") return due >= nextWeekStart && due <= nextWeekEnd;
        if (filterDueDate === "overdue") return due < today && task.status !== "completed";
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
      if (aTime !== bTime) return aTime - bTime;
      return a.id - b.id;
    });
  }, [searchedTasks, filterPlatform, filterReciter, filterStatus, filterDueStatus, quickDateFilter, filterDueDate]);

  const proofsDialogTask = useMemo(
    () => tasks?.find((task) => task.id === proofsDialogTaskId) ?? null,
    [tasks, proofsDialogTaskId]
  );

  // Member rows (one row per task, sorted overdue-first then by dueDate)
  const memberRows = useMemo(() => {
    if (!tasks || (isAdmin && !isAdminMemberPreview)) return { pending: [], completed: [] };
    type Row = { task: (typeof tasks)[0]; key: string; isOverdue: boolean };
    const rows: Row[] = tasks.map((task) => {
      const d = task.dueDate ? startOfDay(new Date(task.dueDate)) : null;
      const isOverdue = d ? isBefore(d, startOfDay(new Date())) && task.status !== "completed" : false;
      return { task, key: `${task.id}`, isOverdue };
    });
    const today = startOfDay(new Date());
    const getPriority = (isOverdue: boolean, d: Date | null) => {
      if (!d) return 3;
      if (d.getTime() === today.getTime()) return 0; // today
      if (!isOverdue) return 1;                      // upcoming
      return 2;                                       // overdue
    };
    const pending = rows
      .filter((r) => r.task.status !== "completed")
      .sort((a, b) => {
        const ad = a.task.dueDate ? startOfDay(new Date(a.task.dueDate)) : null;
        const bd = b.task.dueDate ? startOfDay(new Date(b.task.dueDate)) : null;
        const pa = getPriority(a.isOverdue, ad);
        const pb = getPriority(b.isOverdue, bd);
        if (pa !== pb) return pa - pb;
        if (ad && bd) return ad.getTime() - bd.getTime();
        return 0;
      });
    return { pending, completed: rows.filter((r) => r.task.status === "completed") };
  }, [tasks, isAdmin, isAdminMemberPreview]);
  const pendingMemberRows = memberRows.pending;
  const completedMemberRows = memberRows.completed;

  const adminListTasks = useMemo(() => {
    if (!tasks || !isAdmin || isAdminMemberPreview || activeTab !== "active" || view !== "list") return tasks;
    if (adminListLimit === "all") return tasks;
    return tasks.slice(0, Number(adminListLimit));
  }, [tasks, isAdmin, isAdminMemberPreview, activeTab, view, adminListLimit]);

  const adminListTotal = tasks?.length ?? 0;
  const adminListShown = adminListTasks?.length ?? 0;
  const quickWeekStart = useMemo(() => {
    return addWeeks(startOfWeek(new Date(), { weekStartsOn: 0 }), quickWeekOffset);
  }, [quickWeekOffset]);

  const quickWeekDays = useMemo(() => {
    const start = quickWeekStart;
    return eachDayOfInterval({ start, end: addDays(start, 6) });
  }, [quickWeekStart]);

  const quickWeekEnd = useMemo(() => addDays(quickWeekStart, 6), [quickWeekStart]);

  const handleQuickWeekDateSelect = (value: string) => {
    if (!value) {
      setQuickDateFilter(null);
      return;
    }
    const selectedDate = startOfDay(new Date(`${value}T00:00:00`));
    if (Number.isNaN(selectedDate.getTime())) return;
    const currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 0 });
    const selectedWeekStart = startOfWeek(selectedDate, { weekStartsOn: 0 });
    setQuickWeekOffset(Math.round(differenceInDays(selectedWeekStart, currentWeekStart) / 7));
    setQuickDateFilter(selectedDate);
    setFilterDueDate("all");
  };

  useEffect(() => {
    if (!isAdmin || isAdminMemberPreview || view !== "list" || activeTab !== "active") return;
    const visibleIds = new Set(adminListTasks?.map((task) => task.id) ?? []);
    setSelectedTaskIds((previous) => {
      const next = new Set([...previous].filter((id) => visibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [adminListTasks, isAdmin, isAdminMemberPreview, view, activeTab]);

  const { data: members } = useListMembers({ query: { queryKey: getListMembersQueryKey() } });
  const { data: platforms } = useListPlatforms({ query: { queryKey: getListPlatformsQueryKey() } });
  const { data: reciters } = useListReciters({}, { query: { queryKey: getListRecitersQueryKey() } });
  const currentMemberName = members?.find((member) => member.id === user?.memberId)?.name ?? user?.displayName ?? user?.username ?? null;

  useEffect(() => {
    let cancelled = false;

    async function loadLinkedMembers() {
      if (!quickReciterTask || !quickReciterId || !members) return;
      const reciterId = Number(quickReciterId);
      if (!Number.isFinite(reciterId)) return;

      setQuickReciterMembersLoading(true);
      try {
        const platformId = taskPlatformId(quickReciterTask);
        if (!platformId) throw new Error("Missing platform id for quick reciter change");
        const pagesRes = await fetch(`/api/platforms/${platformId}/pages`, { credentials: "include" });
        let linkedMemberIds: number[] = [];
        if (pagesRes.ok) {
          const pages = (await pagesRes.json()) as Array<{ id: number; reciterId?: number | null }>;
          const page = pages.find((pg) => pg.reciterId === reciterId);
          if (page) {
            const membersRes = await fetch(`/api/platforms/${quickReciterTask.platform.id}/pages/${page.id}/members`, { credentials: "include" });
            if (membersRes.ok) linkedMemberIds = await membersRes.json();
          }
        }

        if (cancelled) return;
        const linkedOptions = linkedMemberIds.length > 0
          ? members.filter((member) => linkedMemberIds.includes(member.id))
          : [];
        const options = linkedOptions.length > 0 ? linkedOptions : members;
        const isOriginalReciter = quickReciterTask.reciter?.id === reciterId;
        setQuickReciterHasLinkedMembers(linkedOptions.length > 0);
        setQuickReciterMemberOptions(options);
        setQuickReciterMemberId((current) =>
          linkedOptions.length > 0
            ? options[0] ? String(options[0].id) : ""
            : isOriginalReciter && options.some((member) => String(member.id) === current)
              ? current
              : ""
        );
      } catch {
        if (cancelled) return;
        const reciterId = Number(quickReciterId);
        const isOriginalReciter = quickReciterTask.reciter?.id === reciterId;
        setQuickReciterHasLinkedMembers(false);
        setQuickReciterMemberOptions(members);
        setQuickReciterMemberId((current) =>
          isOriginalReciter && members.some((member) => String(member.id) === current)
            ? current
            : ""
        );
      } finally {
        if (!cancelled) setQuickReciterMembersLoading(false);
      }
    }

    loadLinkedMembers();
    return () => {
      cancelled = true;
    };
  }, [quickReciterTask, quickReciterId, members]);

  const updateTask = useUpdateTask();
  const createTask = useCreateTask();
  const deleteTask = useDeleteTask();
  const duplicateTask = useDuplicateTask();
  const restoreTask = useRestoreTask();
  const permanentDeleteTask = usePermanentDeleteTask();
  const [isCreateSubmitting, setIsCreateSubmitting] = useState(false);

  const defaultFormValues: Omit<TaskFormValues, "platformId"> & { platformId?: number } = {
    title: "",
    description: "",
    memberIds: [],
    reciterId: null,
    pageId: null,
    appPrayer: null,
    seriesType: "temporary",
    startDate: "",
    dueDate: "",
    endDate: "",
    recurrence: "none",
    recurrenceIntervalDays: null,
    recurrenceDurationDays: null,
    recurrenceDays: null,
    weeklyQuotaRequired: 3,
    dependsOnTaskId: null,
    priority: "normal",
    progress: 0,
  };

  const createForm = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    defaultValues: defaultFormValues,
  });

  const editForm = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    defaultValues: defaultFormValues,
  });

  useEffect(() => {
    if (isAdmin || !user?.memberId) return;
    createForm.setValue("memberIds", [user.memberId]);
    createForm.setValue("seriesType", "temporary");
    createForm.setValue("recurrence", "none");
    createForm.setValue("endDate", "");
    createForm.setValue("weeklyQuotaRequired", null);
    createForm.setValue("dependsOnTaskId", null);
  }, [isAdmin, user?.memberId, createForm]);

  const openEditDialog = (task: TaskWithDetails) => {
    try {
      logTaskDialogOpen("edit-task", taskDialogDiagnostic(task));
      const platformId = taskPlatformId(task);
      const memberIds = taskAssignedMemberIds(task);
      const reciterId = taskReciterId(task);
      const pageId = taskPageId(task);
      const taskRecurrence = normalizeTaskRecurrence((task as any).recurrence);
      const weeklyQuotaRequired = Number((task as any).weeklyQuotaRequired ?? 0);
      const startDate =
        (task as any).weeklyQuotaPeriodStart ??
        (task as any).startDate ??
        task.dueDate ??
        (task as any).createdAt ??
        new Date();
      const dueDate = task.dueDate ?? startDate;
      const defaultValues: TaskFormValues = {
        title: task.title || "مهمة جديدة",
        description: task.description ?? "",
        platformId: platformId ?? (undefined as unknown as number),
        pageId,
        memberIds,
        reciterId,
        appPrayer: extractAppPrayerFromTitle(task.title),
        status: normalizeTaskStatus((task as any).status),
        priority: normalizeTaskPriority((task as any).priority),
        progress: Number.isFinite(Number((task as any).progress)) ? Number((task as any).progress) : 0,
        seriesType: TASK_FORM_STABILITY_MODE ? "temporary" : weeklyQuotaRequired > 0 ? "weekly_quota" : taskRecurrence === "weekly" || taskRecurrence === "monthly" ? "operational" : "temporary",
        startDate: toDateInputValue(startDate),
        dueDate: toDateInputValue(dueDate),
        endDate: TASK_FORM_STABILITY_MODE ? "" : toDateInputValue((task as any).endDate),
        recurrence: TASK_FORM_STABILITY_MODE ? "none" : taskRecurrence,
        recurrenceIntervalDays: TASK_FORM_STABILITY_MODE ? null : toPositiveNumber((task as any).recurrenceIntervalDays),
        recurrenceDurationDays: TASK_FORM_STABILITY_MODE ? null : toPositiveNumber((task as any).recurrenceDurationDays),
        recurrenceDays: TASK_FORM_STABILITY_MODE ? null : typeof (task as any).recurrenceDays === "string" ? (task as any).recurrenceDays : null,
        weeklyQuotaRequired: TASK_FORM_STABILITY_MODE ? null : weeklyQuotaRequired > 0 ? weeklyQuotaRequired : 3,
        dependsOnTaskId: TASK_FORM_STABILITY_MODE ? null : toPositiveNumber((task as any).dependsOnTaskId),
      };
      console.info("[tasks-dialog] edit defaults", defaultValues);
      editForm.reset(defaultValues);
      setEditTaskScope((task as any).seriesId ? "series" : "single");
      setEditingTask(task);
    } catch (error) {
      console.error("[tasks-dialog] failed to prepare edit form", {
        error,
        task: taskDialogDiagnostic(task),
      });
      toast({
        title: "تعذر فتح تعديل المهمة",
        description: "حدث خطأ أثناء تجهيز بيانات المهمة. حدّث الصفحة ثم حاول مرة أخرى.",
        variant: "destructive",
      });
    }
  };

  const openComments = (task: TaskWithDetails) => {
    logTaskDialogOpen("comments", taskDialogDiagnostic(task));
    setCommentsTaskId(task.id);
    setCommentsTaskTitle(task.title || "مهمة");
  };

  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });

  const canModifyTaskAsCurrentUser = (task: TaskWithDetails) => {
    if (isAdmin || isAdminMemberPreview) return true;
    return ENABLE_MEMBER_CREATED_TASKS && (task as any).source === "member_created";
  };

  const toggleTaskSelect = (id: number) => setSelectedTaskIds((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const selectAllAdminTasks = () => setSelectedTaskIds(new Set(adminListTasks?.map((t) => t.id) ?? []));
  const clearSel = () => { setSelectedTaskIds(new Set()); setBulkReassignId("none"); };

  const resetFilters = () => {
    setSearchQuery("");
    setFilterPlatform("all");
    setFilterMember("all");
    setAdminPreviewMemberId("none");
    setFilterReciter("all");
    setFilterMosque("all");
    setFilterStatus("all");
    setFilterDueStatus("all");
    setFilterDueDate("all");
    setQuickDateFilter(null);
    setSelectedCalendarDate(null);
    clearSel();
  };

  const handleBulkDelete = async () => {
    if (!confirm(`نقل ${selectedTaskIds.size} مهمة إلى السلة؟`)) return;
    setBulkPending(true);
    try {
      await Promise.all([...selectedTaskIds].map((id) => fetch(`/api/tasks/${id}`, { method: "DELETE", credentials: "include" })));
      invalidateTasks(); clearSel();
      toast({ title: `تم نقل ${selectedTaskIds.size} مهمة إلى السلة` });
    } finally { setBulkPending(false); }
  };

  const handleBulkReassign = async (mIdStr: string) => {
    if (mIdStr === "none") return;
    const mId = parseInt(mIdStr);
    setBulkReassignId(mIdStr);
    setBulkPending(true);
    try {
      await Promise.all([...selectedTaskIds].map((id) => fetch(`/api/tasks/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ memberIds: [mId] }),
      })));
      invalidateTasks(); clearSel();
      toast({ title: `تم إسناد ${selectedTaskIds.size} مهمة لـ ${members?.find((m) => m.id === mId)?.name}` });
    } finally { setBulkPending(false); }
  };

  const onCreateSubmit = async (data: TaskFormValues) => {
    const isMemberSelfTask = ENABLE_MEMBER_CREATED_TASKS && !isAdmin;
    if (isMemberSelfTask && !user?.memberId) {
      toast({ title: "لا يوجد عضو مرتبط بحسابك لإنشاء مهمة مقطوعة", variant: "destructive" });
      return;
    }
    if (TASK_FORM_STABILITY_MODE && !isAdmin && !isMemberSelfTask) {
      toast({ title: "إنشاء المهمة المقطوعة موقوف مؤقتًا أثناء تثبيت نموذج المهام", variant: "destructive" });
      return;
    }
    if (TASK_FORM_STABILITY_MODE && !isMemberSelfTask) {
      if (!data.platformId) {
        toast({ title: "اختر المنصة أولًا", variant: "destructive" });
        return;
      }
      if (!data.memberIds?.length) {
        toast({ title: "اختر العضو المسؤول", variant: "destructive" });
        return;
      }
      if (!data.startDate || Number.isNaN(new Date(data.startDate).getTime())) {
        toast({ title: "اختر تاريخ المهمة", variant: "destructive" });
        return;
      }
      const selectedPlatform = platforms?.find((platform) => platform.id === data.platformId);
      const selectedReciter = reciters?.find((reciter) => reciter.id === data.reciterId);
      const explicitTitle = typeof data.title === "string" ? data.title.trim() : "";
      const taskTitle = explicitTitle || [selectedReciter?.name, selectedPlatform?.name].filter(Boolean).join(" — ") || "مهمة جديدة";
      const taskDate = new Date(data.startDate).toISOString();

      setIsCreateSubmitting(true);
      try {
        await createTask.mutateAsync({
          data: {
            title: taskTitle,
            description: "",
            platformId: data.platformId,
            memberIds: data.memberIds,
            reciterId: data.reciterId ?? null,
            status: "pending",
            priority: "normal",
            progress: 0,
            seriesType: "temporary",
            startDate: taskDate,
            dueDate: taskDate,
            recurrence: "none",
            recurrenceIntervalDays: null,
            recurrenceDurationDays: null,
            recurrenceDays: null,
            weeklyQuotaRequired: null,
            pageId: data.pageId ?? null,
            expandDailyInstances: false,
            recurrencePattern: "none",
            source: "admin_created",
          } as any,
        });
        invalidateTasks();
        toast({ title: "تم إنشاء المهمة بنجاح" });
        setIsCreateOpen(false);
        createForm.reset(defaultFormValues);
      } catch (error) {
        console.error("[tasks-dialog] stable create submit failed", { error, data });
        toast({ title: "حدث خطأ أثناء إنشاء المهمة", variant: "destructive" });
      } finally {
        setIsCreateSubmitting(false);
      }
      return;
    }
    const memberIdsForCreate = isMemberSelfTask ? [user!.memberId!] : data.memberIds;
    const seriesType = isMemberSelfTask ? "temporary" : data.seriesType ?? "temporary";
    const isWeeklyQuota = !isMemberSelfTask && seriesType === "weekly_quota";
    const apiSeriesType = isWeeklyQuota ? "operational" : seriesType;
    const recurrence = apiSeriesType === "operational" ? (isWeeklyQuota ? "weekly" : data.recurrence === "monthly" ? "monthly" : "weekly") : "none";
    const recurrenceDays = apiSeriesType === "operational" && recurrence === "weekly" && !isWeeklyQuota
      ? data.recurrenceDays ?? null
      : null;
    const weeklyQuotaRequired = isWeeklyQuota ? Number(data.weeklyQuotaRequired ?? 3) : null;
    const selectedPlatform = platforms?.find((p) => p.id === data.platformId);
    const isApplicationPlatform = isApplicationPlatformName(selectedPlatform?.name);
    let pageId = data.pageId ?? null;

    if (isApplicationPlatform && !data.reciterId) {
      toast({ title: "اختر القارئ داخل التطبيق", variant: "destructive" });
      return;
    }
    if (isApplicationPlatform && !data.appPrayer) {
      toast({ title: "اختر الصلاة", variant: "destructive" });
      return;
    }

    setIsCreateSubmitting(true);
    try {
      if (isAdmin && isApplicationPlatform && data.reciterId) {
        pageId = await ensureApplicationReciterPage(data.platformId, data.reciterId, memberIdsForCreate);
      }
      const reciter = reciters?.find((r) => r.id === data.reciterId);
      const taskTitle = isApplicationPlatform
        ? [data.appPrayer, reciter?.name, selectedPlatform?.name].filter(Boolean).join(" — ")
        : isWeeklyQuota
          ? `${data.title || selectedPlatform?.name || "مهمة"} — هدف أسبوعي (${weeklyQuotaRequired} مرات)`
          : data.title || "مهمة جديدة";

      await createTask.mutateAsync({
        data: {
          title: taskTitle || "مهمة جديدة",
          description: data.description,
          platformId: data.platformId,
          memberIds: memberIdsForCreate,
          reciterId: data.reciterId ?? null,
          status: "pending",
          priority: data.priority ?? "normal",
          progress: data.progress ?? 0,
          seriesType: apiSeriesType,
          startDate: new Date(data.startDate).toISOString(),
          dueDate: new Date(data.startDate).toISOString(),
          endDate: apiSeriesType === "temporary" && data.endDate ? new Date(data.endDate).toISOString() : undefined,
          recurrence,
          recurrenceIntervalDays: null,
          recurrenceDurationDays: null,
          recurrenceDays,
          weeklyQuotaRequired,
          pageId,
          expandDailyInstances: !isMemberSelfTask && apiSeriesType === "temporary",
          recurrencePattern: recurrence,
          dependsOnTaskId: ENABLE_TASK_DEPENDENCIES && isAdmin ? data.dependsOnTaskId ?? null : null,
          source: isMemberSelfTask ? "member_created" : "admin_created",
        } as any,
      });
      invalidateTasks();
      queryClient.invalidateQueries({ queryKey: ["page-members"] });
      toast({ title: "تم إنشاء المهمة بنجاح" });
      setIsCreateOpen(false);
      createForm.reset(defaultFormValues);
    } catch (error) {
      console.error("[tasks-dialog] create submit failed", { error, data });
      toast({ title: "حدث خطأ أثناء إنشاء المهمة", variant: "destructive" });
    } finally {
      setIsCreateSubmitting(false);
    }
  };

  const onEditSubmit = (data: TaskFormValues) => {
    if (!editingTask) return;
    if (TASK_FORM_STABILITY_MODE) {
      if (!data.platformId) {
        toast({ title: "اختر المنصة أولًا", variant: "destructive" });
        return;
      }
      const memberIdsForStableUpdate = data.memberIds?.length ? data.memberIds : taskAssignedMemberIds(editingTask);
      if (!memberIdsForStableUpdate.length) {
        toast({ title: "اختر العضو المسؤول", variant: "destructive" });
        return;
      }
      if (!data.startDate || Number.isNaN(new Date(data.startDate).getTime())) {
        toast({ title: "اختر تاريخ المهمة", variant: "destructive" });
        return;
      }
      const selectedPlatform = platforms?.find((platform) => platform.id === data.platformId);
      const selectedReciter = reciters?.find((reciter) => reciter.id === data.reciterId);
      const explicitTitle = typeof data.title === "string" ? data.title.trim() : "";
      const taskTitle = explicitTitle || [selectedReciter?.name, selectedPlatform?.name].filter(Boolean).join(" — ") || "مهمة جديدة";
      const taskDate = new Date(data.startDate).toISOString();

      updateTask.mutate(
        {
          id: editingTask.id,
          data: {
            title: taskTitle,
            platformId: data.platformId,
            memberIds: memberIdsForStableUpdate,
            reciterId: data.reciterId ?? null,
            pageId: data.pageId ?? null,
            startDate: taskDate,
            dueDate: taskDate,
            updateScope: "single",
          } as any,
        },
        {
          onSuccess: () => {
            invalidateTasks();
            toast({ title: "تم تحديث المهمة بنجاح" });
            setEditingTask(null);
          },
          onError: () => toast({ title: "حدث خطأ أثناء تحديث المهمة", variant: "destructive" }),
        }
      );
      return;
    }
    const hasSeries = Boolean((editingTask as any).seriesId);
    const effectiveEditScope: EditTaskScope = hasSeries ? editTaskScope : "single";
    if (hasSeries) {
      const confirmed = window.confirm(
        `${EDIT_SCOPE_MESSAGES[effectiveEditScope]}\nلن يتم تغيير حالة الإنجاز أو الشاهد لبقية أيام السلسلة.`
      );
      if (!confirmed) return;
    }
    const seriesType = data.seriesType ?? "temporary";
    const isWeeklyQuota = seriesType === "weekly_quota";
    const apiSeriesType = isWeeklyQuota ? "operational" : seriesType;
    const recurrence = isWeeklyQuota ? "weekly" : apiSeriesType === "operational" ? (data.recurrence === "monthly" ? "monthly" : "weekly") : "none";
    const recurrenceDays = apiSeriesType === "operational" && recurrence === "weekly" && !isWeeklyQuota
      ? data.recurrenceDays ?? null
      : null;
    const memberIdsForUpdate = data.memberIds?.length ? data.memberIds : taskAssignedMemberIds(editingTask);
    updateTask.mutate(
      {
        id: editingTask.id,
        data: {
          title: data.title || "مهمة جديدة",
          description: data.description,
          platformId: data.platformId,
          memberIds: memberIdsForUpdate,
          reciterId: data.reciterId ?? null,
          status: data.status as TaskStatus | undefined,
          priority: data.priority ?? "normal",
          progress: data.progress ?? 0,
          startDate: new Date(data.startDate).toISOString(),
          dueDate: new Date(data.startDate).toISOString(),
          endDate: apiSeriesType === "temporary" && data.endDate ? new Date(data.endDate).toISOString() : undefined,
          recurrence,
          recurrenceIntervalDays: null,
          recurrenceDurationDays: null,
          recurrenceDays,
          weeklyQuotaRequired: isWeeklyQuota ? Number(data.weeklyQuotaRequired ?? 3) : null,
          pageId: data.pageId ?? null,
          updateScope: effectiveEditScope,
          dependsOnTaskId: ENABLE_TASK_DEPENDENCIES && isAdmin ? data.dependsOnTaskId ?? null : undefined,
        } as any,
      },
      {
        onSuccess: () => {
          invalidateTasks();
          toast({ title: "تم تحديث المهمة بنجاح" });
          setEditingTask(null);
        },
        onError: () => toast({ title: "حدث خطأ أثناء تحديث المهمة", variant: "destructive" }),
      }
    );
  };

  const handleStatusChange = (id: number, status: TaskStatus) => {
    if (status === "completed") {
      const task = tasks?.find((t) => t.id === id);
      if (task && isWeeklyQuotaTask(task)) {
        const quota = weeklyQuotaInfo(task);
        if (quota.completed < quota.required) {
          toast({ title: `أضف ${quota.remaining} شاهد قبل إكمال الهدف الأسبوعي`, variant: "destructive" });
          openUrlDialog(task);
          return;
        }
      }
      if (task && !task.submissionUrl && !isWeeklyQuotaTask(task)) {
        toast({ title: "يجب إضافة رابط الشاهد أولاً لإكمال المهمة", variant: "destructive" });
        setPendingCompleteId(id);
        openUrlDialog(task);
        return;
      }
    }
    updateTask.mutate(
      { id, data: { status } },
      { onSuccess: () => { invalidateTasks(); toast({ title: "تم تحديث حالة المهمة" }); } }
    );
  };

  const handleDelete = (id: number) => {
    deleteTask.mutate(
      { id },
      { onSuccess: () => { invalidateTasks(); toast({ title: "تم نقل المهمة إلى السلة" }); } }
    );
  };

  const handleDuplicate = (id: number) => {
    duplicateTask.mutate(
      { id },
      {
        onSuccess: () => { invalidateTasks(); toast({ title: "تم نسخ المهمة بنجاح" }); },
        onError: () => toast({ title: "تعذر نسخ المهمة", variant: "destructive" }),
      }
    );
  };

  const handleRestore = (id: number) => {
    restoreTask.mutate(
      { id },
      { onSuccess: () => { invalidateTasks(); toast({ title: "تمت استعادة المهمة" }); } }
    );
  };

  const handlePermanentDelete = (id: number) => {
    if (!confirm("هل تريد حذف المهمة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.")) return;
    permanentDeleteTask.mutate(
      { id },
      { onSuccess: () => { invalidateTasks(); toast({ title: "تم حذف المهمة نهائياً" }); } }
    );
  };

  const openUrlDialog = (task: TaskWithDetails) => {
    logTaskDialogOpen("proof-url", taskDialogDiagnostic(task));
    const isQuota = isWeeklyQuotaTask(task);
    setUrlDialog({
      taskId: task.id,
      currentUrl: isQuota ? "" : task.submissionUrl ?? "",
      mode: isQuota ? "proof-create" : "task-url",
      proofId: null,
    });
    urlForm.reset({ url: isQuota ? "" : task.submissionUrl ?? "" });
  };

  const openProofsDialog = (task: TaskWithDetails) => {
    logTaskDialogOpen("proofs-list", taskDialogDiagnostic(task));
    setProofsDialogTaskId(task.id);
  };

  const openProofEditDialog = (task: TaskWithDetails, proof: TaskProof) => {
    logTaskDialogOpen("proof-edit", { ...taskDialogDiagnostic(task), proofId: proof.id });
    setProofsDialogTaskId(null);
    setUrlDialog({
      taskId: task.id,
      currentUrl: proof.url,
      mode: "proof-edit",
      proofId: proof.id,
    });
    urlForm.reset({ url: proof.url });
  };

  const openQuickReciterDialog = (task: TaskWithDetails) => {
    logTaskDialogOpen("quick-reciter", taskDialogDiagnostic(task));
    const taskMembers = taskAssignedMembers(task);
    const reciterId = taskReciterId(task);
    setQuickReciterTask(task);
    setQuickReciterId(reciterId ? String(reciterId) : "none");
    setQuickReciterMemberOptions(taskMembers);
    setQuickReciterMemberId(taskMembers[0] ? String(taskMembers[0].id) : "");
    setQuickReciterHasLinkedMembers(false);
  };

  const closeQuickReciterDialog = () => {
    setQuickReciterTask(null);
    setQuickReciterId("");
    setQuickReciterMemberId("");
    setQuickReciterMemberOptions([]);
    setQuickReciterHasLinkedMembers(false);
    setQuickReciterMembersLoading(false);
  };

  const handleQuickReciterChange = async () => {
    if (!quickReciterTask) return;
    const reciterId = Number(quickReciterId);
    const memberId = Number(quickReciterMemberId);
    if (!Number.isFinite(reciterId) || reciterId <= 0) {
      toast({ title: "اختر القارئ الجديد", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(memberId) || memberId <= 0) {
      toast({ title: "اختر العضو المسؤول", variant: "destructive" });
      return;
    }

    try {
      setQuickReciterSaving(true);
      const response = await fetch(`/api/tasks/${quickReciterTask.id}/quick-reciter`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reciterId, memberId }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? "Failed to change reciter");
      }
      await invalidateTasks();
      toast({ title: "تم تغيير القارئ وإسناد المهمة للعضو المسؤول" });
      closeQuickReciterDialog();
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "حدث خطأ أثناء تغيير القارئ",
        variant: "destructive",
      });
    } finally {
      setQuickReciterSaving(false);
    }
  };

  const handleSubmissionUrl = async (data: { url: string }) => {
    if (!urlDialog) return;
    const taskId = urlDialog.taskId;
    const task = tasks?.find((t) => t.id === taskId);
    if (task && isWeeklyQuotaTask(task)) {
      if (!data.url) {
        toast({ title: "أدخل رابط الشاهد", variant: "destructive" });
        return;
      }
      const isProofEdit = urlDialog.mode === "proof-edit" && typeof urlDialog.proofId === "number";
      try {
        setProofSaving(true);
        const response = await fetch(
          isProofEdit ? `/api/tasks/${taskId}/proofs/${urlDialog.proofId}` : `/api/tasks/${taskId}/proofs`,
          {
            method: isProofEdit ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ url: data.url }),
          }
        );
        if (!response.ok) throw new Error("Failed to save proof");
        await invalidateTasks();
        toast({ title: isProofEdit ? "تم تعديل الشاهد" : "تم حفظ الشاهد" });
        setPendingCompleteId(null);
        setUrlDialog(null);
        urlForm.reset({ url: "" });
      } catch {
        toast({ title: "حدث خطأ أثناء حفظ الشاهد", variant: "destructive" });
      } finally {
        setProofSaving(false);
      }
      return;
    }
    updateTask.mutate(
      { id: taskId, data: { submissionUrl: data.url || null } },
      {
        onSuccess: () => {
          invalidateTasks();
          toast({ title: data.url ? "تم حفظ رابط الشاهد" : "تم حذف رابط الشاهد" });
          if (data.url && pendingCompleteId === taskId) {
            updateTask.mutate(
              { id: taskId, data: { status: "completed" } },
              { onSuccess: () => { invalidateTasks(); toast({ title: "تم إكمال المهمة" }); } }
            );
          }
          setPendingCompleteId(null);
          setUrlDialog(null);
          urlForm.reset({ url: "" });
        },
        onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">المهام</h2>
          <p className="text-muted-foreground mt-2">
            {!isAdmin ? "مهامك المسندة إليك — ضع علامة ✓ عند إتمام كل مهمة" : "إدارة ومتابعة مهام الفريق"}
          </p>
        </div>

        {/* View toggle + create */}
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {/* Trash tab toggle */}
          {isAdmin && (
            <div className="flex border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => setActiveTab("active")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                  activeTab === "active"
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <LayoutList className="h-4 w-4" />
                المهام
              </button>
              <button
                onClick={() => setActiveTab("trash")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-r border-border",
                  activeTab === "trash"
                    ? "bg-red-600 text-white"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <Trash2 className="h-4 w-4" />
                السلة
              </button>
            </div>
          )}
          <div className="flex border border-border rounded-lg overflow-hidden">
            {(
              [
                { key: "list", label: "قائمة", icon: LayoutList },
                { key: "reciter", label: "بالقارئ", icon: Layers },
                { key: "calendar", label: "تقويم", icon: CalendarDays },
              ] as const
            ).map(({ key, label, icon: Icon }, i) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors",
                  i > 0 && "border-r border-border",
                  view === key
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          {/* Archive toggle */}
          <button
            onClick={() => setShowArchived((p) => !p)}
            title={showArchived ? "إخفاء المكتملة" : "إظهار المكتملة فقط"}
            className={cn(
              "flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg border transition-all",
              showArchived
                ? "bg-amber-50 text-amber-700 border-amber-300 font-semibold"
                : "text-muted-foreground border-border hover:bg-muted"
            )}
          >
            <Archive className="h-4 w-4" />
            {showArchived ? "المكتملة" : "الأرشيف"}
          </button>

          {/* Create dialog */}
          {((TASK_FORM_STABILITY_MODE ? isAdmin : isAdmin || (ENABLE_MEMBER_CREATED_TASKS && user?.memberId))) && (
            <Dialog
              open={isCreateOpen}
              onOpenChange={(open) => {
                if (open) {
                  logTaskDialogOpen("create-task", {
                    isAdmin,
                    userId: user?.id,
                    memberId: user?.memberId,
                    defaultValues: createForm.getValues(),
                  });
                }
                setIsCreateOpen(open);
              }}
            >
              <DialogTrigger asChild>
                <Button className="hidden sm:inline-flex bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold">
                  <Plus className="ml-2 h-4 w-4" />
                  {TASK_FORM_STABILITY_MODE ? "مهمة جديدة" : isAdmin ? "مهمة جديدة" : "مهمة مقطوعة"}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[480px] flex flex-col max-h-[90vh] p-0" dir="rtl">
                <TaskDialogErrorBoundary
                  dialogName="إنشاء مهمة"
                  resetKey={`${isCreateOpen}-${platforms?.length ?? 0}-${members?.length ?? 0}-${reciters?.length ?? 0}`}
                  onClose={() => setIsCreateOpen(false)}
                >
                  <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
                    <DialogTitle className="text-xl font-bold">
                      {TASK_FORM_STABILITY_MODE ? "إضافة مهمة جديدة" : isAdmin ? "إضافة مهمة جديدة" : "إضافة مهمة مقطوعة"}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="flex-1 overflow-y-auto px-6 py-4">
                    <Form {...createForm}>
                      <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4">
                        {(TASK_FORM_STABILITY_MODE || USE_SAFE_PHASE_ONE_TASK_FORM) && !(ENABLE_MEMBER_CREATED_TASKS && !isAdmin) ? (
                          <BasicTaskFormFields
                            platforms={platforms}
                            members={members as { id: number; name: string; role: string }[]}
                            reciters={reciters}
                            allTasks={dependencyCandidateTasks ?? rawTasks ?? []}
                            showDependency={ENABLE_TASK_DEPENDENCIES && isAdmin}
                          />
                        ) : (
                          <TaskFormFields
                            platforms={platforms}
                            members={members as { id: number; name: string; role: string }[]}
                            reciters={reciters}
                            allTasks={dependencyCandidateTasks ?? rawTasks ?? []}
                            showDependency={ENABLE_TASK_DEPENDENCIES && isAdmin}
                            isMemberSelfTask={ENABLE_MEMBER_CREATED_TASKS && !isAdmin}
                            currentMemberName={currentMemberName}
                          />
                        )}
                      </form>
                    </Form>
                  </div>
                  <div className="px-6 pb-6 pt-3 border-t border-border shrink-0">
                    <Button
                      type="button"
                      onClick={createForm.handleSubmit(onCreateSubmit)}
                      className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
                      disabled={isCreateSubmitting || createTask.isPending}
                    >
                      {(isCreateSubmitting || createTask.isPending) && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
                      حفظ المهمة
                    </Button>
                  </div>
                </TaskDialogErrorBoundary>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Submission URL dialog — all roles */}
      <Dialog open={!!urlDialog} onOpenChange={(open) => { if (!open) { setUrlDialog(null); urlForm.reset({ url: "" }); } }}>
        <DialogContent className="sm:max-w-[440px]" dir="rtl">
          <TaskDialogErrorBoundary
            dialogName="رابط الشاهد"
            resetKey={`${urlDialog?.taskId ?? "closed"}-${urlDialog?.mode ?? ""}-${urlDialog?.proofId ?? ""}`}
            onClose={() => {
              setUrlDialog(null);
              urlForm.reset({ url: "" });
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-xl font-bold flex items-center gap-2">
                <Link2 className="h-5 w-5 text-sidebar-primary" />
                {urlDialog?.mode === "proof-edit" ? "تعديل الشاهد" : "رابط الشاهد على العمل"}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {urlDialog?.mode === "proof-edit"
                ? "عدّل رابط هذا الشاهد فقط. لن يتغير عدد الشواهد أو حالة المهمة."
                : "أضف رابط المنشور أو المقطع كإثبات على إتمام المهمة — سيظهر للفريق كلّه."}
            </p>
            <form onSubmit={urlForm.handleSubmit(handleSubmissionUrl)} className="space-y-4 pt-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">رابط المنشور</label>
                <Input
                  {...urlForm.register("url")}
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  dir="ltr"
                  className="text-left"
                />
                {urlForm.formState.errors.url && (
                  <p className="text-xs text-red-500">{urlForm.formState.errors.url.message}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  className="flex-1 bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold"
                  disabled={updateTask.isPending || proofSaving}
                >
                  {updateTask.isPending || proofSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Check className="ml-2 h-4 w-4" />}
                  {urlDialog?.mode === "proof-edit" ? "حفظ التعديل" : "حفظ الرابط"}
                </Button>
                {urlDialog?.currentUrl && urlDialog?.mode === "task-url" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="text-red-600 border-red-200 hover:bg-red-50"
                    onClick={() => handleSubmissionUrl({ url: "" })}
                    disabled={updateTask.isPending || proofSaving}
                  >
                    حذف
                  </Button>
                )}
              </div>
            </form>
          </TaskDialogErrorBoundary>
        </DialogContent>
      </Dialog>

      {/* Weekly quota proofs dialog */}
      <Dialog open={!!proofsDialogTask} onOpenChange={(open) => { if (!open) setProofsDialogTaskId(null); }}>
        <DialogContent className="sm:max-w-[560px]" dir="rtl">
          <TaskDialogErrorBoundary
            dialogName="شواهد المهمة"
            resetKey={`${proofsDialogTaskId ?? "closed"}-${proofsDialogTask ? taskProofs(proofsDialogTask).length : 0}`}
            onClose={() => setProofsDialogTaskId(null)}
          >
            <DialogHeader>
              <DialogTitle className="text-xl font-bold flex items-center gap-2">
                <ExternalLink className="h-5 w-5 text-sidebar-primary" />
                شواهد المهمة
              </DialogTitle>
            </DialogHeader>
            {proofsDialogTask && (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <p className="text-sm font-semibold text-sidebar-foreground">{proofsDialogTask.title}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    المطلوب {weeklyQuotaInfo(proofsDialogTask).required} شواهد. يمكنك فتح أي شاهد أو تعديل رابطه أو إضافة شواهد إضافية دون تغيير العدد المطلوب أو حالة المهمة.
                  </p>
                </div>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                  {taskProofs(proofsDialogTask).length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border bg-background p-4 text-center text-sm text-muted-foreground">
                      لم تتم إضافة شواهد بعد.
                    </p>
                  ) : taskProofs(proofsDialogTask).map((proof, index) => (
                    <div key={proof.id} className="rounded-lg border border-border bg-background p-3 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-sidebar-foreground">
                          شاهد {index + 1}
                          {index + 1 > weeklyQuotaInfo(proofsDialogTask).required && (
                            <span className="mr-2 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                              إضافي
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          <a
                            href={proof.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            فتح
                          </a>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1"
                            onClick={() => openProofEditDialog(proofsDialogTask, proof)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            تعديل
                          </Button>
                        </div>
                      </div>
                      <p dir="ltr" className="break-all text-left text-xs text-muted-foreground">
                        {proof.url}
                      </p>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => {
                    setProofsDialogTaskId(null);
                    openUrlDialog(proofsDialogTask);
                  }}
                >
                  <Link2 className="h-4 w-4" />
                  {weeklyQuotaInfo(proofsDialogTask).completed >= weeklyQuotaInfo(proofsDialogTask).required
                    ? "إضافة شاهد إضافي"
                    : "إضافة شاهد جديد"}
                </Button>
              </div>
            )}
          </TaskDialogErrorBoundary>
        </DialogContent>
      </Dialog>

      {/* Quick reciter change dialog */}
      <Dialog open={!!quickReciterTask} onOpenChange={(open) => { if (!open) closeQuickReciterDialog(); }}>
        <DialogContent className="sm:max-w-[520px]" dir="rtl">
          <TaskDialogErrorBoundary
            dialogName="تغيير القارئ"
            resetKey={`${quickReciterTask?.id ?? "closed"}-${quickReciterId}-${quickReciterMemberOptions.length}`}
            onClose={closeQuickReciterDialog}
          >
            <DialogHeader>
              <DialogTitle className="text-xl font-bold flex items-center gap-2">
                <MicVocal className="h-5 w-5 text-sidebar-primary" />
                تغيير القارئ لهذه المهمة فقط
              </DialogTitle>
            </DialogHeader>
            {quickReciterTask && (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm text-sidebar-foreground">
                  سيتم تغيير القارئ والعضو المسؤول لهذه المهمة فقط، وستختفي من قائمة العضو السابق. لن تتغير السلسلة أو التاريخ أو الحالة أو الشواهد.
                </div>
                {quickReciterTask.status === "completed" && (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-700">
                    هذه المهمة مكتملة. سيبقى الإكمال والشواهد كما هي.
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium">القارئ الجديد</label>
                  <Select
                    value={quickReciterId || "none"}
                    onValueChange={(value) => {
                      if (value === "none") return;
                      setQuickReciterId(value);
                      if (taskReciterId(quickReciterTask) !== Number(value)) {
                        setQuickReciterMemberId("");
                      }
                    }}
                  >
                    <SelectTrigger className="bg-background">
                      <SelectValue placeholder="اختر القارئ" />
                    </SelectTrigger>
                    <SelectContent dir="rtl">
                      <SelectItem value="none" disabled>
                        اختر القارئ
                      </SelectItem>
                      {(reciters ?? []).filter((reciter) => !isPlaceholderApplicationReciter(reciter.name)).map((reciter) => (
                        <SelectItem key={reciter.id} value={String(reciter.id)}>
                          {reciter.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-sm font-medium">العضو المسؤول</label>
                    {quickReciterMembersLoading && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        جار فحص الربط
                      </span>
                    )}
                  </div>
                  <Select
                    value={quickReciterMemberId || "none"}
                    onValueChange={(value) => {
                      if (value === "none") return;
                      setQuickReciterMemberId(value);
                    }}
                  >
                    <SelectTrigger className="bg-background">
                      <SelectValue placeholder="اختر العضو" />
                    </SelectTrigger>
                    <SelectContent dir="rtl">
                      <SelectItem value="none" disabled>
                        اختر العضو
                      </SelectItem>
                      {quickReciterMemberOptions.map((member) => (
                        <SelectItem key={member.id} value={String(member.id)}>
                          {member.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className={cn("text-xs", quickReciterHasLinkedMembers ? "text-green-700" : "text-amber-700")}>
                    {quickReciterHasLinkedMembers
                      ? "تم عرض العضو أو الأعضاء المرتبطين بهذا القارئ في هذه المنصة."
                      : "لا يوجد ربط محدد لهذا القارئ، اختر العضو المسؤول يدويًا قبل التأكيد."}
                  </p>
                </div>
                <Button
                  type="button"
                  className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold"
                  disabled={
                    quickReciterSaving ||
                    quickReciterMembersLoading ||
                    !quickReciterMemberId ||
                    quickReciterMemberId === "none" ||
                    !quickReciterId ||
                    quickReciterId === "none"
                  }
                  onClick={handleQuickReciterChange}
                >
                  {quickReciterSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Check className="ml-2 h-4 w-4" />}
                  تأكيد تغيير القارئ
                </Button>
              </div>
            )}
          </TaskDialogErrorBoundary>
        </DialogContent>
      </Dialog>

      {/* Edit dialog — مدير فقط */}
      {isAdmin && (
        <Dialog open={!!editingTask} onOpenChange={(open) => { if (!open) setEditingTask(null); }}>
          <DialogContent className="sm:max-w-[480px] flex flex-col max-h-[90vh] p-0" dir="rtl">
            <TaskDialogErrorBoundary
              dialogName="تعديل المهمة"
              resetKey={`${editingTask?.id ?? "closed"}-${(editingTask as any)?.updatedAt ?? ""}-${members?.length ?? 0}-${reciters?.length ?? 0}`}
              onClose={() => setEditingTask(null)}
            >
              <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
                <DialogTitle className="text-xl font-bold">تعديل المهمة</DialogTitle>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <Form {...editForm}>
                  <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
                    {!TASK_FORM_STABILITY_MODE && (editingTask as any)?.seriesId && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-semibold text-sidebar-foreground">نطاق التعديل</span>
                          <Select value={editTaskScope} onValueChange={(value) => setEditTaskScope(value as EditTaskScope)}>
                            <SelectTrigger className="h-10 bg-background">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent dir="rtl">
                              <SelectItem value="single">تعديل هذه المهمة فقط</SelectItem>
                              <SelectItem value="future">تعديل هذه المهمة وما بعدها</SelectItem>
                              <SelectItem value="series">تعديل جميع مهام السلسلة</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-sm leading-6 text-amber-800">
                          {EDIT_SCOPE_MESSAGES[editTaskScope]} لن يتم تغيير حالة الإنجاز أو الشاهد لبقية الأيام.
                        </p>
                      </div>
                    )}
                    {TASK_FORM_STABILITY_MODE || USE_SAFE_PHASE_ONE_TASK_FORM ? (
                      <EditTaskFormFields
                        platforms={platforms}
                        members={members as { id: number; name: string; role: string }[]}
                        reciters={reciters}
                        currentTask={editingTask}
                        allTasks={dependencyCandidateTasks ?? rawTasks ?? []}
                        excludeTaskId={editingTask?.id}
                        showDependency={ENABLE_TASK_DEPENDENCIES && isAdmin}
                      />
                    ) : (
                      <TaskFormFields
                        platforms={platforms}
                        members={members as { id: number; name: string; role: string }[]}
                        reciters={reciters}
                        showStatus
                        allTasks={dependencyCandidateTasks ?? rawTasks ?? []}
                        currentTask={editingTask}
                        showDependency={ENABLE_TASK_DEPENDENCIES && isAdmin}
                        excludeTaskId={editingTask?.id}
                      />
                    )}
                  </form>
                </Form>
              </div>
              <div className="px-6 pb-6 pt-3 border-t border-border shrink-0">
                <Button
                  type="button"
                  onClick={editForm.handleSubmit(onEditSubmit)}
                  className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
                  disabled={updateTask.isPending}
                >
                  {updateTask.isPending && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
                  حفظ التعديلات
                </Button>
              </div>
            </TaskDialogErrorBoundary>
          </DialogContent>
        </Dialog>
      )}

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="بحث في المهام، المنصات، القراء، الأعضاء..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-11 pr-9 bg-card sm:h-10"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {activeTab === "active" &&
        (TASK_FORM_STABILITY_MODE
          ? isAdmin
          : isAdmin || (ENABLE_MEMBER_CREATED_TASKS && user?.memberId)) && (
          <Button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="h-12 w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold shadow-sm sm:hidden"
          >
            <Plus className="ml-2 h-4 w-4" />
            {TASK_FORM_STABILITY_MODE ? "مهمة جديدة" : isAdmin ? "مهمة جديدة" : "مهمة مقطوعة"}
          </Button>
        )}

      {activeTab === "active" && (
        <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:rounded-lg">
          <div className="flex items-center gap-2 mb-2 text-sm font-bold text-sidebar-primary">
            <Layers className="h-4 w-4" />
            <span>شريط المنصات</span>
          </div>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Button
              type="button"
              size="sm"
              variant={filterPlatform === "all" ? "default" : "outline"}
              className={cn(
                "h-10 shrink-0 rounded-full px-4 shadow-sm whitespace-nowrap sm:h-9 sm:rounded-md",
                filterPlatform === "all" && "bg-sidebar-primary text-sidebar-primary-foreground ring-2 ring-sidebar-primary/20 hover:bg-sidebar-primary/90"
              )}
              onClick={() => setFilterPlatform("all")}
            >
              الكل
            </Button>
            {platforms?.map((platform) => {
              const active = filterPlatform === platform.id.toString();
              return (
                <Button
                  key={platform.id}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  className={cn(
                    "h-10 shrink-0 gap-2 rounded-full px-4 shadow-sm whitespace-nowrap sm:h-9 sm:rounded-md",
                    active && "bg-sidebar-primary text-sidebar-primary-foreground ring-2 ring-sidebar-primary/20 hover:bg-sidebar-primary/90"
                  )}
                  onClick={() => setFilterPlatform(platform.id.toString())}
                >
                  <PlatformIcon name={platform.name} className="h-4 w-4" />
                  <span>{platform.name}</span>
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      {activeTab === "active" && (
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:flex sm:flex-row sm:flex-wrap sm:rounded-lg sm:p-4">
        <div className="flex items-center justify-between sm:hidden">
          <span className="text-sm font-bold text-sidebar-primary">الفلاتر</span>
          <span className="text-xs text-muted-foreground">مرتبطة بالبحث وشريط المنصات</span>
        </div>

        <div className="hidden sm:block">
          <Select value={filterPlatform} onValueChange={setFilterPlatform}>
            <SelectTrigger className="min-w-[140px] bg-background">
              <SelectValue placeholder="كل المنصات" />
            </SelectTrigger>
            <SelectContent dir="rtl">
              <SelectItem value="all">كل المنصات</SelectItem>
              {platforms?.map((p) => (
                <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Mosque filter (only in reciter view) */}
        {view === "reciter" && (
          <Select value={filterMosque} onValueChange={setFilterMosque}>
            <SelectTrigger className="w-full bg-background sm:min-w-[160px]">
              <SelectValue placeholder="كل المساجد" />
            </SelectTrigger>
            <SelectContent dir="rtl">
              <SelectItem value="all">كل المساجد</SelectItem>
              <SelectItem value="nabawi">🕌 المسجد النبوي</SelectItem>
              <SelectItem value="haram">🕋 المسجد الحرام</SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Reciter filter */}
        <Select value={filterReciter} onValueChange={setFilterReciter}>
          <SelectTrigger className="w-full bg-background sm:min-w-[150px]">
            <SelectValue placeholder="كل القراء" />
          </SelectTrigger>
          <SelectContent dir="rtl" className="max-h-64 overflow-y-auto">
            <SelectItem value="all">كل القراء</SelectItem>
            {reciters?.filter((r) => r.mosque === "nabawi").length ? (
              <>
                <div className="px-2 py-1 text-xs font-bold text-muted-foreground">🕌 النبوي</div>
                {reciters?.filter((r) => r.mosque === "nabawi").map((r) => (
                  <SelectItem key={r.id} value={r.id.toString()}>{r.name}</SelectItem>
                ))}
              </>
            ) : null}
            {reciters?.filter((r) => r.mosque === "haram").length ? (
              <>
                <div className="px-2 py-1 text-xs font-bold text-muted-foreground">🕋 الحرام</div>
                {reciters?.filter((r) => r.mosque === "haram").map((r) => (
                  <SelectItem key={r.id} value={r.id.toString()}>{r.name}</SelectItem>
                ))}
              </>
            ) : null}
          </SelectContent>
        </Select>

        {view === "list" && isAdmin && (
          <>
            <Select value={filterMember} onValueChange={setFilterMember} disabled={isAdminMemberPreview}>
              <SelectTrigger className="w-full bg-background sm:min-w-[150px]">
                <SelectValue placeholder="كل الأعضاء" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="all">كل الأعضاء</SelectItem>
                {user?.memberId && (
                  <SelectItem value="mine">مهامي</SelectItem>
                )}
                {members?.filter((m) => m.id !== user?.memberId).map((m) => (
                  <SelectItem key={m.id} value={m.id.toString()}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={adminPreviewMemberId}
              onValueChange={(value) => {
                setAdminPreviewMemberId(value);
                if (value !== "none") {
                  setFilterMember("all");
                  setView("list");
                }
              }}
            >
              <SelectTrigger className="w-full bg-background sm:min-w-[170px]">
                <SelectValue placeholder="عرض كعضو" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="none">عرض كمدير</SelectItem>
                {members?.map((m) => (
                  <SelectItem key={m.id} value={m.id.toString()}>عرض كـ {m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-full bg-background sm:min-w-[140px]">
            <SelectValue placeholder="كل الحالات" />
          </SelectTrigger>
          <SelectContent dir="rtl">
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="pending">قيد التنفيذ</SelectItem>
            <SelectItem value="completed">مكتمل</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterDueStatus} onValueChange={(v) => setFilterDueStatus(v as DueStatusFilter)}>
          <SelectTrigger className="w-full bg-background sm:min-w-[170px]">
            <SelectValue placeholder="حالة الاستحقاق" />
          </SelectTrigger>
          <SelectContent dir="rtl">
            <SelectItem value="all">كل حالات الاستحقاق</SelectItem>
            <SelectItem value="overdue">متأخرة</SelectItem>
            <SelectItem value="due_today">مستحقة اليوم</SelectItem>
            <SelectItem value="completed_on_time">مكتملة في الوقت</SelectItem>
            <SelectItem value="completed_late">مكتملة متأخرة</SelectItem>
          </SelectContent>
        </Select>

        {/* Date filter */}
        <Select value={filterDueDate} onValueChange={(v) => setFilterDueDate(v as typeof filterDueDate)}>
          <SelectTrigger className="w-full bg-background sm:min-w-[160px]">
            <SelectValue placeholder="كل الأوقات" />
          </SelectTrigger>
          <SelectContent dir="rtl">
            <SelectItem value="all">📅 كل الأوقات</SelectItem>
            <SelectItem value="today">اليوم</SelectItem>
            <SelectItem value="this_week">هذا الأسبوع</SelectItem>
            {!isAdmin && (
              <>
                <SelectItem value="next_week">الأسبوع القادم</SelectItem>
                <SelectItem value="overdue">⚠️ متأخرة</SelectItem>
              </>
            )}
          </SelectContent>
        </Select>

        {isAdmin && view === "list" && (
          <div className="flex w-full items-center gap-2 sm:mr-auto sm:w-auto">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              يعرض {adminListShown} من {adminListTotal} مهمة
            </span>
            <Select value={adminListLimit} onValueChange={(value) => setAdminListLimit(value as AdminListLimit)}>
              <SelectTrigger className="w-full bg-background sm:min-w-[120px]">
                <SelectValue placeholder="عدد المهام" />
              </SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="25">25 مهمة</SelectItem>
                <SelectItem value="50">50 مهمة</SelectItem>
                <SelectItem value="100">100 مهمة</SelectItem>
                <SelectItem value="all">الكل</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <Button type="button" variant="outline" className="w-full gap-2 sm:w-auto" onClick={resetFilters}>
          <RotateCcw className="h-4 w-4" />
          إعادة تعيين الفلاتر
        </Button>
      </div>
      )}

      {activeTab === "active" && view === "list" && (
        <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:rounded-lg">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CalendarDays className="h-4 w-4 text-sidebar-primary" />
                {quickWeekOffset === 0 ? "الأسبوع الحالي" : "الأسبوع المعروض"}
              </div>
              <div className="text-xs text-muted-foreground">
                {format(quickWeekStart, "d MMMM", { locale: ar })} — {format(quickWeekEnd, "d MMMM yyyy", { locale: ar })}
                {showHijri && (
                  <span className="ms-1 text-sidebar-primary/80">
                    ({formatHijriDate(quickWeekStart, { day: "numeric", month: "short" })} — {formatHijriDate(quickWeekEnd, { day: "numeric", month: "short", year: "numeric" })})
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1"
                onClick={() => {
                  setQuickWeekOffset((previous) => previous - 1);
                  setQuickDateFilter(null);
                  setFilterDueDate("all");
                }}
              >
                <ChevronRight className="h-4 w-4" />
                السابق
              </Button>
              <div className="w-[170px]">
                <DatePickerInput
                  value={quickDateFilter ? format(quickDateFilter, "yyyy-MM-dd") : ""}
                  onChange={handleQuickWeekDateSelect}
                  placeholder="اختر تاريخًا"
                  optional
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1"
                onClick={() => {
                  setQuickWeekOffset((previous) => previous + 1);
                  setQuickDateFilter(null);
                  setFilterDueDate("all");
                }}
              >
                التالي
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {(quickWeekOffset !== 0 || quickDateFilter) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 text-sidebar-primary"
                  onClick={() => {
                    setQuickWeekOffset(0);
                    setQuickDateFilter(null);
                    setFilterDueDate("all");
                  }}
                >
                  رجوع للحالي
                </Button>
              )}
              {quickDateFilter && (
                <button
                  type="button"
                  onClick={() => setQuickDateFilter(null)}
                  className="text-xs font-medium text-sidebar-primary hover:underline"
                >
                  عرض كل الأيام
                </button>
              )}
            </div>
          </div>
          <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-7 lg:overflow-visible lg:px-0 lg:pb-0 [&::-webkit-scrollbar]:hidden">
            {quickWeekDays.map((day) => {
              const selected = quickDateFilter ? isSameDay(day, quickDateFilter) : false;
              const today = isSameDay(day, new Date());
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  onClick={() => {
                    setQuickDateFilter(startOfDay(day));
                    setFilterDueDate("all");
                  }}
                  className={cn(
                    "min-w-[118px] shrink-0 rounded-md border px-3 py-2 text-center transition-colors lg:min-w-0 lg:shrink",
                    selected
                      ? "border-sidebar-primary bg-sidebar-primary text-sidebar-primary-foreground"
                      : today
                        ? "border-sidebar-primary/40 bg-sidebar-primary/5 text-sidebar-primary"
                        : "border-border bg-background hover:bg-muted/50"
                  )}
                >
                  <span className="block text-xs font-semibold">{format(day, "EEEE", { locale: ar })}</span>
                  <span className="block text-sm font-bold">{format(day, "d MMM", { locale: ar })}</span>
                  {showHijri && <span className="block text-[10px] font-medium opacity-80">{formatHijriDate(day, { day: "numeric", month: "short" })}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Trash view */}
      {activeTab === "trash" && (
        <div className="bg-card border border-border rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-red-50 border-b border-red-200 flex items-center gap-2 text-red-700 text-sm font-medium">
            <Trash2 className="h-4 w-4" />
            المهام المحذوفة — يمكن استعادتها أو حذفها نهائياً
          </div>
          {tasksLoading ? (
            <div className="p-8 flex justify-center"><Loader2 className="h-8 w-8 animate-spin text-sidebar-primary" /></div>
          ) : adminListTotal === 0 ? (
            <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
              <Trash2 className="h-12 w-12 mb-4 text-muted-foreground/30" />
              <p className="text-lg font-medium">السلة فارغة</p>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-right font-bold">المهمة</TableHead>
                  <TableHead className="text-right font-bold">المنصة</TableHead>
                  <TableHead className="text-right font-bold">المسؤولون</TableHead>
                  <TableHead className="text-right font-bold">الحالة</TableHead>
                  <TableHead className="w-[140px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks?.map((task) => {
                  const taskMembers = task.members && task.members.length > 0 ? task.members : [task.member];
                  return (
                      <TableRow
                        key={task.id}
                      id={`task-table-${task.id}`}
                      className={cn("hover:bg-red-50/20", isLinkedTask(task.id) && linkedTaskClassName)}
                    >
                      <TableCell className="font-medium">
                        <div>
                          <p className="line-through text-muted-foreground">{task.title}</p>
                          <TaskNoteLine task={task} compact className="mt-1 max-w-[260px] opacity-75" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <PlatformIcon name={task.platform.name} />
                          <span className="text-sm">{task.platform.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {taskMembers.map((m) => (
                            <span key={m.id} className="text-xs bg-muted text-muted-foreground rounded-full px-2 py-0.5">{m.name}</span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell><TaskStatusBadge status={task.status} /></TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1 text-green-700 border-green-300 hover:bg-green-50"
                            onClick={() => handleRestore(task.id)}
                          >
                            <RotateCcw className="h-3 w-3" />
                            استعادة
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50"
                            onClick={() => handlePermanentDelete(task.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                            حذف نهائي
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {/* Content — active tab only */}
      {activeTab === "active" && (tasksLoading ? (
        <div className="p-8 flex justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-sidebar-primary" />
        </div>
      ) : view === "calendar" ? (
        /* ── Weekly Calendar view ── */
        (() => {
          const today = startOfDay(new Date());
          const weekStart = addWeeks(startOfWeek(today, { weekStartsOn: 0 }), calendarWeekOffset);
          const weekEnd = endOfWeek(weekStart, { weekStartsOn: 0 });
          const days = eachDayOfInterval({ start: weekStart, end: weekEnd });
          const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
          const allTasks = tasks ?? [];
          const selectedDay = selectedCalendarDate ? startOfDay(selectedCalendarDate) : null;
          const calendarTasks = calendarIncompleteOnly
            ? allTasks.filter((task) => task.status !== "completed")
            : allTasks;
          const getTasksForDay = (day: Date) =>
            calendarTasks.filter((t) => {
              if (selectedDay && !isSameDay(day, selectedDay)) return false;
              const due = t.dueDate ? startOfDay(new Date(t.dueDate)) : null;
              return due && isSameDay(due, day);
            });
          return (
            <div className="space-y-3">
              {/* Week nav */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 bg-card border border-border rounded-lg px-4 py-2.5">
                <button
                  onClick={() => {
                    setCalendarWeekOffset((p) => p - 1);
                    setSelectedCalendarDate(null);
                  }}
                  className="flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-md border border-border hover:bg-muted"
                >
                  <ChevronRight className="h-4 w-4" />
                  الأسبوع السابق
                </button>
                <div className="text-center">
                  <p className="font-bold text-foreground">
                    {format(weekStart, "d MMMM", { locale: ar })} — {format(weekEnd, "d MMMM yyyy", { locale: ar })}
                  </p>
                  {showHijri && (
                    <p className="text-[11px] font-medium text-sidebar-primary/80">
                      {formatHijriDate(weekStart, { day: "numeric", month: "long" })} — {formatHijriDate(weekEnd, { day: "numeric", month: "long", year: "numeric" })}
                    </p>
                  )}
                  {calendarWeekOffset === 0 && (
                    <p className="text-xs text-sidebar-primary font-medium">الأسبوع الحالي</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      setCalendarWeekOffset((p) => p + 1);
                      setSelectedCalendarDate(null);
                    }}
                    className="flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-md border border-border hover:bg-muted"
                  >
                    الأسبوع القادم
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  {calendarWeekOffset !== 0 && (
                    <button
                      onClick={() => {
                        setCalendarWeekOffset(0);
                        setSelectedCalendarDate(null);
                      }}
                      className="text-xs text-sidebar-primary hover:bg-sidebar-primary/10 rounded-md px-2 py-2"
                    >
                      اليوم
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
                <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer w-fit">
                  <Checkbox
                    checked={calendarIncompleteOnly}
                    onCheckedChange={(checked) => setCalendarIncompleteOnly(Boolean(checked))}
                  />
                  عرض غير المكتمل فقط
                </label>
                {selectedDay && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      يعرض مهام {format(selectedDay, "EEEE، d MMMM", { locale: ar })}
                      {showHijri ? ` / ${formatHijriDate(selectedDay, { day: "numeric", month: "long", year: "numeric" })}` : ""}
                    </span>
                    <button
                      onClick={() => setSelectedCalendarDate(null)}
                      className="text-sidebar-primary hover:underline"
                    >
                      عرض الأسبوع كاملًا
                    </button>
                  </div>
                )}
              </div>
              {/* Days grid */}
              <div className="grid grid-cols-7 gap-2">
                {days.map((day, i) => {
                  const dayTasks = getTasksForDay(day);
                  const isT = isSameDay(day, today);
                  const isSelectedDay = selectedDay ? isSameDay(day, selectedDay) : false;
                  const isPastDay = isBefore(day, today) && !isT;
                  return (
                    <div
                      key={day.toISOString()}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedCalendarDate(startOfDay(day))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedCalendarDate(startOfDay(day));
                        }
                      }}
                      className={cn(
                        "rounded-lg border min-h-[160px] flex flex-col overflow-hidden cursor-pointer transition-colors",
                        isSelectedDay
                          ? "border-blue-400 bg-blue-50/40"
                          : isT
                            ? "border-sidebar-primary/70 bg-sidebar-primary/5"
                            : isPastDay
                              ? "border-border bg-muted/30"
                              : "border-border bg-card"
                      )}
                    >
                      {/* Day header */}
                      <div className={cn(
                        "px-2 py-1.5 text-center border-b",
                        isT ? "bg-sidebar-primary/10 text-sidebar-primary border-sidebar-primary/20" : "bg-muted/40 border-border",
                        isSelectedDay && "bg-blue-50 text-blue-700 border-blue-100"
                      )}>
                        <p className="text-xs font-bold">{DAY_NAMES[i]}</p>
                        <p className={cn("text-lg font-black leading-tight", isT ? "text-sidebar-primary" : isPastDay ? "text-muted-foreground" : "text-foreground")}>
                          {format(day, "d")}
                        </p>
                        {showHijri && (
                          <p className="text-[10px] font-medium text-sidebar-primary/80">
                            {formatHijriDate(day, { day: "numeric", month: "short" })}
                          </p>
                        )}
                      </div>
                      {/* Tasks */}
                      <div className="flex-1 p-1.5 space-y-1 overflow-y-auto max-h-[320px]">
                        {dayTasks.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground/50 text-center mt-3">—</p>
                        ) : dayTasks.map((task) => {
                          const reciter = task.reciter as Reciter | null | undefined;
                          const isCompleted = task.status === "completed";
                          const taskDueDate = task.dueDate ? startOfDay(new Date(task.dueDate)) : null;
                          const isOverdueTask = !!taskDueDate && isBefore(taskDueDate, today) && !isCompleted;
                          return (
                            <div
                              key={task.id}
                              id={`task-${task.id}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (isAdmin) openEditDialog(task);
                              }}
                              className={cn(
                                "rounded-md px-1.5 py-1 text-[10px] leading-tight border",
                                isCompleted && "bg-green-50 border-green-200 text-green-700",
                                !isCompleted && !isOverdueTask && "bg-sidebar-primary/10 border-sidebar-primary/20 text-foreground",
                                isOverdueTask && "bg-red-50/60 border-red-200/70 text-foreground",
                                isAdmin && "cursor-pointer hover:shadow-sm hover:scale-[1.01] transition-all",
                                isLinkedTask(task.id) && linkedTaskClassName
                              )}
                            >
                              <p className="font-semibold truncate">{task.title}</p>
                              {isWeeklyQuotaTask(task) && (
                                <p className="text-[10px] text-amber-700">
                                  {weeklyQuotaInfo(task).completed}/{weeklyQuotaInfo(task).required} شواهد
                                  {weeklyQuotaInfo(task).extra > 0 ? ` +${weeklyQuotaInfo(task).extra} إضافي` : ""}
                                </p>
                              )}
                              <TaskNoteLine task={task} compact className="mt-1" />
                              {reciter && <p className="text-muted-foreground truncate">{reciter.name}</p>}
                              <div className="flex items-center justify-between gap-1 mt-1">
                                <div className="flex items-center gap-1 min-w-0">
                                  <PlatformIcon name={task.platform.name} className="h-2.5 w-2.5 shrink-0" />
                                  <span className="truncate text-muted-foreground">{task.platform.name}</span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {task.submissionUrl && (
                                    <a
                                      href={task.submissionUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="فتح الشاهد"
                                      onClick={(event) => event.stopPropagation()}
                                      className="h-5 w-5 rounded border border-green-200 bg-green-50 text-green-700 flex items-center justify-center hover:bg-green-100"
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                  {isCompleted ? (
                                    <span className="h-5 w-5 rounded-full bg-green-100 text-green-700 flex items-center justify-center" title="مكتملة">
                                      <Check className="h-3 w-3" />
                                    </span>
                                  ) : (
                                    <button
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleStatusChange(task.id, "completed");
                                      }}
                                      disabled={updateTask.isPending}
                                      title="إتمام المهمة"
                                      className="h-5 w-5 rounded-full border border-green-300 bg-background text-green-700 flex items-center justify-center hover:bg-green-50 disabled:opacity-50"
                                    >
                                      <Check className="h-3 w-3" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Legend */}
              <div className="flex items-center gap-4 text-xs text-muted-foreground px-1">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-sidebar-primary/20 border border-sidebar-primary/30 inline-block" />معلّقة</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-100 border border-green-200 inline-block" />مكتملة</span>
                {isAdmin && <span className="text-muted-foreground/70">انقر على المهمة لتعديلها</span>}
              </div>
            </div>
          );
        })()
      ) : view === "reciter" ? (
        <ReciterGroupedView
          tasks={showArchived ? tasks?.filter((t) => t.status === "completed") : tasks}
          reciters={reciters}
          filterPlatform={filterPlatform}
          filterMosque={filterMosque}
          onEdit={openEditDialog}
          onDelete={handleDelete}
          onStatusChange={handleStatusChange}
          updateTaskPending={updateTask.isPending}
        />
      ) : (
        /* List view */
        <div className="bg-card border border-border rounded-lg shadow-sm overflow-hidden">
          {(!isAdmin || isAdminMemberPreview) ? (
            /* ── Member view: day-expanded rows with collapsed completed ── */
            <>
              {isAdminMemberPreview && (
                <div className="border-b border-blue-100 bg-blue-50/60 px-4 py-2 text-sm font-medium text-blue-700">
                  تعرض الآن صفحة المهام كما يراها العضو المحدد، مع بقاء صلاحياتك كمدير محفوظة.
                </div>
              )}
              {pendingMemberRows.length === 0 && completedMemberRows.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
                  <CircleDashed className="h-12 w-12 mb-4 text-muted-foreground/50" />
                  <p className="text-lg font-medium">لا توجد مهام مطابقة</p>
                </div>
              ) : (
                <>
                  {pendingMemberRows.length > 0 && (
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="text-right font-bold w-[28%]">المهمة</TableHead>
                          <TableHead className="text-right font-bold">المنصة</TableHead>
                          <TableHead className="text-right font-bold">اليوم</TableHead>
                          <TableHead className="text-right font-bold">الاستحقاق</TableHead>
                          <TableHead className="text-right font-bold">القارئ</TableHead>
                          <TableHead className="text-right font-bold w-[90px]">الشاهد</TableHead>
                          <TableHead className="w-[50px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingMemberRows.map(({ task, key, isOverdue }) => {
                          const reciter = task.reciter as Reciter | null | undefined;
                          const dueDate = task.dueDate ? startOfDay(new Date(task.dueDate)) : null;
                          return (
                            <TableRow
                              key={key}
                              id={`task-${task.id}`}
                              className={cn(
                                "hover:bg-muted/30 transition-colors",
                                isOverdue && "bg-red-50/50 hover:bg-red-50/70",
                                isLinkedTask(task.id) && linkedTaskClassName
                              )}
                            >
                              <TableCell className="font-medium">
                                <div className="flex flex-col gap-0.5">
                                  <span>{task.title}</span>
                                  <WeeklyQuotaBadge task={task} />
                                  <MemberCreatedTaskBadge task={task} />
                                  <TaskNoteLine task={task} className="mt-1 max-w-[320px]" />
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <PlatformIcon name={task.platform.name} className="h-4 w-4" />
                                  <span className="text-sm">{task.platform.name}</span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <TaskDayDateLabel dueDate={dueDate} showHijri={showHijri} />
                              </TableCell>
                              <TableCell><TaskDueStatusLabel task={task} /></TableCell>
                              <TableCell>
                                {reciter ? <span className="text-sm">{reciter.name}</span> : <span className="text-xs text-muted-foreground">—</span>}
                              </TableCell>
                              <TableCell>
                                <TaskProofCell task={task} onAdd={openUrlDialog} onManage={openProofsDialog} />
                              </TableCell>
                              <TableCell>
                                <button onClick={() => handleStatusChange(task.id, "completed")} title="تمت"
                                  className="h-7 w-7 rounded-full border-2 border-muted-foreground/30 hover:border-green-400 hover:bg-green-50 flex items-center justify-center transition-all">
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}

                  {/* Completed tasks — collapsible */}
                  {completedMemberRows.length > 0 && (
                    <div className="border-t border-border">
                      <button onClick={() => setCompletedCollapsed((c) => !c)}
                        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-sm font-medium text-muted-foreground">
                        <div className="flex items-center gap-2">
                          {completedCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          <span>المهام المكتملة · {new Set(completedMemberRows.map((r) => r.task.id)).size} مهمة</span>
                        </div>
                        <Check className="h-4 w-4 text-green-500" />
                      </button>
                      {!completedCollapsed && (
                        <Table>
                          <TableBody>
                            {completedMemberRows.map(({ task, key }) => {
                              const reciter = task.reciter as Reciter | null | undefined;
                              const dueDate = task.dueDate ? startOfDay(new Date(task.dueDate)) : null;
                              return (
                                <TableRow
                                  key={key}
                                  id={`task-${task.id}`}
                                  className={cn(
                                    "bg-muted/10 hover:bg-muted/20 transition-colors",
                                    isLinkedTask(task.id) && linkedTaskClassName
                                  )}
                                >
                                  <TableCell className="w-[28%]">
                                    <div className="flex flex-col gap-0.5 opacity-60">
                                      <span className="font-medium line-through">{task.title}</span>
                                      <WeeklyQuotaBadge task={task} />
                                      <MemberCreatedTaskBadge task={task} />
                                      <TaskNoteLine task={task} compact className="mt-1 max-w-[320px]" />
                                    </div>
                                  </TableCell>
                                  <TableCell className="opacity-60">
                                    <div className="flex items-center gap-2">
                                      <PlatformIcon name={task.platform.name} className="h-4 w-4" />
                                      <span className="text-sm text-muted-foreground">{task.platform.name}</span>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="opacity-60">
                                      <TaskDayDateLabel dueDate={dueDate} showHijri={showHijri} />
                                    </div>
                                  </TableCell>
                                  <TableCell><TaskDueStatusLabel task={task} /></TableCell>
                                  <TableCell className="opacity-60">
                                    {reciter ? <span className="text-sm text-muted-foreground">{reciter.name}</span> : <span className="text-xs text-muted-foreground">—</span>}
                                  </TableCell>
                                  <TableCell>
                                    <TaskProofCell task={task} onAdd={openUrlDialog} onManage={openProofsDialog} />
                                  </TableCell>
                                  <TableCell>
                                    <button onClick={() => handleStatusChange(task.id, "pending")} title="إلغاء الإتمام"
                                      className="h-7 w-7 rounded-full border-2 bg-green-500 border-green-500 text-white flex items-center justify-center transition-all hover:bg-red-400 hover:border-red-400">
                                      <Check className="h-3.5 w-3.5" />
                                    </button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          ) : tasks?.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
              <CircleDashed className="h-12 w-12 mb-4 text-muted-foreground/50" />
              <p className="text-lg font-medium">لا توجد مهام مطابقة</p>
              <p className="text-sm mt-1">قم بتغيير فلاتر البحث أو أضف مهمة جديدة</p>
            </div>
          ) : (
            /* ── Admin view ── */
            <>
            <div className="space-y-3 md:hidden">
              {adminListTasks?.map((task) => {
                const isOverdue =
                  Boolean(task.dueDate) &&
                  task.status !== "completed" &&
                  isPast(new Date(task.dueDate!)) &&
                  !isToday(new Date(task.dueDate!));
                const isSelected = selectedTaskIds.has(task.id);
                return (
                  <AdminTaskMobileCard
                    key={task.id}
                    task={task}
                    isSelected={isSelected}
                    isOverdue={isOverdue}
                    showHijri={showHijri}
                    onToggleSelect={() => toggleTaskSelect(task.id)}
                    onEdit={() => openEditDialog(task)}
                    onQuickReciter={() => openQuickReciterDialog(task)}
                    onComments={() => openComments(task)}
                    onProof={() => openUrlDialog(task)}
                    onManageProofs={() => openProofsDialog(task)}
                    onDuplicate={() => handleDuplicate(task.id)}
                    onStatusChange={(status) => handleStatusChange(task.id, status)}
                    onDelete={() => handleDelete(task.id)}
                  />
                );
              })}
            </div>
            <div className="hidden md:block">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-[40px] pr-4">
                    <Checkbox
                      checked={!!(adminListTasks?.length && selectedTaskIds.size === adminListTasks.length)}
                      onCheckedChange={(c) => c ? selectAllAdminTasks() : clearSel()}
                    />
                  </TableHead>
                  <TableHead className="text-right font-bold w-[20%]">المهمة</TableHead>
                  <TableHead className="text-right font-bold">المنصة</TableHead>
                  <TableHead className="text-right font-bold">القارئ</TableHead>
                  <TableHead className="text-right font-bold">المسؤولون</TableHead>
                  <TableHead className="text-right font-bold">الحالة</TableHead>
                  <TableHead className="text-right font-bold">اليوم / التاريخ</TableHead>
                  <TableHead className="text-right font-bold">الاستحقاق</TableHead>
                  <TableHead className="text-right font-bold w-[90px]">الشاهد</TableHead>
                  <TableHead className="w-[70px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adminListTasks?.map((task) => {
                  const reciter = task.reciter as Reciter | null | undefined;
                  const isOverdue =
                    task.dueDate &&
                    task.status !== "completed" &&
                    isPast(new Date(task.dueDate)) &&
                    !isToday(new Date(task.dueDate));
                  const taskMembers = task.members && task.members.length > 0 ? task.members : [task.member];
                  const isSelected = selectedTaskIds.has(task.id);
                  return (
                    <TableRow
                      key={task.id}
                      id={`task-${task.id}`}
                      className={cn(
                        "hover:bg-muted/30 transition-colors",
                        isOverdue && "bg-red-50/40 hover:bg-red-50/60",
                        isSelected && "bg-sidebar-primary/5",
                        isLinkedTask(task.id) && linkedTaskClassName
                      )}
                    >
                      <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={isSelected} onCheckedChange={() => toggleTaskSelect(task.id)} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>{task.title}</span>
                            <WeeklyQuotaBadge task={task} />
                            <MemberCreatedTaskBadge task={task} />
                            {task.recurrence && task.recurrence !== "none" && (
                              <span className={cn(
                                "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border",
                                task.recurrence === "daily" ? "bg-green-50 text-green-600 border-green-200" :
                                task.recurrence === "weekly" ? "bg-blue-50 text-blue-600 border-blue-200" :
                                task.recurrence === "custom_days" ? "bg-orange-50 text-orange-600 border-orange-200" :
                                "bg-purple-50 text-purple-600 border-purple-200"
                              )}>
                                <Repeat2 className="h-2.5 w-2.5" />
                                {task.recurrence === "daily" ? "يومي" : task.recurrence === "weekly" ? "أسبوعي" : task.recurrence === "custom_days" ? "أيام محددة" : "شهري"}
                              </span>
                              )}
                            </div>
                            <TaskNoteLine task={task} className="max-w-[360px]" />
                          </div>
                        </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <PlatformIcon name={task.platform.name} />
                          <span className="text-sm">{task.platform.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {reciter ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium">{reciter.name}</span>
                              {isAdmin && activeTab === "active" && (
                                <button
                                  type="button"
                                  onClick={() => openQuickReciterDialog(task)}
                                  className="h-6 w-6 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-sidebar-primary hover:bg-sidebar-primary/10 transition-colors"
                                  title="تغيير القارئ لهذه المهمة فقط"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              {MOSQUE_ICON[reciter.mosque]} {reciter.mosque === "nabawi" ? "النبوي" : "الحرام"}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {taskMembers.map((m) => (
                            <span key={m.id} className="inline-block text-xs font-medium bg-sidebar-primary/10 text-sidebar-primary border border-sidebar-primary/20 rounded-full px-2 py-0.5">
                              {m.name}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell><TaskStatusBadge status={task.status} /></TableCell>
                      <TableCell><TaskDayDateLabel dueDate={task.dueDate} showHijri={showHijri} /></TableCell>
                      <TableCell><TaskDueStatusLabel task={task} /></TableCell>
                      {/* Submission URL column */}
                      <TableCell>
                        <TaskProofCell task={task} onAdd={openUrlDialog} onManage={openProofsDialog} />
                      </TableCell>
                      <TableCell>
                        {isAdmin ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" className="h-8 w-8 p-0 hover:bg-muted">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem onClick={() => openEditDialog(task)} className="cursor-pointer flex items-center gap-2 font-medium">
                                <Pencil className="h-4 w-4 text-sidebar-primary" />تعديل المهمة
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openQuickReciterDialog(task)} className="cursor-pointer flex items-center gap-2">
                                <MicVocal className="h-4 w-4 text-sidebar-primary/70" />تغيير القارئ
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openComments(task)} className="cursor-pointer flex items-center gap-2">
                                <MessageSquare className="h-4 w-4 text-sidebar-primary/70" />التعليقات
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openUrlDialog(task)} className="cursor-pointer flex items-center gap-2">
                                <Link2 className="h-4 w-4 text-sidebar-primary/70" />رابط الشاهد
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleDuplicate(task.id)} className="cursor-pointer flex items-center gap-2">
                                <Copy className="h-4 w-4 text-violet-500" />نسخ المهمة
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleStatusChange(task.id, "pending")} className="cursor-pointer flex items-center gap-2">
                                <CircleDashed className="h-4 w-4 text-gray-500" />قيد الانتظار
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleStatusChange(task.id, "completed")} className="cursor-pointer flex items-center gap-2">
                                <Check className="h-4 w-4 text-green-600" />مكتمل
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleDelete(task.id)} className="cursor-pointer flex items-center gap-2 text-red-600 focus:text-red-700 focus:bg-red-50">
                                <Trash2 className="h-4 w-4" />نقل إلى السلة
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <button
                            onClick={() => handleStatusChange(task.id, task.status === "completed" ? "pending" : "completed")}
                            title={task.status === "completed" ? "إلغاء الإتمام" : "تمت"}
                            className={cn(
                              "h-7 w-7 rounded-full border-2 flex items-center justify-center transition-all",
                              task.status === "completed"
                                ? "bg-green-500 border-green-500 text-white"
                                : "border-muted-foreground/30 hover:border-green-400 hover:bg-green-50"
                            )}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
            </>
          )}
        </div>
      ))}

      {/* Comments dialog */}
      <TaskDialogErrorBoundary
        dialogName="تعليقات المهمة"
        resetKey={`${commentsTaskId ?? "closed"}-${commentsTaskTitle}`}
        onClose={() => {
          setCommentsTaskId(null);
          setCommentsTaskTitle("");
        }}
      >
        <CommentsDialog
          taskId={commentsTaskId}
          taskTitle={commentsTaskTitle}
          onClose={() => {
            setCommentsTaskId(null);
            setCommentsTaskTitle("");
          }}
        />
      </TaskDialogErrorBoundary>

      {/* Bulk action bar */}
      {isAdmin && !isAdminMemberPreview && selectedTaskIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-sidebar-primary text-sidebar-primary-foreground px-4 py-2.5 rounded-xl shadow-2xl border border-white/10">
          <span className="font-semibold text-sm">{selectedTaskIds.size} مهمة محددة</span>
          <div className="h-5 w-px bg-white/20 mx-1" />
          <Select value={bulkReassignId} onValueChange={handleBulkReassign} disabled={bulkPending}>
            <SelectTrigger className="h-8 min-w-[150px] bg-white/10 border-white/20 text-white text-xs hover:bg-white/20">
              <Users className="h-3 w-3 ml-1.5 shrink-0" />
              <SelectValue placeholder="إسناد لعضو..." />
            </SelectTrigger>
            <SelectContent dir="rtl">
              <SelectItem value="none">— اختر عضواً —</SelectItem>
              {members?.map((m) => (
                <SelectItem key={m.id} value={m.id.toString()}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="destructive"
            className="h-8 gap-1 bg-red-500 hover:bg-red-600"
            onClick={handleBulkDelete}
            disabled={bulkPending}
          >
            {bulkPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            حذف
          </Button>
          <button
            onClick={clearSel}
            className="h-8 w-8 flex items-center justify-center rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
