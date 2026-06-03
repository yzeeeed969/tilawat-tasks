import { bigint, integer, pgTable, timestamp } from "drizzle-orm/pg-core";

export const publicSiteSettingsTable = pgTable("public_site_settings", {
  id: integer("id").primaryKey().default(1),
  youtubeTotalViews: bigint("youtube_total_views", { mode: "number" }),
  youtubeBaselineViews: bigint("youtube_baseline_views", { mode: "number" }).default(0),
  youtubeViewsUpdatedAt: timestamp("youtube_views_updated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PublicSiteSettings = typeof publicSiteSettingsTable.$inferSelect;
