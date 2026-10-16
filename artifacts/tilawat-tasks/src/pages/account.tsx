import { useEffect, useState } from "react";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarDays, CheckCircle2, KeyRound, Link2, ListTodo, Loader2, Mail, Send, User } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

// إحصاءات مهامي (كانت في نافذة «الملف الشخصي»).
function MyTaskStats({ memberId }: { memberId?: number | null }) {
  const [stats, setStats] = useState<{ total: number; completed: number } | null>(null);
  useEffect(() => {
    if (!memberId) return;
    fetch(`/api/tasks?memberId=${memberId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((tasks: { status: string }[]) => {
        if (!Array.isArray(tasks)) return;
        setStats({ total: tasks.length, completed: tasks.filter((t) => t.status === "completed").length });
      })
      .catch(() => {});
  }, [memberId]);
  if (!stats) return null;
  return (
    <div className="grid grid-cols-3 gap-2 sm:col-span-2">
      <div className="flex flex-col items-center gap-1 px-2 py-3 rounded-lg bg-muted/40 text-center">
        <ListTodo className="h-4 w-4 text-sidebar-primary/70" />
        <span className="text-lg font-bold text-foreground">{stats.total}</span>
        <span className="text-[11px] text-muted-foreground leading-tight">إجمالي المهام</span>
      </div>
      <div className="flex flex-col items-center gap-1 px-2 py-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-center">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <span className="text-lg font-bold text-green-700">{stats.completed}</span>
        <span className="text-[11px] text-green-600 leading-tight">مكتملة</span>
      </div>
      <div className="flex flex-col items-center gap-1 px-2 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-center">
        <ListTodo className="h-4 w-4 text-amber-600" />
        <span className="text-lg font-bold text-amber-700">{stats.total - stats.completed}</span>
        <span className="text-[11px] text-amber-600 leading-tight">قيد الانتظار</span>
      </div>
    </div>
  );
}

function ChangePasswordCard() {
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    setPwSuccess(false);
    if (pwNew !== pwConfirm) { setPwError("كلمة المرور الجديدة وتأكيدها غير متطابقتين"); return; }
    if (pwNew.length < 6) { setPwError("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل"); return; }
    setPwLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      });
      const data = await res.json();
      if (!res.ok) { setPwError(data.error || "حدث خطأ"); }
      else { setPwSuccess(true); setPwCurrent(""); setPwNew(""); setPwConfirm(""); }
    } catch {
      setPwError("حدث خطأ في الاتصال بالخادم");
    } finally {
      setPwLoading(false);
    }
  };

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <KeyRound className="h-5 w-5 text-sidebar-primary" />
          تغيير كلمة المرور
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleChangePassword} className="space-y-2.5">
          <Input type="password" placeholder="كلمة المرور الحالية" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} autoComplete="current-password" />
          <Input type="password" placeholder="كلمة المرور الجديدة" value={pwNew} onChange={(e) => setPwNew(e.target.value)} autoComplete="new-password" />
          <Input type="password" placeholder="تأكيد كلمة المرور الجديدة" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} autoComplete="new-password" />
          {pwError && <p className="text-sm text-red-500">{pwError}</p>}
          {pwSuccess && <p className="text-sm text-green-600">تم تغيير كلمة المرور بنجاح ✓</p>}
          <Button type="submit" className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground" disabled={pwLoading || !pwCurrent || !pwNew || !pwConfirm}>
            {pwLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "حفظ كلمة المرور"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangeEmailCard() {
  const { user, refetch } = useAuth();
  const [emailNew, setEmailNew] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailSuccess, setEmailSuccess] = useState(false);

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(""); setEmailSuccess(false);
    if (!emailNew.trim() || !emailPw) { setEmailError("أدخل البريد وكلمة المرور"); return; }
    setEmailLoading(true);
    try {
      const res = await fetch("/api/auth/change-email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: emailNew.trim(), currentPassword: emailPw }),
      });
      const data = await res.json();
      if (!res.ok) { setEmailError(data.error || "حدث خطأ"); }
      else { setEmailSuccess(true); setEmailNew(""); setEmailPw(""); await refetch(); }
    } catch { setEmailError("خطأ في الاتصال"); }
    finally { setEmailLoading(false); }
  };

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Mail className="h-5 w-5 text-sidebar-primary" />
          البريد الإلكتروني
        </CardTitle>
        <CardDescription>
          {user?.email ? <>البريد الحالي: <span dir="ltr" className="font-medium text-foreground">{user.email}</span></> : "لا يوجد بريد مسجّل لهذا الحساب بعد."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleChangeEmail} className="space-y-2.5">
          <Input type="email" placeholder="البريد الإلكتروني الجديد" value={emailNew} onChange={(e) => setEmailNew(e.target.value)} dir="ltr" />
          <Input type="password" placeholder="كلمة المرور للتحقق" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} />
          {emailError && <p className="text-sm text-red-500">{emailError}</p>}
          {emailSuccess && <p className="text-sm text-green-600">تم تحديث البريد الإلكتروني ✓</p>}
          <Button type="submit" variant="outline" className="w-full" disabled={emailLoading || !emailNew || !emailPw}>
            {emailLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "حفظ البريد الإلكتروني"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
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
          بياناتك وكلمة المرور والبريد وربط تنبيهات Telegram — كلها في مكان واحد
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
          {user?.createdAt && (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> تاريخ الانضمام</p>
              <p className="font-semibold">{format(new Date(user.createdAt), "d MMMM yyyy", { locale: ar })}</p>
            </div>
          )}
          <MyTaskStats memberId={user?.memberId} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChangePasswordCard />
        <ChangeEmailCard />
      </div>

      <Card id="telegram" className="border-border/50 shadow-sm scroll-mt-24">
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
