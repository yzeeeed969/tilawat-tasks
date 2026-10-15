import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// قيم صفحة «منصات المشروع» العامة (/achievements) التي لا مصدر آلي لها: روابط المتاجر لكل تطبيق،
// وعدد المتابعين اليدوي (لتويتر/X مثلًا — لا واجهة مجانية). يُترك فارغًا ⇐ لا يُعرض رقم بدل رقم خاطئ.
// إنستقرام وفيسبوك ويوتيوب وقنوات تلقرام العامة تُسحب آليًا، والقيمة اليدوية لها احتياط فقط.

type Manual = {
  platforms: Array<{ id: number; name: string; iosUrl: string | null; androidUrl: string | null }>;
  pages: Array<{ id: number; platformId: number; platformName: string; name: string; pageUrl: string | null; manualFollowers: number | null }>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? "فشلت العملية");
  return body as T;
}

export function ShowcaseManualValues() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["showcase-manual"], queryFn: () => api<Manual>("/api/showcase/manual") });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const onError = (err: Error) => toast({ title: err.message, variant: "destructive" });
  const done = () => { queryClient.invalidateQueries({ queryKey: ["showcase-manual"] }); toast({ title: "تم الحفظ — يظهر في صفحة المنصات خلال دقائق" }); };
  const saveApp = useMutation({
    mutationFn: (v: { id: number; iosUrl: string; androidUrl: string }) => api(`/api/showcase/manual/platforms/${v.id}`, { method: "PUT", body: JSON.stringify({ iosUrl: v.iosUrl || null, androidUrl: v.androidUrl || null }) }),
    onSuccess: done,
    onError,
  });
  const savePage = useMutation({
    mutationFn: (v: { id: number; followers: string }) => api(`/api/showcase/manual/pages/${v.id}`, { method: "PUT", body: JSON.stringify({ manualFollowers: v.followers === "" ? null : v.followers }) }),
    onSuccess: done,
    onError,
  });

  if (!data) return null;
  const apps = data.platforms.filter((p) => /^تطبيق/.test(p.name.trim()));
  const value = (key: string, fallback: string | number | null) => draft[key] ?? (fallback == null ? "" : String(fallback));
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((s) => ({ ...s, [key]: e.target.value }));

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">بيانات صفحة «منصات المشروع» العامة</CardTitle>
        <CardDescription>
          روابط المتاجر لكل تطبيق، وعدد متابعين يدوي للحسابات التي لا يُسحب عددها آليًا (مثل تويتر/X).
          اتركه فارغًا ليُعرض الحساب بلا رقم. المنشورات تُحتسب تلقائيًا من الشواهد الموثّقة.{" "}
          <a href="/achievements" target="_blank" rel="noopener noreferrer" className="text-sidebar-primary hover:underline">فتح الصفحة ↗</a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="text-sm font-semibold">التطبيقات</div>
          {apps.length === 0 && <p className="text-xs text-muted-foreground">لا توجد منصات تبدأ بـ«تطبيق».</p>}
          {apps.map((app) => (
            <div key={app.id} className="flex flex-wrap items-center gap-2">
              <span className="w-48 text-sm">{app.name}</span>
              <Input dir="ltr" className="h-8 w-64" placeholder="رابط App Store" value={value(`ios-${app.id}`, app.iosUrl)} onChange={set(`ios-${app.id}`)} />
              <Input dir="ltr" className="h-8 w-64" placeholder="رابط Google Play" value={value(`android-${app.id}`, app.androidUrl)} onChange={set(`android-${app.id}`)} />
              <Button size="sm" variant="outline" disabled={saveApp.isPending} onClick={() => saveApp.mutate({ id: app.id, iosUrl: value(`ios-${app.id}`, app.iosUrl).trim(), androidUrl: value(`android-${app.id}`, app.androidUrl).trim() })}>حفظ</Button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <div className="text-sm font-semibold">متابعون يدويًا (احتياط عند غياب المصدر الآلي)</div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {data.pages.map((page) => (
              <div key={page.id} className="flex flex-wrap items-center gap-2">
                <span className="w-28 text-xs text-muted-foreground">{page.platformName}</span>
                <span className="w-56 text-sm">{page.name}</span>
                <Input type="number" min={0} className="h-8 w-36" placeholder="بلا رقم" value={value(`f-${page.id}`, page.manualFollowers)} onChange={set(`f-${page.id}`)} />
                <Button size="sm" variant="ghost" disabled={savePage.isPending} onClick={() => savePage.mutate({ id: page.id, followers: value(`f-${page.id}`, page.manualFollowers).trim() })}>حفظ</Button>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
