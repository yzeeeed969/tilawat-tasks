// اتصال بواجهة إنستقرام الرسمية (Instagram API with Instagram Login) — من الخادم فقط.
// المراجع: Business Login for Instagram + IG User Media. صلاحية واحدة: instagram_business_basic.

export const INSTAGRAM_SCOPES = ["instagram_business_basic"] as const;
const GRAPH_VERSION = "v25.0";
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";

export type InstagramConfig = { appId: string; appSecret: string; redirectUri: string };

// الإعدادات من متغيرات البيئة في Railway. أيّها ناقص ⇐ null (الربط غير متاح، والمراقبة نائمة).
export function getInstagramConfig(): InstagramConfig | null {
  const appId = process.env.INSTAGRAM_APP_ID?.trim();
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI?.trim();
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

export function missingInstagramEnv(): string[] {
  return ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI"].filter((name) => !process.env[name]?.trim());
}

export class InstagramApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null, readonly isAuthError: boolean) {
    super(message);
    this.name = "InstagramApiError";
  }
}

async function readJson(response: Response) {
  const body: any = await response.json().catch(() => null);
  if (response.ok && !body?.error && !body?.error_type) return body;
  const err = body?.error ?? body ?? {};
  const code = typeof err.code === "number" ? err.code : typeof body?.code === "number" ? body.code : null;
  const type = String(err.type ?? body?.error_type ?? "");
  const message = String(err.message ?? body?.error_message ?? `HTTP ${response.status}`);
  // 190 = مفتاح غير صالح/منتهي/أُلغي الإذن. OAuthException عمومًا = مشكلة مصادقة.
  const isAuthError = code === 190 || type === "OAuthException" || response.status === 401;
  throw new InstagramApiError(message, response.status, code, isAuthError);
}

export function buildAuthorizeUrl(config: InstagramConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
    // نطلب تسجيل الدخول بحساب إنستقرام الاحترافي نفسه، لا بفيسبوك، ونجبر اختيار الحساب في كل ربط.
    enable_fb_login: "false",
    force_reauth: "true",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// الرمز (code) صالح ساعة ولمرة واحدة؛ قد يصل وفي آخره «#_» فيُزال.
export function cleanAuthCode(code: string): string {
  return code.replace(/#_$/, "").trim();
}

export async function exchangeCodeForShortToken(config: InstagramConfig, code: string): Promise<{ accessToken: string; userId: string }> {
  const response = await fetch(SHORT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
      code: cleanAuthCode(code),
    }).toString(),
  });
  const body = await readJson(response);
  // الوثائق تُرجعها داخل data[]، وبعض الإصدارات مسطّحة — نقبل الشكلين.
  const row = Array.isArray(body?.data) ? body.data[0] : body;
  if (!row?.access_token) throw new InstagramApiError("لم يُرجِع إنستقرام مفتاح وصول", response.status, null, true);
  return { accessToken: String(row.access_token), userId: String(row.user_id ?? "") };
}

export async function exchangeForLongLivedToken(config: InstagramConfig, shortToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.appSecret, access_token: shortToken });
  const body = await readJson(await fetch(`${GRAPH}/access_token?${params.toString()}`));
  if (!body?.access_token) throw new InstagramApiError("تعذّر الحصول على مفتاح طويل الأمد", 400, null, true);
  return { accessToken: String(body.access_token), expiresIn: Number(body.expires_in ?? 60 * 24 * 3600) };
}

// شرط ميتا: المفتاح عمره 24 ساعة على الأقل ولم ينتهِ. كل تجديد يمدّه 60 يومًا.
export async function refreshLongLivedToken(token: string): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
  const body = await readJson(await fetch(`${GRAPH}/refresh_access_token?${params.toString()}`));
  if (!body?.access_token) throw new InstagramApiError("تعذّر تجديد المفتاح", 400, null, true);
  return { accessToken: String(body.access_token), expiresIn: Number(body.expires_in ?? 60 * 24 * 3600) };
}

export async function fetchProfile(token: string): Promise<{ igUserId: string; username: string | null }> {
  const params = new URLSearchParams({ fields: "user_id,username", access_token: token });
  const body = await readJson(await fetch(`${GRAPH}/${GRAPH_VERSION}/me?${params.toString()}`));
  const igUserId = String(body?.user_id ?? body?.id ?? "");
  if (!igUserId) throw new InstagramApiError("تعذّر قراءة معرّف الحساب", 400, null, false);
  return { igUserId, username: body?.username ? String(body.username) : null };
}

export type InstagramMediaItem = {
  id: string;
  caption: string | null;
  mediaType: string | null;
  mediaProductType: string | null;
  permalink: string | null;
  timestamp: Date;
};

// آخر منشورات الحساب (الأحدث أولًا). القصص لا تظهر في هذا الطلب أصلًا (لها مسار مستقل)، ونصفّي
// الأنواع لاحقًا على FEED و REELS فقط احتياطًا.
export async function fetchRecentMedia(token: string, limit = 25): Promise<InstagramMediaItem[]> {
  const params = new URLSearchParams({
    fields: "id,caption,media_type,media_product_type,permalink,timestamp",
    limit: String(limit),
    access_token: token,
  });
  const body = await readJson(await fetch(`${GRAPH}/${GRAPH_VERSION}/me/media?${params.toString()}`));
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows
    .filter((row) => row?.id && row?.timestamp && !Number.isNaN(new Date(row.timestamp).getTime()))
    .map((row) => ({
      id: String(row.id),
      caption: typeof row.caption === "string" ? row.caption : null,
      mediaType: row.media_type ? String(row.media_type) : null,
      mediaProductType: row.media_product_type ? String(row.media_product_type) : null,
      permalink: row.permalink ? String(row.permalink) : null,
      timestamp: new Date(row.timestamp),
    }));
}
