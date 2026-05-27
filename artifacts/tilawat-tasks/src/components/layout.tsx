import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import {
  LayoutDashboard,
  CheckSquare,
  Users,
  BarChart3,
  Settings,
  LogOut,
  ChevronDown,
  Moon,
  Sun,
  HelpCircle,
  User,
  KeyRound,
  Mail,
  Loader2,
  CalendarDays,
  CheckCircle2,
  ListTodo,
  RefreshCw,
  Bell,
  BookOpen,
  Layers,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NotificationsPanel } from "@/components/notifications-panel";
import { useHijriPreference } from "@/lib/hijri-date";
import {
  useRole,
  useIsAdmin,
  useCanViewMembers,
  useCanViewReports,
  useCanAccessSettings,
  getRoleLabel,
  getRoleBadgeClass,
  type UserRole,
} from "@/lib/roles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function useDarkMode() {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem("darkMode") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("darkMode", String(dark));
    } catch { /* ignore */ }
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

function UserCard() {
  const { user, logout, refetch } = useAuth();
  const role = useRole();
  const isAdmin = useIsAdmin();
  const canManageSettingsLocal = useCanAccessSettings();
  const { dark, toggle } = useDarkMode();
  const { showHijri, toggleHijri } = useHijriPreference();
  const [profileOpen, setProfileOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);
  const [emailNew, setEmailNew] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailSuccess, setEmailSuccess] = useState(false);
  const [stats, setStats] = useState<{ total: number; completed: number } | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!profileOpen || !user?.memberId) return;
    fetch(`/api/tasks?memberId=${user.memberId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((tasks: { status: string }[]) => {
        if (!Array.isArray(tasks)) return;
        setStats({ total: tasks.length, completed: tasks.filter((t) => t.status === "completed").length });
      })
      .catch(() => {});
  }, [profileOpen, user?.memberId]);

  const name = user?.displayName || user?.username || "مستخدم";
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((n: string) => n[0])
    .join("")
    .toUpperCase();

  const handleLogout = async () => {
    await logout();
    window.location.href = "/sign-in";
  };

  const handleSwitchAccount = async () => {
    if (switching) return;
    setSwitching(true);
    try {
      const nextUserId = user?.role === "admin" ? 2 : 1;
      const res = await fetch("/api/auth/switch-account", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: nextUserId }),
      });
      if (res.ok) {
        await refetch();
        window.location.href = "/tasks";
      }
    } finally {
      setSwitching(false);
    }
  };

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
    <div className="border-t border-sidebar-border">
      {/* Dark mode toggle */}
      <div className="px-3 pt-2 pb-1">
        <button
          onClick={toggle}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent/30 transition-colors text-sm"
          title={dark ? "تفعيل الوضع الفاتح" : "تفعيل الوضع الداكن"}
        >
          {dark ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4 text-sidebar-foreground/60" />}
          <span className="text-sidebar-foreground/80">{dark ? "الوضع الفاتح" : "الوضع الداكن"}</span>
        </button>
        <button
          onClick={toggleHijri}
          className="mt-1 w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent/30 transition-colors text-sm"
          title={showHijri ? "إخفاء التاريخ الهجري" : "إظهار التاريخ الهجري"}
        >
          <CalendarDays className="h-4 w-4 text-sidebar-foreground/60" />
          <span className="text-sidebar-foreground/80">{showHijri ? "إخفاء التاريخ الهجري" : "إظهار التاريخ الهجري"}</span>
        </button>
      </div>

      <div className="p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-sidebar-accent/30 transition-colors text-sidebar-foreground">
              <div className="w-9 h-9 rounded-full bg-sidebar-primary/20 border border-sidebar-primary/30 flex items-center justify-center text-sidebar-primary font-bold text-sm shrink-0">
                {initials}
              </div>
              <div className="flex-1 text-right min-w-0">
                <p className="text-sm font-semibold truncate leading-tight">{name}</p>
                <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${getRoleBadgeClass(role)}`}>
                  {getRoleLabel(role)}
                </span>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-48 mb-1">
            <DropdownMenuItem className="cursor-pointer flex items-center gap-2" onClick={() => setProfileOpen(true)}>
              <User className="h-4 w-4" />
              حسابي
            </DropdownMenuItem>
            <Link href="/account">
              <DropdownMenuItem className="cursor-pointer flex items-center gap-2">
                <Bell className="h-4 w-4" />
                ربط Telegram
              </DropdownMenuItem>
            </Link>
            <DropdownMenuItem className="cursor-pointer flex items-center gap-2" onClick={handleSwitchAccount} disabled={switching}>
              {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {user?.role === "admin" ? "تبديل إلى حساب عضو" : "تبديل إلى حساب المدير"}
            </DropdownMenuItem>
            {canManageSettingsLocal && (
              <Link href="/settings">
                <DropdownMenuItem className="cursor-pointer flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  الإعدادات
                </DropdownMenuItem>
              </Link>
            )}
            <Link href="/help">
              <DropdownMenuItem className="cursor-pointer flex items-center gap-2">
                <HelpCircle className="h-4 w-4" />
                دليل الاستخدام
              </DropdownMenuItem>
            </Link>
            <DropdownMenuItem
              className="cursor-pointer flex items-center gap-2 text-red-600 focus:text-red-700 focus:bg-red-50"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" />
              تسجيل الخروج
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Profile dialog */}
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <User className="h-4 w-4 text-sidebar-primary" />
              حسابي
            </DialogTitle>
          </DialogHeader>

          {/* User info */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-sidebar-primary/5 border border-sidebar-primary/15">
            <div className="w-11 h-11 rounded-full bg-sidebar-primary/20 border border-sidebar-primary/30 flex items-center justify-center text-sidebar-primary font-bold text-base shrink-0">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{name}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.username}</p>
              <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${getRoleBadgeClass(role)}`}>
                {getRoleLabel(role)}
              </span>
            </div>
          </div>

          {/* Join date + stats */}
          <div className="grid grid-cols-3 gap-2">
            {user?.createdAt && (
              <div className="col-span-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5 shrink-0 text-sidebar-primary/60" />
                <span>انضممت في {format(new Date(user.createdAt), "d MMMM yyyy", { locale: ar })}</span>
              </div>
            )}
            {stats !== null && (
              <>
                <div className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg bg-muted/40 text-center">
                  <ListTodo className="h-4 w-4 text-sidebar-primary/70" />
                  <span className="text-base font-bold text-foreground">{stats.total}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight">إجمالي المهام</span>
                </div>
                <div className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg bg-green-50 text-center">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="text-base font-bold text-green-700">{stats.completed}</span>
                  <span className="text-[10px] text-green-600 leading-tight">مكتملة</span>
                </div>
                <div className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg bg-amber-50 text-center">
                  <ListTodo className="h-4 w-4 text-amber-600" />
                  <span className="text-base font-bold text-amber-700">{stats.total - stats.completed}</span>
                  <span className="text-[10px] text-amber-600 leading-tight">قيد الانتظار</span>
                </div>
              </>
            )}
          </div>

          {/* Change password */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              تغيير كلمة المرور
            </p>
            <form onSubmit={handleChangePassword} className="space-y-2">
              <Input type="password" placeholder="كلمة المرور الحالية" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} className="h-8 text-sm" autoComplete="current-password" />
              <Input type="password" placeholder="كلمة المرور الجديدة" value={pwNew} onChange={(e) => setPwNew(e.target.value)} className="h-8 text-sm" autoComplete="new-password" />
              <Input type="password" placeholder="تأكيد كلمة المرور الجديدة" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} className="h-8 text-sm" autoComplete="new-password" />
              {pwError && <p className="text-xs text-red-500">{pwError}</p>}
              {pwSuccess && <p className="text-xs text-green-600">تم تغيير كلمة المرور بنجاح ✓</p>}
              <Button type="submit" size="sm" className="w-full h-8 bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground text-xs" disabled={pwLoading || !pwCurrent || !pwNew || !pwConfirm}>
                {pwLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "حفظ كلمة المرور"}
              </Button>
            </form>
          </div>

          {/* Change email */}
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              البريد الإلكتروني
              {user?.email && <span className="text-sidebar-primary font-normal truncate max-w-[140px]" dir="ltr">{user.email}</span>}
            </p>
            <form onSubmit={async (e) => {
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
            }} className="space-y-2">
              <Input type="email" placeholder="البريد الإلكتروني الجديد" value={emailNew} onChange={(e) => setEmailNew(e.target.value)} className="h-8 text-sm" dir="ltr" />
              <Input type="password" placeholder="كلمة المرور للتحقق" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} className="h-8 text-sm" />
              {emailError && <p className="text-xs text-red-500">{emailError}</p>}
              {emailSuccess && <p className="text-xs text-green-600">تم تحديث البريد الإلكتروني ✓</p>}
              <Button type="submit" size="sm" variant="outline" className="w-full h-8 text-xs" disabled={emailLoading || !emailNew || !emailPw}>
                {emailLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "حفظ البريد الإلكتروني"}
              </Button>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user, logout, refetch } = useAuth();
  const isAdmin = useIsAdmin();
  const role = useRole();
  const canViewMembers = useCanViewMembers();
  const canViewReports = useCanViewReports();
  const canManageSettings = useCanAccessSettings();
  const { dark, toggle } = useDarkMode();

  const navItems = [
    { href: "/", label: "الرئيسية", icon: LayoutDashboard, show: true },
    { href: "/tasks", label: "المهام", icon: CheckSquare, show: true },
    { href: "/members", label: "الأعضاء", icon: Users, show: canViewMembers },
    { href: "/reports", label: "التقارير", icon: BarChart3, show: canViewReports },
    { href: "/reciters", label: "القراء", icon: BookOpen, show: canManageSettings },
    { href: "/platforms", label: "المنصات", icon: Layers, show: canManageSettings },
    { href: "/settings", label: "الإعدادات", icon: Settings, show: canManageSettings },
    { href: "/account", label: "حسابي", icon: User, show: true },
  ].filter((item) => item.show);

  const name = user?.displayName || user?.username || "مستخدم";
  const initials = name.split(" ").slice(0, 2).map((n: string) => n[0]).join("").toUpperCase();

  const handleLogout = async () => {
    await logout();
    window.location.href = "/sign-in";
  };

  const handleSwitchAccount = async () => {
    const nextUserId = user?.role === "admin" ? 2 : 1;
    const res = await fetch("/api/auth/switch-account", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: nextUserId }),
    });
    if (res.ok) {
      await refetch();
      window.location.href = "/tasks";
    }
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground" dir="rtl">

      {/* ── Desktop Sidebar ─────────────────────────────────── */}
      <aside className="w-64 border-l border-border bg-sidebar shrink-0 flex-col hidden md:flex">
        <div className="h-16 flex items-center justify-between border-b border-sidebar-border px-4">
          <div className="flex items-center gap-2">
            <img
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt="تلاوة الحرمين"
              className="w-8 h-8 rounded-lg"
            />
            <h1 className="text-sidebar-primary-foreground font-bold text-base tracking-tight">
              تلاوة الحرمين
            </h1>
          </div>
          <NotificationsPanel />
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive =
              location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div className={`flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors ${
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}>
                  <item.icon className="h-5 w-5 shrink-0" />
                  <span className="font-medium">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        <UserCard />
      </aside>

      {/* ── Main Content ────────────────────────────────────── */}
      <main className="flex-1 flex flex-col h-full overflow-hidden min-w-0">

        {/* Mobile top header */}
        <header className="h-14 border-b border-border bg-sidebar shrink-0 flex items-center justify-between px-4 md:hidden">
          <div className="flex items-center gap-2">
            <img
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt="تلاوة الحرمين"
              className="w-7 h-7 rounded-lg"
            />
            <h1 className="text-sidebar-foreground font-bold text-base">تلاوة الحرمين</h1>
          </div>
          <div className="flex items-center gap-2">
            <NotificationsPanel />
            <button
              onClick={toggle}
              className="w-8 h-8 flex items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent/30 transition-colors"
            >
              {dark ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4" />}
            </button>
            {/* User avatar + logout dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="w-8 h-8 rounded-full bg-sidebar-primary/20 border border-sidebar-primary/30 flex items-center justify-center text-sidebar-primary font-bold text-xs">
                  {initials}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom" className="w-44 mt-1">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-sm font-semibold truncate">{name}</p>
                  <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${getRoleBadgeClass(role)}`}>
                    {getRoleLabel(role)}
                  </span>
                </div>
                <Link href="/help">
                  <DropdownMenuItem className="cursor-pointer flex items-center gap-2 mt-1">
                    <HelpCircle className="h-4 w-4" />
                    دليل الاستخدام
                  </DropdownMenuItem>
                </Link>
                <Link href="/account">
                  <DropdownMenuItem className="cursor-pointer flex items-center gap-2">
                    <Bell className="h-4 w-4" />
                    ربط Telegram
                  </DropdownMenuItem>
                </Link>
                <DropdownMenuItem className="cursor-pointer flex items-center gap-2" onClick={handleSwitchAccount}>
                  <RefreshCw className="h-4 w-4" />
                  {user?.role === "admin" ? "تبديل إلى عضو" : "تبديل إلى المدير"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer flex items-center gap-2 text-red-600 focus:text-red-700 focus:bg-red-50"
                  onClick={handleLogout}
                >
                  <LogOut className="h-4 w-4" />
                  تسجيل الخروج
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 pb-20 md:pb-8">
          <div className="max-w-6xl mx-auto">{children}</div>
        </div>

        {/* ── Mobile Bottom Navigation ─────────────────────── */}
        <nav className="md:hidden fixed bottom-0 right-0 left-0 bg-sidebar border-t border-sidebar-border z-50 safe-area-bottom">
          <div className="flex items-stretch justify-around">
            {navItems.filter(i => i.href !== "/help").map((item) => {
              const isActive =
                location === item.href ||
                (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href} className="flex-1">
                  <div className={`flex flex-col items-center justify-center gap-1 py-2 px-1 transition-colors ${
                    isActive
                      ? "text-sidebar-primary"
                      : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
                  }`}>
                    <div className={`p-1.5 rounded-lg transition-colors ${isActive ? "bg-sidebar-primary/15" : ""}`}>
                      <item.icon className="h-5 w-5" />
                    </div>
                    <span className={`text-[10px] font-semibold leading-none ${isActive ? "text-sidebar-primary" : ""}`}>
                      {item.label}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </nav>

      </main>
    </div>
  );
}
