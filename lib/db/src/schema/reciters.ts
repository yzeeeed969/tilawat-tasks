import { pgTable, serial, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mosqueEnum = pgEnum("mosque_type", ["nabawi", "haram"]);

export const recitersTable = pgTable("reciters", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  mosque: mosqueEnum("mosque").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertReciterSchema = createInsertSchema(recitersTable).omit({ id: true, createdAt: true });
export type InsertReciter = z.infer<typeof insertReciterSchema>;
export type Reciter = typeof recitersTable.$inferSelect;
