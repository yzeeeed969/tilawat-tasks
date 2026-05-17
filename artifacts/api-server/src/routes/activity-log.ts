import { Router } from "express";
import { db, activityLogTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

// GET /activity-log (admin only)
router.get("/activity-log", requireAdmin, async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;

  const logs = await db
    .select()
    .from(activityLogTable)
    .orderBy(desc(activityLogTable.createdAt))
    .limit(Math.min(limit, 500));

  res.json(logs);
});

export default router;
