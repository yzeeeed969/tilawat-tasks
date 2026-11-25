import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useIsAdmin } from "@/lib/roles";
import { RefreshCw } from "lucide-react";

// «سجل النشر» (الإصدار 90): كل ما نُشر في المنصات المراقَبة. المرحلة 1: فيسبوك.
type Post = {
  id: number; post_id: string; page_name: string; created_time: string; riyadh_day: string; kind: string; source: string; source_app: string | null;
  message: string | null; permalink: string | null; task_id: number | null; match_note: string | null; task_title: string | null;
};
type PageState = { fb_page_id: string; name: string | null; last_checked_at: string | null; last_error: string | null };
type Log = { posts: Post[]; pages: PageState[] };

const SOURCE: Record<string, { label: string; cls: string }> = {
  manual: { label: "يدوي", cls: "bg-amber-100 text-amber-900" },
  bot: { label: "البوت", cls: "bg-sky-100 text-sky-900" },
  instagram: { label: "من إنستقرام", cls: "bg-pink-100 text-pink-900" },
  other: { label: "تطبيق آخر", cls: "bg-gray-100 text-gray-800" },
};
const KIND: Record<string, string> = { video: "🎬 مقطع", photo: "🖼 صورة", text: "📝 نص", link: "🔗 رابط" };
const when = (v: string) => new Date(v.replace(" ", "T") + (/[zZ]|\+/.test(v) ? "" : "Z")).toLocaleString("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? "تعذّر جلب البيانات");
  return body as T;
}

export default function PublishLogPage() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [source, setSource] = useState("");
  const [unmatched, setUnmatched] = useState(false);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const key = ["fb-log", source, unmatched, days];
  const { data, isLoading, error } = useQuery({
    queryKey: key, enabled: isAdmin, refetchInterval: 5 * 60_000,
    queryFn: () => api<Log>(`/api/crosspost/fb-log?days=${days}&source=${source}&unmatched=${unmatched ? 1 : 0}`),
  });
  const pollNow = async () => {
    setBusy(true);
    try { await api("/api/crosspost/fb-poll-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); await qc.invalidateQueries({ queryKey: ["fb-log"] }); }
    finally { setBusy(false); }
  };

  if (!isAdmin) return <div className="p-6 text-muted-foreground">هذه الصفحة للمدير فقط.</div>;
  const posts = data?.posts ?? [];
  const counts = posts.reduce((a, p) => { a[p.source] = (a[p.source] ?? 0) + 1; return a; }, {} as Record<string, number>);

  return (
    <div className="p-4 md:p-6 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">سجل النشر — فيسبوك</h1>
          <p className="text-sm text-muted-foreground">كل ما نُشر في صفحات فيسبوك المربوطة. الفحص تلقائي كل 15 دقيقة، قراءة فقط.</p>
        </div>
        <button onClick={pollNow} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /> افحص الآن
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center text-sm">
        {[["", "الكل"], ["manual", "يدوي"], ["bot", "البوت"], ["instagram", "من إنستقرام"]].map(([k, l]) => (
          <button key={k} onClick={() => setSource(k)} className={`rounded-full border px-3 py-1 ${source === k ? "bg-primary text-primary-foreground" : ""}`}>{l}</button>
        ))}
        <label className="inline-flex items-center gap-1.5 mr-3"><input type="checkbox" checked={unmatched} onChange={(e) => setUnmatched(e.target.checked)} /> بلا مهمة فقط</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border px-2 py-1 bg-background mr-auto">
          <option value={3}>آخر 3 أيام</option><option value={7}>آخر 7 أيام</option><option value={30}>آخر 30 يومًا</option>
        </select>
      </div>

      {data && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded border px-2 py-1">المجموع: {posts.length}</span>
          {Object.entries(counts).map(([k, n]) => <span key={k} className={`rounded px-2 py-1 ${SOURCE[k]?.cls ?? ""}`}>{SOURCE[k]?.label ?? k}: {n}</span>)}
          <span className="rounded border px-2 py-1">بلا مهمة: {posts.filter((p) => !p.task_id).length}</span>
        </div>
      )}

      {isLoading && <div className="text-muted-foreground">جارٍ التحميل…</div>}
      {error && <div className="text-red-600">{(error as Error).message}</div>}

      <div className="space-y-2">
        {posts.map((p) => (
          <div key={p.id} className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <b>{p.page_name}</b>
              <span className="text-muted-foreground">{when(p.created_time)}</span>
              <span>{KIND[p.kind] ?? p.kind}</span>
              <span className={`rounded px-2 py-0.5 text-xs ${SOURCE[p.source]?.cls ?? ""}`}>{SOURCE[p.source]?.label ?? p.source}</span>
              {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" className="mr-auto text-primary underline underline-offset-2">فتح المنشور ↗</a>}
            </div>
            {p.message && <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{p.message}</p>}
            <div className="mt-1 text-xs">
              {p.task_id
                ? <a href={`/tasks/${p.task_id}`} className="text-green-700 underline">✅ وُثّقت به مهمة: {p.task_title}</a>
                : <span className="text-muted-foreground">⚪ {p.match_note ?? "بلا مهمة"}</span>}
            </div>
          </div>
        ))}
        {data && posts.length === 0 && <div className="text-muted-foreground">لا منشورات في هذه الفترة.</div>}
      </div>

      {data && data.pages.length > 0 && (
        <details className="rounded-xl border p-3 text-sm">
          <summary className="cursor-pointer font-semibold">حالة الصفحات المراقَبة ({data.pages.length})</summary>
          <ul className="mt-2 space-y-1">
            {data.pages.map((s) => (
              <li key={s.fb_page_id}>{s.last_error ? "❌" : "✅"} {s.name ?? s.fb_page_id} — آخر فحص: {s.last_checked_at ? when(s.last_checked_at) : "لم يُفحص"}{s.last_error ? ` — ${s.last_error}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
