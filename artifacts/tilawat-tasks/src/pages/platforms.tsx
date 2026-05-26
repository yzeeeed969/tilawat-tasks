import { PlatformsSection } from "@/pages/settings";

export default function PlatformsPage() {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">إدارة المنصات</h2>
        <p className="text-muted-foreground mt-2">إدارة المنصات والصفحات من صفحة مستقلة، مع بقاء نفس البيانات داخل الإعدادات.</p>
      </div>
      <PlatformsSection />
    </div>
  );
}
