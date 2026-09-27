import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// تنظيف لمرة واحدة: قبل إصلاح الإيقاف، كان حذف «هذه وما بعدها» أو «السلسلة كاملة» يحذف المهام ويترك
// السلسلة «active»، فتعود للتولّد بعد أسابيع. هنا نوقف كل سلسلة تشغيلية نشطة آخرُ مهمة فيها (بالتاريخ)
// محذوفة — وهذا يشمل الحذف الكامل والحذف من نقطة. مهام حذفتها النيابة (substitution_id) لا تُحتسب،
// لأنها ليست حذفًا للسلسلة. يُسجَّل تنفيذه في جدول علامات فلا يتكرر أبدًا (حذف «هذه المهمة فقط» لاحقًا
// لآخر مهمة لن يوقف أي سلسلة).

const MIGRATION_NAME = "stop_deleted_task_series_v17";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

let completed = false;

export async function runStoppedSeriesBackfillOnce(): Promise<{ ran: boolean; stoppedSeries: Array<{ id: number; title: string }> }> {
  if (completed) return { ran: false, stoppedSeries: [] };
  const result = await runBackfill();
  completed = true;
  return result;
}

async function runBackfill(): Promise<{ ran: boolean; stoppedSeries: Array<{ id: number; title: string }> }> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS app_one_time_migrations (
      name text PRIMARY KEY,
      ran_at timestamp NOT NULL DEFAULT now(),
      details jsonb
    )
  `);
  // ضمان وجود القيمة في النوع (موجودة منذ البداية؛ آمن للتكرار). خارج أي معاملة.
  await db.execute(sql`ALTER TYPE task_series_status ADD VALUE IF NOT EXISTS 'stopped'`);

  const already = rowsOf<{ name: string }>(await db.execute(sql`SELECT name FROM app_one_time_migrations WHERE name = ${MIGRATION_NAME}`));
  if (already.length > 0) return { ran: false, stoppedSeries: [] };

  return db.transaction(async (tx: any) => {
    // قفل العلامة داخل المعاملة: إن أقلعت نسختان معًا تنفّذ واحدة فقط.
    const inserted = rowsOf<{ name: string }>(await tx.execute(sql`
      INSERT INTO app_one_time_migrations (name) VALUES (${MIGRATION_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `));
    if (inserted.length === 0) return { ran: false, stoppedSeries: [] };

    const stopped = rowsOf<{ id: number; title: string }>(await tx.execute(sql`
      UPDATE task_series s
      SET status = 'stopped', updated_at = now()
      WHERE s.status = 'active'
        AND s.series_type = 'operational'
        AND (
          SELECT t.deleted_at IS NOT NULL
          FROM tasks t
          WHERE t.series_id = s.id AND t.substitution_id IS NULL
          ORDER BY t.due_date DESC NULLS LAST, t.id DESC
          LIMIT 1
        ) = true
      RETURNING s.id, s.title
    `));

    await tx.execute(sql`
      UPDATE app_one_time_migrations
      SET details = ${JSON.stringify({ stoppedSeries: stopped })}::jsonb
      WHERE name = ${MIGRATION_NAME}
    `);
    if (stopped.length > 0) {
      await tx.execute(sql`
        INSERT INTO activity_log (user_name, action, entity_type, entity_name, meta)
        VALUES ('النظام', 'task_series_stopped_backfill', 'task_series', ${`إيقاف ${stopped.length} سلسلة محذوفة`}, ${JSON.stringify({ stoppedSeries: stopped })}::jsonb)
      `);
    }
    return { ran: true, stoppedSeries: stopped };
  });
}
