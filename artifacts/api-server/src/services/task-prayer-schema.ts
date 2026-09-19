import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTaskPrayerSchemaEnsure() {
  // إضافة فقط: عمود يقبل الفراغ بلا قيمة افتراضية، فلا تُعاد كتابة أي صف موجود.
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prayer text`);
}

export async function ensureTaskPrayerSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTaskPrayerSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
