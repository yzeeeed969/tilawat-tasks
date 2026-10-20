import { useEffect } from "react";
import { HelpCircle, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useIsAdmin } from "@/lib/roles";
import { APP_VERSION, APP_VERSION_DATE } from "@/lib/app-version";
import { HELP_SECTIONS, WHATS_NEW, type HelpSection } from "@/lib/help-content";

// «دليل الاستخدام»: قسم للأعضاء وقسم للمدير — كلٌّ يرى ما يخصه فقط. خطوات مرقّمة + صور حقيقية للشاشات.
// المحتوى في lib/help-content.ts (يُحدَّث مع كل تحديث للموقع)، ورقم الإصدار يُقرأ تلقائيًا.

const imageUrl = (file: string) => `${import.meta.env.BASE_URL}help/${file}`;

function SectionCard({ section }: { section: HelpSection }) {
  const Icon = section.icon;
  return (
    <Card id={section.id} className="scroll-mt-20 border-border/60 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${section.bg}`}>
            <Icon className={`h-5 w-5 ${section.color}`} />
          </span>
          {section.title}
        </CardTitle>
        {section.where && <p className="text-xs text-muted-foreground">مكانها: {section.where}</p>}
      </CardHeader>
      <CardContent className="space-y-5">
        {section.topics.map((topic) => (
          <div key={topic.title} className="space-y-2">
            <h3 className="font-bold text-sm">{topic.title}</h3>
            {topic.steps.length > 0 && (
              <ol className="list-decimal space-y-1.5 pr-5 text-sm leading-7 marker:font-bold marker:text-sidebar-primary">
                {topic.steps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            )}
            {topic.notes && topic.notes.length > 0 && (
              <ul className="space-y-1 rounded-md bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
                {topic.notes.map((note, i) => <li key={i}>• {note}</li>)}
              </ul>
            )}
            {topic.image && (
              <img
                src={imageUrl(topic.image)}
                alt={topic.title}
                loading="lazy"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                className="mx-auto w-full max-w-[320px] rounded-xl border border-border shadow-sm"
              />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function HelpPage() {
  const isAdmin = useIsAdmin();
  const memberSections = HELP_SECTIONS.filter((s) => s.audience === "member");
  const adminSections = isAdmin ? HELP_SECTIONS.filter((s) => s.audience === "admin") : [];

  // فتح الدليل على قسم محدد (من زر «؟» في الصفحات): /help#id
  useEffect(() => {
    const id = window.location.hash.replace("#", "");
    if (!id) return;
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    return () => clearTimeout(t);
  }, []);

  const toc = (title: string, list: HelpSection[]) => (
    <div className="space-y-1">
      <p className="text-xs font-bold text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {list.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="rounded-full border border-border bg-background px-3 py-1 text-xs hover:bg-muted">
            {s.title}
          </a>
        ))}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-in fade-in duration-300">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight md:text-3xl">
          <HelpCircle className="h-7 w-7 text-sidebar-primary" /> دليل الاستخدام
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">خطوات مرقّمة لكل ما تحتاجه في الموقع. في كل صفحة زر «؟» أعلى الشاشة يفتح شرحها هنا مباشرة.</p>
      </div>

      <Card className="border-border/60">
        <CardContent className="space-y-3 pt-5">
          {toc(isAdmin ? "للأعضاء" : "الأقسام", memberSections)}
          {adminSections.length > 0 && toc("للمدير", adminSections)}
          <a href="#whats-new" className="inline-flex items-center gap-1 text-xs font-medium text-sidebar-primary hover:underline">
            <Sparkles className="h-3.5 w-3.5" /> ما الجديد؟
          </a>
        </CardContent>
      </Card>

      {isAdmin && <h2 className="pt-2 text-xl font-bold">للأعضاء</h2>}
      {memberSections.map((s) => <SectionCard key={s.id} section={s} />)}

      {adminSections.length > 0 && (
        <>
          <h2 className="pt-4 text-xl font-bold">للمدير</h2>
          {adminSections.map((s) => <SectionCard key={s.id} section={s} />)}
        </>
      )}

      <Card id="whats-new" className="scroll-mt-20 border-sidebar-primary/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg"><Sparkles className="h-5 w-5 text-sidebar-primary" /> ما الجديد؟</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {WHATS_NEW.filter((entry) => entry.items.some((item) => isAdmin || !item.adminOnly)).map((entry) => (
            <div key={entry.version} className="space-y-1">
              <p className="text-sm font-bold">التحديث {entry.version} <span className="font-normal text-muted-foreground">· {entry.date}</span></p>
              <ul className="space-y-1 pr-4 text-sm leading-7">
                {entry.items.filter((item) => isAdmin || !item.adminOnly).map((item, i) => <li key={i} className="list-disc">{item.text}</li>)}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="pb-4 text-center text-xs text-muted-foreground">
        نظام إدارة مهام تلاوة الحرمين — التحديث رقم {APP_VERSION} · {APP_VERSION_DATE}
      </p>
    </div>
  );
}
