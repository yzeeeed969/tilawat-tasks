import { useState, useEffect } from "react";
import { Bell, Check, Trash2, X, ArchiveX, CheckCheck } from "lucide-react";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";

interface AppNotification {
  id: number;
  userId: number;
  type: string;
  title: string;
  body?: string | null;
  taskId?: number | null;
  link?: string | null;
  isRead: boolean;
  deletedAt?: string | null;
  createdAt: string;
}

function lineValue(lines: string[], label: string) {
  const line = lines.find((item) => item.trim().startsWith(label));
  return line ? line.replace(label, "").trim() : null;
}

function getNotificationDisplay(notification: AppNotification) {
  const lines = (notification.body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const taskTitle = lineValue(lines, "المهمة:") ?? notification.title.replace(/^تم إكمال مهمة:\s*/, "");
  const person = lineValue(lines, "القارئ:") ?? lineValue(lines, "العضو:");
  const completedAt = lineValue(lines, "وقت الإكمال:");
  const dateLine = completedAt
    ? `${format(new Date(notification.createdAt), "EEEE، d MMM", { locale: ar })} — وقت الإكمال: ${completedAt}`
    : format(new Date(notification.createdAt), "EEEE، d MMM — h:mm a", { locale: ar });

  return { taskTitle, person, dateLine };
}

export function NotificationsPanel() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [archived, setArchived] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  const fetchNotifications = async () => {
    if (!isSignedIn) return;
    try {
      setLoading(true);
      const [activeRes, archiveRes] = await Promise.all([
        fetch("/api/notifications", { credentials: "include" }),
        fetch("/api/notifications?archive=true", { credentials: "include" }),
      ]);
      if (activeRes.ok) setNotifications(await activeRes.json());
      if (archiveRes.ok) setArchived(await archiveRes.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSignedIn) fetchNotifications();
  }, [isSignedIn]);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open]);

  useEffect(() => {
    if (!isSignedIn) return;
    const id = setInterval(fetchNotifications, 30000);
    return () => clearInterval(id);
  }, [isSignedIn]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const markRead = async (id: number) => {
    await fetch(`/api/notifications/${id}`, { method: "PATCH", credentials: "include" });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
  };

  const openNotification = async (notification: AppNotification) => {
    if (!notification.isRead) {
      setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n)));
      await fetch(`/api/notifications/${notification.id}`, { method: "PATCH", credentials: "include" });
    }

    const target = notification.link ?? (notification.taskId ? `/tasks/${notification.taskId}` : null);
    if (target) {
      setOpen(false);
      setLocation(target);
    }
  };

  const markAllRead = async () => {
    await fetch("/api/notifications/read-all", { method: "POST", credentials: "include" });
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  };

  const deleteOne = async (id: number) => {
    await fetch(`/api/notifications/${id}`, { method: "DELETE", credentials: "include" });
    const found = notifications.find((n) => n.id === id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    if (found) setArchived((prev) => [{ ...found, deletedAt: new Date().toISOString(), isRead: true }, ...prev]);
  };

  const deleteAll = async () => {
    await fetch("/api/notifications", { method: "DELETE", credentials: "include" });
    setArchived((prev) => [...notifications.map((n) => ({ ...n, deletedAt: new Date().toISOString(), isRead: true })), ...prev]);
    setNotifications([]);
  };

  const NotifItem = ({ n, onMarkRead, onDelete }: { n: AppNotification; onMarkRead?: () => void; onDelete?: () => void }) => {
    const canOpen = Boolean(n.link || n.taskId);
    const display = getNotificationDisplay(n);
    return (
      <div
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        onClick={() => openNotification(n)}
        onKeyDown={(event) => {
          if (!canOpen) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openNotification(n);
          }
        }}
        className={cn(
          "w-full px-4 py-3 text-right border-b border-border/40 hover:bg-muted/30",
          canOpen && "cursor-pointer",
          !canOpen && "cursor-default",
          !n.isRead && "bg-[rgba(59,130,246,0.05)]"
        )}
      >
        <div className="flex items-start gap-2.5">
          {!n.isRead && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#3B82F6]" />}
          <div className="flex-1 min-w-0 space-y-1 whitespace-normal break-words">
            <p className={cn("text-[15px] font-semibold leading-snug whitespace-normal break-words", n.isRead ? "text-muted-foreground" : "text-foreground")}>
              {display.taskTitle}
            </p>
            {display.person && (
              <p className="text-sm leading-snug text-foreground whitespace-normal break-words">
                {display.person}
              </p>
            )}
            <p className="text-[11px] leading-snug text-muted-foreground whitespace-normal break-words">
              {display.dateLine}
            </p>
          </div>
          <div className="flex gap-1 shrink-0">
            {onMarkRead && !n.isRead && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onMarkRead?.();
                }}
                title="تعليم كمقروء"
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-green-600 hover:bg-green-50 transition-colors"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete?.();
                }}
                title="حذف"
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative flex items-center justify-center w-9 h-9 rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          aria-label="الإشعارات"
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-[360px] p-0 shadow-lg" dir="rtl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-bold text-base">الإشعارات</h3>
          <div className="flex gap-1.5">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                title="تعليم الكل كمقروء"
                className="flex items-center gap-1 text-xs text-sidebar-primary hover:underline"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                تعليم الكل كمقروء
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={deleteAll}
                title="حذف الكل"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-500"
              >
                <ArchiveX className="h-3.5 w-3.5" />
                مسح الكل
              </button>
            )}
          </div>
        </div>

        <Tabs defaultValue="active" dir="rtl">
          <TabsList className="w-full rounded-none border-b border-border bg-muted/30 h-9">
            <TabsTrigger value="active" className="flex-1 text-xs h-full rounded-none">
              الجديدة
              {unreadCount > 0 && (
                <Badge variant="destructive" className="mr-1.5 h-4 w-4 rounded-full p-0 text-[10px] flex items-center justify-center">
                  {unreadCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="archive" className="flex-1 text-xs h-full rounded-none">
              الأرشيف
              {archived.length > 0 && (
                <Badge variant="secondary" className="mr-1.5 h-4 w-4 rounded-full p-0 text-[10px] flex items-center justify-center">
                  {archived.length > 9 ? "9+" : archived.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="m-0">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground text-xs">جارٍ التحميل...</div>
            ) : notifications.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground text-sm flex flex-col items-center">
                <Bell className="h-8 w-8 mb-2 opacity-25" />
                <p>لا توجد إشعارات جديدة</p>
              </div>
            ) : (
              <ScrollArea className="max-h-80">
                {notifications.map((n) => (
                  <NotifItem
                    key={n.id}
                    n={n}
                    onMarkRead={!n.isRead ? () => markRead(n.id) : undefined}
                    onDelete={() => deleteOne(n.id)}
                  />
                ))}
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="archive" className="m-0">
            {archived.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground text-sm flex flex-col items-center">
                <ArchiveX className="h-8 w-8 mb-2 opacity-25" />
                <p>الأرشيف فارغ</p>
              </div>
            ) : (
              <ScrollArea className="max-h-80">
                {archived.map((n) => (
                  <NotifItem key={n.id} n={n} />
                ))}
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
