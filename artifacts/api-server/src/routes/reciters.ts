import { Router } from "express";
import { db, membersTable, pageMembersTable, platformPagesTable, platformsTable, reciterTaskFlowRuleAssigneesTable, reciterTaskFlowRulesTable, recitersTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  CreateReciterBody,
  GetReciterParams,
  DeleteReciterParams,
  UpdateReciterParams,
  UpdateReciterBody,
  ListRecitersQueryParams,
} from "@workspace/api-zod";

const router = Router();
let taskFlowRulesSchemaEnsured = false;
let taskFlowRulesSchemaEnsurePromise: Promise<void> | null = null;

async function ensureTaskFlowRulesSchema() {
  if (taskFlowRulesSchemaEnsured) return;
  if (!taskFlowRulesSchemaEnsurePromise) {
    taskFlowRulesSchemaEnsurePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS reciter_task_flow_rules (
        id serial PRIMARY KEY,
        reciter_id integer NOT NULL REFERENCES reciters(id) ON DELETE CASCADE,
        page_id integer NOT NULL REFERENCES platform_pages(id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT reciter_task_flow_rules_reciter_page_unique UNIQUE (reciter_id, page_id)
      )
    `)
      .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS reciter_task_flow_rules_reciter_idx ON reciter_task_flow_rules (reciter_id)`))
      .then(() => db.execute(sql`
        CREATE TABLE IF NOT EXISTS reciter_task_flow_rule_assignees (
          rule_id integer NOT NULL REFERENCES reciter_task_flow_rules(id) ON DELETE CASCADE,
          member_id integer NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          created_at timestamp NOT NULL DEFAULT now(),
          PRIMARY KEY (rule_id, member_id)
        )
      `))
      .then(() => {
        taskFlowRulesSchemaEnsured = true;
      })
      .finally(() => {
        taskFlowRulesSchemaEnsurePromise = null;
      });
  }
  await taskFlowRulesSchemaEnsurePromise;
}

router.get("/reciters", async (req, res) => {
  const query = ListRecitersQueryParams.parse({
    mosque: req.query.mosque,
  });

  if (query.mosque === "nabawi" || query.mosque === "haram") {
    const rows = await db
      .select()
      .from(recitersTable)
      .where(eq(recitersTable.mosque, query.mosque))
      .orderBy(recitersTable.name);
    res.json(rows);
    return;
  }

  const rows = await db
    .select()
    .from(recitersTable)
    .orderBy(recitersTable.mosque, recitersTable.name);
  res.json(rows);
});

router.post("/reciters", async (req, res) => {
  const body = CreateReciterBody.parse(req.body);
  const [reciter] = await db
    .insert(recitersTable)
    .values({ name: body.name, mosque: body.mosque as "nabawi" | "haram" })
    .returning();
  res.status(201).json(reciter);
});

router.get("/reciters/:id", async (req, res) => {
  const { id } = GetReciterParams.parse({ id: Number(req.params.id) });
  const [reciter] = await db
    .select()
    .from(recitersTable)
    .where(eq(recitersTable.id, id));
  if (!reciter) {
    res.status(404).json({ error: "Reciter not found" });
    return;
  }
  res.json(reciter);
});

router.get("/reciters/:id/task-flow-rules", async (req, res) => {
  await ensureTaskFlowRulesSchema();
  const { id } = GetReciterParams.parse({ id: Number(req.params.id) });
  const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, id));
  if (!reciter) {
    res.status(404).json({ error: "Reciter not found" });
    return;
  }

  const existingRules = await db
    .select()
    .from(reciterTaskFlowRulesTable)
    .where(eq(reciterTaskFlowRulesTable.reciterId, id));
  const ruleByPageId = new Map(existingRules.map((rule) => [rule.pageId, rule]));
  const ruleIds = existingRules.map((rule) => rule.id);
  const assigneeRows = ruleIds.length > 0
    ? await db
      .select({
        ruleId: reciterTaskFlowRuleAssigneesTable.ruleId,
        memberId: reciterTaskFlowRuleAssigneesTable.memberId,
      })
      .from(reciterTaskFlowRuleAssigneesTable)
      .where(inArray(reciterTaskFlowRuleAssigneesTable.ruleId, ruleIds))
    : [];
  const assigneeIdsByRuleId = new Map<number, number[]>();
  for (const row of assigneeRows) {
    if (!assigneeIdsByRuleId.has(row.ruleId)) assigneeIdsByRuleId.set(row.ruleId, []);
    assigneeIdsByRuleId.get(row.ruleId)!.push(row.memberId);
  }
  const pages = await db
    .select({
      pageId: platformPagesTable.id,
      pageName: platformPagesTable.name,
      pageUrl: platformPagesTable.pageUrl,
      reciterId: platformPagesTable.reciterId,
      platformId: platformsTable.id,
      platformName: platformsTable.name,
      platformIcon: platformsTable.icon,
      platformColor: platformsTable.color,
      platformIsMain: platformsTable.isMain,
    })
    .from(platformPagesTable)
    .innerJoin(platformsTable, eq(platformPagesTable.platformId, platformsTable.id))
    .where(eq(platformPagesTable.reciterId, id))
    .orderBy(platformsTable.name, platformPagesTable.name);
  const pageIds = pages.map((page) => page.pageId);
  const pageMemberRows = pageIds.length > 0
    ? await db
      .select({
        pageId: pageMembersTable.pageId,
        memberId: membersTable.id,
        memberName: membersTable.name,
      })
      .from(pageMembersTable)
      .innerJoin(membersTable, eq(pageMembersTable.memberId, membersTable.id))
      .where(inArray(pageMembersTable.pageId, pageIds))
    : [];
  const membersByPageId = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of pageMemberRows) {
    if (!membersByPageId.has(row.pageId)) membersByPageId.set(row.pageId, []);
    membersByPageId.get(row.pageId)!.push({ id: row.memberId, name: row.memberName });
  }

  res.json({
    reciter,
    configured: existingRules.length > 0,
    rules: pages.map((page) => {
      const rule = ruleByPageId.get(page.pageId);
      return {
        id: rule?.id ?? null,
        reciterId: id,
        pageId: page.pageId,
        enabled: rule?.enabled ?? false,
        defaultAssigneeIds: rule ? assigneeIdsByRuleId.get(rule.id) ?? [] : [],
        pageMembers: membersByPageId.get(page.pageId) ?? [],
        createdAt: rule?.createdAt ?? null,
        updatedAt: rule?.updatedAt ?? null,
        page: {
          id: page.pageId,
          name: page.pageName,
          reciterId: page.reciterId,
          pageUrl: page.pageUrl,
          platformId: page.platformId,
        },
        platform: {
          id: page.platformId,
          name: page.platformName,
          icon: page.platformIcon,
          color: page.platformColor,
          isMain: page.platformIsMain,
        },
      };
    }),
  });
});

