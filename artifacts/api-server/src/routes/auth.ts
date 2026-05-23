import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable, membersTable, activityLogTable, resetTokensTable } from "@workspace/db/schema";
import { eq, count, and, gt } from "drizzle-orm";
import { sendPasswordResetEmail } from "../services/email";

function getAppDomain(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0].trim()}`;
  return `${req.protocol}://${req.get("host")}`;
}

const router = Router();

// GET /api/auth/me — returns current session user
router.get("/auth/me", async (req, res) => {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId))
    .limit(1);

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if ((user as any).isFrozen) {
    req.session.destroy(() => {});
    res.status(403).json({ error: "ACCOUNT_FROZEN" });
    return;
  }

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    email: user.email ?? null,
    role: user.role,
    isApproved: user.isApproved,
    memberId: user.memberId ?? null,
    permissions: (user as any).permissions ?? null,
    lastLoginAt: (user as any).lastLoginAt ?? null,
    createdAt: user.createdAt ?? null,
  });
});

// GET /api/auth/status — returns whether setup is needed
router.get("/auth/status", async (_req, res) => {
  const [{ value }] = await db.select({ value: count() }).from(usersTable);
  res.json({ needsSetup: Number(value) === 0 });
});

// POST /api/auth/setup — create first admin (only works when no users exist)
router.post("/auth/setup", async (req, res) => {
  const [{ value }] = await db.select({ value: count() }).from(usersTable);
  if (Number(value) > 0) {
    res.status(400).json({ error: "SETUP_ALREADY_DONE" });
    return;
  }

  const { username, password, displayName } = req.body as {
    username: string;
    password: string;
    displayName?: string;
  };

  if (!username?.trim() || !password || password.length < 6) {
    res.status(400).json({ error: "بيانات غير صالحة" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      username: username.trim(),
      passwordHash,
      displayName: displayName?.trim() || username.trim(),
      role: "admin",
      isApproved: true,
      lastLoginAt: new Date(),
    } as any)
    .returning();

  req.session.userId = user.id;
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "فشل حفظ جلسة الدخول" });
      return;
    }

    res.status(201).json({
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.username,
      role: user.role,
      isApproved: user.isApproved,
    });
  });
});

// POST /api/auth/login
router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body as { username: string; password: string };

  if (!username?.trim() || !password) {
    res.status(400).json({ error: "أدخل اسم المستخدم وكلمة السر" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username.trim()))
    .limit(1);

  if (!user) {
    res.status(401).json({ error: "اسم المستخدم أو كلمة السر غير صحيحة" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "اسم المستخدم أو كلمة السر غير صحيحة" });
    return;
  }

  if (!user.isApproved) {
    res.status(403).json({ error: "PENDING_APPROVAL" });
    return;
  }

  if ((user as any).isFrozen) {
    res.status(403).json({ error: "ACCOUNT_FROZEN" });
    return;
  }

  const now = new Date();

  req.session.userId = user.id;
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "فشل حفظ جلسة الدخول" });
      return;
    }

    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.username,
      email: user.email ?? null,
      role: user.role,
      isApproved: user.isApproved,
      memberId: user.memberId ?? null,
      permissions: (user as any).permissions ?? null,
      lastLoginAt: now,
      createdAt: user.createdAt ?? null,
    });
  });

  void (async () => {
    await db.update(usersTable).set({ lastLoginAt: now } as any).where(eq(usersTable.id, user.id));

    if (user.memberId) {
      await db.update(membersTable).set({ lastLoginAt: now }).where(eq(membersTable.id, user.memberId));
    }

    await db.insert(activityLogTable).values({
      userId: user.id,
      userName: user.displayName ?? user.username,
      action: "user_login",
      entityType: "user",
      entityId: user.id,
      entityName: user.displayName ?? user.username,
    });
  })().catch(() => {});
});

// POST /api/auth/forgot-password
router.post("/auth/forgot-password", async (req, res) => {
  const { email, username } = req.body as { email?: string; username?: string };
  if (!email && !username) {
    res.status(400).json({ error: "أدخل البريد الإلكتروني أو اسم المستخدم" });
    return;
  }

  let user: typeof usersTable.$inferSelect | undefined;
  if (email) {
    [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.trim().toLowerCase())).limit(1);
  } else if (username) {
    [user] = await db.select().from(usersTable).where(eq(usersTable.username, username.trim())).limit(1);
  }

  if (!user || !user.email) {
    res.json({ ok: true });
    return;
  }

  await db.delete(resetTokensTable).where(eq(resetTokensTable.userId, user.id));

  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(resetTokensTable).values({ userId: user.id, token, expiresAt, used: false });

  const basePath = process.env.BASE_PATH ?? "";
  const domain = getAppDomain(req);
  const resetLink = `${domain}${basePath}/reset-password?token=${token}`;
  await sendPasswordResetEmail(user.email, resetLink, user.displayName ?? user.username);

  res.json({ ok: true });
});

// POST /api/auth/reset-password
router.post("/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  if (!token || !newPassword || newPassword.length < 6) {
    res.status(400).json({ error: "بيانات غير صالحة — كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    return;
  }
  const now = new Date();
  const [resetToken] = await db
    .select()
    .from(resetTokensTable)
    .where(and(eq(resetTokensTable.token, token), eq(resetTokensTable.used, false), gt(resetTokensTable.expiresAt, now)))
    .limit(1);

  if (!resetToken) {
    res.status(400).json({ error: "الرابط غير صالح أو منتهي الصلاحية" });
    return;
  }
  await db.update(usersTable).set({ passwordHash: await bcrypt.hash(newPassword, 12) }).where(eq(usersTable.id, resetToken.userId));
  await db.update(resetTokensTable).set({ used: true }).where(eq(resetTokensTable.id, resetToken.id));
  res.json({ ok: true });
});

// PATCH /api/auth/change-email
router.patch("/auth/change-email", async (req, res) => {
  if (!req.session?.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { newEmail, currentPassword } = req.body as { newEmail: string; currentPassword: string };
  if (!newEmail?.trim() || !currentPassword) { res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" }); return; }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(newEmail.trim())) { res.status(400).json({ error: "البريد الإلكتروني غير صالح" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) { res.status(400).json({ error: "كلمة المرور غير صحيحة" }); return; }
  await db.update(usersTable).set({ email: newEmail.trim().toLowerCase() } as any).where(eq(usersTable.id, user.id));
  res.json({ ok: true, email: newEmail.trim().toLowerCase() });
});

// POST /api/auth/change-password
router.post("/auth/change-password", async (req, res) => {
  if (!req.session?.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  if (!currentPassword || !newPassword) { res.status(400).json({ error: "يجب توفير كلمة المرور الحالية والجديدة" }); return; }
  if (newPassword.length < 6) { res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) { res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" }); return; }
  const newHash = await bcrypt.hash(newPassword, 12);
  await db.update(usersTable).set({ passwordHash: newHash }).where(eq(usersTable.id, user.id));
  res.json({ ok: true });
});

// POST /api/auth/logout
router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sid");
    res.json({ success: true });
  });
});

export default router;
