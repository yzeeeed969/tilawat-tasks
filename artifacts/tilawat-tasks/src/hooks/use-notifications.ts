import { useListTasks, getListTasksQueryKey } from "@workspace/api-client-react";
import { useMemo } from "react";
import { differenceInDays, isPast, isToday } from "date-fns";

export type NotificationItem = {
  taskId: number;
  taskTitle: string;
  memberName: string;
  platformName: string;
  dueDate: Date;
  type: "overdue" | "due_today" | "due_soon";
};

export function useNotifications() {
  const { data: tasks } = useListTasks(
    {},
    { query: { queryKey: getListTasksQueryKey({}) } }
  );

  const notifications = useMemo<NotificationItem[]>(() => {
    if (!tasks) return [];

    const result: NotificationItem[] = [];

    for (const task of tasks) {
      if (task.status === "completed" || !task.dueDate) continue;

      const due = new Date(task.dueDate);
      const daysUntil = differenceInDays(due, new Date());

      let type: NotificationItem["type"] | null = null;

      if (isPast(due) && !isToday(due)) {
        type = "overdue";
      } else if (isToday(due)) {
        type = "due_today";
      } else if (daysUntil <= 3) {
        type = "due_soon";
      }

      if (type) {
        result.push({
          taskId: task.id,
          taskTitle: task.title,
          memberName: task.member.name,
          platformName: task.platform.name,
          dueDate: due,
          type,
        });
      }
    }

    return result.sort((a, b) => {
      const order = { overdue: 0, due_today: 1, due_soon: 2 };
      return order[a.type] - order[b.type];
    });
  }, [tasks]);

  const overdueCount = notifications.filter((n) => n.type === "overdue").length;
  const dueTodayCount = notifications.filter((n) => n.type === "due_today").length;
  const totalUrgent = overdueCount + dueTodayCount;

  return { notifications, overdueCount, dueTodayCount, totalUrgent };
}
