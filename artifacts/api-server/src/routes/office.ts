// «المكتب» (الإصدار 89، قرار المدير 2026-11-25): عرض الأعضاء كموظفين على طاولات في مكتب مفتوح.
// للمدير فقط. لا تُرسل أرقام الجوال إطلاقًا. الفترة الافتراضية: هذا الأسبوع (يبدأ الأحد بتوقيت الرياض)، أو هذا الشهر.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

const router = Router();
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

function riyadhKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(key: string, n: number) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function periodOf(kind: string) {
  const today = riyadhKey();
  if (kind === "month") {
    const start = `${today.slice(0, 7)}-01`;
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return { kind: "month", start, end: d.toISOString().slice(0, 10), today };
  }
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // الأحد = 0
  const start = addDays(today, -dow);
  return { kind: "week", start, end: addDays(start, 7), today };
}

router.get("/office", requireAdmin, async (req, res) => {
  res.json(await officeData(String(req.query.period ?? "week")));
});

export async function officeData(period: string) {
  const p = periodOf(period);
  const members = rowsOf(await db.execute(sql`
    SELECT id, name, role, avatar_url, last_login_at FROM members WHERE is_active = true ORDER BY id`));
  // المهام المعنية: المنجزة في الفترة + غير المنجزة المستحقة حتى نهاية الفترة (المتأخرة: آخر 60 يومًا فقط).
  const tasks = rowsOf(await db.execute(sql`
    SELECT t.id, t.title, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due,
           to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') AS done_day,
           t.completed_at, pl.name AS platform, r.name AS reciter,
           COALESCE((SELECT tp.url FROM task_proofs tp WHERE tp.task_id = t.id AND tp.deleted_at IS NULL ORDER BY tp.is_supplementary, tp.id LIMIT 1), t.submission_url) AS proof,
           ARRAY(SELECT DISTINCT x FROM unnest(array_append(ARRAY(SELECT tm.member_id FROM task_members tm WHERE tm.task_id = t.id), t.member_id)) AS x) AS member_ids
    FROM tasks t
    LEFT JOIN platforms pl ON pl.id = t.platform_id
    LEFT JOIN reciters r ON r.id = t.reciter_id
    WHERE t.deleted_at IS NULL AND (
      (t.status = 'completed' AND to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') >= ${p.start}
                              AND to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') < ${p.end})
      OR (t.status <> 'completed' AND (t.due_date IS NULL OR (to_char(t.due_date, 'YYYY-MM-DD') < ${p.end} AND to_char(t.due_date, 'YYYY-MM-DD') >= ${addDays(p.today, -60)})))
    )`));

  const out = members.map((m) => {
    const mine = tasks.filter((t) => (t.member_ids as number[]).map(Number).includes(Number(m.id)));
    const done = mine.filter((t) => t.status === "completed").sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    const open = mine.filter((t) => t.status !== "completed").sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
    const overdue = open.filter((t) => t.due && t.due < p.today);
    const doneToday = done.filter((t) => t.done_day === p.today).length;
    const item = (t: any) => ({
      id: Number(t.id), title: String(t.title), due: t.due ?? null, doneAt: t.completed_at ?? null,
      platform: t.platform ?? null, reciter: t.reciter ?? null, proof: t.proof ?? null, shared: (t.member_ids as number[]).length > 1,
    });
    return {
      id: Number(m.id), name: String(m.name), role: String(m.role ?? ""), avatarUrl: m.avatar_url ?? null, lastLoginAt: m.last_login_at ?? null,
      doneCount: done.length, doneToday, openCount: open.length, overdueCount: overdue.length,
      light: doneToday > 0 ? "green" : overdue.length > 0 ? "yellow" : "grey",
      open: open.slice(0, 25).map(item), done: done.slice(0, 25).map(item),
    };
  });
  return { period: p, members: out };
}

export default router;
