// Clerk removed — stub kept for build compatibility
export const CLERK_PROXY_PATH = "/__clerk_unused";
export function clerkProxyMiddleware() {
  return (_req: any, _res: any, next: any) => next();
}
export function getClerkProxyHost(_req: any): string | undefined {
  return undefined;
}
