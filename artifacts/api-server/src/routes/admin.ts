import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, membersTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { sendWelcomeEmail } from "../services/email";

const router = Router();

// GET /api/me
router.get("/me", requireAuth, (req, res) => {
  const user = (req as any).currentUser;
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    role: user.role,
    isApproved: user.isApproved,
    permissions: user.permissions ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    isFrozen: user.isFrozen ?? false,
  });
});

// GET /api/admin/users
router.get("/admin/users", requireAdmin, async (_req, res) => {
  const users = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      displayName: usersTable.displayName,
      email: usersTable.email,
      role: usersTable.role,
      isApproved: usersTable.isApproved,
      isFrozen: usersTable.isFrozen,
      memberId: usersTable.memberId,
      permissions: usersTable.permissions,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(asc(usersTable.createdAt));

  const allMembers = await db.select().from(membersTable);
  const membersMap: Record<number, { name: string; role: string; phone: string | null; avatarUrl: string | null; isActive: boolean; lastLoginAt: Date | null }> = {};
  for (const m of allMembers) {
    membersMap[m.id] = {
      name: m.name,
      role: m.role,
      phone: m.phone ?? null,
      avatarUrl: m.avatarUrl ?? null,
      isActive: m.isActive,
      lastLoginAt: m.lastLoginAt ?? null,
    };
  }

  res.json(users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email ?? null,
    role: u.role,
    isApproved: u.isApproved,
    isFrozen: (u as any).isFrozen ?? false,
    memberId: u.memberId,
    createdAt: u.createdAt,
    lastLoginAt: (u as any).lastLoginAt ?? null,
    permissions: (u as any).permissions ?? null,
    memberName: u.memberId ? membersMap[u.memberId]?.name ?? null : null,
    memberRole: u.memberId ? membersMap[u.memberId]?.role ?? null : null,
    memberPhone: u.memberId ? membersMap[u.memberId]?.phone ?? null : null,
    memberAvatarUrl: u.memberId ? membersMap[u.memberId]?.avatarUrl ?? null : null,
    memberIsActive: u.memberId ? membersMap[u.memberId]?.isActive ?? true : true,
  })));
});

// POST /api/admin/users — create user and auto-link to members
router.post("/admin/users", requireAdmin, async (req, res) => {
  const { username, password, displayName, role, memberRole, permissions, email } = req.body as {
    username: string;
    password: string;
    displayName?: string;
    role?: string;
    memberRole?: string;
    permissions?: Record<string, boolean> | null;
    email?: string;
  };

  if (!username?.trim() || !password || password.length < 4) {
    res.status(400).json({ error: "اسم المستخدم وكلمة السر مطلوبان (4 أحرف على الأقل)" });
    return;
  }

  const validRole = ["admin", "editor"].includes(role ?? "") ? role! : "editor";
  const name = displayName?.trim() || username.trim();
  const cleanEmail = email?.trim().toLowerCase() || null;

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const [member] = await db
      .insert(membersTable)
      .values({ name, role: memberRole?.trim() || "" })
      .returning();

    const [user] = await db
      .insert(usersTable)
      .values({
        username: username.trim(),
        passwordHash,
        displayName: name,
        role: validRole,
        isApproved: false,
        memberId: member.id,
        permissions: permissions ?? null,
        email: cleanEmail,
      } as any)
      .returning();

    if (cleanEmail) {
      sendWelcomeEmail(cleanEmail, name, username.trim(), password).catch(() => {});
    }

    res.status(201).json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: (user as any).email ?? null,
      role: user.role,
      isApproved: user.isApproved,
      isFrozen: false,
      memberId: user.memberId,
      permissions: (user as any).permissions ?? null,
      memberName: member.name,
      memberRole: member.role,
    });
  } catch (_e: any) {
    if (_e?.code === "23505") {
      res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    } else {
      res.status(500).json({ error: "خطأ في إنشاء المستخدم" });
    }
  }
});

// PATCH /api/admin/users/:id
router.patch("/admin/users/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { isApproved, role, password, displayName, memberRole, permissions, isFrozen, phone, avatarUrl } = req.body as {
    isApproved?: boolean;
    isFrozen?: boolean;
    role?: string;
    password?: string;
    displayName?: string;
    memberRole?: string;
    permissions?: Record<string, boolean> | null;
    phone?: string;
    avatarUrl?: string;
  };

  const updates: Partial<any> = {};
  if (isApproved !== undefined) updates.isApproved = isApproved;
  if (isFrozen !== undefined) updates.isFrozen = isFrozen;
  if (role && ["admin", "editor"].includes(role)) updates.role = role;
  if (displayName?.trim()) updates.displayName = displayName.trim();
  if (password && password.length >= 4) {
    updates.passwordHash = await bcrypt.hash(password, 10);
  }
  if (permissions !== undefined) updates.permissions = permissions;

  if (Object.keys(updates).length === 0 && memberRole === undefined && phone === undefined && avatarUrl === undefined) {
    res.status(400).json({ error: "لا تحديثات صالحة" });
    return;
  }

  const [user] = Object.keys(updates).length > 0
    ? await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning()
    : await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);

  if (!user) {
    res.status(404).json({ error: "المستخدم غير موجود" });
    return;
  }

  // Also update linked member
  let memberName: string | null = null;
  let memberRoleVal: string | null = null;
  if (user.memberId) {
    const memberUpdates: Partial<typeof membersTable.$inferInsert> = {};
    if (displayName?.trim()) memberUpdates.name = displayName.trim();
    if (memberRole !== undefined) memberUpdates.role = memberRole;
    if (phone !== undefined) (memberUpdates as any).phone = phone;
    if (avatarUrl !== undefined) (memberUpdates as any).avatarUrl = avatarUrl;
    if (Object.keys(memberUpdates).length > 0) {
      const [member] = await db
        .update(membersTable)
        .set(memberUpdates)
        .where(eq(membersTable.id, user.memberId))
        .returning();
      memberName = member?.name ?? null;
      memberRoleVal = member?.role ?? null;
    } else {
      const [member] = await db.select().from(membersTable).where(eq(membersTable.id, user.memberId)).limit(1);
      memberName = member?.name ?? null;
      memberRoleVal = member?.role ?? null;
    }
  }

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isApproved: user.isApproved,
    isFrozen: (user as any).isFrozen ?? false,
    memberId: user.memberId,
    memberName,
    memberRole: memberRoleVal,
  });
});

// DELETE /api/admin/users/:id
router.delete("/admin/users/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const adminUser = (req as any).currentUser;

  if (adminUser.id === id) {
    res.status(400).json({ error: "لا يمكنك حذف حسابك الخاص" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);

  await db.delete(usersTable).where(eq(usersTable.id, id));

  if (user?.memberId) {
    await db.delete(membersTable).where(eq(membersTable.id, user.memberId));
  }

  res.json({ success: true });
});

export default router;
