import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { ensureAdminLinkedMember } from "../lib/user-member";

declare global {
  namespace Express {
    interface Request {
      session: {
        userId?: number;
        save(callback?: (err?: Error) => void): void;
        destroy(callback?: () => void): void;
      };
    }
  }
}

async function getSessionUser(req: Request) {
  if (!req.session?.userId) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId))
    .limit(1);
  return user ? ensureAdminLinkedMember(user) : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!user.isApproved) {
    res.status(403).json({ error: "PENDING_APPROVAL" });
    return;
  }
  (req as any).currentUser = user;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await getSessionUser(req);
  if (!user || !user.isApproved) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Forbidden — admin only" });
    return;
  }
  (req as any).currentUser = user;
  next();
}

/** «جدول المؤذنين»: المدير، أو من مُنح صلاحية «إدارة جدول المؤذنين» (canManageMuezzins). */
export async function requireMuezzinAccess(req: Request, res: Response, next: NextFunction) {
  const user = await getSessionUser(req);
  if (!user || !user.isApproved) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const perms = (user as any).permissions;
  const allowed = user.role === "admin" || (perms && typeof perms === "object" && perms.canManageMuezzins === true);
  if (!allowed) {
    res.status(403).json({ error: "Forbidden — muezzin schedule access required" });
    return;
  }
  (req as any).currentUser = user;
  next();
}

export async function requireEditorOrAbove(req: Request, res: Response, next: NextFunction) {
  const user = await getSessionUser(req);
  if (!user || !user.isApproved) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role === "viewer") {
    res.status(403).json({ error: "Forbidden — editor or above required" });
    return;
  }
  (req as any).currentUser = user;
  next();
}
