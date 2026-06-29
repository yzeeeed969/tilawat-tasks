import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Loader2, Plus, RefreshCw, Trash2, WandSparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/lib/roles";

type Platform = { id: number; name: string };
type Member = { id: number; name: string; isActive?: boolean };
type Page = { id: number; platformId: number; name: string; reciterId: number | null; pageUrl?: string | null };
type PageWithMembers = Page & { memberIds: number[] };

type SourceTask = {
  id: number;
  title: string;
  platformId: number;
  platformName: string;
  reciterId: number;
  reciterName: string | null;
  status: "pending" | "in_progress" | "completed";
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
};

type SourceTasksResponse = {
  week: { start: string; end: string };
  tasks: SourceTask[];
};

type TargetRow = {
  id: string;
  platformId: number | null;
  pageId: number | null;
  memberIds: number[];
  enabled: boolean;
  startDate: string;
  endDate: string;
};

type PreviewResult = {
  sourceTask: {
    id: number;
    title: string;
    platformId: number;
    platformName: string;
    reciterId: number;
    reciterName: string | null;
    startDate: string | null;
    endDate: string | null;
    dueDate: string | null;
    defaultStartDate: string;
    defaultEndDate: string;
  };
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
    startDate: string;
    endDate: string;
    daysCount: number;
    expectedTasks: number;
    warnings: string[];
  }>;
  warnings: Array<{ pageId: number; warning: string }>;
};

type CommitResult = {
  batchId: number;
  sourceTaskId: number;
  created: Array<{ taskId: number; platformName: string; pageName: string; dueDate: string; memberIds: number[] }>;
  skipped: Array<{ platformName?: string; pageName?: string; dueDate?: string; reason: string; existingTaskId?: number }>;
  summary: {
    createdCount: number;
    skippedCount: number;
    createdByPlatform: Record<string, number>;
    skippedByReason: Record<string, number>;
    firstDate: string | null;
    lastDate: string | null;
  };
};

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function isInstagramPlatformName(name: string | null | undefined) {
  const normalized = normalizeText(name);
  return normalized.includes("instagram") || normalized.includes("انست") || normalized.includes("إنست");
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function defaultStart(source: SourceTask | null) {
  return source?.startDate ?? source?.dueDate ?? source?.endDate ?? "";
}

function defaultEnd(source: SourceTask | null) {
  return source?.endDate ?? source?.dueDate ?? source?.startDate ?? "";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "غير محدد";
  return value;
}

function warningLabel(warning: string) {
  const labels: Record<string, string> = {
    missing_page: "الصفحة غير موجودة",
    source_platform_target_not_allowed: "لا يمكن توليد نفس منصة الأصل",
    page_reciter_mismatch: "الصفحة لا تخص القارئ",
    page_not_linked_to_reciter: "الصفحة غير مرتبطة بقارئ",
    missing_assignee: "لا يوجد مسؤول",
    invalid_assignee: "مسؤول غير مسموح لهذه الصفحة",
    invalid_date_range: "نطاق التاريخ غير صحيح",
  };
  return labels[warning] ?? warning;
}

async function jsonFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "تعذر تنفيذ الطلب");
  return data as T;
}

function generationPayload(sourceTask: SourceTask | null, targets: TargetRow[]) {
  return {
    sourceTaskId: sourceTask?.id,
    targets: targets
      .filter((target) => target.enabled)
      .map((target) => ({
        platformId: target.platformId,
        pageId: target.pageId,
        memberIds: target.memberIds,
        startDate: target.startDate,
        endDate: target.endDate,
        enabled: true,
      })),
  };
}

