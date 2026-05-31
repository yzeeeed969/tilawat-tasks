import { useState } from "react";
import {
  useListPlatforms, getListPlatformsQueryKey,
  useListReciters, getListRecitersQueryKey,
  useCreatePlatform, useDeletePlatform, useUpdatePlatform,
  useCreateReciter, useDeleteReciter, useUpdateReciter,
  useListPlatformPages, useCreatePlatformPage, useDeletePlatformPage,
  getListPlatformPagesQueryKey,
  getListMembersQueryKey,
  useListMembers,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import {
  Loader2, Plus, Trash2, Settings as SettingsIcon,
  Shield, MicVocal, UserPlus, CheckCircle, XCircle, Clock,
  ChevronDown, ChevronUp, Pencil, Save, X, Layers, Star, Users,
  Bell, Send, Link2, RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/lib/platform-icon";
import { useIsAdmin, getRoleLabel, getRoleBadgeClass, type UserRole } from "@/lib/roles";
import { useAuth } from "@/lib/auth-context";

// ── Schemas ───────────────────────────────────────────────────────────────────
const platformSchema = z.object({
  name: z.string().min(2, { message: "الاسم مطلوب" }),
  icon: z.string().min(1, { message: "الأيقونة مطلوبة" }),
  color: z.string().min(3, { message: "اللون مطلوب" }),
});

const reciterSchema = z.object({
  name: z.string().min(2, { message: "الاسم مطلوب" }),
  mosque: z.enum(["nabawi", "haram"], { message: "اختر المسجد" }),
});

const createUserSchema = z.object({
  username: z.string().min(3, { message: "اسم المستخدم مطلوب (3 أحرف على الأقل)" }),
  password: z.string().min(4, { message: "كلمة السر مطلوبة (4 أحرف على الأقل)" }),
  displayName: z.string().min(2, { message: "الاسم مطلوب" }),
  memberRole: z.string().optional(),
  email: z.string().email({ message: "البريد الإلكتروني غير صالح" }).optional().or(z.literal("")),
  role: z.enum(["admin", "editor"]),
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface UserPerms {
  canViewMembers?: boolean;
  canViewReports?: boolean;
  canCreateTasks?: boolean;
  canEditTasks?: boolean;
  canDeleteTasks?: boolean;
  canManageSettings?: boolean;
  canManageReciters?: boolean;
  canManagePlatforms?: boolean;
  canManageAccounts?: boolean;
}

interface AppUser {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isApproved: boolean;
  memberId: number | null;
  memberName: string | null;
  memberRole: string | null;
  permissions: UserPerms | null;
  createdAt: string;
}

interface TelegramSettingsData {
  settings: {
    enabled: boolean;
    dailyReminderTime: string;
    dailySummaryTime: string;
    dailyPublicSummaryTime: string;
    overdueAfterTime: string;
    notifyDailyReminder: boolean;
    notifyMemberOverdue: boolean;
    notifyAdminOverdue: boolean;
    notifyAdminCompleted: boolean;
    notifyAdminDailySummary: boolean;
    notifyDailyPublicSummary: boolean;
    suppressRepeatHours: number;
  };
  recipients: Array<{
    id: number;
    userId: number | null;
    memberId: number | null;
    telegramUsername: string | null;
    isEnabled: boolean;
    linkedAt: string;
    memberName: string | null;
    displayName: string | null;
    username: string | null;
  }>;
  botConfigured: boolean;
}

interface TelegramLog {
  id: number;
  type: string;
  recipientUserId: number | null;
  recipientMemberId: number | null;
  taskId: number | null;
  status: string;
  failureReason: string | null;
  sentAt: string | null;
  createdAt: string;
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function fetchAdminUsers(): Promise<AppUser[]> {
  const res = await fetch("/api/admin/users", { credentials: "include" });
  if (!res.ok) throw new Error("Forbidden");
  return res.json();
}

async function createUser(data: {
  username: string; password: string; displayName: string; memberRole?: string; role: string; email?: string;
}) {
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "فشل إنشاء المستخدم");
  return body;
}

async function patchUser(id: number, updates: {
  role?: string; isApproved?: boolean; password?: string;
  displayName?: string; memberRole?: string; permissions?: UserPerms | null;
}) {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update");
  return res.json();
}

async function deleteUser(id: number) {
  const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to delete");
  }
}

async function fetchTelegramSettings(): Promise<TelegramSettingsData> {
  const res = await fetch("/api/telegram/settings", { credentials: "include" });
  if (!res.ok) throw new Error("فشل تحميل إعدادات Telegram");
  return res.json();
}

async function fetchTelegramLogs(): Promise<TelegramLog[]> {
  const res = await fetch("/api/telegram/logs?limit=50", { credentials: "include" });
  if (!res.ok) throw new Error("فشل تحميل سجل Telegram");
  return res.json();
}

async function patchTelegramSettings(updates: Partial<TelegramSettingsData["settings"]>) {
  const res = await fetch("/api/telegram/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "فشل حفظ إعدادات Telegram");
  return body;
}

async function createTelegramLinkToken(userId?: number) {
  const res = await fetch("/api/telegram/link-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(userId ? { userId } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "فشل إنشاء رمز الربط");
  return body as { token: string; expiresAt: string };
}

async function runTelegramDueCheck() {
  const res = await fetch("/api/telegram/run-due", { method: "POST", credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "فشل تشغيل الفحص");
  return body;
}

async function sendTelegramTest(userId?: number) {
  const res = await fetch("/api/telegram/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(userId ? { userId } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "فشل إرسال رسالة الاختبار");
  return body;
}

function riyadhDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10);
}

async function sendTelegramPublicSummaryNow(date: string) {
  const res = await fetch("/api/telegram/public-summary-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ date }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "فشل إرسال ملخص منشورات اليوم");
  return body as { sent: number; publications: number; messages: number; date: string };
}

// ── Permission checkbox ────────────────────────────────────────────────────────
function PermCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 rounded accent-sidebar-primary cursor-pointer"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

const DEFAULT_PERMS: Record<UserRole, Required<UserPerms>> = {
  admin: { canViewMembers: true, canViewReports: true, canCreateTasks: true, canEditTasks: true, canDeleteTasks: true, canManageSettings: true, canManageReciters: true, canManagePlatforms: true, canManageAccounts: true },
  editor: { canViewMembers: false, canViewReports: false, canCreateTasks: true, canEditTasks: true, canDeleteTasks: false, canManageSettings: false, canManageReciters: false, canManagePlatforms: false, canManageAccounts: false },
};

function resolvePerms(role: UserRole, custom: UserPerms | null): Required<UserPerms> {
  if (role === "admin") return DEFAULT_PERMS.admin;
  const base = DEFAULT_PERMS[role];
  if (!custom) return base;
  return {
    canViewMembers: custom.canViewMembers ?? base.canViewMembers,
    canViewReports: custom.canViewReports ?? base.canViewReports,
    canCreateTasks: custom.canCreateTasks ?? base.canCreateTasks,
    canEditTasks: custom.canEditTasks ?? base.canEditTasks,
    canDeleteTasks: custom.canDeleteTasks ?? base.canDeleteTasks,
    canManageSettings: custom.canManageSettings ?? base.canManageSettings,
    canManageReciters: custom.canManageReciters ?? base.canManageReciters,
    canManagePlatforms: custom.canManagePlatforms ?? base.canManagePlatforms,
    canManageAccounts: custom.canManageAccounts ?? base.canManageAccounts,
  };
}

// ── User Row (expandable) ─────────────────────────────────────────────────────
function UserRow({ u, onUpdate, onDelete }: {
  u: AppUser;
  onUpdate: (id: number, updates: Parameters<typeof patchUser>[1]) => void;
  onDelete: (id: number, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(u.displayName ?? "");
  const [username] = useState(u.username);
  const [memberRole, setMemberRole] = useState(u.memberRole ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [role, setRole] = useState<UserRole>(u.role);
  const [showPerms, setShowPerms] = useState(false);
  const [perms, setPerms] = useState<Required<UserPerms>>(() => resolvePerms(u.role, u.permissions));
  const [saving, setSaving] = useState(false);

  const name = u.displayName ?? u.username;
  const isAdmin = role === "admin";

  const setPerm = (key: keyof UserPerms, val: boolean) =>
    setPerms((p) => ({ ...p, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Parameters<typeof patchUser>[1] = {};
      if (displayName.trim() && displayName.trim() !== (u.displayName ?? "")) updates.displayName = displayName.trim();
      if (memberRole !== (u.memberRole ?? "")) updates.memberRole = memberRole;
      if (role !== u.role) updates.role = role;
      if (newPassword && newPassword.length >= 4) updates.password = newPassword;
      if (!isAdmin) updates.permissions = perms;
      onUpdate(u.id, updates);
      setNewPassword("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header row — click to expand */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 p-3 bg-background hover:bg-muted/20 transition-colors text-right"
      >
        <div className="w-10 h-10 rounded-full bg-sidebar-primary/10 border border-sidebar-primary/20 flex items-center justify-center shrink-0 font-bold text-sidebar-primary">
          {name[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0 text-right">
          <p className="font-semibold text-foreground truncate">{name}</p>
          <p className="text-xs text-muted-foreground" dir="ltr">{u.username}</p>
          {u.memberRole && <p className="text-xs text-sidebar-primary/70">{u.memberRole}</p>}
        </div>
        <span className={`text-xs font-bold px-2 py-1 rounded-full border shrink-0 ${getRoleBadgeClass(u.role)}`}>
          {getRoleLabel(u.role)}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {/* Expanded edit panel */}
      {open && (
        <div className="border-t border-border bg-muted/10 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">الاسم الظاهر</label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="الاسم الظاهر" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">اسم المستخدم / رقم الجوال</label>
              <Input value={username} placeholder="0501234567" dir="ltr" disabled className="opacity-60" />
              <p className="text-[10px] text-muted-foreground">لا يمكن تغيير اسم المستخدم</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">الدور الوظيفي في الفريق</label>
              <Input value={memberRole} onChange={(e) => setMemberRole(e.target.value)} placeholder="مثال: محرر فيديو، مصمم..." />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">صلاحية الدخول</label>
              <Select value={role} onValueChange={(v) => {
                const newRole = v as UserRole;
                setRole(newRole);
                if (newRole !== "admin") setPerms(resolvePerms(newRole, null));
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent dir="rtl">
                  <SelectItem value="admin">مدير — صلاحيات كاملة</SelectItem>
                  <SelectItem value="editor">محرر — إضافة وتعديل</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground">كلمة سر جديدة <span className="font-normal">(اتركها فارغة إذا لم تريد التغيير)</span></label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" dir="ltr" />
            </div>
          </div>

          {/* ── Granular permissions ── */}
          {!isAdmin && (
            <div className="bg-background border border-border/60 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowPerms((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-muted-foreground hover:bg-muted/20 transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  تخصيص الصلاحيات التفصيلية
                </span>
                {showPerms ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {showPerms && (
                <div className="px-4 pb-4 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-2.5 border-t border-border/50">
                  <PermCheckbox label="عرض صفحة الأعضاء" checked={perms.canViewMembers} onChange={(v) => setPerm("canViewMembers", v)} />
                  <PermCheckbox label="عرض صفحة التقارير" checked={perms.canViewReports} onChange={(v) => setPerm("canViewReports", v)} />
                  <PermCheckbox label="إضافة مهام" checked={perms.canCreateTasks} onChange={(v) => setPerm("canCreateTasks", v)} />
                  <PermCheckbox label="تعديل المهام" checked={perms.canEditTasks} onChange={(v) => setPerm("canEditTasks", v)} />
                  <PermCheckbox label="حذف المهام" checked={perms.canDeleteTasks} onChange={(v) => setPerm("canDeleteTasks", v)} />
                  <PermCheckbox label="الوصول للإعدادات" checked={perms.canManageSettings} onChange={(v) => setPerm("canManageSettings", v)} />
                  <PermCheckbox label="إدارة القراء" checked={perms.canManageReciters ?? false} onChange={(v) => setPerm("canManageReciters", v)} />
                  <PermCheckbox label="إدارة المنصات" checked={perms.canManagePlatforms ?? false} onChange={(v) => setPerm("canManagePlatforms", v)} />
                  <PermCheckbox label="إدارة الحسابات" checked={perms.canManageAccounts ?? false} onChange={(v) => setPerm("canManageAccounts", v)} />
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={() => onDelete(u.id, name)}
            >
              <Trash2 className="h-4 w-4 ml-1" /> حذف الحساب
            </Button>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
                <X className="h-4 w-4 ml-1" /> إغلاق
              </Button>
              <Button
                size="sm"
                className="bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Save className="h-4 w-4 ml-1" />}
                حفظ التعديلات
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── User Management Section ───────────────────────────────────────────────────
function UserManagementSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: users, isLoading: usersLoading, refetch: refetchUsers } = useQuery({
    queryKey: ["admin-users"],
    queryFn: fetchAdminUsers,
  });

  const createForm = useForm<z.infer<typeof createUserSchema>>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { username: "", password: "", displayName: "", memberRole: "", email: "", role: "editor" },
  });

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      toast({ title: "تم إنشاء الحساب بنجاح" });
      createForm.reset({ username: "", password: "", displayName: "", memberRole: "", email: "", role: "editor" });
      refetchUsers();
      queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: Parameters<typeof patchUser>[1] }) =>
      patchUser(id, updates),
    onSuccess: () => {
      toast({ title: "تم التحديث بنجاح" });
      refetchUsers();
      queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
    },
    onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      toast({ title: "تم حذف المستخدم" });
      refetchUsers();
      queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const pending = users?.filter((u) => !u.isApproved) ?? [];
  const approved = users?.filter((u) => u.isApproved) ?? [];

  return (
    <Card className="border-border/50 shadow-sm lg:col-span-2">
      <CardHeader className="bg-sidebar/5 border-b border-border/50 pb-6">
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-sidebar-primary" />
          إدارة الأعضاء والصلاحيات
        </CardTitle>
        <CardDescription className="text-base mt-2">
          أنشئ حسابات للأعضاء — سيُضاف كل عضو تلقائياً للفريق واضغط على أي عضو لتعديل بياناته
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-8">

        {/* ── Create User Form ── */}
        <div className="bg-muted/20 border border-border/60 rounded-xl p-5 space-y-4">
          <h3 className="font-bold text-lg flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-sidebar-primary" />
            إنشاء حساب جديد
          </h3>
          <Form {...createForm}>
            <form onSubmit={createForm.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={createForm.control} name="displayName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>الاسم الكامل</FormLabel>
                    <FormControl><Input placeholder="مثال: عبدالرحمن العتيبي" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={createForm.control} name="username" render={({ field }) => (
                  <FormItem>
                    <FormLabel>اسم المستخدم / رقم الجوال</FormLabel>
                    <FormControl><Input placeholder="مثال: 0501234567" dir="ltr" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={createForm.control} name="password" render={({ field }) => (
                  <FormItem>
                    <FormLabel>كلمة السر</FormLabel>
                    <FormControl><Input type="password" placeholder="••••••" dir="ltr" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={createForm.control} name="memberRole" render={({ field }) => (
                  <FormItem>
                    <FormLabel>الدور الوظيفي <span className="text-muted-foreground font-normal">(اختياري)</span></FormLabel>
                    <FormControl><Input placeholder="مثال: محرر فيديو، مصمم..." {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={createForm.control} name="email" render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>البريد الإلكتروني <span className="text-muted-foreground font-normal">(اختياري — لاسترداد كلمة المرور وإرسال بيانات الدخول)</span></FormLabel>
                    <FormControl><Input type="email" placeholder="example@gmail.com" dir="ltr" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={createForm.control} name="role" render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>صلاحية الدخول</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent dir="rtl">
                        <SelectItem value="admin">مدير — صلاحيات كاملة</SelectItem>
                        <SelectItem value="editor">محرر — إضافة وتعديل</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <Button type="submit" className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold" disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}
                إنشاء الحساب وإضافته للفريق
              </Button>
            </form>
          </Form>
        </div>

        {/* Roles legend */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="p-2 rounded-lg bg-sidebar-primary/5 border border-sidebar-primary/20 text-center">
            <p className="font-bold text-sidebar-primary">مدير</p>
            <p className="text-muted-foreground mt-0.5">صلاحيات كاملة</p>
          </div>
          <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-center">
            <p className="font-bold text-amber-700">محرر</p>
            <p className="text-muted-foreground mt-0.5">إضافة وتعديل</p>
          </div>
        </div>

        {usersLoading ? (
          <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
        ) : (
          <>
            {/* Pending */}
            {pending.length > 0 && (
              <div className="space-y-3">
                <h3 className="font-semibold text-base flex items-center gap-2 border-b border-border pb-2">
                  <Clock className="h-4 w-4 text-amber-500" />
                  بانتظار الموافقة
                  <Badge variant="secondary" className="mr-auto">{pending.length}</Badge>
                </h3>
                <ul className="space-y-2">
                  {pending.map((u) => (
                    <li key={u.id} className="flex items-center gap-3 p-3 bg-amber-50/60 border border-amber-200 rounded-lg">
                      <div className="h-9 w-9 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center shrink-0 font-bold text-amber-700">
                        {(u.displayName ?? u.username)[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm">{u.displayName ?? u.username}</p>
                        <p className="text-xs text-muted-foreground" dir="ltr">{u.username}</p>
                      </div>
                      <span className={`text-xs font-bold px-2 py-1 rounded-full border shrink-0 ${getRoleBadgeClass(u.role)}`}>
                        {getRoleLabel(u.role)}
                      </span>
                      <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white gap-1 shrink-0"
                        onClick={() => patchMutation.mutate({ id: u.id, updates: { isApproved: true } })}
                        disabled={patchMutation.isPending}>
                        <CheckCircle className="h-3.5 w-3.5" /> موافقة
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-red-600 hover:bg-red-50 shrink-0"
                        onClick={() => { if (confirm(`حذف حساب ${u.displayName ?? u.username}؟`)) deleteMutation.mutate(u.id); }}>
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Active */}
            <div className="space-y-3">
              <h3 className="font-semibold text-base flex items-center gap-2 border-b border-border pb-2">
                <Shield className="h-4 w-4 text-sidebar-primary" />
                أعضاء الفريق النشطون
                <Badge variant="secondary" className="mr-auto">{approved.length}</Badge>
              </h3>
              <p className="text-xs text-muted-foreground -mt-1">اضغط على أي عضو لتعديل بياناته</p>
              {approved.length === 0 ? (
                <p className="text-muted-foreground text-center py-6 text-sm">لا يوجد أعضاء نشطون بعد</p>
              ) : (
                <div className="space-y-2">
                  {approved.map((u) => (
                    <UserRow
                      key={u.id}
                      u={u}
                      onUpdate={(id, updates) => patchMutation.mutate({ id, updates })}
                      onDelete={(id, name) => {
                        if (confirm(`هل تريد إزالة ${name} من النظام؟`)) deleteMutation.mutate(id);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Reciters Section ──────────────────────────────────────────────────────────
export function RecitersSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: reciters, isLoading } = useListReciters({}, { query: { queryKey: getListRecitersQueryKey() } });
  const createReciter = useCreateReciter();
  const deleteReciter = useDeleteReciter();
  const updateReciter = useUpdateReciter();

  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editMosque, setEditMosque] = useState<"nabawi" | "haram">("nabawi");
  const [selectedReciterIds, setSelectedReciterIds] = useState<Set<number>>(new Set());
  const [bulkReciterPending, setBulkReciterPending] = useState(false);

  const toggleReciterSel = (id: number) => setSelectedReciterIds((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const clearReciterSel = () => setSelectedReciterIds(new Set());

  const handleBulkDeleteReciters = async () => {
    if (!confirm(`حذف ${selectedReciterIds.size} قارئ؟`)) return;
    setBulkReciterPending(true);
    try {
      await Promise.all([...selectedReciterIds].map((id) =>
        fetch(`/api/reciters/${id}`, { method: "DELETE", credentials: "include" })
      ));
      queryClient.invalidateQueries({ queryKey: getListRecitersQueryKey() });
      clearReciterSel();
      toast({ title: `تم حذف ${selectedReciterIds.size} قارئ` });
    } finally { setBulkReciterPending(false); }
  };

  const form = useForm<z.infer<typeof reciterSchema>>({
    resolver: zodResolver(reciterSchema),
    defaultValues: { name: "", mosque: "nabawi" },
  });

  const onSubmit = (data: z.infer<typeof reciterSchema>) => {
    createReciter.mutate({ data: { name: data.name, mosque: data.mosque } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRecitersQueryKey() });
        toast({ title: "تم إضافة القارئ بنجاح" });
        form.reset({ name: "", mosque: "nabawi" });
      },
      onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
    });
  };

  const startEdit = (r: { id: number; name: string; mosque: string }) => {
    setEditId(r.id);
    setEditName(r.name);
    setEditMosque(r.mosque as "nabawi" | "haram");
  };

  const saveEdit = (id: number) => {
    updateReciter.mutate({ id, data: { name: editName.trim(), mosque: editMosque } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRecitersQueryKey() });
        toast({ title: "تم تحديث القارئ" });
        setEditId(null);
      },
      onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number) => {
    if (confirm("هل أنت متأكد من حذف هذا القارئ؟")) {
      deleteReciter.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRecitersQueryKey() });
          toast({ title: "تم حذف القارئ" });
        },
      });
    }
  };

  const nabawi = reciters?.filter((r) => r.mosque === "nabawi") ?? [];
  const haram = reciters?.filter((r) => r.mosque === "haram") ?? [];

  const ReciterItem = ({ r }: { r: { id: number; name: string; mosque: string } }) => {
    const isEditing = editId === r.id;
    return (
      <li className="border border-border rounded-md overflow-hidden">
        {isEditing ? (
          <div className="flex flex-col gap-2 p-3 bg-sidebar-primary/5">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="اسم القارئ" className="h-8 text-sm" />
            <Select value={editMosque} onValueChange={(v) => setEditMosque(v as "nabawi" | "haram")}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="nabawi">🕌 المسجد النبوي</SelectItem>
                <SelectItem value="haram">🕋 المسجد الحرام</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 h-8 bg-sidebar-primary text-sidebar-primary-foreground" onClick={() => saveEdit(r.id)} disabled={updateReciter.isPending}>
                {updateReciter.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3 ml-1" />} حفظ
              </Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setEditId(null)}>إلغاء</Button>
            </div>
          </div>
        ) : (
          <div className={`flex items-center justify-between p-3 transition-colors ${selectedReciterIds.has(r.id) ? "bg-sidebar-primary/5" : "bg-background hover:bg-muted/10"}`}>
            <div className="flex items-center gap-3">
              <Checkbox checked={selectedReciterIds.has(r.id)} onCheckedChange={() => toggleReciterSel(r.id)} onClick={(e: React.MouseEvent) => e.stopPropagation()} />
              <MicVocal className={`h-4 w-4 ${r.mosque === "nabawi" ? "text-emerald-600" : "text-amber-600"}`} />
              <span className="font-semibold">{r.name}</span>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-blue-600 hover:bg-blue-50" onClick={() => startEdit(r)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(r.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="bg-sidebar/5 border-b border-border/50 pb-6">
        <CardTitle className="flex items-center gap-2">
          <MicVocal className="h-5 w-5 text-sidebar-primary" />
          إدارة القراء
        </CardTitle>
        <CardDescription className="text-base mt-2">إضافة وتعديل وحذف القراء</CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 bg-muted/20 p-4 rounded-lg border border-border/50">
            <h3 className="font-semibold mb-2">إضافة قارئ جديد</h3>
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>اسم القارئ</FormLabel>
                  <FormControl><Input placeholder="مثال: عبدالرحمن السديس" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="mosque" render={({ field }) => (
                <FormItem>
                  <FormLabel>المسجد</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent dir="rtl">
                      <SelectItem value="nabawi">🕌 المسجد النبوي</SelectItem>
                      <SelectItem value="haram">🕋 المسجد الحرام</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <Button type="submit" className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground" disabled={createReciter.isPending}>
              {createReciter.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}
              إضافة قارئ
            </Button>
          </form>
        </Form>

        {isLoading ? <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
          : reciters?.length === 0 ? <p className="text-muted-foreground text-center py-4">لا يوجد قراء مضافون بعد</p>
          : (
            <div className="space-y-4">
              {selectedReciterIds.size > 0 && (
                <div className="flex items-center gap-2 bg-sidebar-primary/10 border border-sidebar-primary/20 rounded-lg px-3 py-2">
                  <span className="text-sm font-semibold text-sidebar-primary flex-1">{selectedReciterIds.size} قارئ محدد</span>
                  <Button size="sm" variant="destructive" className="h-7 gap-1" onClick={handleBulkDeleteReciters} disabled={bulkReciterPending}>
                    {bulkReciterPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    حذف المحدد
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={clearReciterSel}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              {nabawi.length > 0 && (
                <div>
                  <h3 className="font-bold mb-2 flex items-center gap-2">🕌 المسجد النبوي <span className="text-xs text-muted-foreground font-normal">({nabawi.length})</span></h3>
                  <ul className="space-y-2">{nabawi.map((r) => <ReciterItem key={r.id} r={r} />)}</ul>
                </div>
              )}
              {haram.length > 0 && (
                <div>
                  <h3 className="font-bold mb-2 flex items-center gap-2">🕋 المسجد الحرام <span className="text-xs text-muted-foreground font-normal">({haram.length})</span></h3>
                  <ul className="space-y-2">{haram.map((r) => <ReciterItem key={r.id} r={r} />)}</ul>
                </div>
              )}
            </div>
          )}
      </CardContent>
    </Card>
  );
}

// ── Platform Item (with pages management) ────────────────────────────────────
function PlatformItem({ p, reciters, selected, onToggleSelect }: {
  p: { id: number; name: string; icon: string; color: string; isMain: boolean };
  reciters: { id: number; name: string; mosque: string }[] | undefined;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updatePlatform = useUpdatePlatform();
  const deletePlatform = useDeletePlatform();
  const createPage = useCreatePlatformPage();
  const deletePage = useDeletePlatformPage();

  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState(p.name);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [newPageUrl, setNewPageUrl] = useState("");
  const [newPageReciterId, setNewPageReciterId] = useState<number | null>(null);
  const [editingPageId, setEditingPageId] = useState<number | null>(null);
  const [editPageUrl, setEditPageUrl] = useState("");
  const [editPageReciterId, setEditPageReciterId] = useState<number | null>(null);
  const [savingPage, setSavingPage] = useState(false);
  const [manageMembersPageId, setManageMembersPageId] = useState<number | null>(null);
  const [pageAssignedMembers, setPageAssignedMembers] = useState<number[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);

  const { data: pages } = useListPlatformPages(p.id, { query: { queryKey: getListPlatformPagesQueryKey(p.id), enabled: pagesOpen } });
  const { data: allMembers } = useListMembers({ query: { queryKey: getListMembersQueryKey(), enabled: pagesOpen } });

  const openManageMembers = async (pageId: number) => {
    setManageMembersPageId(pageId);
    const r = await fetch(`/api/platforms/${p.id}/pages/${pageId}/members`, { credentials: "include" });
    const ids: number[] = await r.json();
    setPageAssignedMembers(ids);
  };

  const togglePageMember = (memberId: number) => {
    setPageAssignedMembers((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    );
  };

  const savePageMembers = async () => {
    if (!manageMembersPageId) return;
    setSavingMembers(true);
    try {
      await fetch(`/api/platforms/${p.id}/pages/${manageMembersPageId}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ memberIds: pageAssignedMembers }),
      });
      queryClient.invalidateQueries({ queryKey: ["page-members", manageMembersPageId] });
      setManageMembersPageId(null);
      toast({ title: "تم حفظ الأعضاء المسندين" });
    } catch {
      toast({ title: "حدث خطأ", variant: "destructive" });
    } finally {
      setSavingMembers(false);
    }
  };

  const saveEdit = () => {
    updatePlatform.mutate({ id: p.id, data: { name: editName.trim(), icon: p.icon, color: p.color } }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListPlatformsQueryKey() }); toast({ title: "تم التحديث" }); setEditMode(false); },
      onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
    });
  };

  const toggleMain = () => {
    updatePlatform.mutate({ id: p.id, data: { name: p.name, icon: p.icon, color: p.color, isMain: !p.isMain } }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListPlatformsQueryKey() }); },
    });
  };

  const handleDelete = () => {
    if (confirm(`حذف منصة "${p.name}"؟`)) {
      deletePlatform.mutate({ id: p.id }, {
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListPlatformsQueryKey() }); toast({ title: "تم الحذف" }); },
      });
    }
  };

  const addPage = () => {
    if (!newPageReciterId && !newPageUrl.trim()) return;
    createPage.mutate({ platformId: p.id, data: { reciterId: newPageReciterId, pageUrl: newPageUrl.trim() || undefined } as any }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPlatformPagesQueryKey(p.id) });
        setNewPageUrl("");
        setNewPageReciterId(null);
        toast({ title: "تمت إضافة الصفحة" });
      },
      onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
    });
  };

  const removePage = (pageId: number) => {
    deletePage.mutate({ platformId: p.id, id: pageId }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListPlatformPagesQueryKey(p.id) }); },
    });
  };

  const startEditPage = (pg: { id: number; reciterId?: number | null; pageUrl?: string | null }) => {
    setEditingPageId(pg.id);
    setEditPageUrl((pg as any).pageUrl ?? "");
    setEditPageReciterId(pg.reciterId ?? null);
  };

  const savePageEdit = async () => {
    if (!editingPageId) return;
    setSavingPage(true);
    try {
      await fetch(`/api/platforms/${p.id}/pages/${editingPageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reciterId: editPageReciterId, pageUrl: editPageUrl.trim() || null }),
      });
      queryClient.invalidateQueries({ queryKey: getListPlatformPagesQueryKey(p.id) });
      setEditingPageId(null);
      toast({ title: "تم التحديث" });
    } catch {
      toast({ title: "حدث خطأ", variant: "destructive" });
    } finally {
      setSavingPage(false);
    }
  };

  return (
    <li className="border border-border rounded-md overflow-hidden">
      {editMode ? (
        <div className="flex items-center gap-2 p-2.5 bg-sidebar-primary/5">
          <PlatformIcon name={p.name} className="h-5 w-5 shrink-0 opacity-50" />
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="اسم المنصة" className="h-8 text-sm flex-1" autoFocus />
          <Button size="sm" className="h-8 bg-sidebar-primary text-sidebar-primary-foreground px-3" onClick={saveEdit} disabled={updatePlatform.isPending || !editName.trim()}>
            {updatePlatform.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          </Button>
          <Button size="sm" variant="outline" className="h-8 px-3" onClick={() => { setEditMode(false); setEditName(p.name); }}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <div className={`flex items-center justify-between p-3 transition-colors ${selected ? "bg-sidebar-primary/5" : "bg-background hover:bg-muted/10"}`}>
          <div className="flex items-center gap-2">
            {onToggleSelect && (
              <Checkbox checked={selected ?? false} onCheckedChange={onToggleSelect} onClick={(e: React.MouseEvent) => e.stopPropagation()} />
            )}
            <PlatformIcon name={p.name} className="h-5 w-5" />
            <span className="font-bold">{p.name}</span>
            {p.isMain && <span className="text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5">رئيسية</span>}
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className={`h-8 w-8 ${p.isMain ? "text-amber-500 hover:bg-amber-50" : "text-muted-foreground hover:text-amber-500 hover:bg-amber-50"}`}
              title={p.isMain ? "إلغاء كمنصة رئيسية" : "تعيين كمنصة رئيسية"} onClick={toggleMain}>
              <Star className={`h-3.5 w-3.5 ${p.isMain ? "fill-amber-400" : ""}`} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-violet-600 hover:bg-violet-50"
              title="إدارة الصفحات" onClick={() => setPagesOpen((o) => !o)}>
              <Layers className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-blue-600 hover:bg-blue-50"
              onClick={() => { setEditMode(true); setEditName(p.name); }}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Pages sub-section */}
      {pagesOpen && (
        <div className="border-t border-border bg-muted/10 p-3 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            <Layers className="h-3 w-3" /> صفحات {p.name}
          </p>
          {pages && pages.length > 0 ? (
            <ul className="space-y-1">
              {pages.map((pg) => {
                const reciter = reciters?.find((r) => r.id === pg.reciterId);
                const isEditing = editingPageId === pg.id;
                return (
                  <li key={pg.id} className="bg-background border border-border/50 rounded overflow-hidden">
                    {isEditing ? (
                      <div className="p-2 space-y-2 bg-sidebar-primary/5">
                        <div className="flex gap-2">
                          <Input value={editPageUrl} onChange={(e) => setEditPageUrl(e.target.value)} placeholder="رابط الصفحة" dir="ltr" className="h-7 text-xs flex-1" />
                          <Button size="sm" className="h-7 px-2 bg-sidebar-primary text-sidebar-primary-foreground text-xs" onClick={savePageEdit} disabled={savingPage}>
                            {savingPage ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setEditingPageId(null)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                        {reciters && reciters.length > 0 && (
                          <Select value={editPageReciterId?.toString() ?? "none"} onValueChange={(v) => setEditPageReciterId(v === "none" ? null : parseInt(v))}>
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue placeholder="القارئ" />
                            </SelectTrigger>
                            <SelectContent dir="rtl" className="max-h-48 overflow-y-auto">
                              <SelectItem value="none"><span className="text-muted-foreground text-xs">بدون قارئ</span></SelectItem>
                              {reciters.map((r) => (
                                <SelectItem key={r.id} value={r.id.toString()}>
                                  <span className="text-xs flex items-center gap-1"><MicVocal className="h-3 w-3" />{r.name}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    ) : manageMembersPageId === pg.id ? (
                      <div className="p-2 space-y-2 bg-green-50/50 border-t border-green-100">
                        <p className="text-xs font-semibold text-green-800 flex items-center gap-1">
                          <Users className="h-3 w-3" /> اختر الأعضاء المسؤولين عن هذه الصفحة
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {allMembers?.map((m) => {
                            const isSelected = pageAssignedMembers.includes(m.id);
                            return (
                              <button key={m.id} type="button" onClick={() => togglePageMember(m.id)}
                                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${isSelected ? "bg-sidebar-primary text-sidebar-primary-foreground border-sidebar-primary" : "bg-muted text-muted-foreground border-border hover:border-sidebar-primary/50"}`}>
                                {m.name}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" className="h-7 px-2 bg-sidebar-primary text-sidebar-primary-foreground text-xs" onClick={savePageMembers} disabled={savingMembers}>
                            {savingMembers ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                            <span className="mr-1">حفظ</span>
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setManageMembersPageId(null)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium">{reciter?.name ?? pg.name}</span>
                          {(pg as any).pageUrl && (
                            <a href={(pg as any).pageUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline truncate max-w-[200px]">
                              {(pg as any).pageUrl}
                            </a>
                          )}
                        </div>
                        <div className="flex gap-0.5 shrink-0">
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-green-600 hover:bg-green-50"
                            title="إسناد أعضاء للصفحة"
                            onClick={() => openManageMembers(pg.id)}>
                            <Users className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-blue-600 hover:bg-blue-50"
                            onClick={() => startEditPage(pg)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-red-500 hover:bg-red-50"
                            onClick={() => removePage(pg.id)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">لا توجد صفحات بعد</p>
          )}
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input value={newPageUrl} onChange={(e) => setNewPageUrl(e.target.value)} placeholder="رابط الصفحة (اختياري)" dir="ltr" className="h-8 text-sm flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") addPage(); }} />
              <Button size="sm" className="h-8 bg-sidebar-primary text-sidebar-primary-foreground px-3" onClick={addPage} disabled={createPage.isPending || (!newPageReciterId && !newPageUrl.trim())}>
                {createPage.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              </Button>
            </div>
            {reciters && reciters.length > 0 && (
              <Select value={newPageReciterId?.toString() ?? "none"} onValueChange={(v) => setNewPageReciterId(v === "none" ? null : parseInt(v))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="قارئ الصفحة (اختياري)" />
                </SelectTrigger>
                <SelectContent dir="rtl" className="max-h-48 overflow-y-auto">
                  <SelectItem value="none"><span className="text-muted-foreground text-xs">بدون قارئ</span></SelectItem>
                  {reciters.map((r) => (
                    <SelectItem key={r.id} value={r.id.toString()}>
                      <span className="text-xs flex items-center gap-1">
                        <MicVocal className="h-3 w-3" />{r.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ── Platforms Section ─────────────────────────────────────────────────────────
export function PlatformsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: platforms, isLoading } = useListPlatforms({ query: { queryKey: getListPlatformsQueryKey() } });
  const createPlatform = useCreatePlatform();
  const [selectedPlatformIds, setSelectedPlatformIds] = useState<Set<number>>(new Set());
  const [bulkPlatformPending, setBulkPlatformPending] = useState(false);

  const togglePlatformSel = (id: number) => setSelectedPlatformIds((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const clearPlatformSel = () => setSelectedPlatformIds(new Set());

  const handleBulkDeletePlatforms = async () => {
    if (!confirm(`حذف ${selectedPlatformIds.size} منصة؟`)) return;
    setBulkPlatformPending(true);
    try {
      await Promise.all([...selectedPlatformIds].map((id) =>
        fetch(`/api/platforms/${id}`, { method: "DELETE", credentials: "include" })
      ));
      queryClient.invalidateQueries({ queryKey: getListPlatformsQueryKey() });
      clearPlatformSel();
      toast({ title: `تم حذف ${selectedPlatformIds.size} منصة` });
    } finally { setBulkPlatformPending(false); }
  };

  const form = useForm<z.infer<typeof platformSchema>>({
    resolver: zodResolver(platformSchema),
    defaultValues: { name: "", icon: "FaYoutube", color: "#ff0000" },
  });

  const onSubmit = (data: z.infer<typeof platformSchema>) => {
    createPlatform.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPlatformsQueryKey() });
        toast({ title: "تم إضافة المنصة بنجاح" });
        form.reset();
      },
      onError: () => toast({ title: "حدث خطأ", variant: "destructive" }),
    });
  };

  const { data: reciters } = useListReciters({}, { query: { queryKey: getListRecitersQueryKey() } });
  const main = platforms?.filter((p) => p.isMain) ?? [];
  const sub = platforms?.filter((p) => !p.isMain) ?? [];

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="bg-sidebar/5 border-b border-border/50 pb-6">
        <CardTitle className="flex items-center gap-2"><SettingsIcon className="h-5 w-5 text-sidebar-primary" />إدارة المنصات</CardTitle>
        <CardDescription className="text-base mt-2">إضافة منصات النشر وتصنيفها (رئيسية / فرعية) وإدارة صفحاتها</CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 bg-muted/20 p-4 rounded-lg border border-border/50">
            <h3 className="font-semibold mb-2">إضافة منصة جديدة</h3>
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>اسم المنصة</FormLabel><FormControl><Input placeholder="مثال: يوتيوب" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <Button type="submit" className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground" disabled={createPlatform.isPending}>
              {createPlatform.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}إضافة منصة
            </Button>
          </form>
        </Form>
        <div className="space-y-4">
          {isLoading ? (
            <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
          ) : platforms?.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">لا توجد منصات</p>
          ) : (
            <>
              {selectedPlatformIds.size > 0 && (
                <div className="flex items-center gap-2 bg-sidebar-primary/10 border border-sidebar-primary/20 rounded-lg px-3 py-2">
                  <span className="text-sm font-semibold text-sidebar-primary flex-1">{selectedPlatformIds.size} منصة محددة</span>
                  <Button size="sm" variant="destructive" className="h-7 gap-1" onClick={handleBulkDeletePlatforms} disabled={bulkPlatformPending}>
                    {bulkPlatformPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    حذف المحدد
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={clearPlatformSel}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              {main.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-semibold text-sm flex items-center gap-2 border-b border-border pb-1.5">
                    <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" /> المنصات الرئيسية
                  </h3>
                  <ul className="space-y-2">{main.map((p) => <PlatformItem key={p.id} p={p} reciters={reciters} selected={selectedPlatformIds.has(p.id)} onToggleSelect={() => togglePlatformSel(p.id)} />)}</ul>
                </div>
              )}
              {sub.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-semibold text-sm flex items-center gap-2 border-b border-border pb-1.5">
                    <Layers className="h-3.5 w-3.5 text-muted-foreground" /> منصات أخرى
                  </h3>
                  <ul className="space-y-2">{sub.map((p) => <PlatformItem key={p.id} p={p} reciters={reciters} selected={selectedPlatformIds.has(p.id)} onToggleSelect={() => togglePlatformSel(p.id)} />)}</ul>
                </div>
              )}
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          ⭐ اضغط على النجمة لتصنيف المنصة كرئيسية · <Layers className="inline h-3 w-3" /> اضغط لإدارة صفحاتها
        </p>
      </CardContent>
    </Card>
  );
}

function TelegramToggleRow({ title, description, checked, onChange }: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-background px-4 py-3">
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function TelegramSettingsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [publicSummaryDate, setPublicSummaryDate] = useState(() => riyadhDateInputValue());

  const { data, isLoading } = useQuery({
    queryKey: ["telegram-settings"],
    queryFn: fetchTelegramSettings,
  });
  const { data: logs } = useQuery({
    queryKey: ["telegram-logs"],
    queryFn: fetchTelegramLogs,
  });

  const saveMutation = useMutation({
    mutationFn: patchTelegramSettings,
    onSuccess: () => {
      toast({ title: "تم حفظ إعدادات Telegram" });
      queryClient.invalidateQueries({ queryKey: ["telegram-settings"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const linkMutation = useMutation({
    mutationFn: () => createTelegramLinkToken(user?.id),
    onSuccess: (result) => {
      setLinkToken(result.token);
      toast({ title: "تم إنشاء رمز الربط" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const runMutation = useMutation({
    mutationFn: runTelegramDueCheck,
    onSuccess: (result) => {
      toast({ title: `تم تشغيل الفحص — أُرسل ${result.sent ?? 0}` });
      queryClient.invalidateQueries({ queryKey: ["telegram-logs"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: () => sendTelegramTest(user?.id),
    onSuccess: () => {
      toast({ title: "تم إرسال رسالة اختبار" });
      queryClient.invalidateQueries({ queryKey: ["telegram-logs"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const publicSummaryMutation = useMutation({
    mutationFn: () => sendTelegramPublicSummaryNow(publicSummaryDate),
    onSuccess: (result) => {
      if ((result.publications ?? 0) === 0) {
        toast({ title: "لا توجد منشورات مكتملة لها شاهد في التاريخ المحدد" });
      } else {
        toast({ title: `تم إرسال ملخص النشر — ${result.publications} منشور` });
      }
      queryClient.invalidateQueries({ queryKey: ["telegram-logs"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const settings = data?.settings;

  return (
    <Card className="border-border/50 shadow-sm lg:col-span-2">
      <CardHeader className="bg-sidebar/5 border-b border-border/50 pb-6">
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-sidebar-primary" />
          إعدادات إشعارات Telegram
        </CardTitle>
        <CardDescription className="text-base mt-2">
          التحكم في تذكيرات المهام والتنبيهات وسجل الإرسال، مع منع التكرار تلقائيًا
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        {isLoading || !settings ? (
          <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-sidebar-primary" /></div>
        ) : (
          <>
            {!data.botConfigured && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                لم يتم ضبط متغير <span dir="ltr" className="font-mono">TELEGRAM_BOT_TOKEN</span> في الخادم بعد. يمكن حفظ الإعدادات الآن، لكن الإرسال الفعلي يحتاج ضبط التوكن في Railway.
              </div>
            )}

            <TelegramToggleRow
              title="تفعيل إشعارات Telegram"
              description="إيقافه يمنع كل رسائل Telegram دون التأثير على إشعارات الموقع الداخلية."
              checked={settings.enabled}
              onChange={(enabled) => saveMutation.mutate({ enabled })}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-semibold">وقت تذكير الأعضاء</label>
                <Input
                  type="time"
                  dir="ltr"
                  defaultValue={settings.dailyReminderTime}
                  onBlur={(e) => saveMutation.mutate({ dailyReminderTime: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">وقت ملخص المدير</label>
                <Input
                  type="time"
                  dir="ltr"
                  defaultValue={settings.dailySummaryTime}
                  onBlur={(e) => saveMutation.mutate({ dailySummaryTime: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">وقت ملخص النشر</label>
                <Input
                  type="time"
                  dir="ltr"
                  defaultValue={settings.dailyPublicSummaryTime}
                  onBlur={(e) => saveMutation.mutate({ dailyPublicSummaryTime: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">اعتبار المهمة متأخرة بعد</label>
                <Input
                  type="time"
                  dir="ltr"
                  defaultValue={settings.overdueAfterTime}
                  onBlur={(e) => saveMutation.mutate({ overdueAfterTime: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">منع التكرار بالساعات</label>
                <Input
                  type="number"
                  min={1}
                  max={168}
                  dir="ltr"
                  defaultValue={settings.suppressRepeatHours}
                  onBlur={(e) => saveMutation.mutate({ suppressRepeatHours: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TelegramToggleRow
                title="تذكير يومي للأعضاء"
                description="يرسل لكل عضو ملخص مهامه اليوم: المكتملة وغير المكتملة."
                checked={settings.notifyDailyReminder}
                onChange={(notifyDailyReminder) => saveMutation.mutate({ notifyDailyReminder })}
              />
              <TelegramToggleRow
                title="تنبيه العضو عند التأخير"
                description="يرسل للعضو إذا أصبحت مهمة مسندة له متأخرة."
                checked={settings.notifyMemberOverdue}
                onChange={(notifyMemberOverdue) => saveMutation.mutate({ notifyMemberOverdue })}
              />
              <TelegramToggleRow
                title="تنبيه المدير عند تأخر عضو"
                description="يرسل للمديرين عند وجود مهمة متأخرة على عضو."
                checked={settings.notifyAdminOverdue}
                onChange={(notifyAdminOverdue) => saveMutation.mutate({ notifyAdminOverdue })}
              />
              <TelegramToggleRow
                title="تنبيه المدير عند إكمال مهمة"
                description="يرسل مرة واحدة فقط عند انتقال المهمة إلى مكتملة."
                checked={settings.notifyAdminCompleted}
                onChange={(notifyAdminCompleted) => saveMutation.mutate({ notifyAdminCompleted })}
              />
              <TelegramToggleRow
                title="ملخص يومي للمدير"
                description="يعرض المنجز والمتأخر وغير المكتمل في اليوم."
                checked={settings.notifyAdminDailySummary}
                onChange={(notifyAdminDailySummary) => saveMutation.mutate({ notifyAdminDailySummary })}
              />
              <TelegramToggleRow
                title="ملخص منشورات اليوم للنشر"
                description="يرسل للمدير منشورات اليوم المكتملة التي لها شاهد، بدون أسماء الأعضاء أو المتأخرات."
                checked={settings.notifyDailyPublicSummary}
                onChange={(notifyDailyPublicSummary) => saveMutation.mutate({ notifyDailyPublicSummary })}
              />
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/10 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-bold">إرسال ملخص منشورات اليوم يدويًا</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  اختر التاريخ ثم أرسل منشوراته المكتملة التي لها شاهد، بدون التأثير على الإرسال التلقائي.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="date"
                  dir="ltr"
                  value={publicSummaryDate}
                  onChange={(e) => setPublicSummaryDate(e.target.value)}
                  className="w-full sm:w-44"
                />
                <Button
                  variant="outline"
                  onClick={() => publicSummaryMutation.mutate()}
                  disabled={publicSummaryMutation.isPending || !publicSummaryDate}
                  className="shrink-0"
                >
                  {publicSummaryMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Send className="h-4 w-4 ml-2" />}
                  إرسال الملخص الآن
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
              <h3 className="font-bold flex items-center gap-2">
                <Link2 className="h-4 w-4 text-sidebar-primary" />
                ربط حسابي في Telegram
              </h3>
              <p className="text-sm text-muted-foreground">
                أنشئ رمز ربط، ثم أرسل للبوت في Telegram: <span dir="ltr" className="font-mono">/start الرمز</span>. الرمز صالح لمدة 30 دقيقة.
              </p>
              {linkToken && (
                <div className="rounded-lg bg-background border border-border px-3 py-2 font-mono text-sm text-left" dir="ltr">
                  /start {linkToken}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => linkMutation.mutate()} disabled={linkMutation.isPending}>
                  {linkMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Link2 className="h-4 w-4 ml-2" />}
                  إنشاء رمز ربط
                </Button>
                <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
                  {testMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Send className="h-4 w-4 ml-2" />}
                  إرسال اختبار لي
                </Button>
                <Button variant="outline" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
                  {runMutation.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <RefreshCw className="h-4 w-4 ml-2" />}
                  تشغيل الفحص الآن
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border/60 bg-background p-4">
                <h3 className="font-bold mb-3">الحسابات المرتبطة</h3>
                {data.recipients.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا يوجد ربط Telegram بعد.</p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {data.recipients.map((recipient) => (
                      <div key={recipient.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2 text-sm">
                        <span>{recipient.displayName ?? recipient.memberName ?? recipient.username ?? "مستخدم"}</span>
                        <Badge variant={recipient.isEnabled ? "default" : "secondary"}>
                          {recipient.isEnabled ? "مفعل" : "متوقف"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border/60 bg-background p-4">
                <h3 className="font-bold mb-3">آخر سجل إرسال</h3>
                {!logs || logs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا توجد رسائل مرسلة بعد.</p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-auto">
                    {logs.slice(0, 10).map((log) => (
                      <div key={log.id} className="rounded-lg border border-border/50 px-3 py-2 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{log.type}</span>
                          <Badge variant={log.status === "success" ? "default" : log.status === "failed" ? "destructive" : "secondary"}>
                            {log.status === "success" ? "نجح" : log.status === "failed" ? "فشل" : "قيد الإرسال"}
                          </Badge>
                        </div>
                        {log.failureReason && <p className="text-red-600">{log.failureReason}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────
export default function Settings() {
  const isAdmin = useIsAdmin();
  const { user } = useAuth();
  const perms = user?.permissions ?? null;
  const canManageAccounts = isAdmin || (perms?.canManageAccounts ?? false);
  const canManageReciters = isAdmin || (perms?.canManageReciters ?? false);
  const canManagePlatforms = isAdmin || (perms?.canManagePlatforms ?? false);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">الإعدادات</h2>
        <p className="text-muted-foreground mt-2 text-lg">إدارة الفريق والمنصات والقراء والصلاحيات</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {isAdmin && <TelegramSettingsSection />}
        {canManageAccounts && <UserManagementSection />}
        {canManageReciters && <RecitersSection />}
        {canManagePlatforms && <PlatformsSection />}
      </div>
    </div>
  );
}
