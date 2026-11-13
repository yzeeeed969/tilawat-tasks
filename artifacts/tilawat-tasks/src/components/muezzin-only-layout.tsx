import type { ReactNode } from "react";
import { LogOut, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

/** واجهة مشرف المؤذنين: صفحة «جدول المؤذنين» وحدها، بلا قائمة النظام. */
export function MuezzinOnlyLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const name = user?.displayName || user?.username || "";
  return (
    <div className="min-h-screen w-full bg-background text-foreground" dir="rtl">
      <header className="sticky top-0 z-10 border-b border-border bg-sidebar/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-2 font-bold text-sidebar-foreground">
            <Megaphone className="h-5 w-5 text-sidebar-primary" />
            جدول مؤذني المسجد الحرام
          </div>
          <div className="flex items-center gap-3 text-sm text-sidebar-foreground/80">
            {name && <span className="hidden sm:inline">{name}</span>}
            <Button size="sm" variant="ghost" className="text-sidebar-foreground/80" onClick={() => logout().then(() => { window.location.href = "/sign-in"; })}>
              <LogOut className="ml-1 h-4 w-4" />خروج
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
