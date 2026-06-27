import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, BellOff, CalendarClock, Check, Loader2, Plus, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type ReminderStatus = "active" | "sent" | "cancelled" | string;
type ReminderType = "custom" | "weekly_tasks";

type PersonalReminder = {
  id: number;
  userId: number;
  message: string;
  remindAt: string;
  timezone: string;
  type: ReminderType | string;
  weekdays: string | null;
  timeOfDay: string | null;
  status: ReminderStatus;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type TelegramMe = {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
};

const weekdayOptions = [
  { value: 6, label: "السبت" },
  { value: 0, label: "الأحد" },
  { value: 1, label: "الاثنين" },
  { value: 2, label: "الثلاثاء" },
  { value: 3, label: "الأربعاء" },
  { value: 4, label: "الخميس" },
  { value: 5, label: "الجمعة" },
];

function defaultReminderDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh",
  }).format(new Date(value));
}

function formatTime(value: string | null) {
  if (!value) return "-";
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat("ar-SA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function parseWeekdays(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  } catch {
    return [];
  }
}

function formatWeekdays(value: string | null) {
  const days = parseWeekdays(value);
  if (days.length === 0) return "لم تحدد أيام";
  return weekdayOptions
    .filter((day) => days.includes(day.value))
    .map((day) => day.label)
    .join("، ");
}

function getStatusLabel(reminder: Pick<PersonalReminder, "status" | "remindAt" | "type">) {
  const isCustomDue = reminder.type !== "weekly_tasks" && reminder.status === "active" && new Date(reminder.remindAt).getTime() <= Date.now();
  if (isCustomDue) return "مستحق - بانتظار الإرسال";
  const status = reminder.status;
  if (status === "active") return "نشط";
  if (status === "sent") return "تم الإرسال";
  if (status === "cancelled") return "ملغي";
  return status;
}

function getStatusVariant(reminder: Pick<PersonalReminder, "status" | "remindAt" | "type">): "default" | "secondary" | "destructive" | "outline" {
  if (reminder.type !== "weekly_tasks" && reminder.status === "active" && new Date(reminder.remindAt).getTime() <= Date.now()) return "destructive";
  if (reminder.status === "active") return "default";
  if (reminder.status === "sent") return "secondary";
  if (reminder.status === "cancelled") return "outline";
  return "secondary";
}

