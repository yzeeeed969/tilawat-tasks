import { Router } from "express";
import { db, platformsTable, platformPagesTable, recitersTable, pageMembersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { CreatePlatformBody, DeletePlatformParams, UpdatePlatformParams, UpdatePlatformBody, CreatePlatformPageBody, CreatePlatformPageParams } from "@workspace/api-zod";

const router = Router();

router.get("/platforms", async (req, res) => {
  const platforms = await db.select().from(platformsTable).orderBy(platformsTable.id);
  res.json(platforms);
});

router.post("/platforms", async (req, res) => {
  const body = CreatePlatformBody.parse(req.body);
  const [platform] = await db.insert(platformsTable).values(body).returning();
  res.status(201).json(platform);
});

router.put("/platforms/:id", async (req, res) => {
  const { id } = UpdatePlatformParams.parse({ id: Number(req.params.id) });
  const body = UpdatePlatformBody.parse(req.body);
  const [platform] = await db
    .update(platformsTable)
    .set({ name: body.name, icon: body.icon, color: body.color, isMain: (body as { isMain?: boolean }).isMain })
    .where(eq(platformsTable.id, id))
    .returning();
  if (!platform) {
    res.status(404).json({ error: "Platform not found" });
    return;
  }
  res.json(platform);
});

router.delete("/platforms/:id", async (req, res) => {
  const { id } = DeletePlatformParams.parse({ id: Number(req.params.id) });
  await db.delete(platformsTable).where(eq(platformsTable.id, id));
  res.status(204).end();
});

router.get("/platforms/:platformId/pages", async (req, res) => {
  const platformId = Number(req.params.platformId);
  const pages = await db
    .select()
    .from(platformPagesTable)
    .where(eq(platformPagesTable.platformId, platformId))
    .orderBy(platformPagesTable.createdAt);
  res.json(pages);
});

router.post("/platforms/:platformId/pages", async (req, res) => {
  const { platformId } = CreatePlatformPageParams.parse({ platformId: Number(req.params.platformId) });
  const { name, reciterId, pageUrl } = CreatePlatformPageBody.parse(req.body) as { name?: string; reciterId?: number | null; pageUrl?: string | null };
  // Auto-generate name from reciter if not provided
  let pageName = name ?? "";
  if (!pageName && reciterId) {
    const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, reciterId));
    pageName = reciter?.name ?? "";
  }
  if (!pageName) pageName = pageUrl ?? "صفحة";
  const [page] = await db
    .insert(platformPagesTable)
    .values({ platformId, name: pageName, reciterId: reciterId ?? null, pageUrl: pageUrl ?? null })
    .returning();
  res.status(201).json(page);
});

router.patch("/platforms/:platformId/pages/:id", async (req, res) => {
  const platformId = Number(req.params.platformId);
  const id = Number(req.params.id);
  const { reciterId, pageUrl } = req.body as { reciterId?: number | null; pageUrl?: string | null };
  let name: string | undefined;
  if (reciterId) {
    const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, reciterId));
    name = reciter?.name;
  }
  if (!name) name = pageUrl ?? undefined;
  const updateData: Record<string, unknown> = {};
  if (reciterId !== undefined) updateData.reciterId = reciterId ?? null;
  if (pageUrl !== undefined) updateData.pageUrl = pageUrl ?? null;
  if (name) updateData.name = name;
  const [page] = await db
    .update(platformPagesTable)
    .set(updateData)
    .where(eq(platformPagesTable.id, id))
    .returning();
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  res.json(page);
});

router.delete("/platforms/:platformId/pages/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(platformPagesTable).where(eq(platformPagesTable.id, id));
  res.status(204).end();
});

// GET /platforms/:platformId/pages/:id/members
router.get("/platforms/:platformId/pages/:id/members", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db
    .select({ memberId: pageMembersTable.memberId })
    .from(pageMembersTable)
    .where(eq(pageMembersTable.pageId, id));
  res.json(rows.map((r) => r.memberId));
});

// PUT /platforms/:platformId/pages/:id/members
router.put("/platforms/:platformId/pages/:id/members", async (req, res) => {
  const id = Number(req.params.id);
  const { memberIds } = req.body as { memberIds: number[] };
  if (!Array.isArray(memberIds)) {
    res.status(400).json({ error: "memberIds must be an array" });
    return;
  }
  await db.delete(pageMembersTable).where(eq(pageMembersTable.pageId, id));
  if (memberIds.length > 0) {
    await db.insert(pageMembersTable).values(memberIds.map((memberId) => ({ pageId: id, memberId })));
  }
  res.json(memberIds);
});

export default router;
