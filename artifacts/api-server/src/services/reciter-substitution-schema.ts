import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function columnExists(table: string, column: string) {
  const result: any = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : result?.rows ?? [];
  return rows.length > 0;
}

// إضافة فقط: أعمدة تقبل الفراغ (أو بقيمة افتراضية) وجداول جديدة. لا يُحذف ولا يُعاد كتابة أي صف قائم،
// باستثناء تعبئة لمرة واحدة لعلَم «يشمل كل القرّاء» لحظة إنشاء العمود لأول مرة (انظر أدناه).
async function runReciterSubstitutionSchemaEnsure() {
  const hadCoversAllColumn = await columnExists("platforms", "covers_all_reciters");
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS covers_all_reciters boolean NOT NULL DEFAULT false`);
  if (!hadCoversAllColumn) {
    // مرة واحدة فقط عند إنشاء العمود: منصة «تطبيق تلاوات الحرمين» تشمل كل القرّاء.
    // مطابقة صارمة للاسم (تلاوات + الحرمين معًا) — لا مطابقة لكلمة app. يمكن تعديله لاحقًا من الإعدادات.
    await db.execute(sql`
      UPDATE platforms SET covers_all_reciters = true
      WHERE name LIKE '%تلاوات%' AND name LIKE '%الحرمين%'
    `);
  }

  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS substitution_id integer`);
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS original_reciter_id integer`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reciter_substitutions (
      id serial PRIMARY KEY,
      base_task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
      from_reciter_id integer REFERENCES reciters(id) ON DELETE SET NULL,
      to_reciter_id integer REFERENCES reciters(id) ON DELETE SET NULL,
      scope_kind text NOT NULL,
      slots jsonb NOT NULL,
      status text NOT NULL DEFAULT 'applied',
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      undone_at timestamp,
      undone_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reciter_substitution_items (
      id serial PRIMARY KEY,
      substitution_id integer NOT NULL REFERENCES reciter_substitutions(id) ON DELETE CASCADE,
      task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      action text NOT NULL,
      before jsonb,
      after jsonb,
      undone_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_reciter_substitution_items_substitution ON reciter_substitution_items(substitution_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_reciter_substitution_items_task ON reciter_substitution_items(task_id)`);
}

export async function ensureReciterSubstitutionSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runReciterSubstitutionSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
