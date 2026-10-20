import { Link, useLocation } from "wouter";
import { HelpCircle } from "lucide-react";
import { useIsAdmin } from "@/lib/roles";
import { helpSectionForRoute } from "@/lib/help-content";

// زر «؟» في رأس كل صفحة: يفتح شرح الصفحة الحالية في «دليل الاستخدام» مباشرة.
export function HelpButton({ className = "" }: { className?: string }) {
  const [location] = useLocation();
  const isAdmin = useIsAdmin();
  if (location.startsWith("/help")) return null;
  const section = helpSectionForRoute(location, isAdmin);
  const href = section ? `/help#${section.id}` : "/help";
  return (
    <Link
      href={href}
      aria-label="شرح هذه الصفحة"
      title="شرح هذه الصفحة"
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors ${className}`}
    >
      <HelpCircle className="h-5 w-5" />
    </Link>
  );
}
