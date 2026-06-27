import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, personalRemindersTable } from "@workspace/db";
import { ensurePersonalRemindersSchema } from "../services/personal-reminders-schema";

const router = Router();
const RIYADH_OFFSET_HOURS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function parseTimeOfDay(value: unknown) {
  if (typeof value !== "string") return null;
  const time = value.trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time) ? time : null;
}

function parseWeekdays(value: unknown) {
  if (!Array.isArray(value)) return null;
  const weekdays = [...new Set(value.map((day) => Number(day)))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  return weekdays.length > 0 ? weekdays : null;
}

function riyadhParts(now = new Date()) {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

function riyadhLocalToUtc(year: number, month: number, day: number, hours = 0, minutes = 0) {
  return new Date(Date.UTC(year, month - 1, day, hours - RIYADH_OFFSET_HOURS, minutes, 0, 0));
}

function nextWeeklyReminderDate(weekdays: number[], timeOfDay: string, now = new Date()) {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const parts = riyadhParts(now);
  for (let offset = 0; offset <= 7; offset += 1) {
    const targetWeekday = (parts.weekday + offset) % 7;
    if (!weekdays.includes(targetWeekday)) continue;
    const candidate = riyadhLocalToUtc(parts.year, parts.month, parts.day + offset, hours, minutes);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(now.getTime() + DAY_MS);
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
  const type = req.body?.type === "weekly_tasks" ? "weekly_tasks" : "custom";
  const message = parseReminderMessage(req.body?.message);

  if (type === "weekly_tasks") {
    const weekdays = parseWeekdays(req.body?.weekdays);
    const timeOfDay = parseTimeOfDay(req.body?.timeOfDay);
    if (!message) {
      res.status(400).json({ error: "message must be between 3 and 500 characters" });
      return;
    }
    if (!weekdays) {
      res.status(400).json({ error: "weekdays must include at least one valid weekday" });
      return;
    }
    if (!timeOfDay) {
      res.status(400).json({ error: "timeOfDay must be HH:mm" });
      return;
    }

    const [reminder] = await db
      .insert(personalRemindersTable)
      .values({
        userId: user.id,
        message,
        remindAt: nextWeeklyReminderDate(weekdays, timeOfDay),
        timezone: "Asia/Riyadh",
        type,
        weekdays: JSON.stringify(weekdays),
        timeOfDay,
        status: "active",
      })
      .returning();

    res.status(201).json(reminder);
    return;
  }

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
      type,
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
