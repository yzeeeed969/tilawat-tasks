import { RecitersSection } from "@/pages/settings";

export default function RecitersPage() {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">إدارة القراء</h2>
        <p className="text-muted-foreground mt-2">إضافة وتعديل القراء من صفحة مستقلة، بنفس بيانات صفحة الإعدادات.</p>
      </div>
      <RecitersSection />
    </div>
  );
}