async function fetchReminders(): Promise<PersonalReminder[]> {
  const res = await fetch("/api/reminders", { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "تعذر تحميل التذكيرات");
  return Array.isArray(data) ? data : [];
}

async function fetchTelegramMe(): Promise<TelegramMe> {
  const res = await fetch("/api/telegram/me", { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "تعذر تحميل حالة Telegram");
  return data;
}

async function createReminder(input: {
  type: ReminderType;
  message?: string;
  remindAt?: string;
  weekdays?: number[];
  timeOfDay?: string;
}): Promise<PersonalReminder> {
  const res = await fetch("/api/reminders", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "تعذر إنشاء التذكير");
  return data;
}

async function cancelReminder(id: number): Promise<PersonalReminder> {
  const res = await fetch(`/api/reminders/${id}/cancel`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "تعذر إلغاء التذكير");
  return data;
}

export default function Reminders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reminderType, setReminderType] = useState<ReminderType>("custom");
  const [message, setMessage] = useState("");
  const [remindAt, setRemindAt] = useState(defaultReminderDateTime);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([1, 3, 6]);
  const [timeOfDay, setTimeOfDay] = useState("20:00");

  const trimmedMessage = message.trim();
  const selectedDate = useMemo(() => new Date(remindAt), [remindAt]);
  const isFutureDate = Number.isFinite(selectedDate.getTime()) && selectedDate.getTime() > Date.now();
  const canSubmitCustom = trimmedMessage.length >= 3 && trimmedMessage.length <= 500 && isFutureDate;
  const canSubmitWeekly = trimmedMessage.length >= 3 && trimmedMessage.length <= 500 && selectedWeekdays.length > 0 && /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeOfDay);
  const canSubmit = reminderType === "custom" ? canSubmitCustom : canSubmitWeekly;

  const remindersQuery = useQuery({
    queryKey: ["personal-reminders"],
    queryFn: fetchReminders,
    refetchInterval: 60_000,
  });

  const telegramQuery = useQuery({
    queryKey: ["telegram-me"],
    queryFn: fetchTelegramMe,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      if (reminderType === "weekly_tasks") {
        return createReminder({ type: "weekly_tasks", message: trimmedMessage, weekdays: selectedWeekdays, timeOfDay });
      }
      return createReminder({ type: "custom", message: trimmedMessage, remindAt: selectedDate.toISOString() });
    },
    onSuccess: () => {
      toast({ title: "تم إنشاء التذكير" });
      setMessage("");
      setRemindAt(defaultReminderDateTime());
      queryClient.invalidateQueries({ queryKey: ["personal-reminders"] });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: cancelReminder,
    onSuccess: () => {
      toast({ title: "تم إلغاء التذكير" });
      queryClient.invalidateQueries({ queryKey: ["personal-reminders"] });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  const reminders = remindersQuery.data ?? [];

  const toggleWeekday = (day: number) => {
    setSelectedWeekdays((current) => (
      current.includes(day)
        ? current.filter((value) => value !== day)
        : [...current, day].sort((a, b) => a - b)
    ));
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-3">
            <AlarmClock className="h-8 w-8 text-sidebar-primary" />
            التذكيرات
          </h2>
          <p className="text-muted-foreground mt-2 text-lg">
            تذكيرات شخصية وتذكيرات أسبوعية تصل إلى Telegram في الوقت الذي تحدده.
          </p>
        </div>
      </div>

      {!telegramQuery.isLoading && !telegramQuery.data?.linked && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <BellOff className="h-4 w-4" />
          <AlertTitle>Telegram غير مربوط</AlertTitle>
          <AlertDescription>
            يمكنك إنشاء التذكيرات الآن، لكنها لن تصل عبر Telegram حتى تربط حسابك من صفحة حسابي.
          </AlertDescription>
        </Alert>
      )}

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="bg-sidebar/5 border-b border-border/50">
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-sidebar-primary" />
            تذكير جديد
          </CardTitle>
          <CardDescription>
            التذكير لا ينشئ مهمة ولا يدخل في التقارير أو الإنجازات.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-5">
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmit || createMutation.isPending) return;
              createMutation.mutate();
            }}
          >
            <div className="grid gap-2">
              <Label>نوع التذكير</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button type="button" variant={reminderType === "custom" ? "default" : "outline"} onClick={() => setReminderType("custom")}>
                  تذكير نصي
                </Button>
                <Button type="button" variant={reminderType === "weekly_tasks" ? "default" : "outline"} onClick={() => setReminderType("weekly_tasks")}>
                  تذكير بالمهام الأسبوعية
                </Button>
              </div>
            </div>

            {reminderType === "custom" ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="reminder-message">نص التذكير</Label>
                  <Textarea
                    id="reminder-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    maxLength={500}
                    placeholder="اكتب ما تريد أن يصلك في وقت التذكير"
                    className="min-h-28"
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>من 3 إلى 500 حرف</span>
                    <span>{trimmedMessage.length}/500</span>
                  </div>
                </div>

                <div className="grid gap-2 sm:max-w-xs">
                  <Label htmlFor="reminder-time">تاريخ ووقت التذكير</Label>
                  <Input
                    id="reminder-time"
                    type="datetime-local"
                    value={remindAt}
                    onChange={(event) => setRemindAt(event.target.value)}
                  />
                  {!isFutureDate && <p className="text-xs text-destructive">وقت التذكير يجب أن يكون في المستقبل.</p>}
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="weekly-reminder-message">نص التذكير</Label>
                  <Textarea
                    id="weekly-reminder-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    maxLength={500}
                    placeholder="اكتب ما تريد أن يذكّرك به هذا التذكير"
                    className="min-h-24"
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>مثال: تذكير بنشر مقاطع الشيخ ياسر</span>
                    <span>{trimmedMessage.length}/500</span>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>أيام التذكير الأسبوعي</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {weekdayOptions.map((day) => {
                      const selected = selectedWeekdays.includes(day.value);
                      return (
                        <Button
                          key={day.value}
                          type="button"
                          variant={selected ? "default" : "outline"}
                          className="justify-center"
                          onClick={() => toggleWeekday(day.value)}
                        >
                          {selected && <Check className="h-4 w-4 ml-1" />}
                          {day.label}
                        </Button>
                      );
                    })}
                  </div>
                  {selectedWeekdays.length === 0 && <p className="text-xs text-destructive">اختر يومًا واحدًا على الأقل.</p>}
                </div>

                <div className="grid gap-2 sm:max-w-xs">
                  <Label htmlFor="weekly-reminder-time">وقت الإرسال</Label>
                  <Input
                    id="weekly-reminder-time"
                    type="time"
                    value={timeOfDay}
                    onChange={(event) => setTimeOfDay(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">سيستخدم هذا الوقت لكل الأيام المختارة بتوقيت Asia/Riyadh.</p>
                </div>
              </>
            )}

            <div>
              <Button type="submit" disabled={!canSubmit || createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Plus className="h-4 w-4 ml-2" />}
                حفظ التذكير
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-sidebar-primary" />
            تذكيراتي
          </CardTitle>
          <CardDescription>تظهر هنا التذكيرات الخاصة بحسابك فقط.</CardDescription>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          {remindersQuery.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" />
            </div>
          ) : reminders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center text-muted-foreground">
              لا توجد تذكيرات حتى الآن.
            </div>
          ) : (
            <div className="space-y-3">
              {reminders.map((reminder) => {
                const isWeekly = reminder.type === "weekly_tasks";
                return (
                  <div
                    key={reminder.id}
                    className="rounded-xl border border-border/70 bg-background p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="space-y-2 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={isWeekly ? "secondary" : "outline"}>
                          {isWeekly ? "تذكير بالمهام الأسبوعية" : "تذكير نصي"}
                        </Badge>
                        <Badge variant={getStatusVariant(reminder)}>{getStatusLabel(reminder)}</Badge>
                      </div>
                      {isWeekly ? (
                        <>
                          <p className="font-semibold leading-7 whitespace-pre-wrap break-words">{reminder.message}</p>
                          <p className="font-medium leading-7">
                            كل أسبوع: {formatWeekdays(reminder.weekdays)} — {formatTime(reminder.timeOfDay)}
                          </p>
                          <p className="text-sm text-muted-foreground">موعد الإرسال القادم التقريبي: {formatDateTime(reminder.remindAt)}</p>
                        </>
                      ) : (
                        <>
                          <span className="block text-sm text-muted-foreground">{formatDateTime(reminder.remindAt)}</span>
                          <p className="font-medium leading-7 whitespace-pre-wrap break-words">{reminder.message}</p>
                        </>
                      )}
                      {reminder.sentAt && (
                        <p className="text-xs text-muted-foreground">آخر إرسال: {formatDateTime(reminder.sentAt)}</p>
                      )}
                    </div>
                    {reminder.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => cancelMutation.mutate(reminder.id)}
                        disabled={cancelMutation.isPending}
                      >
                        {cancelMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <XCircle className="h-4 w-4 ml-2" />}
                        إلغاء
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
