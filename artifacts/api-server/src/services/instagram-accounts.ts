import { randomBytes } from "node:crypto";
import { and, asc, eq, lt, ne } from "drizzle-orm";
import {
  db,
  instagramAccountsTable,
  instagramOauthStatesTable,
  instagramSettingsTable,
  membersTable,
  platformPagesTable,
  platformsTable,
  recitersTable,
} from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import {
  buildAuthorizeUrl,
  exchangeCodeForShortToken,
  exchangeForLongLivedToken,
  fetchProfile,
  getInstagramConfig,
  InstagramApiError,
} from "./instagram-client";
import { encryptToken } from "../lib/instagram-token-crypto";

// إدارة حسابات إنستقرام وربطها (OAuth). المطابقة لاحقًا بالحساب وحده؛ القالب = صفحة القارئ + العضو.

export class InstagramError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InstagramError";
  }
}

const STATE_TTL_MS = 15 * 60 * 1000;
// منصة إنستقرام تُعرف باسمها (كما تُعرف منصة يوتيوب في بقية النظام).
export const INSTAGRAM_PLATFORM_NAME = /إنستقرام|انستقرام|إنستغرام|انستغرام|انستجرام|إنستجرام|instagram/i;

export async function getInstagramSettings() {
  await ensureInstagramSchema();
  const [row] = await db.select().from(instagramSettingsTable).orderBy(asc(instagramSettingsTable.id)).limit(1);
  if (row) return row;
  const [created] = await db.insert(instagramSettingsTable).values({}).returning();
  return created;
}

export async function updateInstagramSettings(input: { enabled?: unknown; trialMode?: unknown }) {
  const current = await getInstagramSettings();
  const patch: Partial<typeof instagramSettingsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (typeof input.trialMode === "boolean") patch.trialMode = input.trialMode;
  const [updated] = await db.update(instagramSettingsTable).set(patch).where(eq(instagramSettingsTable.id, current.id)).returning();
  return updated;
}

// صفحات القرّاء على منصة إنستقرام (لاختيار قالب الحساب) — الصفحة يجب أن تكون مربوطة بقارئ.
export async function listInstagramPages() {
  const rows = await db
    .select({
      id: platformPagesTable.id,
      name: platformPagesTable.name,
      platformId: platformPagesTable.platformId,
      platformName: platformsTable.name,
      reciterId: platformPagesTable.reciterId,
      reciterName: recitersTable.name,
    })
    .from(platformPagesTable)
    .innerJoin(platformsTable, eq(platformsTable.id, platformPagesTable.platformId))
    .leftJoin(recitersTable, eq(recitersTable.id, platformPagesTable.reciterId))
    .orderBy(asc(platformPagesTable.name));
  return rows.filter((row) => INSTAGRAM_PLATFORM_NAME.test(row.platformName));
}

// عرض الحسابات للإدارة — بلا أي مفتاح وصول.
export async function listInstagramAccounts() {
  await ensureInstagramSchema();
  const rows = await db
    .select({
      id: instagramAccountsTable.id,
      pageId: instagramAccountsTable.pageId,
      pageName: platformPagesTable.name,
      platformId: instagramAccountsTable.platformId,
      reciterId: instagramAccountsTable.reciterId,
      reciterName: recitersTable.name,
      memberId: instagramAccountsTable.memberId,
      memberName: membersTable.name,
      enabled: instagramAccountsTable.enabled,
      igUserId: instagramAccountsTable.igUserId,
      username: instagramAccountsTable.username,
      status: instagramAccountsTable.status,
      lastError: instagramAccountsTable.lastError,
      tokenExpiresAt: instagramAccountsTable.tokenExpiresAt,
      tokenRefreshedAt: instagramAccountsTable.tokenRefreshedAt,
      connectedAt: instagramAccountsTable.connectedAt,
      monitoringStartedAt: instagramAccountsTable.monitoringStartedAt,
      lastCheckedAt: instagramAccountsTable.lastCheckedAt,
    })
    .from(instagramAccountsTable)
    .innerJoin(platformPagesTable, eq(platformPagesTable.id, instagramAccountsTable.pageId))
    .innerJoin(recitersTable, eq(recitersTable.id, instagramAccountsTable.reciterId))
    .innerJoin(membersTable, eq(membersTable.id, instagramAccountsTable.memberId))
    .orderBy(asc(recitersTable.name));
  return rows;
}

