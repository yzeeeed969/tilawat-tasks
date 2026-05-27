import { useState, useEffect, useMemo, useRef } from "react";
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
  seriesType: z.enum(["temporary", "operational"]).optional(),
  startDate: z.string().min(1, { message: "تاريخ البداية مطلوب" }),
  endDate: z.string().optional(),
  dueDate: z.string().optional(),
  recurrence: z.enum(["none", "daily", "weekly", "monthly", "custom_days"]).optional(),
  recurrenceIntervalDays: z.coerce.number().min(1).max(365).optional().nullable(),
  recurrenceDurationDays: z.coerce.number().min(1).max(365).optional().nullable(),
  recurrenceDays: z.string().optional().nullable(),
  submissionUrl: z.string().url({ message: "أدخل رابطاً صحيحاً" }).or(z.literal("")).optional().nullable(),
}).superRefine((data, ctx) => {
  if ((data.seriesType ?? "temporary") === "operational" && data.recurrence !== "weekly" && data.recurrence !== "monthly") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "اختر تكراراً أسبوعياً أو شهرياً",
      path: ["recurrence"],
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


function TaskFormFields({
  platforms,
  members,
  reciters,
  showStatus,
}: {
  platforms: { id: number; name: string }[] | undefined;
  members: { id: number; name: string; role: string }[] | undefined;
  reciters: Reciter[] | undefined;
  showStatus?: boolean;
}) {
  const { watch, setValue } = useFormContext<TaskFormValues>();
  const platformId = watch("platformId");
  const reciterId = watch("reciterId");
  const pageId = watch("pageId");
  const memberIds = watch("memberIds") ?? [];
  const appPrayer = watch("appPrayer");
  const seriesType = watch("seriesType") ?? "temporary";
  const recurrence = watch("recurrence") ?? "none";
  const recurrenceDays = watch("recurrenceDays") ?? "";
  const selectedPlatform = platforms?.find((p) => p.id === platformId);
  const isApplicationPlatform = isApplicationPlatformName(selectedPlatform?.name);
  const applicationReciters = useMemo(
    () => reciters?.filter((r) => !isPlaceholderApplicationReciter(r.name)) ?? [],
    [reciters]
  );
  const previousPlatformIdRef = useRef<number | undefined>(undefined);

  const { data: pages } = useListPlatformPages(platformId ?? 0, {
    query: { queryKey: getListPlatformPagesQueryKey(platformId ?? 0), enabled: !!platformId },
  });

  const selectedApplicationPage = useMemo(
    () => pages?.find((pg) => pg.reciterId === reciterId),
    [pages, reciterId]
  );

  const { data: pageMembers } = useQuery<number[]>({
    queryKey: ["page-members", pageId],
    queryFn: async () => {
      if (!pageId) return [];
      const r = await fetch(`/api/platforms/0/pages/${pageId}/members`, { credentials: "include" });
      return r.json();
    },
    enabled: !!pageId,
  });

  const filteredMembers = useMemo(() => {
    if (isApplicationPlatform) return members;
    if (!pageId || pageMembers === undefined) return members;
    if (pageMembers.length === 0) return [];
    return members?.filter((m) => pageMembers.includes(m.id));
  }, [isApplicationPlatform, members, pageId, pageMembers]);

  useEffect(() => {
    if (previousPlatformIdRef.current === undefined) {
      previousPlatformIdRef.current = platformId;
      return;
    }
    if (previousPlatformIdRef.current === platformId) return;
    previousPlatformIdRef.current = platformId;
    setValue("pageId", null);
    setValue("reciterId", null);
    setValue("memberIds", []);
    setValue("appPrayer", null);
  }, [platformId, setValue]);

  useEffect(() => {
    if (seriesType === "temporary" && recurrence !== "none") {
      setValue("recurrence", "none");
    }
    if (seriesType === "operational" && recurrence !== "weekly" && recurrence !== "monthly") {
      setValue("recurrence", "weekly");
    }
    if ((seriesType !== "operational" || recurrence !== "weekly") && recurrenceDays) {
      setValue("recurrenceDays", null);
    }
  }, [seriesType, recurrence, recurrenceDays, setValue]);

  // Auto-set reciterId from page when page changes
  useEffect(() => {
    if (pageId && pages) {
      const page = pages.find((pg) => pg.id === pageId);
      if (page?.reciterId) {
        setValue("reciterId", page.reciterId);
      }
    }
  }, [pageId, pages, setValue]);

  useEffect(() => {
    if (!isApplicationPlatform || !reciterId) return;
    setValue("pageId", selectedApplicationPage?.id ?? null);
  }, [isApplicationPlatform, reciterId, selectedApplicationPage?.id, setValue]);

  useEffect(() => {
    if (!isApplicationPlatform || !pageId || !pageMembers || pageMembers.length === 0 || memberIds.length > 0) return;
    setValue("memberIds", pageMembers);
  }, [isApplicationPlatform, pageId, pageMembers, memberIds.length, setValue]);

  useEffect(() => {
    const platform = platforms?.find((p) => p.id === platformId);
    const reciter = reciters?.find((r) => r.id === reciterId);
    const page = pages?.find((pg) => pg.id === pageId);
    if (isApplicationPlatform) {
      const parts = [appPrayer, reciter?.name, platform?.name].filter(Boolean) as string[];
      setValue("title", parts.join(" — ") || "مهمة جديدة");
      return;
    }
    const location = page?.name || platform?.name || "";
    const parts: string[] = [];
    if (location) parts.push(location);
    if (reciter?.name) parts.push(reciter.name);
    setValue("title", parts.join(" — ") || "مهمة جديدة");
  }, [platformId, reciterId, pageId, appPrayer, isApplicationPlatform, platforms, reciters, pages, setValue]);

  return (
    <>
      <FormField
        name="platformId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>المنصة</FormLabel>
            <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value?.toString()}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="اختر المنصة" />
                </SelectTrigger>
              </FormControl>
              <SelectContent dir="rtl">
                {platforms?.map((p) => (
                  <SelectItem key={p.id} value={p.id.toString()}>
                    <div className="flex items-center gap-2">
                      <PlatformIcon name={p.name} />
                      <span>{p.name}</span>
                    </div>
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
                  onValueChange={(v) => field.onChange(v === "none" ? null : parseInt(v))}
                  value={field.value != null ? field.value.toString() : "none"}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر القارئ" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent dir="rtl">
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
                  <SelectContent dir="rtl">
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
      ) : pages && pages.length > 0 ? (
        <FormField
          name="pageId"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <LayoutList className="h-3.5 w-3.5 text-sidebar-primary" />
                الصفحة / القناة
              </FormLabel>
              <Select
                onValueChange={(v) => field.onChange(v === "none" ? null : parseInt(v))}
                value={field.value != null ? field.value.toString() : "none"}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الصفحة (اختياري)" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">بدون تحديد صفحة</span>
                  </SelectItem>
                  {pages.map((pg) => (
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
        const page = pages?.find((pg) => pg.id === pageId);
        const displayReciter = reciters?.find((r) => r.id === page?.reciterId);
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

      <FormField
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-muted-foreground text-sm">
              ملاحظة <span className="text-xs">(اختياري)</span>
            </FormLabel>
            <FormControl>
              <Textarea
                placeholder="أي تفاصيل أو توجيهات إضافية للعضو..."
                className="resize-none min-h-[72px]"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

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
              <Select onValueChange={field.onChange} value={field.value ?? "temporary"}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر نوع المهمة" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent dir="rtl">
                  <SelectItem value="temporary">مهمة مؤقتة</SelectItem>
                  <SelectItem value="operational">مهمة تشغيلية متكررة</SelectItem>
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
                    <SelectItem value="weekly">
                      <div className="flex items-center gap-2">
                        <Repeat2 className="h-3.5 w-3.5 text-blue-500" />
                        أسبوعي - كل أسبوع في نفس اليوم
                      </div>
                    </SelectItem>
                    <SelectItem value="monthly">
                      <div className="flex items-center gap-2">
                        <Repeat2 className="h-3.5 w-3.5 text-purple-500" />
                        شهري - كل شهر في نفس التاريخ
                      </div>
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
        <div className={cn("grid gap-3", seriesType === "operational" ? "grid-cols-1" : "grid-cols-2")}>
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
              ? "ينشئ النظام مهاماً مستقلة شهرياً في نفس تاريخ البداية ضمن نافذة 60 يوماً قادمة."
              : "ينشئ النظام مهاماً مستقلة أسبوعياً في نفس يوم البداية ضمن نافذة 60 يوماً قادمة."
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
                    <div className="flex items-center gap-2">
                      <Flame className="h-3.5 w-3.5 text-red-500" />
                      عاجل
                    </div>
                  </SelectItem>
                  <SelectItem value="normal">
                    <div className="flex items-center gap-2">
                      <Minus className="h-3.5 w-3.5 text-blue-500" />
                      عادي
                    </div>
                  </SelectItem>
                  <SelectItem value="low">
                    <div className="flex items-center gap-2">
                      <ArrowDown className="h-3.5 w-3.5 text-gray-400" />
                      منخفض
                    </div>
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
                <Select onValueChange={field.onChange} value={field.value}>
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
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [quickDateFilter, setQuickDateFilter] = useState<Date | null>(null);
  const [adminPreviewMemberId, setAdminPreviewMemberId] = useState<string>("none");
  const [activeTab, setActiveTab] = useState<"active" | "trash">("active");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskWithDetails | null>(null);
  const [editTaskScope, setEditTaskScope] = useState<EditTaskScope>("series");
  const [urlDialog, setUrlDialog] = useState<{ taskId: number; currentUrl: string } | null>(null);
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
  }, [searchedTasks, filterPlatform, filterReciter, filterStatus, quickDateFilter, filterDueDate]);

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
  const quickWeekDays = useMemo(() => {
    const start = startOfWeek(new Date(), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end: addDays(start, 6) });
  }, []);

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

  const openEditDialog = (task: TaskWithDetails) => {
    setEditingTask(task);
    setEditTaskScope((task as any).seriesId ? "series" : "single");
    const allMembers = task.members && task.members.length > 0 ? task.members : [task.member];
    const reciter = task.reciter as Reciter | null | undefined;
    const taskRecurrence = (task.recurrence ?? "none") as TaskFormValues["recurrence"];
    editForm.reset({
      title: task.title,
      description: task.description ?? "",
      platformId: task.platform.id,
      pageId: task.pageId ?? null,
      memberIds: allMembers.map((m) => m.id),
      reciterId: reciter?.id ?? null,
      status: task.status as TaskFormValues["status"],
      priority: (task.priority ?? "normal") as TaskFormValues["priority"],
      progress: task.progress ?? 0,
      seriesType: taskRecurrence === "weekly" || taskRecurrence === "monthly" ? "operational" : "temporary",
      startDate: (task as any).startDate ? format(new Date((task as any).startDate), "yyyy-MM-dd") : "",
      dueDate: task.dueDate ? format(new Date(task.dueDate), "yyyy-MM-dd") : "",
      endDate: (task as any).endDate ? format(new Date((task as any).endDate), "yyyy-MM-dd") : "",
      recurrence: taskRecurrence,
      recurrenceIntervalDays: (task as any).recurrenceIntervalDays ?? null,
      recurrenceDurationDays: (task as any).recurrenceDurationDays ?? null,
      recurrenceDays: (task as any).recurrenceDays ?? null,
    });
  };

  const openComments = (task: TaskWithDetails) => {
    setCommentsTaskId(task.id);
    setCommentsTaskTitle(task.title);
  };

  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });

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
    const seriesType = data.seriesType ?? "temporary";
    const recurrence = seriesType === "operational" ? (data.recurrence === "monthly" ? "monthly" : "weekly") : "none";
    const recurrenceDays = seriesType === "operational" && recurrence === "weekly"
      ? data.recurrenceDays ?? null
      : null;
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
      if (isApplicationPlatform && data.reciterId) {
        pageId = await ensureApplicationReciterPage(data.platformId, data.reciterId, data.memberIds);
      }
      const reciter = reciters?.find((r) => r.id === data.reciterId);
      const taskTitle = isApplicationPlatform
        ? [data.appPrayer, reciter?.name, selectedPlatform?.name].filter(Boolean).join(" — ")
        : data.title || "مهمة جديدة";

      await createTask.mutateAsync({
        data: {
          title: taskTitle || "مهمة جديدة",
          description: data.description,
          platformId: data.platformId,
          memberIds: data.memberIds,
          reciterId: data.reciterId ?? null,
          status: "pending",
          priority: data.priority ?? "normal",
          progress: data.progress ?? 0,
          seriesType,
          startDate: new Date(data.startDate).toISOString(),
          dueDate: new Date(data.startDate).toISOString(),
          endDate: seriesType === "temporary" && data.endDate ? new Date(data.endDate).toISOString() : undefined,
          recurrence,
          recurrenceIntervalDays: null,
          recurrenceDurationDays: null,
          recurrenceDays,
          pageId,
          expandDailyInstances: seriesType === "temporary",
          recurrencePattern: recurrence,
        } as any,
      });
      invalidateTasks();
      queryClient.invalidateQueries({ queryKey: ["page-members"] });
      toast({ title: "تم إنشاء المهمة بنجاح" });
      setIsCreateOpen(false);
      createForm.reset(defaultFormValues);
    } catch {
      toast({ title: "حدث خطأ أثناء إنشاء المهمة", variant: "destructive" });
    } finally {
      setIsCreateSubmitting(false);
    }
  };

  const onEditSubmit = (data: TaskFormValues) => {
    if (!editingTask) return;
    const hasSeries = Boolean((editingTask as any).seriesId);
    const effectiveEditScope: EditTaskScope = hasSeries ? editTaskScope : "single";
    if (hasSeries) {
      const confirmed = window.confirm(
        `${EDIT_SCOPE_MESSAGES[effectiveEditScope]}\nلن يتم تغيير حالة الإنجاز أو الشاهد لبقية أيام السلسلة.`
      );
      if (!confirmed) return;
    }
    const seriesType = data.seriesType ?? "temporary";
    const recurrence = seriesType === "operational" ? (data.recurrence === "monthly" ? "monthly" : "weekly") : "none";
    const recurrenceDays = seriesType === "operational" && recurrence === "weekly"
      ? data.recurrenceDays ?? null
      : null;
    updateTask.mutate(
      {
        id: editingTask.id,
        data: {
          title: data.title || "مهمة جديدة",
          description: data.description,
          platformId: data.platformId,
          memberIds: data.memberIds,
          reciterId: data.reciterId ?? null,
          status: data.status as TaskStatus | undefined,
          priority: data.priority ?? "normal",
          progress: data.progress ?? 0,
          startDate: new Date(data.startDate).toISOString(),
          dueDate: new Date(data.startDate).toISOString(),
          endDate: seriesType === "temporary" && data.endDate ? new Date(data.endDate).toISOString() : undefined,
          recurrence,
          recurrenceIntervalDays: null,
          recurrenceDurationDays: null,
          recurrenceDays,
          pageId: data.pageId ?? null,
          updateScope: effectiveEditScope,
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
      if (!task?.submissionUrl) {
        toast({ title: "يجب إضافة رابط الشاهد أولاً لإكمال المهمة", variant: "destructive" });
        setPendingCompleteId(id);
        openUrlDialog(task!);
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
      { onSuccess: () => { invalidateTasks(); toast({ title: "تم نسخ المهمة بنجاح" }); } }
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
    setUrlDialog({ taskId: task.id, currentUrl: task.submissionUrl ?? "" });
    urlForm.reset({ url: task.submissionUrl ?? "" });
  };

  const handleSubmissionUrl = (data: { url: string }) => {
    if (!urlDialog) return;
    const taskId = urlDialog.taskId;
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

          {/* Create dialog — مدير فقط */}
          {isAdmin && (
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button className="bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold">
                  <Plus className="ml-2 h-4 w-4" />
                  مهمة جديدة
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[480px] flex flex-col max-h-[90vh] p-0" dir="rtl">
                <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
                  <DialogTitle className="text-xl font-bold">إضافة مهمة جديدة</DialogTitle>
                </DialogHeader>
                <div className="flex-1 overflow-y-auto px-6 py-4">
                <Form {...createForm}>
                  <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4">
                    <TaskFormFields platforms={platforms} members={members as { id: number; name: string; role: string }[]} reciters={reciters} />
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
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Submission URL dialog — all roles */}
      <Dialog open={!!urlDialog} onOpenChange={(open) => { if (!open) { setUrlDialog(null); urlForm.reset({ url: "" }); } }}>
        <DialogContent className="sm:max-w-[440px]" dir="rtl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <Link2 className="h-5 w-5 text-sidebar-primary" />
              رابط الشاهد على العمل
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            أضف رابط المنشور أو المقطع كإثبات على إتمام المهمة — سيظهر للفريق كلّه.
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
                disabled={updateTask.isPending}
              >
                {updateTask.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Check className="ml-2 h-4 w-4" />}
                حفظ الرابط
              </Button>
              {urlDialog?.currentUrl && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => handleSubmissionUrl({ url: "" })}
                  disabled={updateTask.isPending}
                >
                  حذف
                </Button>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog — مدير فقط */}
      {isAdmin && (
        <Dialog open={!!editingTask} onOpenChange={(open) => { if (!open) setEditingTask(null); }}>
          <DialogContent className="sm:max-w-[480px] flex flex-col max-h-[90vh] p-0" dir="rtl">
            <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
              <DialogTitle className="text-xl font-bold">تعديل المهمة</DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-6 py-4">
            <Form {...editForm}>
              <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
                {(editingTask as any)?.seriesId && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <FormLabel className="text-sm font-semibold text-sidebar-foreground">نطاق التعديل</FormLabel>
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
                <TaskFormFields platforms={platforms} members={members as { id: number; name: string; role: string }[]} reciters={reciters} showStatus />
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
          className="pr-9 bg-card"
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

      {/* Filters */}
      {activeTab === "active" && (
      <div className="flex flex-col sm:flex-row gap-3 p-4 bg-card border border-border rounded-lg shadow-sm flex-wrap">
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

        {/* Mosque filter (only in reciter view) */}
        {view === "reciter" && (
          <Select value={filterMosque} onValueChange={setFilterMosque}>
            <SelectTrigger className="min-w-[160px] bg-background">
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
          <SelectTrigger className="min-w-[150px] bg-background">
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
              <SelectTrigger className="min-w-[150px] bg-background">
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
              <SelectTrigger className="min-w-[170px] bg-background">
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
          <SelectTrigger className="min-w-[140px] bg-background">
            <SelectValue placeholder="كل الحالات" />
          </SelectTrigger>
          <SelectContent dir="rtl">
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="pending">قيد التنفيذ</SelectItem>
            <SelectItem value="completed">مكتمل</SelectItem>
          </SelectContent>
        </Select>

        {/* Date filter */}
        <Select value={filterDueDate} onValueChange={(v) => setFilterDueDate(v as typeof filterDueDate)}>
          <SelectTrigger className="min-w-[160px] bg-background">
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
          <div className="flex items-center gap-2 mr-auto">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              يعرض {adminListShown} من {adminListTotal} مهمة
            </span>
            <Select value={adminListLimit} onValueChange={(value) => setAdminListLimit(value as AdminListLimit)}>
              <SelectTrigger className="min-w-[120px] bg-background">
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

        <Button type="button" variant="outline" className="gap-2" onClick={resetFilters}>
          <RotateCcw className="h-4 w-4" />
          إعادة تعيين الفلاتر
        </Button>
      </div>
      )}

      {activeTab === "active" && view === "list" && (
        <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CalendarDays className="h-4 w-4 text-sidebar-primary" />
              الأسبوع الحالي
            </div>
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
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
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
                    "rounded-md border px-3 py-2 text-center transition-colors",
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
                      id={`task-${task.id}`}
                      className={cn("hover:bg-red-50/20", isLinkedTask(task.id) && linkedTaskClassName)}
                    >
                      <TableCell className="font-medium">
                        <div>
                          <p className="line-through text-muted-foreground">{task.title}</p>
                          {task.description && <p className="text-xs text-muted-foreground/60 truncate max-w-[200px]">{task.description}</p>}
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
                                {task.submissionUrl ? (
                                  <div className="flex items-center gap-1.5">
                                    <a href={task.submissionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100 transition-colors max-w-[80px] truncate">
                                      <ExternalLink className="h-3 w-3 shrink-0" /><span className="truncate">رابط</span>
                                    </a>
                                    <button onClick={() => openUrlDialog(task)} className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><Pencil className="h-3 w-3" /></button>
                                  </div>
                                ) : (
                                  <button onClick={() => openUrlDialog(task)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-primary hover:bg-sidebar-primary/10 border border-dashed border-muted-foreground/30 hover:border-sidebar-primary/50 rounded-full px-2 py-0.5 transition-colors">
                                    <Link2 className="h-3 w-3" />أضف
                                  </button>
                                )}
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
                                    {task.submissionUrl ? (
                                      <div className="flex items-center gap-1.5">
                                        <a href={task.submissionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100 transition-colors max-w-[80px] truncate">
                                          <ExternalLink className="h-3 w-3 shrink-0" /><span className="truncate">رابط</span>
                                        </a>
                                        <button onClick={() => openUrlDialog(task)} className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><Pencil className="h-3 w-3" /></button>
                                      </div>
                                    ) : (
                                      <button onClick={() => openUrlDialog(task)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-primary hover:bg-sidebar-primary/10 border border-dashed border-muted-foreground/30 hover:border-sidebar-primary/50 rounded-full px-2 py-0.5 transition-colors">
                                        <Link2 className="h-3 w-3" />أضف
                                      </button>
                                    )}
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
                          {task.description && (
                            <span className="text-xs text-muted-foreground truncate max-w-[220px]">{task.description}</span>
                          )}
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
                            <span className="text-sm font-medium">{reciter.name}</span>
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
                        {task.submissionUrl ? (
                          <div className="flex items-center gap-1.5">
                            <a
                              href={task.submissionUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={task.submissionUrl}
                              className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100 transition-colors max-w-[80px] truncate"
                            >
                              <ExternalLink className="h-3 w-3 shrink-0" />
                              <span className="truncate">رابط</span>
                            </a>
                            <button
                              onClick={() => openUrlDialog(task)}
                              title="تعديل الرابط"
                              className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => openUrlDialog(task)}
                            title="إضافة رابط الشاهد"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-primary hover:bg-sidebar-primary/10 border border-dashed border-muted-foreground/30 hover:border-sidebar-primary/50 rounded-full px-2 py-0.5 transition-colors"
                          >
                            <Link2 className="h-3 w-3" />
                            أضف
                          </button>
                        )}
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
          )}
        </div>
      ))}

      {/* Comments dialog */}
      <CommentsDialog
        taskId={commentsTaskId}
        taskTitle={commentsTaskTitle}
        onClose={() => {
          setCommentsTaskId(null);
          setCommentsTaskTitle("");
        }}
      />

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
