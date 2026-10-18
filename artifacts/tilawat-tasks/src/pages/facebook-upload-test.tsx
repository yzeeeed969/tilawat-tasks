import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIsAdmin } from "@/lib/roles";

// ⚠️ صفحة تجربة مؤقتة (تُحذف بعد التأكد): رفع فيديو واحد إلى صفحة فيسبوك كمسودة غير منشورة للتحقق من
// صلاحية pages_manage_posts. للمدير فقط، ولا تظهر في القائمة.
export default function FacebookUploadTest() {
  const isAdmin = useIsAdmin();
  const [file, setFile] = useState<File | null>(null);
  const [reciter, setReciter] = useState("بليلة");
  const [title, setTitle] = useState("تلاوة عذبة لفواتح سورة الشورى للشيخ د. بندر بليلة | فجر الأحد 7-5-1448هـ");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);

  if (!isAdmin) return <p className="text-sm text-muted-foreground">للمدير فقط.</p>;

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/instagram/facebook/test-upload?${new URLSearchParams({ reciter, title })}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      setResult(await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })));
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-2xl" dir="rtl">
      <CardHeader>
        <CardTitle>تجربة رفع فيديو إلى فيسبوك (مسودة غير منشورة)</CardTitle>
        <CardDescription>تجربة مؤقتة للتحقق من صلاحية pages_manage_posts — الفيديو يُرفع بـ published=false ولا يظهر للعامة.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>ملف الفيديو</span>
          <input type="file" accept="video/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          {file && <span className="block text-xs text-muted-foreground">{file.name} — {(file.size / 1024 / 1024).toFixed(1)} MB</span>}
        </label>
        <label className="block space-y-1 text-sm"><span>القارئ (جزء من الاسم)</span><Input value={reciter} onChange={(event) => setReciter(event.target.value)} /></label>
        <label className="block space-y-1 text-sm"><span>العنوان</span><Input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <Button onClick={upload} disabled={!file || busy}>{busy ? "جارٍ الرفع… (قد يستغرق دقائق)" : "رفع كمسودة غير منشورة"}</Button>
        {result != null && <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 text-xs" dir="ltr">{JSON.stringify(result, null, 2)}</pre>}
      </CardContent>
    </Card>
  );
}
