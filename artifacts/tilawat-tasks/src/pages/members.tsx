import { useState, useRef, useEffect } from "react";
import { useGetMemberStats, getGetMemberStatsQueryKey, useDeleteMember, getListMembersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import {
  Users, Trash2, UserPlus, Loader2, Eye, EyeOff, Download, Upload,
  Phone, Lock, SnowflakeIcon, Flame, CheckCircle, XCircle,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getRoleLabel, type UserRole } from "@/lib/roles";
import * as XLSX from "xlsx";

const ROLES: UserRole[] = ["admin", "editor"];
const MEMBER_ROLES = ["مشرف", "مصمم", "مقطع", "نشر", "تواصل", "مراجع", "عضو"];

const AVATAR_COLORS = [
  "bg-violet-500", "bg-blue-500", "bg-emerald-500", "bg-amber-500",
  "bg-rose-500", "bg-cyan-500", "bg-indigo-500", "bg-orange-500",
];

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xfffff;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

interface AdminUser {
  id: number;
  memberId: number | null;
  isFrozen: boolean;
  lastLoginAt: string | null;
}

export default function Members() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: memberStats, isLoading } = useGetMemberStats({ query: { queryKey: getGetMemberStatsQueryKey() } });

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    username: "",
    password: "",
    displayName: "",
    memberRole: "عضو",
    role: "editor" as UserRole,
  });

  // Admin users map: memberId -> AdminUser
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [freezePending, setFreezePending] = useState<number | null>(null);

  // Change password dialog
  const [changePassDialog, setChangePassDialog] = useState<{ userId: number; name: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [showNewPass, setShowNewPass] = useState(false);
  const [changingPass, setChangingPass] = useState(false);

  const fetchAdminUsers = async () => {
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setAdminUsers(data);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchAdminUsers(); }, []);

  // Map memberId -> AdminUser
  const adminUserMap = adminUsers.reduce<Record<number, AdminUser>>((acc, u) => {
    if (u.memberId) acc[u.memberId] = u;
    return acc;
  }, {});

  const deleteMember = useDeleteMember({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMemberStatsQueryKey() });
        toast({ title: "تم حذف العضو" });
      },
      onError: () => toast({ title: "حدث خطأ أثناء الحذف", variant: "destructive" }),
    },
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username.trim() || !form.password.trim() || !form.displayName.trim()) {
      toast({ title: "جميع الحقول مطلوبة", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "حدث خطأ");
      }
      toast({ title: "تم إنشاء الحساب بنجاح" });
      queryClient.invalidateQueries({ queryKey: getGetMemberStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
      setForm({ username: "", password: "", displayName: "", memberRole: "عضو", role: "editor" });
      setCreateOpen(false);
      fetchAdminUsers();
    } catch (err: unknown) {
      toast({ title: err instanceof Error ? err.message : "حدث خطأ", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const handleFreeze = async (memberId: number, isFrozen: boolean) => {
    const adminUser = adminUserMap[memberId];
    if (!adminUser) return;
    setFreezePending(memberId);
    try {
      const res = await fetch(`/api/admin/users/${adminUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isFrozen }),
      });
      if (!res.ok) throw new Error();
      toast({ title: isFrozen ? "تم تجميد الحساب" : "تم تفعيل الحساب" });
      fetchAdminUsers();
    } catch {
      toast({ title: "حدث خطأ", variant: "destructive" });
    } finally {
      setFreezePending(null);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changePassDialog || newPassword.length < 4) {
      toast({ title: "كلمة المرور يجب أن تكون 4 أحرف على الأقل", variant: "destructive" });
      return;
    }
    setChangingPass(true);
    try {
      const res = await fetch(`/api/admin/users/${changePassDialog.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) throw new Error();
      toast({ title: "تم تغيير كلمة المرور بنجاح" });
      setChangePassDialog(null);
      setNewPassword("");
    } catch {
      toast({ title: "حدث خطأ", variant: "destructive" });
    } finally {
      setChangingPass(false);
    }
  };

  const handleExport = () => {
    if (!memberStats || memberStats.length === 0) {
      toast({ title: "لا توجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const rows = memberStats.map((s) => ({
      "الاسم": s.member.name,
      "المسمى الوظيفي": s.member.role || "",
      "الجوال": s.member.phone || "",
      "الحالة": s.member.isActive ? "نشط" : "غير نشط",
      "إجمالي المهام": s.totalTasks,
      "المهام المكتملة": s.completedTasks,
      "قيد التنفيذ": s.inProgressTasks,
      "معدل الإنجاز %": Math.round(s.completionRate),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "الأعضاء");
    XLSX.writeFile(wb, `أعضاء-تلاوة-الحرمين-${format(new Date(), "yyyy-MM-dd")}.xlsx`);
    toast({ title: "تم تصدير البيانات بنجاح" });
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });

      if (rows.length === 0) {
        toast({ title: "الملف فارغ", variant: "destructive" });
        return;
      }

      const roleMap: Record<string, UserRole> = {
        "مدير": "admin", "admin": "admin",
        "محرر": "editor", "editor": "editor",
        "متابع": "editor",
      };

      let created = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const row of rows) {
        const displayName = (row["الاسم الكامل"] || row["الاسم"] || "").trim();
        const username = (row["اسم المستخدم"] || row["رقم الجوال"] || "").trim();
        const password = String(row["كلمة المرور"] || row["كلمة السر"] || "").trim();
        const memberRole = (row["المسمى الوظيفي"] || row["الدور"] || "عضو").trim();
        const roleRaw = (row["الصلاحية"] || row["الدور الوظيفي"] || "editor").trim();
        const role: UserRole = roleMap[roleRaw] ?? "editor";

        if (!displayName || !username || !password) {
          failed++;
          errors.push(`سطر مجهول: ${JSON.stringify(row)}`);
          continue;
        }

        const res = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ displayName, username, password, memberRole, role }),
        });

        if (res.ok) {
          created++;
        } else {
          failed++;
          const body = await res.json().catch(() => ({}));
          errors.push(`${displayName}: ${body.error ?? "خطأ"}`);
        }
      }

      queryClient.invalidateQueries({ queryKey: getGetMemberStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });

      if (failed === 0) {
        toast({ title: `تم استيراد ${created} عضو بنجاح` });
      } else {
        toast({
          title: `تم استيراد ${created} عضو — فشل ${failed}`,
          description: errors.slice(0, 3).join(" | "),
          variant: "destructive",
        });
      }
      fetchAdminUsers();
    } catch {
      toast({ title: "خطأ في قراءة الملف", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">أعضاء الفريق</h2>
          <p className="text-muted-foreground mt-2 text-lg">إحصائيات الأداء لكل عضو في الفريق</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Excel Export */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            className="gap-1.5"
            disabled={isLoading || !memberStats?.length}
          >
            <Download className="h-4 w-4" />
            تصدير Excel
          </Button>

          {/* Excel Import */}
          <input
            ref={importRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleImport}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => importRef.current?.click()}
            disabled={importing}
            className="gap-1.5"
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            استيراد Excel
          </Button>

        </div>
      </div>

      {/* Import template hint */}
      <div className="bg-muted/40 border border-border/60 rounded-lg px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
        <Upload className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>
          <span className="font-semibold">نموذج الاستيراد:</span> الملف يجب أن يحتوي على الأعمدة التالية:
          <span className="font-mono mx-1 bg-background px-1 py-0.5 rounded border border-border/40">الاسم الكامل</span>
          <span className="font-mono mx-1 bg-background px-1 py-0.5 rounded border border-border/40">اسم المستخدم</span>
          <span className="font-mono mx-1 bg-background px-1 py-0.5 rounded border border-border/40">كلمة المرور</span>
          <span className="font-mono mx-1 bg-background px-1 py-0.5 rounded border border-border/40">المسمى الوظيفي</span>
          <span className="font-mono mx-1 bg-background px-1 py-0.5 rounded border border-border/40">الصلاحية</span>
          (مدير / محرر / متابع)
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {isLoading ? (
          [...Array(6)].map((_, i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)
        ) : memberStats?.length === 0 ? (
          <div className="col-span-full py-16 text-center text-muted-foreground bg-card border border-border rounded-xl flex flex-col items-center">
            <Users className="h-12 w-12 mb-4 text-muted-foreground/50" />
            <p className="text-xl font-medium">لا يوجد أعضاء في الفريق بعد</p>
          </div>
        ) : (
          memberStats?.map((stat) => {
            const adminUser = adminUserMap[stat.member.id];
            const isFrozen = adminUser?.isFrozen ?? false;
            const initials = getInitials(stat.member.name);
            const avatarBg = getAvatarColor(stat.member.name);

            return (
              <Card
                key={stat.member.id}
                className={`border-border/50 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col ${isFrozen ? "opacity-60 border-blue-200" : ""}`}
              >
                <div className={`h-2 w-full ${isFrozen ? "bg-blue-300" : "bg-sidebar-primary/20"}`} />
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      {/* Avatar + name */}
                      <div className="flex items-center gap-3">
                        {stat.member.avatarUrl ? (
                          <img
                            src={stat.member.avatarUrl}
                            alt={stat.member.name}
                            className="h-11 w-11 rounded-full object-cover border-2 border-border"
                          />
                        ) : (
                          <div className={`h-11 w-11 rounded-full ${avatarBg} flex items-center justify-center text-white font-bold text-sm shrink-0`}>
                            {initials}
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-lg font-bold text-foreground truncate">{stat.member.name}</p>
                          <p className="text-xs font-medium text-sidebar-primary">{stat.member.role}</p>
                        </div>
                      </div>
                      {/* Badges + actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        {/* isActive badge */}
                        <Badge
                          variant={stat.member.isActive ? "default" : "secondary"}
                          className={`text-[10px] px-1.5 py-0.5 ${stat.member.isActive ? "bg-green-100 text-green-700 border-green-200" : "bg-gray-100 text-gray-500"}`}
                        >
                          {stat.member.isActive ? (
                            <><CheckCircle className="h-2.5 w-2.5 ml-0.5" />نشط</>
                          ) : (
                            <><XCircle className="h-2.5 w-2.5 ml-0.5" />غير نشط</>
                          )}
                        </Badge>
                        {/* Frozen badge */}
                        {isFrozen && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 text-blue-600 border-blue-300 bg-blue-50">
                            <SnowflakeIcon className="h-2.5 w-2.5 ml-0.5" />مجمّد
                          </Badge>
                        )}
                        {/* Delete */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-red-600 hover:bg-red-50"
                          onClick={() => {
                            if (confirm(`هل تريد حذف العضو "${stat.member.name}"؟`)) {
                              deleteMember.mutate({ id: stat.member.id });
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Phone */}
                    {stat.member.phone && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3 shrink-0" />
                        <span dir="ltr">{stat.member.phone}</span>
                      </div>
                    )}
                  </CardTitle>

                  {/* Last login */}
                  <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                    <div>انضم في {format(new Date(stat.member.createdAt), "dd MMMM yyyy", { locale: ar })}</div>
                    {stat.member.lastLoginAt && (
                      <div>آخر دخول: {format(new Date(stat.member.lastLoginAt), "dd MMM yyyy، h:mm a", { locale: ar })}</div>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="flex-1 flex flex-col justify-end space-y-4 pt-0">
                  <div className="grid grid-cols-3 gap-2 text-center divide-x divide-x-reverse divide-border">
                    <div>
                      <div className="text-2xl font-bold text-foreground">{stat.totalTasks}</div>
                      <div className="text-xs text-muted-foreground mt-1 font-medium">إجمالي</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-green-600">{stat.completedTasks}</div>
                      <div className="text-xs text-muted-foreground mt-1 font-medium">مكتمل</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-amber-500">{stat.inProgressTasks}</div>
                      <div className="text-xs text-muted-foreground mt-1 font-medium">قيد التنفيذ</div>
                    </div>
                  </div>

                  <div className="space-y-2 bg-muted/30 p-3 rounded-lg">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-semibold">معدل الإنجاز</span>
                      <span className="font-bold text-sidebar-primary">{Math.round(stat.completionRate)}%</span>
                    </div>
                    <Progress value={stat.completionRate} className="h-2" />
                  </div>

                  {/* Admin actions */}
                  {adminUser && (
                    <div className="flex gap-2 pt-1">
                      {/* Freeze / Unfreeze */}
                      <Button
                        variant="outline"
                        size="sm"
                        className={`flex-1 text-xs gap-1 ${isFrozen ? "text-orange-600 border-orange-300 hover:bg-orange-50" : "text-blue-600 border-blue-200 hover:bg-blue-50"}`}
                        disabled={freezePending === stat.member.id}
                        onClick={() => handleFreeze(stat.member.id, !isFrozen)}
                      >
                        {freezePending === stat.member.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : isFrozen ? (
                          <Flame className="h-3 w-3" />
                        ) : (
                          <SnowflakeIcon className="h-3 w-3" />
                        )}
                        {isFrozen ? "رفع التجميد" : "تجميد الحساب"}
                      </Button>

                      {/* Change password */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs gap-1 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setChangePassDialog({ userId: adminUser.id, name: stat.member.name });
                          setNewPassword("");
                          setShowNewPass(false);
                        }}
                      >
                        <Lock className="h-3 w-3" />
                        تغيير كلمة المرور
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Change Password Dialog */}
      <Dialog open={!!changePassDialog} onOpenChange={(o) => !o && setChangePassDialog(null)}>
        <DialogContent className="sm:max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-sidebar-primary" />
              تغيير كلمة مرور {changePassDialog?.name}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleChangePassword} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>كلمة المرور الجديدة</Label>
              <div className="relative">
                <Input
                  type={showNewPass ? "text" : "password"}
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  dir="ltr"
                  className="pl-10"
                  autoFocus
                  minLength={4}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPass((v) => !v)}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showNewPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">4 أحرف على الأقل</p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setChangePassDialog(null)}
              >
                إلغاء
              </Button>
              <Button
                type="submit"
                disabled={changingPass || newPassword.length < 4}
                className="flex-1 bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
              >
                {changingPass ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <Lock className="h-4 w-4 ml-2" />}
                حفظ
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
