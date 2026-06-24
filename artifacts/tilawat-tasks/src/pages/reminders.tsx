import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, BellOff, CalendarClock, Loader2, Plus, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type ReminderStatus = "active" | "sent" | "cancelled" | string;

type PersonalReminder = {
  id: number;
  userId: number;
  message: string;
  remindAt: string;
  timezone: string;
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

function defaultReminderDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh",
  }).format(new Date(value));
}

function getStatusLabel(status: ReminderStatus) {
  if (status === "active") return "نشط";
  if (status === "sent") return "تم الإرسال";
  if (status === "cancelled") return "ملغي";
  return status;
}

function getStatusVariant(status: ReminderStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "sent") return "secondary";
  if (status === "cancelled") return "outline";
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

async function createReminder(input: { message: string; remindAt: string }): Promise<PersonalReminder> {
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
  const [message, setMessage] = useState("");
  const [remindAt, setRemindAt] = useState(defaultReminderDateTime);

  const trimmedMessage = message.trim();
  const selectedDate = useMemo(() => new Date(remindAt), [remindAt]);
  const isFutureDate = Number.isFinite(selectedDate.getTime()) && selectedDate.getTime() > Date.now();
  const canSubmit = trimmedMessage.length >= 3 && trimmedMessage.length <= 500 && isFutureDate;

  const remindersQuery = useQuery({
    queryKey: ["personal-reminders"],
    queryFn: fetchReminders,
  });

  const telegramQuery = useQuery({
    queryKey: ["telegram-me"],
    queryFn: fetchTelegramMe,
  });

  const createMutation = useMutation({
    mutationFn: () => createReminder({ message: trimmedMessage, remindAt: selectedDate.toISOString() }),
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

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-3">
            <AlarmClock className="h-8 w-8 text-sidebar-primary" />
            التذكيرات
          </h2>
          <p className="text-muted-foreground mt-2 text-lg">
            تذكيرات شخصية تصل إلى Telegram في الوقت الذي تحدده.
          </p>
        </div>
      </div>

      {!telegramQuery.isLoading && !telegramQuery.data?.linked && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <BellOff className="h-4 w-4" />
          <AlertTitle>Telegram غير مربوط</AlertTitle>
          <AlertDescription>
            يمكنك إنشاء التذكير الآن، لكنه لن يصل عبر Telegram حتى تربط حسابك من صفحة حسابي.
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
            التذكير هنا شخصي فقط، ولا ينشئ مهمة ولا يدخل في التقارير.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-5">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmit || createMutation.isPending) return;
              createMutation.mutate();
            }}
          >
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
              {reminders.map((reminder) => (
                <div
                  key={reminder.id}
                  className="rounded-xl border border-border/70 bg-background p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="space-y-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={getStatusVariant(reminder.status)}>{getStatusLabel(reminder.status)}</Badge>
                      <span className="text-sm text-muted-foreground">
                        {formatDateTime(reminder.remindAt)}
                      </span>
                    </div>
                    <p className="font-medium leading-7 whitespace-pre-wrap break-words">{reminder.message}</p>
                    {reminder.sentAt && (
                      <p className="text-xs text-muted-foreground">أرسل في: {formatDateTime(reminder.sentAt)}</p>
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
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
