import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCircle2, Link2, Loader2, Send, User } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { getRoleBadgeClass, getRoleLabel } from "@/lib/roles";

type TelegramMe = {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
};

async function fetchTelegramMe(): Promise<TelegramMe> {
  const res = await fetch("/api/telegram/me", { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "فشل تحميل حالة ربط Telegram");
  return data;
}

async function createTelegramLinkToken(): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch("/api/telegram/link-token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "فشل إنشاء رمز الربط");
  return data;
}

async function sendTelegramTest(): Promise<void> {
  const res = await fetch("/api/telegram/test", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "فشل إرسال رسالة الاختبار");
}

export default function Account() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [linkToken, setLinkToken] = useState<string | null>(null);

  const { data: telegramMe, isLoading } = useQuery({
    queryKey: ["telegram-me"],
    queryFn: fetchTelegramMe,
  });

  const linkMutation = useMutation({
    mutationFn: createTelegramLinkToken,
    onSuccess: (result) => {
      setLinkToken(result.token);
      toast({ title: "تم إنشاء رمز الربط" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: sendTelegramTest,
    onSuccess: () => {
      toast({ title: "تم إرسال رسالة اختبار" });
      queryClient.invalidateQueries({ queryKey: ["telegram-me"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const displayName = user?.displayName || user?.username || "مستخدم";

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-3">
          <User className="h-8 w-8 text-sidebar-primary" />
          حسابي
        </h2>
        <p className="text-muted-foreground mt-2 text-lg">
          معلومات حسابك وربط تنبيهات Telegram الخاصة بك
        </p>
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-xl">
            <User className="h-5 w-5 text-sidebar-primary" />
            بيانات الحساب
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <p className="text-xs text-muted-foreground mb-1">الاسم</p>
            <p className="font-semibold">{displayName}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <p className="text-xs text-muted-foreground mb-1">اسم المستخدم</p>
            <p className="font-semibold" dir="ltr">{user?.username}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <p className="text-xs text-muted-foreground mb-1">الصلاحية</p>
            <Badge className={getRoleBadgeClass(user?.role ?? "viewer")}>
              {getRoleLabel(user?.role ?? "viewer")}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="bg-sidebar/5 border-b border-border/50 pb-5">
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-sidebar-primary" />
            ربط حسابي في Telegram
          </CardTitle>
          <CardDescription className="text-base mt-2">
            اربط حسابك مرة واحدة حتى تصلك تذكيرات مهامك وتنبيهات التأخير على Telegram.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          {isLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" />
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-border/60 bg-background px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">حالة الربط</p>
                  <p className="text-sm text-muted-foreground">
                    {telegramMe?.linked
                      ? `مرتبط${telegramMe.telegramUsername ? ` باسم @${telegramMe.telegramUsername}` : ""}`
                      : "لا يوجد ربط Telegram لهذا الحساب بعد."}
                  </p>
                </div>
                <Badge variant={telegramMe?.linked ? "default" : "secondary"} className="gap-1">
                  {telegramMe?.linked && <CheckCircle2 className="h-3.5 w-3.5" />}
                  {telegramMe?.linked ? "مرتبط" : "غير مرتبط"}
                </Badge>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                  اضغط إنشاء رمز ربط، ثم أرسل النص الذي يظهر لك إلى بوت Telegram:
                  <span dir="ltr" className="font-mono mx-1">@Tilawatalharamain_bot</span>
                </p>
                {linkToken && (
                  <div className="rounded-lg bg-background border border-border px-3 py-2 font-mono text-sm text-left" dir="ltr">
                    /start {linkToken}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => linkMutation.mutate()} disabled={linkMutation.isPending}>
                    {linkMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Link2 className="h-4 w-4 ml-2" />}
                    إنشاء رمز ربط
                  </Button>
                  <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending || !telegramMe?.linked}>
                    {testMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Send className="h-4 w-4 ml-2" />}
                    إرسال اختبار لي
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
