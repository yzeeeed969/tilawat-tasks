import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// pg يُطلق حدث 'error' على العملاء الخاملين عندما تُسقط قاعدة البيانات الاتصال
// (انتهاء مهلة الخمول، إعادة ضبط SSL، تذبذب الشبكة — شائع مع القواعد البعيدة).
// بدون مستمع، يعتبر Node حدث 'error' استثناءً غير ملتقَط ويُنهي العملية.
// نُسجّله ونتجاهله؛ فالـ Pool يتخلّص من الاتصال الميت وينشئ اتصالًا جديدًا عند
// الاستعلام التالي، دون أي أثر على البيانات.
pool.on("error", (err) => {
  console.error("[db] خطأ في اتصال خامل (سقط الاتصال، سيُعاد الاتصال تلقائيًا):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
