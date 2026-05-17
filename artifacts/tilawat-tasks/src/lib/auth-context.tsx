import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export interface UserPermissions {
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

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  email?: string | null;
  role: "admin" | "editor";
  isApproved: boolean;
  memberId?: number | null;
  permissions?: UserPermissions | null;
  createdAt?: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  refetch: () => Promise<void>;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function fetchMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const refetch = useCallback(async () => {
    const me = await fetchMe();
    setUser(me);
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const login = useCallback(async (username: string, password: string): Promise<AuthUser> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "فشل تسجيل الدخول");
    setUser(data);
    return data;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoaded, isSignedIn: !!user, refetch, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
