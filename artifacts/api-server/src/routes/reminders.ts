import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, personalRemindersTable } from "@workspace/db";
import { ensurePersonalRemindersSchema } from "../services/personal-reminders-schema";

const router = Router();

router.use(async (_req, _res, next) => {
  try {
    await ensurePersonalRemindersSchema();
    next();
  } catch (error) {
    next(error);
  }
});

function parseReminderMessage(value: unknown) {
  if (typeof value !== "string") return null;
  const message = value.trim();
  if (message.length < 3 || message.length > 500) return null;
  return message;
}

function parseFutureDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() <= Date.now()) return null;
  return date;
}

router.get("/reminders", async (req, res) => {
  const user = (req as any).currentUser;
  const reminders = await db
    .select()
    .from(personalRemindersTable)
    .where(eq(personalRemindersTable.userId, user.id))
    .orderBy(desc(personalRemindersTable.remindAt), desc(personalRemindersTable.createdAt))
    .limit(200);

  res.json(reminders);
});

router.post("/reminders", async (req, res) => {
  const user = (req as any).currentUser;
  const message = parseReminderMessage(req.body?.message);
  const remindAt = parseFutureDate(req.body?.remindAt);

  if (!message) {
    res.status(400).json({ error: "message must be between 3 and 500 characters" });
    return;
  }
  if (!remindAt) {
    res.status(400).json({ error: "remindAt must be a future date" });
    return;
  }

  const [reminder] = await db
    .insert(personalRemindersTable)
    .values({
      userId: user.id,
      message,
      remindAt,
      timezone: "Asia/Riyadh",
      status: "active",
    })
    .returning();

  res.status(201).json(reminder);
});

router.patch("/reminders/:id/cancel", async (req, res) => {
  const user = (req as any).currentUser;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid reminder id" });
    return;
  }

  const [reminder] = await db
    .update(personalRemindersTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(personalRemindersTable.id, id),
      eq(personalRemindersTable.userId, user.id),
      eq(personalRemindersTable.status, "active"),
    ))
    .returning();

  if (!reminder) {
    res.status(404).json({ error: "Reminder not found" });
    return;
  }

  res.json(reminder);
});

export default router;
