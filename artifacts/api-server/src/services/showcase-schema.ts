import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// روابط المتاجر لكل تطبيق — الشيء اليدوي الوحيد في صفحة «منصات المشروع» (روابط ثابتة، ليست أرقامًا).
// أعمدة إضافية فارغة افتراضيًا، تُقرأ وتُكتب باستعلامات مباشرة فقط (ليست في مخطط Drizzle).
async function runEnsure() {
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ios_url text`);
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS android_url text`);
}

export async function ensureShowcaseSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
