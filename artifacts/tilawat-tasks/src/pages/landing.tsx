import { Link } from "wouter";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Landing() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-sidebar text-sidebar-foreground px-6"
      dir="rtl"
    >
      {/* Logo */}
      <div className="flex flex-col items-center gap-6 mb-10">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="شعار تلاوة الحرمين" className="w-28 h-28 rounded-2xl shadow-xl" />
        <div className="text-center">
          <h1 className="text-4xl font-bold text-sidebar-foreground tracking-tight mb-2">
            تلاوة الحرمين
          </h1>
          <p className="text-sidebar-foreground/70 text-lg max-w-xs leading-relaxed">
            نظام إدارة مهام الفريق الإعلامي
          </p>
        </div>
      </div>

      {/* Feature pills */}
      <div className="flex flex-wrap gap-3 justify-center mb-10 max-w-md">
        {["متابعة المهام", "10 منصات", "التقارير الأسبوعية", "صلاحيات متعددة"].map((f) => (
          <span
            key={f}
            className="px-4 py-1.5 rounded-full border border-sidebar-foreground/20 text-sm text-sidebar-foreground/80 bg-sidebar-accent/20"
          >
            {f}
          </span>
        ))}
      </div>

      {/* CTA */}
      <Link href="/sign-in">
        <Button
          size="lg"
          className="bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground text-base font-bold px-8 py-6 rounded-xl shadow-lg"
        >
          <LogIn className="ml-2 h-5 w-5" />
          تسجيل الدخول
        </Button>
      </Link>

      <p className="mt-6 text-sidebar-foreground/40 text-xs">
        للانضمام تواصل مع مدير الفريق
      </p>
    </div>
  );
}