async function resolveTemplate(pageId: number, memberId: number) {
  const [page] = await db
    .select({ id: platformPagesTable.id, platformId: platformPagesTable.platformId, reciterId: platformPagesTable.reciterId, platformName: platformsTable.name })
    .from(platformPagesTable)
    .innerJoin(platformsTable, eq(platformsTable.id, platformPagesTable.platformId))
    .where(eq(platformPagesTable.id, pageId))
    .limit(1);
  if (!page) throw new InstagramError(404, "الصفحة غير موجودة");
  if (!INSTAGRAM_PLATFORM_NAME.test(page.platformName)) throw new InstagramError(400, "الصفحة ليست على منصة إنستقرام");
  if (!page.reciterId) throw new InstagramError(400, "الصفحة غير مربوطة بقارئ — اربطها بالقارئ من صفحة المنصات أولًا");
  const [member] = await db.select({ id: membersTable.id }).from(membersTable).where(eq(membersTable.id, memberId)).limit(1);
  if (!member) throw new InstagramError(400, "العضو غير موجود");
  return { pageId: page.id, platformId: page.platformId, reciterId: page.reciterId, memberId };
}

export async function createInstagramAccount(input: { pageId: unknown; memberId: unknown }) {
  await ensureInstagramSchema();
  const pageId = Number(input.pageId);
  const memberId = Number(input.memberId);
  if (!Number.isInteger(pageId) || pageId <= 0 || !Number.isInteger(memberId) || memberId <= 0) throw new InstagramError(400, "اختر الصفحة والعضو المسؤول");
  const template = await resolveTemplate(pageId, memberId);
  const [existing] = await db.select({ id: instagramAccountsTable.id }).from(instagramAccountsTable).where(eq(instagramAccountsTable.pageId, pageId)).limit(1);
  if (existing) throw new InstagramError(409, "لهذه الصفحة حساب إنستقرام مضاف مسبقًا");
  const [created] = await db.insert(instagramAccountsTable).values(template).returning({ id: instagramAccountsTable.id });
  return created;
}

export async function updateInstagramAccount(id: number, input: { memberId?: unknown; enabled?: unknown }) {
  await ensureInstagramSchema();
  const [account] = await db.select().from(instagramAccountsTable).where(eq(instagramAccountsTable.id, id)).limit(1);
  if (!account) throw new InstagramError(404, "الحساب غير موجود");
  const patch: Partial<typeof instagramAccountsTable.$inferInsert> = {};
  if (input.memberId !== undefined) {
    const template = await resolveTemplate(account.pageId, Number(input.memberId));
    patch.memberId = template.memberId;
  }
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (Object.keys(patch).length === 0) return account;
  const [updated] = await db.update(instagramAccountsTable).set(patch).where(eq(instagramAccountsTable.id, id)).returning();
  return updated;
}

// فصل الحساب: يُحذف المفتاح فقط، ويبقى السجل والمنشورات والمهام كما هي.
export async function disconnectInstagramAccount(id: number) {
  await ensureInstagramSchema();
  const [updated] = await db.update(instagramAccountsTable).set({
    accessTokenEncrypted: null,
    tokenExpiresAt: null,
    status: "not_connected",
    lastError: null,
  }).where(eq(instagramAccountsTable.id, id)).returning({ id: instagramAccountsTable.id });
  if (!updated) throw new InstagramError(404, "الحساب غير موجود");
}

