import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Loader2, Plus, Trash2, WandSparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/lib/roles";

type Platform = { id: number; name: string };
type Reciter = { id: number; name: string };
type Member = { id: number; name: string; isActive?: boolean };
type Page = { id: number; platformId: number; name: string; reciterId: number | null; pageUrl?: string | null };
type PageWithMembers = Page & { memberIds: number[] };
type TargetRow = { id: string; platformId: number | null; pageId: number | null; memberIds: number[]; enabled: boolean };

type PreviewResult = {
  sourcePlatform: { id: number; name: string };
  reciter: { id: number; name: string };
  startDate: string;
  endDate: string;
  daysCount: number;
  platformsCount: number;
  totalExpected: number;
  items: Array<{
    platformId: number;
    platformName: string;
    pageId: number;
    pageName: string;
    memberIds: number[];
    memberNames: string[];
    daysCount: number;
    expectedTasks: number;
    warnings: string[];
  }>;
  warnings: Array<{ pageId: number; warning: string }>;
};

type CommitResult = {
  batchId: number;
  created: Array<{ taskId: number; platformName: string; pageName: string; dueDate: string }>;
  skipped: Array<{ platformName?: string; pageName?: string; dueDate?: string; reason: string; existingTaskId?: number }>;
  summary: {
    createdCount: number;
    skippedCount: number;
    createdByPlatform: Record<string, number>;
    skippedByReason: Record<string, number>;
  };
};

function todayInput() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function isSourcePlatformName(name: string | null | undefined) {
  const normalized = normalizeText(name);
  return normalized.includes("تطبيق") && normalized.includes("تلاوات") && normalized.includes("الحرمين");
}

async function jsonFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "تعذر تنفيذ الطلب");
  return data as T;
}

function generationPayload(input: {
  title: string;
  reciterId: string;
  startDate: string;
  endDate: string;
  note: string;
  targets: TargetRow[];
}) {
  return {
    title: input.title.trim(),
    reciterId: Number(input.reciterId),
    startDate: input.startDate,
    endDate: input.endDate,
    note: input.note.trim() || null,
    targets: input.targets
      .filter((target) => target.enabled)
      .map((target) => ({
        platformId: target.platformId,
        pageId: target.pageId,
        memberIds: target.memberIds,
        enabled: true,
      })),
  };
}

