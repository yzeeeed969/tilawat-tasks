# تلاوة الحرمين — نظام إدارة مهام الفريق الإعلامي

## Overview

A team task management web application for "تلاوة الحرمين" media team. Built as a pnpm monorepo with a React + Vite frontend, Express API server, and PostgreSQL database.

## Artifacts

| Artifact | Path | Description |
|---|---|---|
| `tilawat-tasks` | `/` | Main React + Vite web app |
| `api-server` | `/api` | Express 5 REST API server |
| `mockup-sandbox` | `/mockup-sandbox` | Vite component preview server (canvas) |

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **Frontend**: React 19 + Vite 6 + Tailwind CSS v4 + shadcn/ui
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec in `lib/api-spec`)
- **Auth**: Session-based (`express-session` + `SESSION_SECRET`), custom login
- **Email**: nodemailer (GMAIL_USER + GMAIL_APP_PASSWORD; gracefully skips if missing)
- **Routing** (frontend): Wouter
- **State/data**: TanStack Query v5

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Architecture

```
artifacts/
  api-server/       — Express API, Drizzle queries, session auth middleware
  tilawat-tasks/    — React + Vite SPA, Arabic RTL UI
  mockup-sandbox/   — Isolated component preview server for canvas

lib/
  api-spec/         — OpenAPI YAML spec (source of truth)
  api-zod/          — Generated Zod schemas from spec
  api-client-react/ — Generated React Query hooks from spec
  db/               — Drizzle schema, migrations, DB connection
```

## Authentication

- Session-based auth via `express-session` + `SESSION_SECRET` env var
- Users stored in `app_users` table (`username`, `password_hash`, `role`, `is_approved`, `member_id`, `email`)
- Roles: `admin` | `editor` (viewer removed permanently)
- Auth middleware: `requireAuth` (any logged-in), applied globally via route index
- Admin-only routes use `requireAdmin` middleware
- Email endpoints: `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `PATCH /api/auth/change-email`
- Password reset tokens stored in `reset_tokens` table (1hr expiry)

## Role-Based Access

| Role | Label | Permissions |
|---|---|---|
| `admin` | مدير | Full access — create/edit/delete tasks, manage users, view Members/Reports pages |
| `editor` | محرر | View own tasks, mark complete (✓ toggle only), submit URL |

- Non-admins see only their own tasks (API filters by memberId)
- Non-admins see single ✓ toggle button (no ✗, no dropdown)
- Member filter in list view is admin-only
- Calendar shows all tasks (no archive filter applied)
- Kanban board: 2 columns only (pending / completed)

## Database Schema

Tables: `tasks`, `members`, `platforms`, `platform_pages`, `task_members`, `reciters`, `comments`, `app_users`, `otp_codes`, `reset_tokens`

Key fields on tasks: `title`, `description`, `status` (pending/completed), `priority` (urgent/normal/low), `progress` (0-100), `startDate`, `endDate`, `dueDate`, `platformId`, `pageId`, `reciterId`, `recurrence`, `submissionUrl`

Platform hierarchy: `platforms.is_main` (boolean), `platform_pages` table (`id`, `platform_id` FK, `name`, `reciter_id`, `page_url`, `created_at`)

## CSS Theme

- Sidebar: dark green `HSL(160, 50%, 15%)`
- Accent/primary: gold `HSL(40, 70%, 50%)`
- Background: off-white
- Tailwind v4: `@layer theme, base, clerk, components, utilities` before `@import "tailwindcss"`

## Features

- Task CRUD with 3 date fields (البداية/النهاية/الاستحقاق), recurrence, submission URL (شاهد)
- **Priority**: urgent/normal/low per task
- **Progress**: 0–100% slider (admin dialog only)
- **Comments**: full comment thread via CommentsDialog
- **4 views**: List table | Kanban (2 cols: pending/completed) | Weekly calendar | Reciter-grouped
- **Archive toggle**: filter to show only completed tasks
- **Statistics page** (`/reports`): daily/weekly/monthly/all-time tabs, WhatsApp export
- **Auto-title**: generated from platform+page+reciter; reciter shown display-only (from page)
- **Platform pages**: URL field + reciter select; name auto-generated from reciter
- **Granular permissions**: canViewMembers/canViewReports/canCreateTasks/canEditTasks/canDeleteTasks/canManageSettings/canManageReciters/canManagePlatforms/canManageAccounts
- **"حسابي" profile dialog**: in sidebar, shows name/username/role, change password form, change email form
- **Forgot password**: email reset link flow (`/reset-password` page)
- **Welcome email**: sent on user creation if GMAIL credentials set
- **Excel import/export** on members page

## Important Files

- `artifacts/tilawat-tasks/src/pages/tasks.tsx` — main tasks page (all views, dialogs, form)
- `artifacts/tilawat-tasks/src/components/kanban-view.tsx` — Kanban board (2-col)
- `artifacts/tilawat-tasks/src/components/calendar-view.tsx` — weekly calendar view
- `artifacts/tilawat-tasks/src/components/layout.tsx` — sidebar, UserCard with profile dialog (change password + email)
- `artifacts/tilawat-tasks/src/lib/roles.ts` — `useRole`, `useIsAdmin`, `useCanEdit`, role helpers, new permission hooks
- `artifacts/tilawat-tasks/src/lib/auth-context.tsx` — AuthUser type (includes email, 9 permissions)
- `artifacts/tilawat-tasks/src/pages/settings.tsx` — members, platforms, admin user management (3 new perms)
- `artifacts/tilawat-tasks/src/pages/sign-in.tsx` — login + forgot password flow
- `artifacts/tilawat-tasks/src/pages/reset-password.tsx` — password reset page (token from email)
- `artifacts/api-server/src/routes/tasks.ts` — task CRUD (endDate, startDate, status filter)
- `artifacts/api-server/src/routes/auth.ts` — login, logout, change-password, forgot/reset-password, change-email
- `artifacts/api-server/src/routes/admin.ts` — user management (create with email, welcome email)
- `artifacts/api-server/src/services/email.ts` — nodemailer email service (reset + welcome)
- `artifacts/api-server/src/middlewares/auth.ts` — `requireAuth`, `requireAdmin`

## Gotchas

- `in_progress` status removed from UI/API layer; kept in DB enum (PostgreSQL enum cannot be modified)
- After any OpenAPI spec change run: `pnpm --filter @workspace/api-spec run codegen`
- Platform page names are auto-generated from reciter; manual name input removed from UI
- Email features require `GMAIL_USER` + `GMAIL_APP_PASSWORD` secrets; silently skipped if missing
- `reset_tokens` table was created via raw SQL (not via Drizzle push) — schema file exists at `lib/db/src/schema/reset-tokens.ts`
