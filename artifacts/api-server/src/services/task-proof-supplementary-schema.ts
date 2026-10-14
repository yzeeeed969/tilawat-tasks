import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

// «شاهد تكميلي» (مثل رابط نسخة فيسبوك لمنشور إنستقرام): شاهد يظهر على المهمة لكنه لا يُحتسب في
// عدّاد «هدف أسبوعي بعدد مرات» ولا يغيّر الحالة. إضافة فقط: false افتراضيًا لكل الصفوف القائمة.
async function runEnsure() {
  await db.execute(sql`ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS is_supplementary boolean NOT NULL DEFAULT false`);
}

export async function ensureTaskProofSupplementarySchema() {
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
