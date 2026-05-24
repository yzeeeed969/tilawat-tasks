import { db } from "@workspace/db";
import { membersTable, usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

type AppUser = typeof usersTable.$inferSelect;

export async function ensureAdminLinkedMember(user: AppUser): Promise<AppUser> {
  if (user.role !== "admin") return user;

  if (typeof user.memberId === "number") {
    const [member] = await db
      .select({ id: membersTable.id })
      .from(membersTable)
      .where(eq(membersTable.id, user.memberId))
      .limit(1);
    if (member) return user;
  }

  const displayName = user.displayName?.trim() || user.username;
  const [member] = await db
    .insert(membersTable)
    .values({ name: displayName, role: "مدير" })
    .returning();

  await db
    .update(usersTable)
    .set({ memberId: member.id } as any)
    .where(eq(usersTable.id, user.id));

  return { ...user, memberId: member.id };
}
