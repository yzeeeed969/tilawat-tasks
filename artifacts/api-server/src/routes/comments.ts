import { Router } from "express";
import { db, commentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

// GET /tasks/:id/comments
router.get("/tasks/:id/comments", async (req, res) => {
  const taskId = Number(req.params.id);
  const rows = await db
    .select()
    .from(commentsTable)
    .where(eq(commentsTable.taskId, taskId))
    .orderBy(commentsTable.createdAt);
  res.json(rows);
});

// POST /tasks/:id/comments
router.post("/tasks/:id/comments", async (req, res) => {
  const taskId = Number(req.params.id);
  const { content, authorName, memberId } = req.body as {
    content: string;
    authorName: string;
    memberId?: number | null;
  };

  if (!content || !authorName) {
    res.status(400).json({ error: "content and authorName are required" });
    return;
  }

  const [comment] = await db
    .insert(commentsTable)
    .values({ taskId, content, authorName, memberId: memberId ?? null })
    .returning();

  res.status(201).json(comment);
});

// DELETE /tasks/:taskId/comments/:id
router.delete("/tasks/:taskId/comments/:id", async (req, res) => {
  const taskId = Number(req.params.taskId);
  const id = Number(req.params.id);
  await db
    .delete(commentsTable)
    .where(and(eq(commentsTable.id, id), eq(commentsTable.taskId, taskId)));
  res.status(204).send();
});

export default router;
