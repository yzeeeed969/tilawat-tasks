// اتصال بواجهة فيسبوك (Graph API) — من الخادم فقط. تفويض Facebook Login بصلاحيتين للقراءة:
// pages_show_list (قائمة الصفحات) + pages_read_engagement (قراءة منشورات/ريلز الصفحة) + read_insights
// (مشاهدات الريلز الظاهرة في صفحة المنصات). لا نشر.

export const FACEBOOK_SCOPES = ["pages_show_list", "pages_read_engagement", "read_insights"] as const;
const GRAPH_VERSION = "v25.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

export type FacebookConfig = { appId: string; appSecret: string; redirectUri: string };

export function getFacebookConfig(): FacebookConfig | null {
  const appId = process.env.FACEBOOK_APP_ID?.trim();
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim();
  const redirectUri = process.env.FACEBOOK_REDIRECT_URI?.trim();
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

export function missingFacebookEnv(): string[] {
  return ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "FACEBOOK_REDIRECT_URI"].filter((name) => !process.env[name]?.trim());
}

export class FacebookApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null, readonly isAuthError: boolean) {
    super(message);
    this.name = "FacebookApiError";
  }
}

async function readJson(response: Response) {
  const body: any = await response.json().catch(() => null);
  if (response.ok && !body?.error) return body;
  const err = body?.error ?? {};
  const code = typeof err.code === "number" ? err.code : null;
  // 190 = مفتاح غير صالح/منتهي/أُلغي؛ 102 = جلسة؛ 10/200 = صلاحية مفقودة — كلها تحتاج إعادة تفويض.
  const isAuthError = code === 190 || code === 102 || code === 10 || code === 200 || response.status === 401;
  throw new FacebookApiError(String(err.message ?? `HTTP ${response.status}`), response.status, code, isAuthError);
}

async function graphGet(path: string, params: Record<string, string>) {
  const url = path.startsWith("https://") ? path : `${GRAPH}/${path}?${new URLSearchParams(params).toString()}`;
  return readJson(await fetch(url));
}

export function buildFacebookAuthorizeUrl(config: FacebookConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    response_type: "code",
    scope: FACEBOOK_SCOPES.join(","),
  });
  return `${DIALOG}?${params.toString()}`;
}

export async function exchangeFacebookCode(config: FacebookConfig, code: string): Promise<string> {
  const body = await graphGet("oauth/access_token", { client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code });
  if (!body?.access_token) throw new FacebookApiError("لم يُرجِع فيسبوك مفتاح وصول", 400, null, true);
  return String(body.access_token);
}

// مفتاح المستخدم طويل الأمد (~60 يومًا). مفاتيح الصفحات المشتقة منه لا تنتهي عادةً.
export async function exchangeFacebookLongLived(config: FacebookConfig, shortToken: string): Promise<{ accessToken: string; expiresIn: number | null }> {
  const body = await graphGet("oauth/access_token", { grant_type: "fb_exchange_token", client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: shortToken });
  if (!body?.access_token) throw new FacebookApiError("تعذّر الحصول على مفتاح طويل الأمد", 400, null, true);
  return { accessToken: String(body.access_token), expiresIn: body.expires_in ? Number(body.expires_in) : null };
}

export async function fetchFacebookMe(token: string): Promise<{ id: string; name: string | null }> {
  const body = await graphGet("me", { fields: "id,name", access_token: token });
  return { id: String(body?.id ?? ""), name: body?.name ? String(body.name) : null };
}

// كل الصفحات التي يديرها المفوِّض عبر كل المحافظ، مع مفتاح كل صفحة (مع الترقيم).
export async function fetchManagedPages(userToken: string): Promise<Array<{ id: string; name: string; accessToken: string | null }>> {
  const pages: Array<{ id: string; name: string; accessToken: string | null }> = [];
  let body = await graphGet("me/accounts", { fields: "id,name,access_token", limit: "100", access_token: userToken });
  for (let guard = 0; guard < 20; guard += 1) {
    for (const row of Array.isArray(body?.data) ? body.data : []) {
      if (row?.id) pages.push({ id: String(row.id), name: String(row.name ?? row.id), accessToken: row.access_token ? String(row.access_token) : null });
    }
    const next = body?.paging?.next;
    if (!next) break;
    body = await graphGet(String(next), {});
  }
  return pages;
}

export type FacebookItem = { kind: "reel" | "post"; id: string; text: string; createdAt: Date; url: string };

// آخر ريلز + منشورات الصفحة منذ تاريخ معيّن. رابط الريل: https://www.facebook.com/reel/{id}/
export async function fetchPageItems(pageId: string, pageToken: string, since: Date, limit = 25): Promise<FacebookItem[]> {
  const sinceUnix = String(Math.floor(since.getTime() / 1000));
  const [reels, posts] = await Promise.all([
    graphGet(`${pageId}/video_reels`, { fields: "id,description,created_time,permalink_url", limit: String(limit), since: sinceUnix, access_token: pageToken }),
    graphGet(`${pageId}/published_posts`, { fields: "id,message,created_time,permalink_url", limit: String(limit), since: sinceUnix, access_token: pageToken }),
  ]);
  const items: FacebookItem[] = [];
  for (const row of Array.isArray(reels?.data) ? reels.data : []) {
    const createdAt = new Date(row?.created_time);
    if (!row?.id || Number.isNaN(createdAt.getTime())) continue;
    items.push({ kind: "reel", id: String(row.id), text: String(row.description ?? ""), createdAt, url: `https://www.facebook.com/reel/${row.id}/` });
  }
  for (const row of Array.isArray(posts?.data) ? posts.data : []) {
    const createdAt = new Date(row?.created_time);
    if (!row?.id || Number.isNaN(createdAt.getTime()) || !row?.permalink_url) continue;
    items.push({ kind: "post", id: String(row.id), text: String(row.message ?? ""), createdAt, url: String(row.permalink_url) });
  }
  return items;
}
