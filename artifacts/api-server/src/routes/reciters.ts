import { Router } from "express";
import { db, recitersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateReciterBody,
  GetReciterParams,
  DeleteReciterParams,
  UpdateReciterParams,
  UpdateReciterBody,
  ListRecitersQueryParams,
} from "@workspace/api-zod";

const router = Router();

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
