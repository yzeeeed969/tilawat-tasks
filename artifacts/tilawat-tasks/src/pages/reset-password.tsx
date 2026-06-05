import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, CheckCircle2, AlertCircle } from "lucide-react";

export default function ResetPasswordPage() {
  const [, setLocation] = useLocation();
  const params = useParams<{ token?: string }>();
  const token = new URLSearchParams(window.location.search).get("token") ?? params.token ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) setError("رابط إعادة التعيين غير صالح");
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 6) { setError("كلمة المرور يجب أن تكون 6 أحرف على الأقل"); return; }
    if (newPassword !== confirm) { setError("كلمتا المرور غير متطابقتان"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "حدث خطأ");
      setSuccess(true);
      setTimeout(() => setLocation("/sign-in"), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-sidebar px-4 gap-8" dir="rtl">
      <div className="flex flex-col items-center gap-3">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="تلاوة الحرمين" className="w-20 h-20 rounded-2xl shadow-lg" />
        <div className="text-center">
          <h1 className="text-2xl font-bold text-sidebar-foreground">تلاوة الحرمين</h1>
          <p className="text-sidebar-foreground/60 text-sm mt-1">نظام إدارة مهام الفريق الإعلامي</p>
        </div>
      </div>

      <div className="bg-card w-full max-w-sm rounded-2xl shadow-2xl border border-border/50 overflow-hidden">
        <div className="p-6">
          {success ? (
            <div className="text-center space-y-4 py-4">
              <CheckCircle2 className="h-14 w-14 text-green-500 mx-auto" />
              <h2 className="text-xl font-bold text-foreground">تم تغيير كلمة المرور بنجاح</h2>
              <p className="text-sm text-muted-foreground">سيتم توجيهك لصفحة الدخول خلال ثوانٍ...</p>
              <Button className="w-full bg-sidebar-primary text-sidebar-primary-foreground" onClick={() => setLocation("/sign-in")}>
                الذهاب لصفحة الدخول
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="text-center mb-2">
                <h2 className="text-xl font-bold text-foreground">إعادة تعيين كلمة المرور</h2>
                <p className="text-sm text-muted-foreground mt-1">أدخل كلمة المرور الجديدة</p>
              </div>

              {!token && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  رابط إعادة التعيين غير صالح أو منتهي الصلاحية
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="newPassword" className="font-medium">كلمة المرور الجديدة</Label>
                <div className="relative">
                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="6 أحرف على الأقل"
                    className="pr-10"
                    dir="ltr"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    disabled={!token}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm" className="font-medium">تأكيد كلمة المرور</Label>
                <div className="relative">
                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="أعد كتابة كلمة المرور"
                    className="pr-10"
                    dir="ltr"
                    autoComplete="new-password"
                    required
                    disabled={!token}
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm font-medium">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-bold py-5"
                disabled={loading || !token}
              >
                {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                تعيين كلمة المرور الجديدة
              </Button>

              <p
                className="text-center text-xs text-sidebar-primary cursor-pointer hover:underline pt-1"
                onClick={() => setLocation("/sign-in")}
              >
                العودة لصفحة الدخول
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
