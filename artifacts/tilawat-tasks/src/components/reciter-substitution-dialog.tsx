import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Lock, Plus, Trash2, UserCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/lib/platform-icon";
import { formatHijriDate } from "@/lib/hijri-date";
import { cn } from "@/lib/utils";

// شاشة النيابة الموحّدة: (1) النائب والنطاق ← (2) قرار كل منصة ← (3) ملخص وتأكيد.
// المعاينة لا تغيّر شيئًا؛ الإغلاق قبل التأكيد لا يترك أي أثر.

type ScopeKind = "single" | "dates" | "rest_of_week";
type MemberOption = { id: number; name: string };
type PageOption = { id: number; name: string; members: MemberOption[] };
type SlotKey = { date: string | null; prayer: string | null; creationGroupId: number | null };
type RowKind =
  | "auto_assign"
  | "choose_member"
  | "choose_any_member"
  | "choose_page"
  | "delete_unavailable"
  | "protected_completed"
  | "protected_proof"
  | "excluded_quota";

type PlanRow = {
  taskId: number;
  slot: SlotKey;
  platformId: number;
  platformName: string;
  coversAllReciters: boolean;
  kind: RowKind;
  currentMemberIds: number[];
  currentMemberNames: string[];
  currentTitle: string;
  newTitle: string;
  titleWillChange: boolean;
  pageId: number | null;
  pageOptions: PageOption[];
  candidateMembers: MemberOption[];
  autoMemberId: number | null;
  warnings: string[];
};

type ExtraRow = {
  key: string;
  slot: SlotKey;
  platformId: number;
  platformName: string;
  pageOptions: PageOption[];
  pageId: number | null;
  candidateMembers: MemberOption[];
  autoMemberId: number | null;
  newTitle: string;
};

type Plan = {
  baseTaskId: number;
  fromReciter: { id: number; name: string };
  toReciter: { id: number; name: string };
  scopeKind: ScopeKind;
  slots: SlotKey[];
  rows: PlanRow[];
  extras: ExtraRow[];
  warnings: string[];
  planToken: string;
};

type SlotOption = { date: string; prayer: string | null; isBase: boolean; isPast: boolean; taskCount: number; actionableCount: number };
type SlotListing = {
  base: { id: number; reciterId: number; reciterName: string; prayer: string | null; dateKey: string | null };
  week: { start: string; end: string } | null;
  slots: SlotOption[];
  canUseMultiDay: boolean;
};

type RowChoice = { memberId?: number; pageId?: number };
type ExtraChoice = { create: boolean; memberId?: number; pageId?: number };

const PRAYER_LABELS: Record<string, string> = {
  fajr: "الفجر",
  maghrib: "المغرب",
  isha: "العشاء",
  jumuah: "الجمعة",
};

const LOCKED_KINDS: RowKind[] = ["protected_completed", "protected_proof", "excluded_quota"];

