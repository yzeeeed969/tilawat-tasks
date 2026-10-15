import { PlatformsSection } from "@/pages/settings";
import { ShowcaseManualValues } from "@/components/showcase-manual-values";
import { useIsAdmin } from "@/lib/roles";

export default function PlatformsPage() {
  const isAdmin = useIsAdmin();
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">إدارة المنصات</h2>
        <p className="text-muted-foreground mt-2">إدارة المنصات والصفحات من صفحة مستقلة، مع بقاء نفس البيانات داخل الإعدادات.</p>
      </div>
      <PlatformsSection />
      {isAdmin && <ShowcaseManualValues />}
    </div>
  );
}
