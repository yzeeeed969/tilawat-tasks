import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// روابط المتاجر لكل تطبيق — الشيء اليدوي الوحيد في صفحة «منصات المشروع» (روابط ثابتة، ليست أرقامًا).
// أعمدة إضافية فارغة افتراضيًا، تُقرأ وتُكتب باستعلامات مباشرة فقط (ليست في مخطط Drizzle).
async function runEnsure() {
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ios_url text`);
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS android_url text`);
  // إخفاء صفحة من الصفحة العامة فقط (تبقى في النظام وصفحة المنصات) — قرار عرض، لا رقم.
  await db.execute(sql`ALTER TABLE platform_pages ADD COLUMN IF NOT EXISTS hide_from_showcase boolean NOT NULL DEFAULT false`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS app_one_time_migrations (
      name text PRIMARY KEY,
      ran_at timestamp NOT NULL DEFAULT now(),
      details jsonb
    )
  `);
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