function slotLabel(slot: { date: string | null; prayer: string | null }) {
  const prayer = slot.prayer ? `صلاة ${PRAYER_LABELS[slot.prayer] ?? slot.prayer}` : "";
  if (!slot.date) return prayer || "بلا تاريخ";
  const anchor = new Date(`${slot.date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ar-SA", { timeZone: "Asia/Riyadh", weekday: "long" }).format(anchor);
  const hijri = formatHijriDate(anchor, { year: undefined });
  return [weekday, hijri, prayer].filter(Boolean).join(" · ");
}

async function readJson(response: Response) {
  return response.json().catch(() => null);
}

function kindBadge(kind: RowKind) {
  switch (kind) {
    case "auto_assign":
      return { label: "تلقائي", className: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: UserCheck };
    case "choose_member":
      return { label: "اختر من أعضاء الصفحة", className: "bg-sky-50 text-sky-700 border-sky-200", Icon: Users };
    case "choose_any_member":
      return { label: "لا عضو للنائب — اختر عضوًا", className: "bg-amber-50 text-amber-700 border-amber-200", Icon: Users };
    case "choose_page":
      return { label: "اختر الصفحة والعضو", className: "bg-amber-50 text-amber-700 border-amber-200", Icon: Users };
    case "delete_unavailable":
      return { label: "تُحذف (النائب غير موجود على المنصة)", className: "bg-red-50 text-red-700 border-red-200", Icon: Trash2 };
    case "protected_completed":
      return { label: "محمية — مكتملة", className: "bg-muted text-muted-foreground border-border", Icon: Lock };
    case "protected_proof":
      return { label: "محمية — لها شاهد", className: "bg-muted text-muted-foreground border-border", Icon: Lock };
    case "excluded_quota":
      return { label: "مستثناة — حصة أسبوعية", className: "bg-muted text-muted-foreground border-border", Icon: Lock };
  }
}

function MemberSelect({
  value,
  options,
  onChange,
  placeholder = "اختر العضو المسؤول",
}: {
  value?: number;
  options: MemberOption[];
  onChange: (id: number) => void;
  placeholder?: string;
}) {
  return (
    <Select value={value ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent dir="rtl" className="max-h-[280px] overflow-y-auto">
        {options.map((m) => (
          <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PageSelect({ value, options, onChange }: { value?: number; options: PageOption[]; onChange: (id: number) => void }) {
  return (
    <Select value={value ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder="اختر صفحة النائب" />
      </SelectTrigger>
      <SelectContent dir="rtl">
        {options.map((p) => (
          <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ReciterSubstitutionDialog({
  task,
  reciters,
  onClose,
  onApplied,
}: {
  task: { id: number; title: string; reciter?: { id: number; name: string } | null } | null;
  reciters: Array<{ id: number; name: string }> | undefined;
  onClose: () => void;
  onApplied: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [newReciterId, setNewReciterId] = useState<number | null>(null);
  const [scopeKind, setScopeKind] = useState<ScopeKind>("single");
  const [listing, setListing] = useState<SlotListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rowChoices, setRowChoices] = useState<Record<number, RowChoice>>({});
  const [extraChoices, setExtraChoices] = useState<Record<string, ExtraChoice>>({});
  const [loading, setLoading] = useState(false);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  useEffect(() => {
    setStep(1);
    setNewReciterId(null);
    setScopeKind("single");
    setListing(null);
    setListingError(null);
    setSelectedDates([]);
    setPlan(null);
    setRowChoices({});
    setExtraChoices({});
    setStaleNotice(null);
    if (!task) return;
    let cancelled = false;
    fetch(`/api/tasks/${task.id}/substitution/slots`, { credentials: "include" })
      .then(async (response) => {
        const payload = await readJson(response);
        if (cancelled) return;
        if (!response.ok) {
          setListingError(payload?.message ?? "تعذّر تحميل فروض القارئ");
          return;
        }
        setListing(payload as SlotListing);
        const baseDate = (payload as SlotListing).base.dateKey;
        if (baseDate) setSelectedDates([baseDate]);
      })
      .catch(() => !cancelled && setListingError("تعذّر تحميل فروض القارئ"));
    return () => {
      cancelled = true;
    };
  }, [task?.id]);

  const reciterOptions = useMemo(
    () => (reciters ?? []).filter((r) => r.id !== listing?.base.reciterId),
    [reciters, listing?.base.reciterId],
  );

  const restOfWeekDates = useMemo(() => {
    const base = listing?.base.dateKey;
    if (!listing || !base) return [];
    return listing.slots.filter((s) => s.date >= base).map((s) => s.date);
  }, [listing]);

  const applyPlan = (next: Plan) => {
    setPlan(next);
    // اختيارات افتراضية: العضو التلقائي، أو العضو الحالي إن كان ضمن المرشّحين (لتقليل النقرات).
    const defaults: Record<number, RowChoice> = {};
    for (const row of next.rows) {
      if (LOCKED_KINDS.includes(row.kind) || row.kind === "delete_unavailable") continue;
      if (row.kind === "auto_assign" && row.autoMemberId) {
        defaults[row.taskId] = { memberId: row.autoMemberId };
        continue;
      }
      if (row.kind === "choose_page") {
        defaults[row.taskId] = {};
        continue;
      }
      const current = row.currentMemberIds.find((id) => row.candidateMembers.some((m) => m.id === id));
      defaults[row.taskId] = current ? { memberId: current } : {};
    }
    setRowChoices(defaults);
    const extraDefaults: Record<string, ExtraChoice> = {};
    for (const extra of next.extras) {
      extraDefaults[extra.key] = { create: false, memberId: extra.autoMemberId ?? undefined, pageId: extra.pageId ?? undefined };
    }
    setExtraChoices(extraDefaults);
  };

  const requestBody = () => ({
    newReciterId,
    scopeKind,
    dates: scopeKind === "dates" ? selectedDates : undefined,
  });

  const runPreview = async () => {
    if (!task || !newReciterId) return;
    if (scopeKind === "dates" && selectedDates.length === 0) {
      toast({ title: "اختر يومًا واحدًا على الأقل", variant: "destructive" });
      return;
    }
    setLoading(true);
    setStaleNotice(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}/substitution/preview`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّرت المعاينة");
      applyPlan(payload as Plan);
      setStep(2);
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "تعذّرت المعاينة", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const actionableRows = plan?.rows.filter((row) => !LOCKED_KINDS.includes(row.kind) && row.kind !== "delete_unavailable") ?? [];
  const deleteRows = plan?.rows.filter((row) => row.kind === "delete_unavailable") ?? [];
  const lockedRows = plan?.rows.filter((row) => LOCKED_KINDS.includes(row.kind)) ?? [];
  const extrasToCreate = plan?.extras.filter((extra) => extraChoices[extra.key]?.create) ?? [];

  const rowAllowedMembers = (row: PlanRow): MemberOption[] => {
    if (row.kind !== "choose_page") return row.candidateMembers;
    const page = row.pageOptions.find((p) => p.id === rowChoices[row.taskId]?.pageId);
    if (!page) return [];
    return page.members.length > 0 ? page.members : row.candidateMembers;
  };

  const extraAllowedMembers = (extra: ExtraRow): MemberOption[] => {
    if (extra.pageOptions.length <= 1) return extra.candidateMembers;
    const page = extra.pageOptions.find((p) => p.id === extraChoices[extra.key]?.pageId);
    if (!page) return [];
    return page.members.length > 0 ? page.members : extra.candidateMembers;
  };

  const rowsComplete = actionableRows.every((row) => {
    const choice = rowChoices[row.taskId];
    if (row.kind === "choose_page" && !choice?.pageId) return false;
    return Boolean(choice?.memberId && rowAllowedMembers(row).some((m) => m.id === choice.memberId));
  });
  const extrasComplete = extrasToCreate.every((extra) => {
    const choice = extraChoices[extra.key];
    if (extra.pageOptions.length > 1 && !choice?.pageId) return false;
    return Boolean(choice?.memberId && extraAllowedMembers(extra).some((m) => m.id === choice.memberId));
  });
  const hasChanges = actionableRows.length + deleteRows.length + extrasToCreate.length > 0;

  const groupedRows = useMemo(() => {
    const groups = new Map<number, { platformId: number; platformName: string; rows: PlanRow[] }>();
    for (const row of plan?.rows ?? []) {
      if (!groups.has(row.platformId)) groups.set(row.platformId, { platformId: row.platformId, platformName: row.platformName, rows: [] });
      groups.get(row.platformId)!.rows.push(row);
    }
    return [...groups.values()];
  }, [plan]);

  const applyMemberToPlatform = (platformId: number, memberId: number) => {
    setRowChoices((prev) => {
      const next = { ...prev };
      for (const row of actionableRows) {
        if (row.platformId !== platformId) continue;
        if (rowAllowedMembers(row).some((m) => m.id === memberId)) next[row.taskId] = { ...next[row.taskId], memberId };
      }
      return next;
    });
  };

  const runApply = async () => {
    if (!task || !plan) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}/substitution/apply`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestBody(),
          planToken: plan.planToken,
          decisions: actionableRows.map((row) => ({ taskId: row.taskId, ...rowChoices[row.taskId] })),
          extras: plan.extras.map((extra) => ({ key: extra.key, ...extraChoices[extra.key] })),
        }),
      });
      const payload = await readJson(response);
      if (response.status === 409 && payload?.error === "plan_stale") {
        if (payload?.details?.plan) applyPlan(payload.details.plan as Plan);
        setStaleNotice(payload?.message ?? "تغيّرت البيانات منذ المعاينة — راجع الشاشة من جديد");
        setStep(2);
        return;
      }
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تطبيق النيابة");
      const parts = [
        payload?.reassigned ? `أُعيد إسناد ${payload.reassigned}` : null,
        payload?.deleted ? `حُذف ${payload.deleted}` : null,
        payload?.created ? `أُنشئ ${payload.created}` : null,
        payload?.protected ? `محمي ${payload.protected}` : null,
      ].filter(Boolean);
      toast({ title: `تمت النيابة: ${plan.toReciter.name} عن ${plan.fromReciter.name}`, description: parts.join(" · ") || undefined });
      await onApplied();
      onClose();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "تعذّر تطبيق النيابة", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const open = Boolean(task);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !loading) onClose(); }}>
      <DialogContent className="sm:max-w-[680px] max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>نيابة (تغيير القارئ)</DialogTitle>
          <DialogDescription>
            {listing
              ? `القارئ المجدول: ${listing.base.reciterName}${listing.base.dateKey ? ` · ${slotLabel({ date: listing.base.dateKey, prayer: listing.base.prayer })}` : ""}`
              : "…"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {["النائب والنطاق", "قرار كل منصة", "الملخص والتأكيد"].map((label, index) => (
            <span key={label} className={cn("rounded-full border px-2 py-0.5", step === index + 1 && "border-sidebar-primary text-sidebar-primary font-bold")}>
              {index + 1}. {label}
            </span>
          ))}
        </div>

        {listingError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{listingError}</div>
        )}

        {!listingError && step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>القارئ النائب</Label>
              <Select value={newReciterId ? String(newReciterId) : undefined} onValueChange={(v) => setNewReciterId(Number(v))}>
                <SelectTrigger>
                  <SelectValue placeholder="اختر القارئ النائب" />
                </SelectTrigger>
                <SelectContent dir="rtl" className="max-h-[320px] overflow-y-auto">
                  {reciterOptions.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>نطاق النيابة</Label>
              <RadioGroup value={scopeKind} onValueChange={(v) => setScopeKind(v as ScopeKind)} className="space-y-2">
                <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer">
                  <RadioGroupItem value="single" className="mt-1" />
                  <span className="text-sm">
                    <span className="font-medium">فرض واحد</span>
                    <span className="block text-xs text-muted-foreground">هذه الصلاة فقط، على كل منصاتها.</span>
                  </span>
                </label>
                <label className={cn("flex items-start gap-2 rounded-md border p-2", listing?.canUseMultiDay ? "cursor-pointer" : "opacity-50")}>
                  <RadioGroupItem value="dates" className="mt-1" disabled={!listing?.canUseMultiDay} />
                  <span className="text-sm">
                    <span className="font-medium">أيام محددة</span>
                    <span className="block text-xs text-muted-foreground">نفس الصلاة في أيام تختارها من هذا الأسبوع.</span>
                  </span>
                </label>
                <label className={cn("flex items-start gap-2 rounded-md border p-2", listing?.canUseMultiDay ? "cursor-pointer" : "opacity-50")}>
                  <RadioGroupItem value="rest_of_week" className="mt-1" disabled={!listing?.canUseMultiDay} />
                  <span className="text-sm">
                    <span className="font-medium">من هذا اليوم لآخر الأسبوع</span>
                    <span className="block text-xs text-muted-foreground">نفس الصلاة حتى السبت (الأسبوع من الأحد إلى السبت).</span>
                  </span>
                </label>
              </RadioGroup>
              {listing && !listing.canUseMultiDay && (
                <p className="text-xs text-amber-700">هذه مهمة قديمة بلا صلاة/مجموعة محفوظة — النيابة متاحة لها كفرض واحد فقط.</p>
              )}
            </div>

            {scopeKind === "dates" && listing && (
              <div className="space-y-1.5 rounded-md border p-2">
                {listing.slots.map((slot) => (
                  <label key={slot.date} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={selectedDates.includes(slot.date)}
                      onCheckedChange={(checked) =>
                        setSelectedDates((prev) => checked ? [...new Set([...prev, slot.date])] : prev.filter((d) => d !== slot.date))
                      }
                    />
                    <span className={cn(slot.isPast && "text-muted-foreground")}>{slotLabel(slot)}</span>
                    {slot.isBase && <span className="text-[10px] rounded-full bg-sidebar-primary/10 text-sidebar-primary px-1.5">هذه المهمة</span>}
                    {slot.isPast && <span className="text-[10px] text-muted-foreground">(مضى)</span>}
                    {slot.actionableCount < slot.taskCount && (
                      <span className="text-[10px] text-muted-foreground">({slot.taskCount - slot.actionableCount} محمية)</span>
                    )}
                  </label>
                ))}
              </div>
            )}

            {scopeKind === "rest_of_week" && listing && (
              <div className="rounded-md border p-2 text-xs text-muted-foreground space-y-0.5">
                <p className="font-medium text-foreground">الفروض المشمولة:</p>
                {restOfWeekDates.map((date) => <p key={date}>• {slotLabel({ date, prayer: listing.base.prayer })}</p>)}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>إلغاء</Button>
              <Button onClick={runPreview} disabled={!newReciterId || loading || !listing}>
                {loading && <Loader2 className="h-4 w-4 animate-spin ml-1" />}
                معاينة
              </Button>
            </div>
          </div>
        )}

        {step === 2 && plan && (
          <div className="space-y-4">
            {staleNotice && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 flex gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />{staleNotice}
              </div>
            )}
            {plan.warnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50/70 p-2 text-xs text-amber-800 space-y-0.5">
                {plan.warnings.map((w) => <p key={w}>⚠ {w}</p>)}
              </div>
            )}

            {groupedRows.map((group) => {
              const groupActionable = group.rows.filter((row) => actionableRows.includes(row));
              const sharedCandidates = groupActionable.length > 1 ? groupActionable[0].candidateMembers : [];
              return (
                <div key={group.platformId} className="rounded-md border">
                  <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                    <span className="flex items-center gap-2 font-medium text-sm">
                      <PlatformIcon name={group.platformName} />{group.platformName}
                    </span>
                    {sharedCandidates.length > 0 && (
                      <div className="w-48">
                        <MemberSelect
                          options={sharedCandidates}
                          onChange={(id) => applyMemberToPlatform(group.platformId, id)}
                          placeholder="نفس العضو لكل الأيام"
                        />
                      </div>
                    )}
                  </div>
                  <div className="divide-y">
                    {group.rows.map((row) => {
                      const badge = kindBadge(row.kind);
                      const choice = rowChoices[row.taskId] ?? {};
                      const needsInput = actionableRows.includes(row) && row.kind !== "auto_assign";
                      return (
                        <div key={row.taskId} className="px-3 py-2 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-medium">{slotLabel(row.slot)}</span>
                            <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", badge.className)}>
                              <badge.Icon className="h-3 w-3" />{badge.label}
                            </span>
                            <span className="text-muted-foreground">الحالي: {row.currentMemberNames.join("، ") || "—"}</span>
                          </div>
                          {row.kind === "auto_assign" && row.autoMemberId && (
                            <p className="text-xs text-emerald-700">
                              المسؤول الجديد: {row.candidateMembers.find((m) => m.id === row.autoMemberId)?.name}
                            </p>
                          )}
                          {needsInput && (
                            <div className="grid gap-2 sm:grid-cols-2">
                              {row.kind === "choose_page" && (
                                <PageSelect
                                  value={choice.pageId}
                                  options={row.pageOptions}
                                  onChange={(pageId) => setRowChoices((prev) => ({ ...prev, [row.taskId]: { pageId } }))}
                                />
                              )}
                              <MemberSelect
                                value={choice.memberId}
                                options={rowAllowedMembers(row)}
                                onChange={(memberId) => setRowChoices((prev) => ({ ...prev, [row.taskId]: { ...prev[row.taskId], memberId } }))}
                              />
                            </div>
                          )}
                          {actionableRows.includes(row) && row.titleWillChange && (
                            <p className="text-[11px] text-muted-foreground">العنوان الجديد: {row.newTitle}</p>
                          )}
                          {row.warnings.map((w) => (
                            <p key={w} className="text-[11px] text-amber-700">⚠ {w}</p>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {plan.extras.length > 0 && (
              <div className="rounded-md border border-dashed">
                <div className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">
                  منصات للنائب ليست ضمن مهام الفرض — هل تُنشأ لها مهام جديدة؟
                </div>
                <div className="divide-y">
                  {plan.extras.map((extra) => {
                    const choice = extraChoices[extra.key] ?? { create: false };
                    return (
                      <div key={extra.key} className="px-3 py-2 space-y-1.5">
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={choice.create}
                            onCheckedChange={(checked) => setExtraChoices((prev) => ({ ...prev, [extra.key]: { ...prev[extra.key], create: Boolean(checked) } }))}
                          />
                          <Plus className="h-3 w-3" />
                          <PlatformIcon name={extra.platformName} className="h-3.5 w-3.5" />
                          <span className="font-medium">{extra.platformName}</span>
                          <span className="text-muted-foreground">· {slotLabel(extra.slot)}</span>
                        </label>
                        {choice.create && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {extra.pageOptions.length > 1 && (
                              <PageSelect
                                value={choice.pageId}
                                options={extra.pageOptions}
                                onChange={(pageId) => setExtraChoices((prev) => ({ ...prev, [extra.key]: { ...prev[extra.key], pageId, memberId: undefined } }))}
                              />
                            )}
                            <MemberSelect
                              value={choice.memberId}
                              options={extraAllowedMembers(extra)}
                              onChange={(memberId) => setExtraChoices((prev) => ({ ...prev, [extra.key]: { ...prev[extra.key], memberId } }))}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={loading}>
                <ArrowLeft className="h-4 w-4 ml-1 rotate-180" />رجوع
              </Button>
              <Button onClick={() => setStep(3)} disabled={!rowsComplete || !extrasComplete || !hasChanges}>
                متابعة
              </Button>
            </div>
            {!hasChanges && <p className="text-xs text-muted-foreground text-left">لا يوجد ما يُغيَّر — كل مهام النطاق محمية.</p>}
          </div>
        )}

        {step === 3 && plan && (
          <div className="space-y-3">
            <div className="rounded-md border p-3 text-sm space-y-1">
              <p className="font-medium">{plan.toReciter.name} ينوب عن {plan.fromReciter.name}</p>
              <p className="text-xs text-muted-foreground">{plan.slots.map((slot) => slotLabel(slot)).join(" | ")}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">إعادة إسناد: <b>{actionableRows.length}</b></div>
              <div className="rounded-md border border-red-200 bg-red-50 p-2">حذف ناعم: <b>{deleteRows.length}</b></div>
              <div className="rounded-md border border-sky-200 bg-sky-50 p-2">مهام جديدة: <b>{extrasToCreate.length}</b></div>
              <div className="rounded-md border bg-muted/40 p-2">محمية لن تُمسّ: <b>{lockedRows.length}</b></div>
            </div>
            {deleteRows.length > 0 && (
              <p className="text-xs text-muted-foreground">
                المهام المحذوفة تذهب إلى السلة ويمكن استرجاعها، ويمكن التراجع عن النيابة كاملة من تفاصيل المهمة.
              </p>
            )}
            <p className="text-xs text-muted-foreground">سيصل إشعار (داخلي + تيليجرام) لكل عضو تغيّرت مهامه.</p>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={loading}>
                <ArrowLeft className="h-4 w-4 ml-1 rotate-180" />رجوع
              </Button>
              <Button onClick={runApply} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <CheckCircle2 className="h-4 w-4 ml-1" />}
                تطبيق النيابة
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// سجلّ النيابات لمهمة + زر التراجع (للمدير).
type SubstitutionHistoryItem = {
  id: number;
  status: string;
  scopeKind: ScopeKind;
  createdAt: string;
  undoneAt: string | null;
  fromReciterName: string | null;
  toReciterName: string | null;
  counts: Record<string, number>;
};

export function TaskSubstitutionHistory({ taskId, onChanged }: { taskId: number; onChanged: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [items, setItems] = useState<SubstitutionHistoryItem[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = () => {
    fetch(`/api/tasks/${taskId}/substitutions`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      .catch(() => setItems([]));
  };
  useEffect(load, [taskId]);

  if (!items || items.length === 0) return null;

  const undo = async (item: SubstitutionHistoryItem) => {
    if (!confirm(`التراجع عن نيابة ${item.toReciterName ?? ""} عن ${item.fromReciterName ?? ""} بالكامل؟\nستعود كل المهام كما كانت، ما عدا ما اكتمل أو رُفع له شاهد بعد النيابة.`)) return;
    setBusyId(item.id);
    try {
      const response = await fetch(`/api/substitutions/${item.id}/undo`, { method: "POST", credentials: "include" });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التراجع");
      const skipped = Array.isArray(payload?.skipped) ? payload.skipped.length : 0;
      toast({
        title: "تم التراجع عن النيابة",
        description: [
          `أُعيد ${payload?.restored ?? 0}`,
          `استُرجع ${payload?.undeleted ?? 0}`,
          `أُزيل ${payload?.removedCreated ?? 0}`,
          skipped ? `تُخطّي ${skipped} (اكتملت أو تغيّرت)` : null,
        ].filter(Boolean).join(" · "),
      });
      await onChanged();
      load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "تعذّر التراجع", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-md border p-2 space-y-1.5">
      <p className="text-xs font-medium">سجلّ النيابة</p>
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            {item.toReciterName} عن {item.fromReciterName}
            <span className="text-muted-foreground"> · {new Date(item.createdAt).toLocaleDateString("ar-SA")}</span>
            {item.status !== "applied" && <span className="text-muted-foreground"> · تم التراجع</span>}
          </span>
          {item.status === "applied" && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === item.id} onClick={() => undo(item)}>
              {busyId === item.id && <Loader2 className="h-3 w-3 animate-spin ml-1" />}تراجع عن النيابة
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
