import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, User, Eye, EyeOff, Shield, Mail, ArrowRight } from "lucide-react";

export default function SignInPage() {
  const { login, isSignedIn, isLoaded } = useAuth();
  const [, setLocation] = useLocation();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");

  const [showForgot, setShowForgot] = useState(false);
  const [forgotInput, setForgotInput] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState("");

  useEffect(() => {
    fetch("/api/auth/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setNeedsSetup(d.needsSetup))
      .finally(() => setSetupLoading(false));
  }, []);

  useEffect(() => {
    if (isLoaded && isSignedIn) setLocation("/tasks");
  }, [isLoaded, isSignedIn, setLocation]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username.trim(), password);
      setLocation("/tasks");
    } catch (err: any) {
      if (err.message === "PENDING_APPROVAL") {
        setError("حسابك قيد المراجعة — انتظر موافقة المدير");
      } else {
        setError(err.message || "اسم المستخدم أو كلمة السر غير صحيحة");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          displayName: displayName.trim() || username.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "فشل إعداد الحساب");
      window.location.href = "/tasks";
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError("");
    if (!forgotInput.trim()) { setForgotError("أدخل اسم المستخدم أو البريد الإلكتروني"); return; }
    setForgotLoading(true);
    try {
      const isEmail = forgotInput.includes("@");
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEmail ? { email: forgotInput.trim() } : { username: forgotInput.trim() }),
      });
      setForgotSent(true);
    } catch {
      setForgotError("حدث خطأ في الاتصال بالخادم");
    } finally {
      setForgotLoading(false);
    }
  };

  if (setupLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sidebar">
        <div className="w-8 h-8 border-4 border-sidebar-primary/30 border-t-sidebar-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-sidebar px-4 gap-8" dir="rtl">
      {/* Logo */}
      <div className="flex flex-col items-center gap-3">
        <img
          src={`${import.meta.env.BASE_URL}logo.svg`}
          alt="تلاوة الحرمين"
          className="w-20 h-20 rounded-2xl shadow-lg"
        />
        <div className="text-center">
          <h1 className="text-2xl font-bold text-sidebar-foreground">تلاوة الحرمين</h1>
          <p className="text-sidebar-foreground/60 text-sm mt-1">نظام إدارة مهام الفريق الإعلامي</p>
        </div>
      </div>

      {/* Card */}
      <div className="bg-card w-full max-w-sm rounded-2xl shadow-2xl border border-border/50 overflow-hidden">
        {needsSetup && (
          <div className="bg-sidebar-primary/10 border-b border-sidebar-primary/20 px-6 py-3 flex items-center gap-2">
            <Shield className="h-4 w-4 text-sidebar-primary" />
            <p className="text-sm font-semibold text-sidebar-primary">إعداد حساب المدير الأول</p>
          </div>
        )}

        {/* Forgot password panel */}
        {showForgot && !needsSetup && (
          <div className="p-6 space-y-4">
            <div className="text-center mb-2">
              <h2 className="text-xl font-bold text-foreground">استرداد كلمة المرور</h2>
              <p className="text-sm text-muted-foreground mt-1">
                أدخل اسم المستخدم أو بريدك الإلكتروني وسيُرسل إليك رابط الاسترداد
              </p>
            </div>
            {forgotSent ? (
              <div className="space-y-4">
                <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm text-center">
                  إذا كان البريد أو الحساب مسجلاً في النظام، ستصلك رسالة الاسترداد قريباً
                </div>
                <button
                  type="button"
                  onClick={() => { setShowForgot(false); setForgotSent(false); setForgotInput(""); }}
                  className="w-full flex items-center justify-center gap-1.5 text-sm text-sidebar-primary hover:underline"
                >
                  <ArrowRight className="h-4 w-4" /> العودة لصفحة الدخول
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="forgotInput" className="font-medium">اسم المستخدم أو البريد الإلكتروني</Label>
                  <div className="relative">
                    <Mail className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="forgotInput"
                      value={forgotInput}
                      onChange={(e) => setForgotInput(e.target.value)}
                      placeholder="0501234567 أو example@gmail.com"
                      className="pr-10"
                      dir="ltr"
                      autoComplete="username"
                      required
                    />
                  </div>
                </div>
                {forgotError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">
                    {forgotError}
                  </div>
                )}
                <Button
                  type="submit"
                  className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-bold py-5"
                  disabled={forgotLoading}
                >
                  {forgotLoading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                  إرسال رابط الاسترداد
                </Button>
                <button
                  type="button"
                  onClick={() => { setShowForgot(false); setForgotInput(""); setForgotError(""); }}
                  className="w-full flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ArrowRight className="h-4 w-4" /> العودة لصفحة الدخول
                </button>
              </form>
            )}
          </div>
        )}

        {!showForgot && (
        <form onSubmit={needsSetup ? handleSetup : handleLogin} className="p-6 space-y-4">
          <div className="text-center mb-2">
            <h2 className="text-xl font-bold text-foreground">
              {needsSetup ? "إنشاء حساب المدير" : "تسجيل الدخول"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {needsSetup
                ? "أنشئ حساب المدير للبدء في استخدام النظام"
                : "أدخل بياناتك للدخول إلى لوحة المهام"}
            </p>
          </div>

          {needsSetup && (
            <div className="space-y-1.5">
              <Label htmlFor="displayName" className="font-medium">الاسم الظاهر</Label>
              <div className="relative">
                <User className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="مثال: عبدالرحمن"
                  className="pr-10"
                  dir="rtl"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="username" className="font-medium">
              {needsSetup ? "اسم المستخدم أو رقم الجوال" : "اسم المستخدم / رقم الجوال"}
            </Label>
            <div className="relative">
              <User className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="مثال: 0501234567"
                className="pr-10"
                dir="ltr"
                autoComplete="username"
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="font-medium">كلمة السر</Label>
            <div className="relative">
              <Lock className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pr-10 pl-10"
                dir="ltr"
                autoComplete={needsSetup ? "new-password" : "current-password"}
                required
                minLength={needsSetup ? 6 : 1}
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
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
            disabled={loading}
          >
            {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
            {needsSetup ? "إنشاء الحساب والدخول" : "دخول"}
          </Button>

          {!needsSetup && !showForgot && (
            <button
              type="button"
              onClick={() => { setShowForgot(true); setError(""); }}
              className="w-full text-center text-xs text-sidebar-primary/80 hover:text-sidebar-primary hover:underline pt-1 transition-colors"
            >
              نسيت كلمة المرور؟
            </button>
          )}
        </form>
        )}
      </div>
    </div>
  );
}