// بداية الربط: رمز state لمرة واحدة (15 دقيقة) ثم رابط صفحة تسجيل الدخول في إنستقرام.
export async function startInstagramConnect(accountId: number, userId: number | null): Promise<{ url: string }> {
  await ensureInstagramSchema();
  const config = getInstagramConfig();
  if (!config) throw new InstagramError(400, "إعدادات ميتا غير مكتملة في Railway (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_REDIRECT_URI)");
  const [account] = await db.select({ id: instagramAccountsTable.id }).from(instagramAccountsTable).where(eq(instagramAccountsTable.id, accountId)).limit(1);
  if (!account) throw new InstagramError(404, "الحساب غير موجود");
  await db.delete(instagramOauthStatesTable).where(lt(instagramOauthStatesTable.expiresAt, new Date()));
  const state = randomBytes(24).toString("base64url");
  await db.insert(instagramOauthStatesTable).values({ state, accountId, createdByUserId: userId, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
  return { url: buildAuthorizeUrl(config, state) };
}

export type ConnectOutcome = { ok: true; accountId: number; username: string | null } | { ok: false; message: string };

// عودة المتصفح من إنستقرام: تحقق state (مرة واحدة) ← رمز قصير ← مفتاح طويل (60 يومًا) ← الملف ← حفظ.
export async function completeInstagramConnect(query: { state?: unknown; code?: unknown; error?: unknown; error_description?: unknown }): Promise<ConnectOutcome> {
  await ensureInstagramSchema();
  const stateValue = typeof query.state === "string" ? query.state : "";
  if (!stateValue) return { ok: false, message: "طلب ربط غير صالح (بلا state)" };
  const [state] = await db.delete(instagramOauthStatesTable).where(eq(instagramOauthStatesTable.state, stateValue)).returning();
  if (!state) return { ok: false, message: "انتهت صلاحية طلب الربط أو استُخدم مسبقًا — ابدأ الربط من جديد" };
  if (state.expiresAt.getTime() < Date.now()) return { ok: false, message: "انتهت صلاحية طلب الربط (15 دقيقة) — ابدأ الربط من جديد" };
  if (query.error) return { ok: false, message: query.error === "access_denied" ? "أُلغي الربط من صفحة إنستقرام" : `رفض إنستقرام الربط: ${String(query.error_description ?? query.error)}` };
  const code = typeof query.code === "string" ? query.code : "";
  if (!code) return { ok: false, message: "لم يُرسل إنستقرام رمز الربط" };
  const config = getInstagramConfig();
  if (!config) return { ok: false, message: "إعدادات ميتا غير مكتملة في Railway" };

  try {
    const short = await exchangeCodeForShortToken(config, code);
    const long = await exchangeForLongLivedToken(config, short.accessToken);
    const profile = await fetchProfile(long.accessToken);

    const [other] = await db
      .select({ id: instagramAccountsTable.id })
      .from(instagramAccountsTable)
      .where(and(eq(instagramAccountsTable.igUserId, profile.igUserId), ne(instagramAccountsTable.id, state.accountId)))
      .limit(1);
    if (other) return { ok: false, message: `الحساب @${profile.username ?? profile.igUserId} مربوط بقارئ آخر في النظام` };

    const [account] = await db.select().from(instagramAccountsTable).where(eq(instagramAccountsTable.id, state.accountId)).limit(1);
    if (!account) return { ok: false, message: "الحساب حُذف أثناء الربط" };
    const now = new Date();
    await db.update(instagramAccountsTable).set({
      igUserId: profile.igUserId,
      username: profile.username,
      accessTokenEncrypted: encryptToken(long.accessToken, config.appSecret),
      tokenExpiresAt: new Date(now.getTime() + long.expiresIn * 1000),
      tokenRefreshedAt: now,
      status: "connected",
      lastError: null,
      reconnectAlertSentAt: null,
      connectedAt: now,
      // أول ربط فقط يحدّد بداية المراقبة؛ إعادة الربط تُبقيها كي تُلتقط منشورات فترة الانقطاع.
      monitoringStartedAt: account.monitoringStartedAt ?? now,
    }).where(eq(instagramAccountsTable.id, account.id));
    return { ok: true, accountId: account.id, username: profile.username };
  } catch (err) {
    const message = err instanceof InstagramApiError ? err.message : String((err as Error)?.message ?? err);
    return { ok: false, message: `تعذّر إكمال الربط: ${message}` };
  }
}