export default function TaskGenerationPage() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [reciterId, setReciterId] = useState("");
  const [startDate, setStartDate] = useState(todayInput);
  const [endDate, setEndDate] = useState(todayInput);
  const [note, setNote] = useState("");
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const platformsQuery = useQuery({ queryKey: ["platforms"], queryFn: () => jsonFetch<Platform[]>("/api/platforms") });
  const recitersQuery = useQuery({ queryKey: ["reciters"], queryFn: () => jsonFetch<Reciter[]>("/api/reciters") });
  const membersQuery = useQuery({ queryKey: ["members"], queryFn: () => jsonFetch<Member[]>("/api/members") });

  const pagesQuery = useQuery({
    queryKey: ["task-generation-pages", platformsQuery.data?.map((platform) => platform.id).join(",")],
    enabled: Boolean(platformsQuery.data?.length),
    queryFn: async () => {
      const platforms = platformsQuery.data ?? [];
      const pageLists = await Promise.all(platforms.map(async (platform) => {
        const pages = await jsonFetch<Page[]>(`/api/platforms/${platform.id}/pages`);
        return pages.map((page) => ({ ...page, platformId: platform.id }));
      }));
      const pages = pageLists.flat();
      const memberPairs = await Promise.all(pages.map(async (page) => {
        const memberIds = await jsonFetch<number[]>(`/api/platforms/${page.platformId}/pages/${page.id}/members`);
        return [page.id, memberIds] as const;
      }));
      const memberIdsByPage = new Map(memberPairs);
      return pages.map((page) => ({ ...page, memberIds: memberIdsByPage.get(page.id) ?? [] }));
    },
  });

  const platforms = platformsQuery.data ?? [];
  const reciters = recitersQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const pages = pagesQuery.data ?? [];
  const sourcePlatform = platforms.find((platform) => isSourcePlatformName(platform.name));
  const selectedReciterId = Number(reciterId);

  const pageById = useMemo(() => new Map(pages.map((page) => [page.id, page])), [pages]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  const targetPagesForPlatform = (platformId: number | null) => {
    if (!platformId) return [];
    return pages.filter((page) => page.platformId === platformId && (!page.reciterId || page.reciterId === selectedReciterId));
  };

  const addTarget = () => {
    setTargets((current) => [...current, { id: crypto.randomUUID(), platformId: null, pageId: null, memberIds: [], enabled: true }]);
    setPreview(null);
    setResult(null);
  };

  const updateTarget = (id: string, patch: Partial<TargetRow>) => {
    setTargets((current) => current.map((target) => target.id === id ? { ...target, ...patch } : target));
    setPreview(null);
    setResult(null);
  };

  const removeTarget = (id: string) => {
    setTargets((current) => current.filter((target) => target.id !== id));
    setPreview(null);
    setResult(null);
  };

  const canRequestPreview = isAdmin && Boolean(title.trim()) && Boolean(reciterId) && Boolean(startDate) && Boolean(endDate) && targets.some((target) => target.enabled);

  const previewMutation = useMutation({
    mutationFn: () => jsonFetch<PreviewResult>("/api/task-generation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationPayload({ title, reciterId, startDate, endDate, note, targets })),
    }),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  const commitMutation = useMutation({
    mutationFn: () => jsonFetch<CommitResult>("/api/task-generation/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationPayload({ title, reciterId, startDate, endDate, note, targets })),
    }),
    onSuccess: (data) => {
      setResult(data);
      toast({ title: `تم إنشاء ${data.summary.createdCount} مهمة` });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  if (!isAdmin) {
    return (
      <Alert variant="destructive">
        <AlertTitle>غير مصرح</AlertTitle>
        <AlertDescription>توليد المهام متاح للمدير فقط.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-3">
          <WandSparkles className="h-8 w-8 text-sidebar-primary" />
          توليد المهام
        </h2>
        <p className="text-muted-foreground mt-2 text-lg">
          أنشئ دفعة مهام مستقلة بناءً على عمل أصلي في تطبيق تلاوات الحرمين.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>بيانات العمل الأصلي</CardTitle>
          <CardDescription>منصة الأصل ثابتة: {sourcePlatform?.name ?? "تطبيق تلاوات الحرمين"}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <CalendarDays className="h-4 w-4" />
            <AlertDescription>
              سيتم توليد المهام بناءً على عمل أصلي في تطبيق تلاوات الحرمين. إذا تساوى تاريخ البداية والنهاية فسيتم إنشاء مهام يوم واحد.
            </AlertDescription>
          </Alert>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>عنوان المهمة</Label>
              <Input value={title} onChange={(event) => { setTitle(event.target.value); setPreview(null); setResult(null); }} placeholder="مثال: نشر مقاطع الشيخ ياسر الدوسري" />
            </div>
            <div className="grid gap-2">
              <Label>القارئ</Label>
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={reciterId} onChange={(event) => { setReciterId(event.target.value); setTargets([]); setPreview(null); setResult(null); }}>
                <option value="">اختر القارئ</option>
                {reciters.map((reciter) => <option key={reciter.id} value={reciter.id}>{reciter.name}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label>تاريخ البداية</Label>
              <Input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setPreview(null); setResult(null); }} />
            </div>
            <div className="grid gap-2">
              <Label>تاريخ النهاية</Label>
              <Input type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setPreview(null); setResult(null); }} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>ملاحظة اختيارية</Label>
            <Textarea value={note} onChange={(event) => { setNote(event.target.value); setPreview(null); setResult(null); }} placeholder="ملاحظة تظهر كوصف للمهام المولدة" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>المنصات المستهدفة</CardTitle>
            <CardDescription>لن تدخل أي منصة في التوليد إلا إذا أضفتها واخترت صفحتها ومسؤوليها صراحة.</CardDescription>
          </div>
          <Button type="button" onClick={addTarget} disabled={!reciterId}>
            <Plus className="h-4 w-4 ml-2" />
            إضافة منصة
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {targets.length === 0 ? (
            <div className="rounded-xl border border-dashed py-8 text-center text-muted-foreground">
              اختر قارئًا ثم أضف المنصات التي تريد توليد مهام لها.
            </div>
          ) : targets.map((target) => {
            const availablePages = targetPagesForPlatform(target.platformId);
            const selectedPage = target.pageId ? pageById.get(target.pageId) : null;
            const allowedMemberIds = selectedPage?.memberIds ?? [];
            return (
              <div key={target.id} className="rounded-xl border p-4 space-y-3">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="grid gap-2">
                    <Label>المنصة</Label>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={target.platformId ?? ""}
                      onChange={(event) => updateTarget(target.id, { platformId: Number(event.target.value) || null, pageId: null, memberIds: [] })}
                    >
                      <option value="">اختر المنصة</option>
                      {platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}</option>)}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label>الصفحة</Label>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={target.pageId ?? ""}
                      onChange={(event) => updateTarget(target.id, { pageId: Number(event.target.value) || null, memberIds: [] })}
                    >
                      <option value="">اختر الصفحة</option>
                      {availablePages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
                    </select>
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <Button type="button" variant="outline" onClick={() => updateTarget(target.id, { enabled: !target.enabled })}>
                      {target.enabled ? "مفعلة" : "معطلة"}
                    </Button>
                    <Button type="button" variant="outline" size="icon" onClick={() => removeTarget(target.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>المسؤولون</Label>
                  {!selectedPage ? (
                    <p className="text-sm text-muted-foreground">اختر الصفحة أولًا.</p>
                  ) : allowedMemberIds.length === 0 ? (
                    <p className="text-sm text-destructive">لا يوجد أعضاء مرتبطون بهذه الصفحة.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allowedMemberIds.map((memberId) => {
                        const selected = target.memberIds.includes(memberId);
                        return (
                          <Button
                            key={memberId}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            size="sm"
                            onClick={() => updateTarget(target.id, {
                              memberIds: selected ? target.memberIds.filter((id) => id !== memberId) : [...target.memberIds, memberId],
                            })}
                          >
                            {memberById.get(memberId)?.name ?? `#${memberId}`}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => previewMutation.mutate()} disabled={!canRequestPreview || previewMutation.isPending}>
              {previewMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <WandSparkles className="h-4 w-4 ml-2" />}
              معاينة التوليد
            </Button>
            <Button type="button" variant="outline" onClick={() => commitMutation.mutate()} disabled={!preview || preview.totalExpected === 0 || commitMutation.isPending}>
              {commitMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 ml-2" />}
              اعتماد وإنشاء المهام
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>المعاينة</CardTitle>
            <CardDescription>
              الأصل: {preview.sourcePlatform.name}، القارئ: {preview.reciter.name}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Badge variant="secondary">الأيام: {preview.daysCount}</Badge>
              <Badge variant="secondary">المنصات: {preview.platformsCount}</Badge>
              <Badge variant="secondary">الإجمالي: {preview.totalExpected}</Badge>
              <Badge variant="outline">من: {preview.startDate}</Badge>
              <Badge variant="outline">إلى: {preview.endDate}</Badge>
            </div>
            <div className="space-y-2">
              {preview.items.map((item) => (
                <div key={`${item.platformId}-${item.pageId}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{item.platformName} — {item.pageName}</p>
                    <Badge variant={item.warnings.length === 0 ? "default" : "destructive"}>
                      {item.warnings.length === 0 ? `${item.expectedTasks} مهمة` : item.warnings.join(", ")}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">المسؤولون: {item.memberNames.length > 0 ? item.memberNames.join("، ") : "لا يوجد"}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>نتيجة التنفيذ</CardTitle>
            <CardDescription>رقم دفعة التوليد: {result.batchId}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge>تم إنشاء {result.summary.createdCount} مهمة</Badge>
              <Badge variant="secondary">تم تخطي {result.summary.skippedCount} مهمة</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border p-3">
                <p className="font-semibold mb-2">التوزيع حسب المنصة</p>
                {Object.entries(result.summary.createdByPlatform).map(([platform, count]) => (
                  <p key={platform} className="text-sm">{platform}: {count}</p>
                ))}
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-semibold mb-2">أسباب التخطي</p>
                {Object.keys(result.summary.skippedByReason).length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا يوجد تخطي.</p>
                ) : Object.entries(result.summary.skippedByReason).map(([reason, count]) => (
                  <p key={reason} className="text-sm">{reason}: {count}</p>
                ))}
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => { window.location.href = "/tasks"; }}>
              عرض صفحة المهام
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
