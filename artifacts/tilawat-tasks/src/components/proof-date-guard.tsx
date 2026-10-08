import { useCallback, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ProofDateWarning = { message: string; videoLabel: string; taskLabel: string; differences: string[] };

// تحذير وقائي قبل حفظ شاهد يوتيوب يدويًا: يسأل الخادم هل صلاة/تاريخ/يوم الفيديو تخالف المهمة.
// guard() ⇐ true للمتابعة (لا تحذير، أو أكّد المستخدم)، false عند الإلغاء. أي خطأ ⇐ متابعة بلا تحذير.
export function useProofDateGuard() {
  const [pending, setPending] = useState<{ warning: ProofDateWarning; resolve: (ok: boolean) => void } | null>(null);

  const guard = useCallback(async (taskId: number, url: string): Promise<boolean> => {
    if (!url) return true;
    let warning: ProofDateWarning | null = null;
    try {
      const response = await fetch(`/api/tasks/${taskId}/proof-date-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url }),
      });
      if (response.ok) warning = ((await response.json()) as { warning: ProofDateWarning | null }).warning;
    } catch {
      warning = null;
    }
    if (!warning) return true;
    return new Promise<boolean>((resolve) => setPending({ warning: warning!, resolve }));
  }, []);

  const finish = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const dialog = (
    <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) finish(false); }}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>الفيديو لا يطابق المهمة</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2 text-right">
            <span className="block">{pending?.warning.message}</span>
            <span className="block text-xs">الفيديو: {pending?.warning.videoLabel}هـ · المهمة: {pending?.warning.taskLabel}هـ</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel onClick={() => finish(false)}>إلغاء</AlertDialogCancel>
          <AlertDialogAction onClick={() => finish(true)}>تأكيد الربط</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { guard, dialog };
}
