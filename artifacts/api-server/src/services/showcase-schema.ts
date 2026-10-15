import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// قيم صفحة «منصات المشروع» المُدارة يدويًا (لا مصدر آلي لها): روابط المتاجر لكل تطبيق، وعدد المتابعين
// لحسابات بلا واجهة مجانية (تويتر/X، أو قناة تلقرام خاصة). أعمدة إضافية فارغة افتراضيًا، تُقرأ وتُكتب
// باستعلامات مباشرة فقط (ليست في مخطط Drizzle) فلا يتأثر أي استعلام قائم على المنصات أو الصفحات.
async function runEnsure() {
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS ios_url text`);
  await db.execute(sql`ALTER TABLE platforms ADD COLUMN IF NOT EXISTS android_url text`);
  await db.execute(sql`ALTER TABLE platform_pages ADD COLUMN IF NOT EXISTS manual_followers integer`);
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
