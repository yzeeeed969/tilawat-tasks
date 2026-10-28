import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// جداول «جدول المؤذنين» — جديدة كليًا (إضافة فقط). لا يقرأها ولا يعدّلها أي جزء قائم من النظام.
let ensured = false;
let ensurePromise: Promise<void> | null = null;

// القائمة الأولية كما وردت في الجداول الأسبوعية الرسمية (بلا أرقام — يضيفها المدير من الصفحة).
const INITIAL_MUEZZINS = [
  "عبدالله باعفيف", "تركي الحسني", "أحمد نحاس", "محمد باسعد", "حسين شحات", "علي ملا", "أحمد بصنوي",
  "سعيد فلاته", "د. ماجد العباس", "أحمد خوجة", "توفيق خوج", "هاشم السقاف", "محمد شاكر", "حمد دغريري",
  "سهيل حافظ", "أ.د. عصام خان", "محمد العمري", "نايف فيده", "سامي ريس", "عماد بقري", "محمد المغربي",
];

async function runMuezzinSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS muezzins (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      phone text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS muezzin_schedule_batches (
      id serial PRIMARY KEY,
      week_start text NOT NULL,
      entries integer NOT NULL DEFAULT 0,
      source_title text,
      created_by_user_id integer,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS muezzin_schedule (
      id serial PRIMARY KEY,
      date_key text NOT NULL,
      slot text NOT NULL,
      muezzin_id integer NOT NULL REFERENCES muezzins(id) ON DELETE RESTRICT,
      batch_id integer REFERENCES muezzin_schedule_batches(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  // الدور: مؤذن أو ملازم (إضافة فقط — الصفوف القائمة تصبح «مؤذن»).
  await db.execute(sql`ALTER TABLE muezzin_schedule ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'muezzin'`);
  // الفهرس الفريد صار (اليوم، الصلاة، الدور) بدل (اليوم، الصلاة) ليتسع للملازم.
  await db.execute(sql`DROP INDEX IF EXISTS uq_muezzin_schedule_slot`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_muezzin_schedule_slot_role ON muezzin_schedule(date_key, slot, role)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS muezzin_send_log (
      id serial PRIMARY KEY,
      date_key text NOT NULL,
      muezzin_id integer REFERENCES muezzins(id) ON DELETE SET NULL,
      muezzin_name text NOT NULL,
      phone text,
      test_mode boolean NOT NULL,
      ok boolean NOT NULL,
      detail text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_muezzin_send_log_date ON muezzin_send_log(date_key)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS muezzin_settings (
      id integer PRIMARY KEY DEFAULT 1,
      send_hour integer NOT NULL DEFAULT 21,
      test_mode boolean NOT NULL DEFAULT true,
      test_phone text,
      auto_send_enabled boolean NOT NULL DEFAULT false,
      last_auto_run_date text,
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT muezzin_settings_single_row CHECK (id = 1)
    )
  `);
  await db.execute(sql`INSERT INTO muezzin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // بذرة لمرة واحدة: فقط إن كانت القائمة فارغة تمامًا.
  const existing = await db.execute(sql`SELECT count(*)::int AS n FROM muezzins`);
  const rows: any[] = Array.isArray(existing) ? existing : ((existing as any)?.rows ?? []);
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) {
    for (const name of INITIAL_MUEZZINS) {
      await db.execute(sql`INSERT INTO muezzins (name) VALUES (${name}) ON CONFLICT (name) DO NOTHING`);
    }
  }
}

export async function ensureMuezzinSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runMuezzinSchemaEnsure()
      .then(() => {
        ensured = true;
      })
      .finally(() => {
        ensurePromise = null;
      });
  }
  await ensurePromise;
}
