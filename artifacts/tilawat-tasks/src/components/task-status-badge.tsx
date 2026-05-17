import { Badge } from "@/components/ui/badge";
import { TaskStatus } from "@workspace/api-client-react";

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  if (status === "completed") {
    return <Badge className="bg-green-600 hover:bg-green-700 text-white rounded-full px-3 py-0.5 font-medium border-transparent shadow-sm">مكتمل</Badge>;
  }
  return <Badge className="bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-full px-3 py-0.5 font-medium border-transparent shadow-sm dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">قيد الانتهاء</Badge>;
}
