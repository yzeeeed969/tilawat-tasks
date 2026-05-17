import { Router } from "express";
import { db, notificationsTable, tasksTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// GET /notifications?archive=true
router.get("/notifications", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  const archive = req.query.archive === "true";

  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, user.id),
        archive ? isNotNull(notificationsTable.deletedAt) : isNull(notificationsTable.deletedAt)
      )
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(100);

  res.json(notifications);
});

// POST /notifications/read-all
router.post("/notifications/read-all", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(
      and(
        eq(notificationsTable.userId, user.id),
        isNull(notificationsTable.deletedAt)
      )
    );
  res.json({ success: true });
});

// PATCH /notifications/:id — mark as read
router.patch("/notifications/:id", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  const id = Number(req.params.id);

  const [notification] = await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, user.id)))
    .returning();

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  res.json(notification);
});

// DELETE /notifications/:id — soft delete (archive)
router.delete("/notifications/:id", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;
  const id = Number(req.params.id);

  await db
    .update(notificationsTable)
    .set({ deletedAt: new Date(), isRead: true })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, user.id)));

  res.status(204).end();
});

// DELETE /notifications — delete all (archive all)
router.delete("/notifications", requireAuth, async (req, res) => {
  const user = (req as any).currentUser;

  await db
    .update(notificationsTable)
    .set({ deletedAt: new Date(), isRead: true })
    .where(
      and(
        eq(notificationsTable.userId, user.id),
        isNull(notificationsTable.deletedAt)
      )
    );

  res.status(204).end();
});

export default router;
