import type { Request } from "express";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getPublicAppUrl(req?: Request) {
  const explicit =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.WEB_URL;

  if (explicit?.trim()) return trimTrailingSlash(explicit.trim());

  if (process.env.RAILWAY_PUBLIC_DOMAIN?.trim()) {
    return `https://${trimTrailingSlash(process.env.RAILWAY_PUBLIC_DOMAIN.trim())}`;
  }

  if (req) return trimTrailingSlash(`${req.protocol}://${req.get("host")}`);

  return "";
}

export function getTaskUrl(taskId: number | string) {
  const baseUrl = getPublicAppUrl();
  return baseUrl ? `${baseUrl}/tasks/${taskId}` : `/tasks/${taskId}`;
}
