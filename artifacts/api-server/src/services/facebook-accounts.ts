import { randomBytes } from "node:crypto";
import { asc, eq, lt, notInArray } from "drizzle-orm";
import { db, facebookConnectionTable, facebookOauthStatesTable, facebookPagesTable, instagramAccountsTable } from "@workspace/db";
import { ensureInstagramSchema } from "./instagram-schema";
import { InstagramError } from "./instagram-accounts";
import {
  buildFacebookAuthorizeUrl,
  exchangeFacebookCode,
  exchangeFacebookLongLived,
  FacebookApiError,
  fetchFacebookMe,
  fetchManagedPages,
  getFacebookConfig,
} from "./facebook-client";
import { encryptToken } from "../lib/instagram-token-crypto";

// تفويض فيسبوك (مرة واحدة) وصفحاته: المفوِّض أدمن على صفحات القرّاء عبر عدة محافظ، فـ /me/accounts
// يرجّع مفاتيح كل الصفحات دفعة واحدة. المفاتيح مشفّرة (مشتقة من FACEBOOK_APP_SECRET) ولا تصل للواجهة.

const STATE_TTL_MS = 15 * 60 * 1000;

export async function getFacebookConnection() {
  await ensureInstagramSchema();
  const [row] = await db.select().from(facebookConnectionTable).orderBy(asc(facebookConnectionTable.id)).limit(1);
  if (row) return row;
  const [created] = await db.insert(facebookConnectionTable).values({}).returning();
  return created;
}

export async function listFacebookPages() {
  await ensureInstagramSchema();
  return db
    .select({ fbPageId: facebookPagesTable.fbPageId, name: facebookPagesTable.name, status: facebookPagesTable.status, lastError: facebookPagesTable.lastError })
    .from(facebookPagesTable)
    .orderBy(asc(facebookPagesTable.name));
}

export async function startFacebookConnect(userId: number | null): Promise<{ url: string }> {
  await ensureInstagramSchema();
  const config = getFacebookConfig();
  if (!config) throw new InstagramError(400, "إعدادات فيسبوك غير مكتملة في Railway (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_REDIRECT_URI)");
  await db.delete(facebookOauthStatesTable).where(lt(facebookOauthStatesTable.expiresAt, new Date()));
  const state = randomBytes(24).toString("base64url");
  await db.insert(facebookOauthStatesTable).values({ state, createdByUserId: userId, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
  return { url: buildFacebookAuthorizeUrl(config, state) };
}

export type FacebookConnectOutcome = { ok: true; pages: number; userName: string | null } | { ok: false; message: string };

// عودة المتصفح من فيسبوك: state لمرة واحدة ← رمز ← مفتاح قصير ← طويل ← /me/accounts ← حفظ الصفحات.
export async function completeFacebookConnect(query: { state?: unknown; code?: unknown; error?: unknown; error_description?: unknown }): Promise<FacebookConnectOutcome> {
  await ensureInstagramSchema();
  const stateValue = typeof query.state === "string" ? query.state : "";
  if (!stateValue) return { ok: false, message: "طلب ربط غير صالح (بلا state)" };
  const [state] = await db.delete(facebookOauthStatesTable).where(eq(facebookOauthStatesTable.state, stateValue)).returning();
  if (!state) return { ok: false, message: "انتهت صلاحية طلب الربط أو استُخدم مسبقًا — ابدأ الربط من جديد" };
  if (state.expiresAt.getTime() < Date.now()) return { ok: false, message: "انتهت صلاحية طلب الربط (15 دقيقة) — ابدأ الربط من جديد" };
  if (query.error) return { ok: false, message: query.error === "access_denied" ? "أُلغي الربط من صفحة فيسبوك" : `رفض فيسبوك الربط: ${String(query.error_description ?? query.error)}` };
  const code = typeof query.code === "string" ? query.code : "";
  if (!code) return { ok: false, message: "لم يُرسل فيسبوك رمز الربط" };
  const config = getFacebookConfig();
  if (!config) return { ok: false, message: "إعدادات فيسبوك غير مكتملة في Railway" };

  try {
    const shortToken = await exchangeFacebookCode(config, code);
    const long = await exchangeFacebookLongLived(config, shortToken);
    const me = await fetchFacebookMe(long.accessToken);
    const pages = await fetchManagedPages(long.accessToken);
    const now = new Date();
    for (const page of pages) {
      const values = {
        name: page.name,
        accessTokenEncrypted: page.accessToken ? encryptToken(page.accessToken, config.appSecret) : null,
        status: page.accessToken ? "connected" : "needs_reconnect",
        lastError: page.accessToken ? null : "لم يُرجِع فيسبوك مفتاحًا لهذه الصفحة (صلاحية ناقصة؟)",
        updatedAt: now,
      };
      await db.insert(facebookPagesTable).values({ fbPageId: page.id, ...values })
        .onConflictDoUpdate({ target: facebookPagesTable.fbPageId, set: values });
    }
    // صفحات لم تعد ضمن صفحات المفوِّض: تبقى مسجّلة (للربط القائم) لكن «غير متاحة».
    const ids = pages.map((page) => page.id);
    await db.update(facebookPagesTable).set({ status: "missing", accessTokenEncrypted: null, updatedAt: now, lastError: "الصفحة لم تعد ضمن صفحات الحساب المفوِّض" })
      .where(ids.length > 0 ? notInArray(facebookPagesTable.fbPageId, ids) : undefined);
    const connection = await getFacebookConnection();
    await db.update(facebookConnectionTable).set({
      userTokenEncrypted: encryptToken(long.accessToken, config.appSecret),
      tokenExpiresAt: long.expiresIn ? new Date(now.getTime() + long.expiresIn * 1000) : null,
      fbUserId: me.id,
      fbUserName: me.name,
      status: "connected",
      lastError: null,
      reconnectAlertSentAt: null,
      connectedAt: now,
      updatedAt: now,
    }).where(eq(facebookConnectionTable.id, connection.id));
    return { ok: true, pages: pages.length, userName: me.name };
  } catch (err) {
    const message = err instanceof FacebookApiError ? err.message : String((err as Error)?.message ?? err);
    return { ok: false, message: `تعذّر إكمال ربط فيسبوك: ${message}` };
  }
}

// ربط حساب إنستقرام (قارئ) بصفحة فيسبوك المقابلة — أو فكّه (null).
export async function setAccountFacebookPage(accountId: number, fbPageId: unknown) {
  await ensureInstagramSchema();
  const value = fbPageId === null || fbPageId === "" ? null : String(fbPageId);
  if (value) {
    const [page] = await db.select({ id: facebookPagesTable.id }).from(facebookPagesTable).where(eq(facebookPagesTable.fbPageId, value)).limit(1);
    if (!page) throw new InstagramError(400, "صفحة فيسبوك غير معروفة — اربط فيسبوك أولًا");
  }
  const [updated] = await db.update(instagramAccountsTable).set({ fbPageId: value }).where(eq(instagramAccountsTable.id, accountId)).returning({ id: instagramAccountsTable.id });
  if (!updated) throw new InstagramError(404, "الحساب غير موجود");
}
