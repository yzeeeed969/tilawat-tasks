import { pgTable, integer, primaryKey } from "drizzle-orm/pg-core";
import { platformPagesTable } from "./platform-pages";
import { membersTable } from "./members";

export const pageMembersTable = pgTable("page_members", {
  pageId: integer("page_id").notNull().references(() => platformPagesTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.pageId, t.memberId] })]);
