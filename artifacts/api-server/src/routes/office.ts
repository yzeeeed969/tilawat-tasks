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

// تصنيف الأعضاء في المكتب (قرار المدير 2026-11-25): القسم (رجال/نساء) وإخفاء من ليس تحت إدارته (فريق جدول المؤذنين).
let seatingReady: Promise<void> | null = null;
function ensureSeating() {
  if (!seatingReady) {
    seatingReady = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS office_seating (member_id integer PRIMARY KEY, gender text, hidden boolean NOT NULL DEFAULT false, updated_at timestamp NOT NULL DEFAULT now())`);
    })().catch((e) => { seatingReady = null; throw e; });
  }
  return seatingReady;
}

router.get("/office/seating", requireAdmin, async (_req, res) => {
  await ensureSeating();
  res.json(rowsOf(await db.execute(sql`SELECT s.member_id, m.name, s.gender, s.hidden FROM office_seating s JOIN members m ON m.id = s.member_id ORDER BY s.member_id`)));
});
// جسم الطلب: { items: [{ memberId, gender: "m"|"f"|null, hidden: boolean }] }
router.post("/office/seating", requireAdmin, async (req, res) => {
  await ensureSeating();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  for (const it of items) {
    const id = Number(it?.memberId);
    if (!Number.isFinite(id)) continue;
    const gender = it.gender === "m" || it.gender === "f" ? it.gender : null;
    await db.execute(sql`
      INSERT INTO office_seating (member_id, gender, hidden) VALUES (${id}, ${gender}, ${Boolean(it.hidden)})
      ON CONFLICT (member_id) DO UPDATE SET gender = EXCLUDED.gender, hidden = EXCLUDED.hidden, updated_at = now()`);
  }
  res.json({ ok: true, count: items.length });
});

export async function officeData(period: string) {
  const p = periodOf(period);
  await ensureSeating();
  const members = rowsOf(await db.execute(sql`
    SELECT m.id, m.name, m.role, m.avatar_url, m.last_login_at, s.gender
    FROM members m LEFT JOIN office_seating s ON s.member_id = m.id
    WHERE m.is_active = true AND COALESCE(s.hidden, false) = false ORDER BY m.id`));
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
      id: Number(m.id), name: String(m.name), role: String(m.role ?? ""), gender: m.gender ?? null, avatarUrl: m.avatar_url ?? null, lastLoginAt: m.last_login_at ?? null,
      doneCount: done.length, doneToday, openCount: open.length, overdueCount: overdue.length,
      light: doneToday > 0 ? "green" : overdue.length > 0 ? "yellow" : "grey",
      open: open.slice(0, 25).map(item), done: done.slice(0, 25).map(item),
    };
  });
  // ── مكتب المدير ──
  const [mgr] = rowsOf(await db.execute(sql`
    SELECT m.id, m.name, m.avatar_url FROM app_users u JOIN members m ON m.id = u.member_id WHERE u.role = 'admin' ORDER BY u.id LIMIT 1`));
  // آخر إنجاز لكل عضو (آخر 60 يومًا) — لتنبيه «لم يعمل منذ أيام».
  const lastDone = rowsOf(await db.execute(sql`
    SELECT x.mid, to_char(max((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh'), 'YYYY-MM-DD') AS last_day
    FROM tasks t, unnest(array_append(ARRAY(SELECT tm.member_id FROM task_members tm WHERE tm.task_id = t.id), t.member_id)) AS x(mid)
    WHERE t.deleted_at IS NULL AND t.status = 'completed' AND t.completed_at > now() - interval '60 days'
    GROUP BY x.mid`));
  const lastMap = new Map(lastDone.map((r) => [Number(r.mid), String(r.last_day)]));
  // نفس الفترة السابقة (الأسبوع أو الشهر الماضي) للمقارنة.
  const prevStart = p.kind === "month" ? (() => { const d = new Date(`${p.start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })() : addDays(p.start, -7);
  // حتى نفس اليوم من الفترة السابقة، لتكون المقارنة عادلة.
  const elapsed = Math.round((Date.parse(`${p.today}T00:00:00Z`) - Date.parse(`${p.start}T00:00:00Z`)) / 86400000) + 1;
  const prevCut = addDays(prevStart, elapsed);
  const visibleIds = `{${out.map((m) => m.id).join(",")}}`; // مصفوفة Postgres نصية
  const [prev] = rowsOf(await db.execute(sql`
    SELECT count(*)::int AS n FROM tasks t
    WHERE t.deleted_at IS NULL AND t.status = 'completed'
      AND to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') >= ${prevStart}
      AND to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') < ${prevCut}
      AND (t.member_id = ANY(${visibleIds}::int[]) OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.member_id = ANY(${visibleIds}::int[])))`));
  const [cur] = rowsOf(await db.execute(sql`
    SELECT count(*)::int AS n FROM tasks t
    WHERE t.deleted_at IS NULL AND t.status = 'completed'
      AND to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') >= ${p.start}
      AND to_char((t.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') < ${p.end}
      AND (t.member_id = ANY(${visibleIds}::int[]) OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.member_id = ANY(${visibleIds}::int[])))`));
  const daysSince = (day: string | undefined) => day ? Math.round((Date.parse(`${p.today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000) : null;
  const manager = mgr ? {
    id: Number(mgr.id), name: String(mgr.name), avatarUrl: mgr.avatar_url ?? null,
    overdue: out.filter((m) => m.overdueCount > 0).sort((a, b) => b.overdueCount - a.overdueCount).map((m) => ({ id: m.id, name: m.name, count: m.overdueCount })),
    idle: out.map((m) => ({ id: m.id, name: m.name, days: daysSince(lastMap.get(m.id)) }))
      .filter((x) => x.days === null || x.days >= 3).sort((a, b) => (b.days ?? 999) - (a.days ?? 999)),
    stars: [...out].filter((m) => m.doneCount > 0).sort((a, b) => b.doneCount - a.doneCount).slice(0, 3).map((m) => ({ id: m.id, name: m.name, count: m.doneCount })),
    compare: { current: Number(cur?.n ?? 0), previous: Number(prev?.n ?? 0), days: elapsed },
  } : null;
  return { period: p, members: out, manager };
}

export default router;
