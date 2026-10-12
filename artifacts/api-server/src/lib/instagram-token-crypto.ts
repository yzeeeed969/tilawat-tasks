import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// تشفير مفاتيح وصول إنستقرام في القاعدة (AES-256-GCM). المفتاح مشتق من INSTAGRAM_APP_SECRET:
// تغيير السر في ميتا يُبطل المفاتيح على أي حال (يلزم إعادة ربط)، فلا حاجة لمتغير بيئة إضافي.
function keyFrom(secret: string) {
  return createHash("sha256").update(`instagram-token:${secret}`).digest();
}

export function encryptToken(token: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

// null ⇐ تعذّر فك التشفير (سر مختلف أو بيانات تالفة) — يُعامَل كحساب يحتاج إعادة ربط.
export function decryptToken(payload: string | null | undefined, secret: string): string | null {
  if (!payload) return null;
  const [version, iv, tag, data] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