export default function TaskGenerationPage() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const sourceTasksQuery = useQuery({
    queryKey: ["task-generation-source-tasks"],
    enabled: isAdmin,
    queryFn: () => jsonFetch<SourceTasksResponse>("/api/task-generation/source-tasks"),
  });
  const platformsQuery = useQuery({ queryKey: ["platforms"], queryFn: () => jsonFetch<Platform[]>("/api/platforms"), enabled: isAdmin });
  const membersQuery = useQuery({ queryKey: ["members"], queryFn: () => jsonFetch<Member[]>("/api/members"), enabled: isAdmin });

  const platforms = platformsQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const sourceTasks = sourceTasksQuery.data?.tasks ?? [];
  const selectedSource = sourceTasks.find((task) => task.id === selectedSourceId) ?? null;

  const pagesQuery = useQuery({
    queryKey: ["task-generation-pages", platforms.map((platform) => platform.id).join(",")],
    enabled: isAdmin && platforms.length > 0,
    queryFn: async () => {
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

  const pages = pagesQuery.data ?? [];
  const pageById = useMemo(() => new Map(pages.map((page) => [page.id, page])), [pages]);
  const platformById = useMemo(() => new Map(platforms.map((platform) => [platform.id, platform])), [platforms]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  useEffect(() => {
    if (!selectedSource || pages.length === 0 || platforms.length === 0) {
      setTargets([]);
      return;
    }
    const start = defaultStart(selectedSource);
    const end = defaultEnd(selectedSource);
    const relatedPages = pages.filter((page) => page.reciterId === selectedSource.reciterId && page.platformId !== selectedSource.platformId);
    setTargets(relatedPages.map((page) => {
      const platform = platformById.get(page.platformId);
      return {
        id: makeId(),
        platformId: page.platformId,
        pageId: page.id,
        memberIds: page.memberIds,
        enabled: !isInstagramPlatformName(platform?.name),
        startDate: start,
        endDate: end,
      };
    }));
    setPreview(null);
    setResult(null);
  }, [selectedSourceId, selectedSource, pages, platforms, platformById]);

  const targetPagesForPlatform = (platformId: number | null) => {
    if (!platformId || !selectedSource) return [];
    return pages.filter((page) => page.platformId === platformId && page.reciterId === selectedSource.reciterId);
  };

  const addTarget = () => {
    const start = defaultStart(selectedSource);
    const end = defaultEnd(selectedSource);
    setTargets((current) => [...current, { id: makeId(), platformId: null, pageId: null, memberIds: [], enabled: true, startDate: start, endDate: end }]);
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

  const canRequestPreview = isAdmin && Boolean(selectedSource) && targets.some((target) => (
    target.enabled && target.platformId && target.pageId && target.startDate && target.endDate
  ));

  const previewMutation = useMutation({
    mutationFn: () => jsonFetch<PreviewResult>("/api/task-generation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generationPayload(selectedSource, targets)),
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
      body: JSON.stringify(generationPayload(selectedSource, targets)),
    }),
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-3">
            <WandSparkles className="h-8 w-8 text-sidebar-primary" />
            توليد المهام
          </h2>
          <p className="text-muted-foreground mt-2 text-lg">
            اختر مهمة أصلية محفوظة من تطبيق تلاوات الحرمين، ثم راجع المنصات التابعة قبل إنشاء أي مهمة.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => sourceTasksQuery.refetch()}>
          <RefreshCw className="h-4 w-4 ml-2" />
          تحديث مهام الأسبوع
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>المهام الأصلية لهذا الأسبوع</CardTitle>
          <CardDescription>
            تظهر هنا فقط مهام تطبيق تلاوات الحرمين غير المحذوفة، المرتبطة بقارئ، والواقعة بين {sourceTasksQuery.data?.week.start ?? "..."} و {sourceTasksQuery.data?.week.end ?? "..."}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sourceTasksQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              جار تحميل المهام الأصلية...
            </div>
          ) : sourceTasks.length === 0 ? (
            <Alert>
              <CalendarDays className="h-4 w-4" />
              <AlertTitle>لا توجد مهام مؤهلة</AlertTitle>
              <AlertDescription>أنشئ مهمة أصلية على منصة تطبيق تلاوات الحرمين لهذا الأسبوع مع قارئ، ثم عد إلى هذه الصفحة.</AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-3">
              {sourceTasks.map((task) => {
                const selected = task.id === selectedSourceId;
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelectedSourceId(task.id)}
                    className={`rounded-lg border p-4 text-right transition hover:border-sidebar-primary ${selected ? "border-sidebar-primary bg-sidebar-primary/5" : "bg-card"}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-foreground">{task.title}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {task.platformName} - {task.reciterName ?? "قارئ غير محدد"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">#{task.id}</Badge>
                        <Badge variant={task.status === "completed" ? "default" : "secondary"}>{task.status}</Badge>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>الاستحقاق: {formatDate(task.dueDate)}</span>
                      <span>البداية: {formatDate(task.startDate)}</span>
                      <span>النهاية: {formatDate(task.endDate)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {selectedSource && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>المهمة الأصلية المختارة</CardTitle>
              <CardDescription>هذه البيانات للقراءة فقط، وسيستخدمها السيرفر عند إنشاء المهام التابعة.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">العنوان</p>
                <p className="font-medium">{selectedSource.title}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">القارئ</p>
                <p className="font-medium">{selectedSource.reciterName ?? "غير محدد"}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">المنصة الأصلية</p>
                <p className="font-medium">{selectedSource.platformName}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">نطاق التاريخ</p>
                <p className="font-medium">{formatDate(defaultStart(selectedSource))} إلى {formatDate(defaultEnd(selectedSource))}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>المنصات والصفحات التابعة</CardTitle>
                <CardDescription>
                  الصفحات المرتبطة بنفس القارئ تظهر هنا. Instagram لا يتم تفعيله تلقائيًا، ويمكن اختياره يدويًا عند الحاجة.
                </CardDescription>
              </div>
              <Button type="button" onClick={addTarget}>
                <Plus className="h-4 w-4 ml-2" />
                إضافة منصة
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {pagesQuery.isLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  جار تحميل صفحات القارئ...
                </div>
              ) : targets.length === 0 ? (
                <div className="rounded-xl border border-dashed py-8 text-center text-muted-foreground">
                  لا توجد صفحات مرتبطة بهذا القارئ. يمكنك إضافة منصة يدويًا إذا كانت الصفحة موجودة.
                </div>
              ) : targets.map((target) => {
                const platform = target.platformId ? platformById.get(target.platformId) : null;
                const availablePages = targetPagesForPlatform(target.platformId);
                const selectedPage = target.pageId ? pageById.get(target.pageId) : null;
                const allowedMemberIds = selectedPage?.memberIds ?? [];
                return (
                  <div key={target.id} className={`rounded-xl border p-4 space-y-4 ${target.enabled ? "bg-card" : "bg-muted/30"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">{platform?.name ?? "منصة غير محددة"} {selectedPage ? `- ${selectedPage.name}` : ""}</p>
                        {platform && isInstagramPlatformName(platform.name) && (
                          <p className="text-xs text-muted-foreground">Instagram مستبعد افتراضيًا لأنه له خطة مستقلة.</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button type="button" variant={target.enabled ? "default" : "outline"} onClick={() => updateTarget(target.id, { enabled: !target.enabled })}>
                          {target.enabled ? "داخل التوليد" : "مستبعد"}
                        </Button>
                        <Button type="button" variant="outline" size="icon" onClick={() => removeTarget(target.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                      <div className="grid gap-2">
                        <Label>المنصة</Label>
                        <select
                          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                          value={target.platformId ?? ""}
                          onChange={(event) => updateTarget(target.id, { platformId: Number(event.target.value) || null, pageId: null, memberIds: [] })}
                        >
                          <option value="">اختر المنصة</option>
                          {platforms
                            .filter((item) => item.id !== selectedSource.platformId)
                            .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
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
                      <div className="grid gap-2">
                        <Label>من تاريخ</Label>
                        <Input type="date" value={target.startDate} onChange={(event) => updateTarget(target.id, { startDate: event.target.value })} />
                      </div>
                      <div className="grid gap-2">
                        <Label>إلى تاريخ</Label>
                        <Input type="date" value={target.endDate} onChange={(event) => updateTarget(target.id, { endDate: event.target.value })} />
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
        </>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>معاينة التوليد</CardTitle>
            <CardDescription>
              المصدر: #{preview.sourceTask.id} - {preview.sourceTask.title}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Badge variant="secondary">المهام المتوقعة: {preview.totalExpected}</Badge>
              <Badge variant="secondary">المنصات الجاهزة: {preview.platformsCount}</Badge>
              <Badge variant="secondary">إجمالي الأيام: {preview.daysCount}</Badge>
              <Badge variant="outline">القارئ: {preview.sourceTask.reciterName ?? "غير محدد"}</Badge>
              <Badge variant="outline">المنصة: {preview.sourceTask.platformName}</Badge>
            </div>
            <div className="space-y-2">
              {preview.items.map((item) => (
                <div key={`${item.platformId}-${item.pageId}-${item.startDate}-${item.endDate}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{item.platformName} - {item.pageName}</p>
                    <Badge variant={item.warnings.length === 0 ? "default" : "destructive"}>
                      {item.warnings.length === 0 ? `${item.expectedTasks} مهمة` : item.warnings.map(warningLabel).join("، ")}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">المسؤولون: {item.memberNames.length > 0 ? item.memberNames.join("، ") : "لا يوجد"}</p>
                  <p className="mt-1 text-sm text-muted-foreground">النطاق: {item.startDate} إلى {item.endDate} - {item.daysCount} يوم</p>
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
            <CardDescription>دفعة التوليد: #{result.batchId} - المهمة الأصلية: #{result.sourceTaskId}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge>تم إنشاء {result.summary.createdCount} مهمة</Badge>
              <Badge variant="secondary">تم تخطي {result.summary.skippedCount} مهمة</Badge>
              <Badge variant="outline">أول تاريخ: {result.summary.firstDate ?? "لا يوجد"}</Badge>
              <Badge variant="outline">آخر تاريخ: {result.summary.lastDate ?? "لا يوجد"}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border p-3">
                <p className="font-semibold mb-2">المهام المنشأة</p>
                {result.created.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لم يتم إنشاء مهام.</p>
                ) : result.created.slice(0, 20).map((item) => (
                  <p key={`${item.taskId}-${item.dueDate}`} className="text-sm">
                    #{item.taskId} - {item.platformName} - {item.pageName} - {item.dueDate}
                  </p>
                ))}
                {result.created.length > 20 && <p className="text-xs text-muted-foreground">و {result.created.length - 20} مهمة أخرى.</p>}
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-semibold mb-2">العناصر المتخطاة</p>
                {result.skipped.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا يوجد تخطي.</p>
                ) : result.skipped.slice(0, 20).map((item, index) => (
                  <p key={`${item.pageName}-${item.dueDate}-${index}`} className="text-sm">
                    {item.platformName ?? "منصة"} - {item.pageName ?? "صفحة"} - {item.dueDate ?? "بدون تاريخ"}: {item.reason}
                    {item.existingTaskId ? ` (#${item.existingTaskId})` : ""}
                  </p>
                ))}
                {result.skipped.length > 20 && <p className="text-xs text-muted-foreground">و {result.skipped.length - 20} عنصر آخر.</p>}
              </div>
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