router.put("/reciters/:id/task-flow-rules", async (req, res) => {
  await ensureTaskFlowRulesSchema();
  const { id } = GetReciterParams.parse({ id: Number(req.params.id) });
  const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, id));
  if (!reciter) {
    res.status(404).json({ error: "Reciter not found" });
    return;
  }

  const inputRules: Array<{ pageId?: unknown; enabled?: unknown; defaultAssigneeIds?: unknown }> = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const normalizedRules: Array<{ pageId: number; enabled: boolean; defaultAssigneeIds: number[] }> = inputRules
    .map((rule: { pageId?: unknown; enabled?: unknown; defaultAssigneeIds?: unknown }) => ({
      pageId: Number(rule.pageId),
      enabled: Boolean(rule.enabled),
      defaultAssigneeIds: Array.isArray(rule.defaultAssigneeIds)
        ? [...new Set(rule.defaultAssigneeIds.map((memberId) => Number(memberId)).filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0))]
        : [],
    }))
    .filter((rule) => Number.isSafeInteger(rule.pageId) && rule.pageId > 0);
  const pageIds: number[] = [...new Set(normalizedRules.map((rule) => rule.pageId))];
  const validPages = pageIds.length > 0
    ? await db
      .select({ id: platformPagesTable.id })
      .from(platformPagesTable)
      .where(and(eq(platformPagesTable.reciterId, id), inArray(platformPagesTable.id, pageIds)))
    : [];
  const validPageIds = new Set(validPages.map((page) => page.id));
  const allowedRows = pageIds.length > 0
    ? await db
      .select({ pageId: pageMembersTable.pageId, memberId: pageMembersTable.memberId })
      .from(pageMembersTable)
      .where(inArray(pageMembersTable.pageId, pageIds))
    : [];
  const allowedByPageId = new Map<number, Set<number>>();
  for (const row of allowedRows) {
    if (!allowedByPageId.has(row.pageId)) allowedByPageId.set(row.pageId, new Set());
    allowedByPageId.get(row.pageId)!.add(row.memberId);
  }
  const values = normalizedRules
    .filter((rule) => validPageIds.has(rule.pageId))
    .map((rule) => ({
      reciterId: id,
      pageId: rule.pageId,
      enabled: rule.enabled,
      updatedAt: new Date(),
    }));

  await db.delete(reciterTaskFlowRulesTable).where(eq(reciterTaskFlowRulesTable.reciterId, id));
  if (values.length > 0) {
    const insertedRules = await db.insert(reciterTaskFlowRulesTable).values(values).returning();
    const insertedRuleByPageId = new Map(insertedRules.map((rule) => [rule.pageId, rule]));
    const assigneeValues = normalizedRules.flatMap((rule) => {
      const insertedRule = insertedRuleByPageId.get(rule.pageId);
      const allowedMemberIds = allowedByPageId.get(rule.pageId) ?? new Set<number>();
      if (!insertedRule) return [];
      return rule.defaultAssigneeIds
        .filter((memberId) => allowedMemberIds.has(memberId))
        .map((memberId) => ({ ruleId: insertedRule.id, memberId }));
    });
    if (assigneeValues.length > 0) {
      await db.insert(reciterTaskFlowRuleAssigneesTable).values(assigneeValues);
    }
  }

  res.json({ ok: true, saved: values.length });
});

router.put("/reciters/:id", async (req, res) => {
  const { id } = UpdateReciterParams.parse({ id: Number(req.params.id) });
  const body = UpdateReciterBody.parse(req.body);
  const [reciter] = await db
    .update(recitersTable)
    .set({ name: body.name, mosque: body.mosque as "nabawi" | "haram" })
    .where(eq(recitersTable.id, id))
    .returning();
  if (!reciter) {
    res.status(404).json({ error: "Reciter not found" });
    return;
  }
  res.json(reciter);
});

router.delete("/reciters/:id", async (req, res) => {
  const { id } = DeleteReciterParams.parse({ id: Number(req.params.id) });
  await db.delete(recitersTable).where(eq(recitersTable.id, id));
  res.status(204).end();
});

export default router;
