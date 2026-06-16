import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

async function runTaskFlowLinksSchemaEnsure() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS task_flow_links (
      id serial PRIMARY KEY,
      parent_task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      child_task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
      source_page_id integer REFERENCES platform_pages(id) ON DELETE SET NULL,
      target_page_id integer NOT NULL REFERENCES platform_pages(id) ON DELETE CASCADE,
      target_platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
      flow_date timestamp NOT NULL,
      batch_key text NOT NULL,
      created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_flow_links_child_task ON task_flow_links(child_task_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_task_flow_links_parent_target_date
    ON task_flow_links(parent_task_id, target_page_id, flow_date)
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_flow_links_parent_task ON task_flow_links(parent_task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_task_flow_links_child_task ON task_flow_links(child_task_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reciter_task_flow_rules (
      id serial PRIMARY KEY,
      reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
      page_id integer NOT NULL REFERENCES platform_pages(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reciter_task_flow_rules_reciter_page_unique UNIQUE (reciter_id, page_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS reciter_task_flow_rules_reciter_idx ON reciter_task_flow_rules (reciter_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reciter_task_flow_rule_assignees (
      rule_id integer NOT NULL REFERENCES reciter_task_flow_rules(id) ON DELETE CASCADE,
      member_id integer NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (rule_id, member_id)
    )
  `);
}

export async function ensureTaskFlowLinksSchema() {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = runTaskFlowLinksSchemaEnsure().then(() => {
      ensured = true;
    }).finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
