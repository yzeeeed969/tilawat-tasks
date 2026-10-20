import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { APP_VERSION, APP_VERSION_DATE } from "@/lib/app-version";
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
  Loader2,
  CalendarDays,
  RefreshCw,
  Bell,
  AlarmClock,
  BookOpen,
  Layers,
  ClipboardList,
  CalendarPlus,
  Send,
  Camera,
  Menu,
  Globe,
  ShieldCheck,
  Radar,
  Upload,
} from "lucide-react";
import { NotificationsPanel } from "@/components/notifications-panel";
import { HelpButton } from "@/components/help-button";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";

function useDarkMode() {
  const [dark, setDark] = useState<boolean>(readDarkPreference);

  // مزامنة كل النسخ (القائمة الجانبية، لوحة الإعدادات، الجوال) عبر حدث واحد.
  useEffect(() => {
    const sync = () => setDark(readDarkPreference());
    window.addEventListener(DARK_EVENT, sync);
    return () => window.removeEventListener(DARK_EVENT, sync);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const setDarkMode = (value: boolean) => {
    setDark(value);
    try {
      localStorage.setItem("darkMode", String(value));
    } catch { /* ignore */ }
    window.dispatchEvent(new Event(DARK_EVENT));
  };

  return { dark, setDarkMode };
}

const DARK_EVENT = "tilawat:dark-mode-pref";
function readDarkPreference() {
  try {
    return localStorage.getItem("darkMode") === "true";
  } catch {
    return false;
  }
}

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };
type NavGroup = { key: string; label: string; icon: typeof LayoutDashboard; items: NavItem[] };

function isActivePath(location: string, href: string) {
  const path = href.split("#")[0];
  return location === path || (path !== "/" && location.startsWith(path));
}

// المجموعات القابلة للطيّ (أكورديون): مجموعة واحدة مفتوحة في كل مرة حتى تبقى القائمة كلها ظاهرة بلا تمرير
// حتى على الشاشات القصيرة. تُفتح تلقائيًا المجموعة التي فيها الصفحة الحالية، ويُحفظ الاختيار.
const NAV_GROUP_KEY = "nav-open-group";
function useOpenGroup(groups: NavGroup[], location: string) {
  const activeKey = groups.find((group) => group.items.some((item) => isActivePath(location, item.href)))?.key ?? null;
  const [openKey, setOpenKey] = useState<string | null>(() => {
    try {
      return activeKey ?? localStorage.getItem(NAV_GROUP_KEY);
    } catch {
      return activeKey;
    }
  });
  useEffect(() => {
    if (activeKey) setOpenKey(activeKey);
  }, [activeKey]);
  const toggle = (key: string) => setOpenKey((current) => {
    const next = current === key ? null : key;
    try { localStorage.setItem(NAV_GROUP_KEY, next ?? ""); } catch { /* ignore */ }
    return next;
  });
  return { openKey, toggle };
}

function NavLinkRow({ item, location, onNavigate }: { item: NavItem; location: string; onNavigate?: () => void }) {
  const active = isActivePath(location, item.href);
  return (
    <Link href={item.href} onClick={onNavigate}>
      <div className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors text-sm ${
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      }`}>
        <item.icon className="h-[18px] w-[18px] shrink-0" />
        <span className="font-medium truncate">{item.label}</span>
      </div>
    </Link>
  );
}

function CollapsibleNavGroup({ group, location, open, onToggle, onNavigate }: {
  group: NavGroup; location: string; open: boolean; onToggle: () => void; onNavigate?: () => void;
}) {
  const containsActive = group.items.some((item) => isActivePath(location, item.href));
  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-bold text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/30 transition-colors"
      >
        <group.icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-right">{group.label}</span>
        {!open && containsActive && <span className="h-1.5 w-1.5 rounded-full bg-sidebar-primary" />}
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 pr-2">
          {group.items.map((item) => <NavLinkRow key={item.href} item={item} location={location} onNavigate={onNavigate} />)}
        </div>
      )}
    </div>
  );
}

function initialsOf(name: string) {
  return name.split(" ").slice(0, 2).map((n: string) => n[0]).join("").toUpperCase();
}

function PanelRow({ icon: Icon, label, hint, onClick, href, danger, external }: {
  icon: typeof LayoutDashboard; label: string; hint?: string; onClick?: () => void; href?: string; danger?: boolean; external?: boolean;
}) {
  const body = (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors text-sm ${danger ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" : "text-foreground hover:bg-muted"}`}>
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="flex-1 font-medium">{label}</span>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
  if (href && external) return <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{body}</a>;
  if (href) return <Link href={href} onClick={onClick}>{body}</Link>;
  return <button type="button" className="w-full text-right" onClick={onClick}>{body}</button>;
}

// لوحة «الإعدادات»: التفضيلات (ليست تنقّلًا) + الحساب. على الجوال تضم القائمة كلها أيضًا.
function SettingsPanel({ open, onOpenChange, navMain, navGroups, location }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navMain?: NavItem[];
  navGroups?: NavGroup[];
  location: string;
}) {
  const { user, logout, refetch } = useAuth();
  const role = useRole();
  const isAdmin = useIsAdmin();
  const { dark, setDarkMode } = useDarkMode();
  const { showHijri, toggleHijri } = useHijriPreference();
  const [switching, setSwitching] = useState(false);
  const { openKey, toggle: toggleGroup } = useOpenGroup(navGroups ?? [], location);
  const close = () => onOpenChange(false);
  const name = user?.displayName || user?.username || "مستخدم";

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

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-[88vw] max-w-sm p-0 flex flex-col" dir="rtl">
          <SheetHeader className="pl-5 pr-12 pt-5 pb-3 border-b border-border text-right">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Settings className="h-4 w-4 text-sidebar-primary" />
              الإعدادات
            </SheetTitle>
            <div className="flex items-center gap-3 pt-2">
              <div className="w-10 h-10 rounded-full bg-sidebar-primary/20 border border-sidebar-primary/30 flex items-center justify-center text-sidebar-primary font-bold text-sm shrink-0">
                {initialsOf(name)}
              </div>
              <div className="min-w-0 text-right">
                <p className="text-sm font-semibold truncate">{name}</p>
                <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${getRoleBadgeClass(role)}`}>{getRoleLabel(role)}</span>
              </div>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
            {(navMain?.length || navGroups?.length) ? (
              <section className="space-y-0.5 md:hidden bg-sidebar rounded-xl p-2">
                <p className="px-3 pb-1 text-[11px] font-bold text-sidebar-foreground/60">القائمة</p>
                {navMain?.map((item) => <NavLinkRow key={item.href} item={item} location={location} onNavigate={close} />)}
                {navGroups?.map((group) => <CollapsibleNavGroup key={group.key} group={group} location={location} open={openKey === group.key} onToggle={() => toggleGroup(group.key)} onNavigate={close} />)}
              </section>
            ) : null}

            <section>
              <p className="px-3 pb-1 text-[11px] font-bold text-muted-foreground">التفضيلات</p>
              <label className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted cursor-pointer text-sm">
                {dark ? <Sun className="h-4 w-4 shrink-0 text-amber-500" /> : <Moon className="h-4 w-4 shrink-0 opacity-70" />}
                <span className="flex-1 font-medium">الوضع الداكن</span>
                <span dir="ltr" className="flex"><Switch checked={dark} onCheckedChange={setDarkMode} /></span>
              </label>
              <label className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted cursor-pointer text-sm">
                <CalendarDays className="h-4 w-4 shrink-0 opacity-70" />
                <span className="flex-1 font-medium">إظهار التاريخ الهجري</span>
                <span dir="ltr" className="flex"><Switch checked={showHijri} onCheckedChange={() => toggleHijri()} /></span>
              </label>
            </section>

            <section>
              <p className="px-3 pb-1 text-[11px] font-bold text-muted-foreground">الحساب</p>
              <PanelRow icon={User} label="حسابي" hint="كلمة المرور · البريد · Telegram" href="/account" onClick={close} />
              <PanelRow icon={switching ? Loader2 : RefreshCw} label={user?.role === "admin" ? "تبديل إلى حساب عضو" : "تبديل إلى حساب المدير"} onClick={handleSwitchAccount} />
            </section>

            <section>
              <p className="px-3 pb-1 text-[11px] font-bold text-muted-foreground">عام</p>
              <PanelRow icon={HelpCircle} label="دليل الاستخدام" href="/help" onClick={close} />
              {isAdmin && <PanelRow icon={Globe} label="صفحة المنصات العامة" hint="↗" href="/achievements" external onClick={close} />}
            </section>
          </div>

          <div className="border-t border-border px-3 py-2">
            <PanelRow icon={LogOut} label="تسجيل الخروج" onClick={handleLogout} danger />
            <p className="px-3 pt-1 text-[10px] text-muted-foreground">تحديث رقم {APP_VERSION} · {APP_VERSION_DATE}</p>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const isAdmin = useIsAdmin();
  const role = useRole();
  const canViewMembers = useCanViewMembers();
  const canViewReports = useCanViewReports();
  const canManageSettings = useCanAccessSettings();
  const [panelOpen, setPanelOpen] = useState(false);

  // الأساسية: ظاهرة دائمًا. («الرئيسية» كانت تحوّل إلى «المهام» نفسها، فدُمجت فيها.)
  const mainItems: NavItem[] = [
    { href: "/tasks", label: "المهام", icon: CheckSquare, show: true },
    { href: "/members", label: "الأعضاء", icon: Users, show: canViewMembers },
    { href: "/reports", label: "التقارير", icon: BarChart3, show: canViewReports },
    { href: "/reminders", label: "التذكيرات", icon: AlarmClock, show: true },
  ].filter((item) => item.show);

  const groups: NavGroup[] = [
    {
      key: "system",
      label: "إدارة النظام",
      icon: Settings,
      items: [
        { href: "/reciters", label: "القراء", icon: BookOpen, show: canManageSettings },
        { href: "/platforms", label: "المنصات والصفحات", icon: Layers, show: canManageSettings },
        { href: "/weekly-schedule", label: "إنشاء الجدول الأسبوعي", icon: CalendarPlus, show: isAdmin },
        { href: "/publishing-template", label: "قالب النشر", icon: ClipboardList, show: isAdmin },
        { href: "/settings/telegram", label: "إشعارات Telegram", icon: Bell, show: canManageSettings },
        { href: "/settings/general", label: "المستخدمون والصلاحيات", icon: ShieldCheck, show: canManageSettings },
      ].filter((item) => item.show),
    },
    {
      key: "monitoring",
      label: "المراقبة والتوثيق التلقائي",
      icon: Radar,
      items: [
        { href: "/youtube-monitor", label: "مراقبة يوتيوب", icon: RefreshCw, show: canManageSettings },
        { href: "/telegram-monitor", label: "مراقبة تلقرام", icon: Send, show: isAdmin },
        { href: "/instagram-monitor", label: "مراقبة إنستقرام", icon: Camera, show: isAdmin },
        { href: "/crosspost-monitor", label: "رفع يوتيوب ← فيسبوك", icon: Upload, show: isAdmin },
      ].filter((item) => item.show),
    },
  ].filter((group) => group.items.length > 0);

  const { openKey, toggle: toggleGroup } = useOpenGroup(groups, location);
  const name = user?.displayName || user?.username || "مستخدم";
  const initials = initialsOf(name);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground" dir="rtl">

      {/* ── القائمة الجانبية (سطح المكتب) ───────────────────── */}
      <aside className="w-64 border-l border-border bg-sidebar shrink-0 flex-col hidden md:flex">
        <div className="h-16 flex items-center justify-between border-b border-sidebar-border px-4 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="تلاوة الحرمين" className="w-8 h-8 rounded-lg" />
            <h1 className="text-sidebar-primary-foreground font-bold text-base tracking-tight truncate">تلاوة الحرمين</h1>
          </div>
          <div className="flex items-center gap-1">
            <HelpButton />
            <NotificationsPanel />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
          {mainItems.map((item) => <NavLinkRow key={item.href} item={item} location={location} />)}
          {groups.length > 0 && <div className="pt-1 mt-2 border-t border-sidebar-border/70" />}
          {groups.map((group) => <CollapsibleNavGroup key={group.key} group={group} location={location} open={openKey === group.key} onToggle={() => toggleGroup(group.key)} />)}
        </nav>

        {/* أسفل ثابت: الإعدادات + الملف الشخصي — لا يحتاج تمريرًا أبدًا. */}
        <div className="border-t border-sidebar-border shrink-0 p-3 space-y-1">
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          >
            <Settings className="h-[18px] w-[18px] shrink-0" />
            <span className="font-medium">الإعدادات</span>
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-sidebar-accent/30 transition-colors text-sidebar-foreground"
            title="الحساب والتفضيلات"
          >
            <div className="w-9 h-9 rounded-full bg-sidebar-primary/20 border border-sidebar-primary/30 flex items-center justify-center text-sidebar-primary font-bold text-sm shrink-0">
              {initials}
            </div>
            <div className="flex-1 text-right min-w-0">
              <p className="text-sm font-semibold truncate leading-tight">{name}</p>
              <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${getRoleBadgeClass(role)}`}>{getRoleLabel(role)}</span>
            </div>
          </button>
          <p className="text-center text-[10px] font-medium text-sidebar-foreground/45 pt-1">
            تحديث رقم {APP_VERSION} · {APP_VERSION_DATE}
          </p>
        </div>
      </aside>

      {/* ── المحتوى ─────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col h-full overflow-hidden min-w-0">

        {/* رأس الجوال */}
        <header className="h-14 border-b border-border bg-sidebar shrink-0 flex items-center justify-between px-4 md:hidden">
          <div className="flex items-center gap-2 min-w-0">
            <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="تلاوة الحرمين" className="w-7 h-7 rounded-lg" />
            <h1 className="text-sidebar-foreground font-bold text-base truncate">تلاوة الحرمين</h1>
          </div>
          <div className="flex items-center gap-2">
            <HelpButton />
            <NotificationsPanel />
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="w-8 h-8 rounded-full bg-sidebar-primary/20 border border-sidebar-primary/30 flex items-center justify-center text-sidebar-primary font-bold text-xs"
              aria-label="الإعدادات والحساب"
            >
              {initials}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 pb-20 md:pb-8">
          <div className="max-w-6xl mx-auto">{children}</div>
        </div>

        {/* شريط الجوال السفلي: الأساسية + «المزيد» (القائمة كلها والإعدادات) */}
        <nav className="md:hidden fixed bottom-0 right-0 left-0 bg-sidebar border-t border-sidebar-border z-50 safe-area-bottom">
          <div className="flex items-stretch justify-around">
            {[...mainItems.slice(0, 4).map((item) => ({ ...item, onClick: undefined as undefined | (() => void) })), { href: "#more", label: "المزيد", icon: Menu, onClick: () => setPanelOpen(true) }].map((item) => {
              const active = item.onClick ? panelOpen : isActivePath(location, item.href);
              const inner = (
                <div className={`flex flex-col items-center justify-center gap-1 py-2 px-1 transition-colors ${active ? "text-sidebar-primary" : "text-sidebar-foreground/60 hover:text-sidebar-foreground"}`}>
                  <div className={`p-1.5 rounded-lg transition-colors ${active ? "bg-sidebar-primary/15" : ""}`}>
                    <item.icon className="h-5 w-5" />
                  </div>
                  <span className={`text-[10px] font-semibold leading-none ${active ? "text-sidebar-primary" : ""}`}>{item.label}</span>
                </div>
              );
              return item.onClick
                ? <button key={item.href} type="button" className="flex-1" onClick={item.onClick}>{inner}</button>
                : <Link key={item.href} href={item.href} className="flex-1">{inner}</Link>;
            })}
          </div>
        </nav>
      </main>

      <SettingsPanel open={panelOpen} onOpenChange={setPanelOpen} navMain={mainItems} navGroups={groups} location={location} />
    </div>
  );
}
