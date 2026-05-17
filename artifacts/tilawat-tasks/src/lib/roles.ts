import { useAuth } from "./auth-context";
import type { UserPermissions } from "./auth-context";

export type { UserPermissions };
export type UserRole = "admin" | "editor";

export function useRole(): UserRole {
  const { user } = useAuth();
  return (user?.role as UserRole) ?? "editor";
}

export function useIsAdmin(): boolean {
  return useRole() === "admin";
}

export function useCanEdit(): boolean {
  return true;
}

function resolvePermissions(role: UserRole, custom?: UserPermissions | null): Required<UserPermissions> {
  const defaults: Record<UserRole, Required<UserPermissions>> = {
    admin: {
      canViewMembers: true, canViewReports: true, canCreateTasks: true,
      canEditTasks: true, canDeleteTasks: true, canManageSettings: true,
      canManageReciters: true, canManagePlatforms: true, canManageAccounts: true,
    },
    editor: {
      canViewMembers: false, canViewReports: false, canCreateTasks: false,
      canEditTasks: false, canDeleteTasks: false, canManageSettings: false,
      canManageReciters: false, canManagePlatforms: false, canManageAccounts: false,
    },
  };
  if (role === "admin") return defaults.admin;
  const base = defaults[role];
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

export function usePermissions(): Required<UserPermissions> {
  const { user } = useAuth();
  const role = (user?.role as UserRole) ?? "editor";
  return resolvePermissions(role, user?.permissions);
}

export function useCanViewMembers(): boolean { return usePermissions().canViewMembers; }
export function useCanViewReports(): boolean { return usePermissions().canViewReports; }
export function useCanCreateTasks(): boolean { return usePermissions().canCreateTasks; }
export function useCanEditTasks(): boolean { return usePermissions().canEditTasks; }
export function useCanManageSettings(): boolean { return usePermissions().canManageSettings; }
export function useCanManageReciters(): boolean { return usePermissions().canManageReciters; }
export function useCanManagePlatforms(): boolean { return usePermissions().canManagePlatforms; }
export function useCanManageAccounts(): boolean { return usePermissions().canManageAccounts; }

export function useCanAccessSettings(): boolean {
  const p = usePermissions();
  return p.canManageSettings || p.canManageReciters || p.canManagePlatforms || p.canManageAccounts;
}

export function getRoleLabel(role: string): string {
  if (role === "admin") return "مدير";
  return "محرر";
}

export function getRoleBadgeClass(role: string): string {
  if (role === "admin") return "bg-sidebar-primary/20 text-sidebar-primary border border-sidebar-primary/30";
  return "bg-amber-100 text-amber-700 border border-amber-200";
}
