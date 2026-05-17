import http from "node:http";

const json = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://localhost:5176",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
};

const ok = (res, body = { ok: true }) => json(res, 200, body);
const now = () => new Date().toISOString();

const members = [
  { id: 1, name: "أحمد محمد", role: "مصمم جرافيك", phone: "0500000001", avatarUrl: null, isActive: true, lastLoginAt: null, createdAt: new Date().toISOString() },
  { id: 2, name: "سارة عبدالله", role: "محررة فيديو", phone: "0500000002", avatarUrl: null, isActive: true, lastLoginAt: null, createdAt: new Date().toISOString() },
  { id: 3, name: "عمر خالد", role: "مدير تواصل", phone: "0500000003", avatarUrl: null, isActive: true, lastLoginAt: null, createdAt: new Date().toISOString() },
];

const reciters = [
  { id: 1, name: "عبدالرحمن السديس", mosque: "haram", createdAt: new Date().toISOString() },
  { id: 2, name: "علي الحذيفي", mosque: "nabawi", createdAt: new Date().toISOString() },
];

const platforms = [
  { id: 1, name: "يوتيوب", icon: "youtube", color: "#ff0000", isMain: true },
  { id: 2, name: "تويتر", icon: "twitter", color: "#1da1f2", isMain: false },
  { id: 3, name: "فيسبوك", icon: "facebook", color: "#1877f2", isMain: false },
];

const pages = {
  1: [
    { id: 1, platformId: 1, name: "السديس", reciterId: 1, reciter: reciters[0], pageUrl: "https://youtube.com/@example", createdAt: new Date().toISOString() },
    { id: 2, platformId: 1, name: "الحذيفي", reciterId: 2, reciter: reciters[1], pageUrl: "https://youtube.com/@example2", createdAt: new Date().toISOString() },
  ],
  2: [{ id: 3, platformId: 2, name: "السديس", reciterId: 1, reciter: reciters[0], pageUrl: "https://x.com/example", createdAt: new Date().toISOString() }],
  3: [],
};

const pageMemberIds = {
  1: [1],
  2: [2],
  3: [2, 3],
};

let tasks = [
  {
    id: 1,
    seriesId: null,
    title: "السديس - يوتيوب",
    description: "نشر مقطع تلاوة قصير مع وصف مناسب.",
    platformId: 1,
    platform: platforms[0],
    pageId: 1,
    page: pages[1][0],
    reciterId: 1,
    reciter: reciters[0],
    memberId: 1,
    members: [members[0]],
    status: "pending",
    priority: "urgent",
    progress: 20,
    startDate: null,
    endDate: null,
    dueDate: new Date(Date.now() + 86400000).toISOString(),
    completedAt: null,
    recurrence: "none",
    recurrenceIntervalDays: null,
    recurrenceDurationDays: null,
    recurrenceDays: null,
    submissionUrl: null,
    completedInstances: [],
    instanceUrls: {},
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    seriesId: null,
    title: "الحذيفي - تويتر",
    description: "تجهيز نص التغريدة وإرفاق الرابط بعد النشر.",
    platformId: 2,
    platform: platforms[1],
    pageId: 3,
    page: pages[2][0],
    reciterId: 2,
    reciter: reciters[1],
    memberId: 2,
    members: [members[1], members[2]],
    status: "completed",
    priority: "normal",
    progress: 100,
    startDate: null,
    endDate: null,
    dueDate: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    recurrence: "none",
    recurrenceIntervalDays: null,
    recurrenceDurationDays: null,
    recurrenceDays: null,
    submissionUrl: "https://x.com/example/status/1",
    completedInstances: [],
    instanceUrls: {},
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
];

let taskSeries = [];

const users = [
  {
    id: 1,
    username: "admin",
    displayName: "المدير",
    email: "admin@example.com",
    role: "admin",
    isApproved: true,
    memberId: null,
    permissions: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    username: "ahmed",
    displayName: "أحمد محمد",
    email: "ahmed@example.com",
    role: "editor",
    isApproved: true,
    memberId: 1,
    permissions: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 3,
    username: "sara",
    displayName: "سارة عبدالله",
    email: "sara@example.com",
    role: "editor",
    isApproved: true,
    memberId: 2,
    permissions: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 4,
    username: "omar",
    displayName: "عمر خالد",
    email: "omar@example.com",
    role: "editor",
    isApproved: true,
    memberId: 3,
    permissions: null,
    createdAt: new Date().toISOString(),
  },
];

let comments = {
  1: [],
  2: [],
};

let notifications = [
  { id: 1, userId: 1, type: "message", title: "مرحبًا بك", body: "هذه نسخة محلية كاملة للتجربة.", taskId: null, isRead: false, deletedAt: null, createdAt: now() },
];

const notifyAdminsTaskCompleted = (task) => {
  const adminUsers = users.filter((user) => user.role === "admin" && user.isApproved);
  const member = members.find((m) => m.id === task.memberId);
  for (const admin of adminUsers) {
    const alreadyNotified = notifications.some((notification) =>
      notification.userId === admin.id
      && notification.type === "task_completed"
      && notification.taskId === task.id
    );
    if (alreadyNotified) continue;
    notifications.unshift({
      id: nextId(notifications),
      userId: admin.id,
      type: "task_completed",
      title: `تم إكمال مهمة: ${task.title}`,
      body: [
        `العضو: ${member?.name ?? "غير معروف"}`,
        `المهمة: ${task.title}`,
        `وقت الإكمال: ${task.completedAt ?? now()}`,
        task.submissionUrl ? `الشاهد: ${task.submissionUrl}` : null,
        `فتح المهمة: /tasks/${task.id}`,
      ].filter(Boolean).join("\n"),
      taskId: task.id,
      isRead: false,
      deletedAt: null,
      createdAt: now(),
    });
  }
};

let activityLog = [
  { id: 1, userId: 1, userName: "المدير", action: "local_demo_started", entityType: "system", entityId: null, entityName: "تشغيل محلي", meta: null, createdAt: now() },
];

let currentUserId = 1;

const currentUser = () => users.find((u) => u.id === currentUserId) ?? users[0];
const hasPermission = (user, keys) => !!user?.permissions && keys.some((key) => user.permissions[key] === true);
const taskMemberIds = (task) => new Set([task.memberId, ...(task.memberIds ?? []), ...(task.members ?? []).map((m) => m.id)].filter(Boolean));
const canCreateTask = (user, memberIds) => user?.role === "admin"
  || hasPermission(user, ["canCreateTasks", "createTasks", "canManageTasks", "manageTasks", "tasksManage"])
  || (user?.memberId && memberIds.length > 0 && memberIds.every((id) => id === user.memberId));
const canViewTask = (user, task) => user?.role === "admin"
  || hasPermission(user, ["canViewAllTasks", "viewAllTasks", "canManageTasks", "manageTasks", "tasksManage"])
  || taskMemberIds(task).has(user?.memberId);
const canEditTask = (user, task) => user?.role === "admin"
  || hasPermission(user, ["canEditAllTasks", "editAllTasks", "canManageTasks", "manageTasks", "tasksManage"])
  || taskMemberIds(task).has(user?.memberId);
const canDeleteTask = (user, task) => user?.role === "admin"
  || hasPermission(user, ["canDeleteTasks", "deleteTasks", "canManageTasks", "manageTasks", "tasksManage"])
  || taskMemberIds(task).has(user?.memberId);

const nextId = (rows) => (rows.length ? Math.max(...rows.map((row) => row.id)) + 1 : 1);
const dateOnly = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};
const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
const formatDateTitle = (date) => new Intl.DateTimeFormat("ar-SA", {
  weekday: "long",
  day: "numeric",
  month: "long",
}).format(date);
const dayRange = (startValue, endValue) => {
  if (!startValue) return [];
  const start = dateOnly(startValue);
  const end = endValue ? dateOnly(endValue) : start;
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(new Date(cursor));
  }
  return dates;
};
const monthStep = (date, months) => {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() !== day) next.setDate(0);
  return next;
};
const recurrenceRange = (startValue, endValue, pattern) => {
  if (!startValue) return [];
  if (!endValue) return [dateOnly(startValue)];
  if (pattern === "weekly") {
    const start = dateOnly(startValue);
    const end = dateOnly(endValue);
    const dates = [];
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) dates.push(new Date(cursor));
    return dates;
  }
  if (pattern === "monthly") {
    const start = dateOnly(startValue);
    const end = dateOnly(endValue);
    const dates = [];
    for (let cursor = start, step = 0; cursor <= end; step += 1, cursor = monthStep(start, step)) dates.push(new Date(cursor));
    return dates;
  }
  return dayRange(startValue, endValue);
};
const upcomingOperationalDates = (startValue, pattern) => {
  if (!startValue || !["weekly", "monthly"].includes(pattern)) return [];
  const start = dateOnly(startValue);
  const today = dateOnly(now());
  const windowEnd = addDays(today, 60);
  const dates = [];
  if (pattern === "weekly") {
    for (let cursor = start; cursor <= windowEnd; cursor = addDays(cursor, 7)) {
      if (cursor >= today) dates.push(new Date(cursor));
    }
    return dates;
  }
  for (let cursor = start, step = 0; cursor <= windowEnd; step += 1, cursor = monthStep(start, step)) {
    if (cursor >= today) dates.push(new Date(cursor));
  }
  return dates;
};
const syncActiveSeries = () => {
  const threshold = addDays(dateOnly(now()), 14);
  for (const series of taskSeries) {
    if (series.status !== "active" || series.seriesType !== "operational") continue;
    if (series.generateUntil && dateOnly(series.generateUntil) > threshold) continue;
    const template = tasks
      .filter((task) => task.seriesId === series.id)
      .sort((a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime())[0];
    if (!template) continue;
    const dates = upcomingOperationalDates(series.startDate, series.recurrenceType);
    for (const date of dates) {
      if (tasks.some((task) => task.seriesId === series.id && dateOnly(task.dueDate).getTime() === date.getTime())) continue;
      tasks.unshift({
        ...template,
        id: nextId(tasks),
        title: `${series.title} - ${formatDateTitle(date)}`,
        status: "pending",
        progress: 0,
        startDate: date.toISOString(),
        endDate: date.toISOString(),
        dueDate: date.toISOString(),
        completedAt: null,
        submissionUrl: null,
        deletedAt: null,
        createdAt: now(),
      });
    }
    series.generateUntil = dates.at(-1)?.toISOString() ?? series.generateUntil;
    series.updatedAt = now();
  }
};
const allPages = () => Object.values(pages).flat();
const getPage = (id) => allPages().find((page) => page.id === id) ?? null;
const withTaskRelations = (task) => ({
  ...task,
  platform: platforms.find((p) => p.id === task.platformId) ?? task.platform ?? null,
  reciter: reciters.find((r) => r.id === task.reciterId) ?? task.reciter ?? null,
  page: task.pageId ? getPage(task.pageId) : null,
  members: task.members ?? members.filter((m) => [task.memberId].includes(m.id)),
});
const log = (action, entityType, entityId, entityName, meta = null) => {
  const user = currentUser();
  activityLog.unshift({
    id: nextId(activityLog),
    userId: user.id,
    userName: user.displayName,
    action,
    entityType,
    entityId,
    entityName,
    meta,
    createdAt: now(),
  });
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const url = new URL(req.url, "http://localhost:3001");
  const path = url.pathname;

  if (path === "/api/healthz") return json(res, 200, { ok: true });
  if (path === "/api/auth/status") return json(res, 200, { needsSetup: false });
  if (path === "/api/auth/setup") return json(res, 400, { error: "SETUP_ALREADY_DONE" });
  if (path === "/api/auth/me") return json(res, 200, currentUser());
  if (path === "/api/auth/login") {
    const body = await readBody(req);
    const requested = users.find((u) => u.username === body.username) ?? users[0];
    currentUserId = requested.id;
    return json(res, 200, currentUser());
  }
  if (path === "/api/auth/switch-account") {
    const body = await readBody(req);
    const requested = users.find((u) => u.id === Number(body.userId));
    if (!requested) return json(res, 404, { error: "الحساب غير موجود" });
    currentUserId = requested.id;
    return json(res, 200, requested);
  }
  if (path === "/api/auth/mock-users") return json(res, 200, users);
  if (path === "/api/auth/logout") return ok(res);
  if (path === "/api/auth/change-password") return ok(res);
  if (path === "/api/auth/forgot-password") return ok(res);
  if (path === "/api/auth/reset-password") return ok(res);
  if (path === "/api/auth/change-email") {
    const body = await readBody(req);
    const user = currentUser();
    user.email = body.newEmail ?? user.email;
    return ok(res, user);
  }

  if (path === "/api/members" && req.method === "GET") return json(res, 200, members);
  if (path === "/api/members" && req.method === "POST") {
    const body = await readBody(req);
    const member = { id: nextId(members), name: body.name || "عضو جديد", role: body.role || "عضو فريق", phone: body.phone ?? null, avatarUrl: body.avatarUrl ?? null, isActive: body.isActive ?? true, lastLoginAt: null, createdAt: now() };
    members.push(member);
    log("member_created", "member", member.id, member.name);
    return json(res, 201, member);
  }
  if (path.match(/^\/api\/members\/\d+$/) && req.method === "GET") {
    const member = members.find((m) => m.id === Number(path.split("/")[3]));
    return member ? json(res, 200, member) : json(res, 404, { error: "العضو غير موجود" });
  }
  if (path.match(/^\/api\/members\/\d+$/) && ["PUT", "PATCH"].includes(req.method)) {
    const id = Number(path.split("/")[3]);
    const body = await readBody(req);
    const index = members.findIndex((m) => m.id === id);
    if (index === -1) return json(res, 404, { error: "العضو غير موجود" });
    members[index] = { ...members[index], ...body };
    log("member_updated", "member", id, members[index].name);
    return json(res, 200, members[index]);
  }
  if (path.match(/^\/api\/members\/\d+$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[3]);
    const index = members.findIndex((m) => m.id === id);
    if (index !== -1) members.splice(index, 1);
    tasks = tasks.map((task) => ({ ...task, members: task.members.filter((m) => m.id !== id) }));
    log("member_deleted", "member", id, null);
    return ok(res);
  }

  if (path === "/api/platforms" && req.method === "GET") return json(res, 200, platforms);
  if (path === "/api/platforms" && req.method === "POST") {
    const body = await readBody(req);
    const platform = { id: nextId(platforms), name: body.name || "منصة جديدة", icon: body.icon || "globe", color: body.color || "#0f766e", isMain: body.isMain ?? false };
    platforms.push(platform);
    pages[platform.id] = [];
    log("platform_created", "platform", platform.id, platform.name);
    return json(res, 201, platform);
  }
  if (path.match(/^\/api\/platforms\/\d+$/) && ["PUT", "PATCH"].includes(req.method)) {
    const id = Number(path.split("/")[3]);
    const body = await readBody(req);
    const index = platforms.findIndex((p) => p.id === id);
    if (index === -1) return json(res, 404, { error: "المنصة غير موجودة" });
    platforms[index] = { ...platforms[index], ...body };
    log("platform_updated", "platform", id, platforms[index].name);
    return json(res, 200, platforms[index]);
  }
  if (path.match(/^\/api\/platforms\/\d+$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[3]);
    const index = platforms.findIndex((p) => p.id === id);
    if (index !== -1) platforms.splice(index, 1);
    delete pages[id];
    tasks = tasks.map((task) => (task.platformId === id ? { ...task, deletedAt: now() } : task));
    log("platform_deleted", "platform", id, null);
    return ok(res);
  }

  if (path === "/api/reciters" && req.method === "GET") return json(res, 200, reciters);
  if (path === "/api/reciters" && req.method === "POST") {
    const body = await readBody(req);
    const reciter = { id: nextId(reciters), name: body.name || "قارئ جديد", mosque: body.mosque || "haram", createdAt: now() };
    reciters.push(reciter);
    log("reciter_created", "reciter", reciter.id, reciter.name);
    return json(res, 201, reciter);
  }
  if (path.match(/^\/api\/reciters\/\d+$/) && req.method === "GET") {
    const reciter = reciters.find((r) => r.id === Number(path.split("/")[3]));
    return reciter ? json(res, 200, reciter) : json(res, 404, { error: "القارئ غير موجود" });
  }
  if (path.match(/^\/api\/reciters\/\d+$/) && ["PUT", "PATCH"].includes(req.method)) {
    const id = Number(path.split("/")[3]);
    const body = await readBody(req);
    const index = reciters.findIndex((r) => r.id === id);
    if (index === -1) return json(res, 404, { error: "القارئ غير موجود" });
    reciters[index] = { ...reciters[index], ...body };
    log("reciter_updated", "reciter", id, reciters[index].name);
    return json(res, 200, reciters[index]);
  }
  if (path.match(/^\/api\/reciters\/\d+$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[3]);
    const index = reciters.findIndex((r) => r.id === id);
    if (index !== -1) reciters.splice(index, 1);
    for (const group of Object.values(pages)) {
      group.forEach((page) => {
        if (page.reciterId === id) {
          page.reciterId = null;
          page.reciter = null;
        }
      });
    }
    tasks = tasks.map((task) => (task.reciterId === id ? { ...task, reciterId: null, reciter: null } : task));
    log("reciter_deleted", "reciter", id, null);
    return ok(res);
  }

  if (path.match(/^\/api\/platforms\/\d+\/pages$/) && req.method === "GET") {
    const platformId = Number(path.split("/")[3]);
    return json(res, 200, pages[platformId] ?? []);
  }
  if (path.match(/^\/api\/platforms\/\d+\/pages$/) && req.method === "POST") {
    const platformId = Number(path.split("/")[3]);
    const body = await readBody(req);
    const reciter = reciters.find((r) => r.id === body.reciterId) ?? null;
    const page = { id: nextId(allPages()), platformId, name: reciter?.name ?? "صفحة جديدة", reciterId: reciter?.id ?? null, reciter, pageUrl: body.pageUrl ?? null, createdAt: now() };
    pages[platformId] ??= [];
    pages[platformId].push(page);
    pageMemberIds[page.id] = [];
    log("page_created", "platform_page", page.id, page.name);
    return json(res, 201, page);
  }
  if (path.match(/^\/api\/platforms\/\d+\/pages\/\d+$/) && ["PUT", "PATCH"].includes(req.method)) {
    const platformId = Number(path.split("/")[3]);
    const pageId = Number(path.split("/")[5]);
    const body = await readBody(req);
    const group = pages[platformId] ?? [];
    const index = group.findIndex((page) => page.id === pageId);
    if (index === -1) return json(res, 404, { error: "الصفحة غير موجودة" });
    const reciter = reciters.find((r) => r.id === body.reciterId) ?? null;
    group[index] = { ...group[index], ...body, reciterId: body.reciterId ?? null, reciter, name: reciter?.name ?? group[index].name };
    log("page_updated", "platform_page", pageId, group[index].name);
    return json(res, 200, group[index]);
  }
  if (path.match(/^\/api\/platforms\/\d+\/pages\/\d+$/) && req.method === "DELETE") {
    const platformId = Number(path.split("/")[3]);
    const pageId = Number(path.split("/")[5]);
    pages[platformId] = (pages[platformId] ?? []).filter((page) => page.id !== pageId);
    delete pageMemberIds[pageId];
    tasks = tasks.map((task) => (task.pageId === pageId ? { ...task, pageId: null, page: null } : task));
    log("page_deleted", "platform_page", pageId, null);
    return ok(res);
  }
  if (path.match(/^\/api\/platforms\/\d+\/pages\/\d+\/members$/) && req.method === "GET") {
    const pageId = Number(path.split("/")[5]);
    return json(res, 200, pageMemberIds[pageId] ?? []);
  }
  if (path.match(/^\/api\/platforms\/\d+\/pages\/\d+\/members$/) && req.method === "PUT") {
    const pageId = Number(path.split("/")[5]);
    const body = await readBody(req);
    pageMemberIds[pageId] = Array.isArray(body.memberIds) ? body.memberIds : [];
    return json(res, 200, pageMemberIds[pageId]);
  }
  if (path === "/api/tasks" && req.method === "GET") {
    syncActiveSeries();
    const user = currentUser();
    const memberId = user.role === "admin" ? Number(url.searchParams.get("memberId")) || null : user.memberId;
    const archive = url.searchParams.get("archive") === "true" || url.searchParams.get("deleted") === "true";
    const visibleTasks = memberId
      ? tasks.filter((task) => task.members.some((member) => member.id === memberId))
      : tasks;
    return json(res, 200, visibleTasks.filter((task) => archive ? !!task.deletedAt : !task.deletedAt).map(withTaskRelations));
  }
  if (path === "/api/tasks" && req.method === "POST") {
    const body = await readBody(req);
    const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(Number))] : [];
    if (!memberIds.length || memberIds.some((id) => !Number.isInteger(id) || !members.some((m) => m.id === id))) {
      return json(res, 400, { error: "Invalid memberIds" });
    }
    if (!canCreateTask(currentUser(), memberIds)) return json(res, 403, { error: "Forbidden" });
    const seriesType = body.seriesType === "operational" ? "operational" : "temporary";
    const pattern = seriesType === "operational"
      ? (body.recurrence === "monthly" ? "monthly" : "weekly")
      : "none";
    let seriesId = null;
    const dates = seriesType === "operational"
      ? upcomingOperationalDates(body.startDate, pattern)
      : body.expandDailyInstances
        ? recurrenceRange(body.startDate, body.endDate, "none")
        : [dateOnly(body.dueDate ?? body.startDate ?? now())];
    if (dates.length === 0) return json(res, 400, { error: "تاريخ البداية مطلوب" });
    if (seriesType === "operational") {
      const series = {
        id: nextId(taskSeries),
        title: body.title || "مهمة جديدة",
        recurrenceType: pattern,
        seriesType: "operational",
        startDate: dateOnly(body.startDate).toISOString(),
        endDate: null,
        generateUntil: dates.at(-1)?.toISOString() ?? null,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      };
      taskSeries.push(series);
      seriesId = series.id;
    }
    const baseTitle = body.title || "مهمة جديدة";
    const createdTasks = dates.map((date) => {
      if (seriesId && tasks.some((task) => task.seriesId === seriesId && dateOnly(task.dueDate).getTime() === date.getTime())) {
        return null;
      }
      const task = {
        id: nextId(tasks),
        seriesId,
        title: dates.length > 1 ? `${baseTitle} - ${formatDateTitle(date)}` : baseTitle,
        description: body.description || null,
        platformId: body.platformId,
        platform: platforms.find((p) => p.id === body.platformId) ?? platforms[0],
        pageId: body.pageId ?? null,
        page: body.pageId ? getPage(body.pageId) : null,
        reciterId: body.reciterId ?? null,
        reciter: reciters.find((r) => r.id === body.reciterId) ?? null,
        memberId: memberIds[0],
        members: members.filter((m) => memberIds.includes(m.id)),
        status: "pending",
        priority: body.priority ?? "normal",
        progress: 0,
        startDate: date.toISOString(),
        endDate: date.toISOString(),
        dueDate: date.toISOString(),
        completedAt: null,
        recurrence: "none",
        recurrenceIntervalDays: null,
        recurrenceDurationDays: null,
        recurrenceDays: null,
        submissionUrl: null,
        completedInstances: [],
        instanceUrls: {},
        deletedAt: null,
        createdAt: now(),
      };
      tasks.push(task);
      return task;
    }).filter(Boolean);
    tasks = [...createdTasks.reverse(), ...tasks.filter((task) => !createdTasks.some((created) => created.id === task.id))];
    notifications.unshift({ id: nextId(notifications), userId: 1, type: "task_assigned", title: "تم إنشاء مهام جديدة", body: `${createdTasks.length} مهمة مستقلة`, taskId: createdTasks[0].id, isRead: false, deletedAt: null, createdAt: now() });
    log("task_created", "task", createdTasks[0].id, baseTitle, { count: createdTasks.length });
    return json(res, 201, withTaskRelations(createdTasks[0]));
  }
  if (path.match(/^\/api\/tasks\/\d+$/) && req.method === "GET") {
    const task = tasks.find((t) => t.id === Number(path.split("/")[3]));
    if (task && !canViewTask(currentUser(), task)) return json(res, 403, { error: "Forbidden" });
    return task ? json(res, 200, withTaskRelations(task)) : json(res, 404, { error: "المهمة غير موجودة" });
  }
  if (path.match(/^\/api\/tasks\/\d+$/) && ["PUT", "PATCH"].includes(req.method)) {
    const id = Number(path.split("/")[3]);
    const body = await readBody(req);
    const existing = tasks.find((t) => t.id === id);
    if (!existing) return json(res, 404, { error: "المهمة غير موجودة" });
    if (!canEditTask(currentUser(), existing)) return json(res, 403, { error: "Forbidden" });
    if (body.memberIds) {
      const memberIds = [...new Set(body.memberIds.map(Number))];
      if (!memberIds.length || memberIds.some((mId) => !Number.isInteger(mId) || !members.some((m) => m.id === mId))) return json(res, 400, { error: "Invalid memberIds" });
      if (!canCreateTask(currentUser(), memberIds)) return json(res, 403, { error: "Forbidden" });
      body.memberIds = memberIds;
    }
    const wasCompleted = existing.status === "completed";
    tasks = tasks.map((t) => {
      if (t.id !== id) return t;
      const assignedMembers = body.memberIds ? members.filter((m) => body.memberIds.includes(m.id)) : t.members;
      return { ...t, ...body, members: assignedMembers, memberId: assignedMembers[0]?.id ?? t.memberId, status: body.status ?? t.status, completedAt: body.status === "completed" ? now() : t.completedAt };
    });
    const task = tasks.find((t) => t.id === id);
    if (body.status === "completed" && !wasCompleted) notifyAdminsTaskCompleted(task);
    log("task_updated", "task", id, task?.title ?? null);
    return json(res, 200, withTaskRelations(task));
  }
  if (path.match(/^\/api\/tasks\/\d+\/duplicate$/) && req.method === "POST") {
    const id = Number(path.split("/")[3]);
    const original = tasks.find((t) => t.id === id);
    if (!original) return json(res, 404, { error: "المهمة غير موجودة" });
    if (!canViewTask(currentUser(), original) || !canCreateTask(currentUser(), [...taskMemberIds(original)])) return json(res, 403, { error: "Forbidden" });
    const duplicate = { ...original, id: nextId(tasks), title: `${original.title} - نسخة`, status: "pending", progress: 0, completedAt: null, deletedAt: null, createdAt: now() };
    tasks.unshift(duplicate);
    log("task_duplicated", "task", duplicate.id, duplicate.title);
    return json(res, 201, withTaskRelations(duplicate));
  }
  if (path.match(/^\/api\/tasks\/\d+\/restore$/) && req.method === "POST") {
    const id = Number(path.split("/")[3]);
    const existing = tasks.find((t) => t.id === id);
    if (!existing) return json(res, 404, { error: "المهمة غير موجودة" });
    if (!canDeleteTask(currentUser(), existing)) return json(res, 403, { error: "Forbidden" });
    tasks = tasks.map((t) => (t.id === id ? { ...t, deletedAt: null } : t));
    log("task_restored", "task", id, null);
    return json(res, 200, withTaskRelations(tasks.find((t) => t.id === id)));
  }
  if (path.match(/^\/api\/tasks\/\d+\/permanent$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[3]);
    const existing = tasks.find((t) => t.id === id);
    if (!existing) return json(res, 404, { error: "المهمة غير موجودة" });
    if (!canDeleteTask(currentUser(), existing)) return json(res, 403, { error: "Forbidden" });
    tasks = existing.seriesId
      ? tasks.map((t) => (t.id === id ? { ...t, deletedAt: now() } : t))
      : tasks.filter((t) => t.id !== id);
    delete comments[id];
    log("task_permanent_deleted", "task", id, null);
    return ok(res);
  }
  if (path.match(/^\/api\/tasks\/\d+\/instance-url$/) && req.method === "PATCH") {
    const id = Number(path.split("/")[3]);
    const body = await readBody(req);
    tasks = tasks.map((t) => (t.id === id ? { ...t, submissionUrl: body.url ?? body.submissionUrl ?? t.submissionUrl } : t));
    const task = tasks.find((t) => t.id === id);
    log("task_submission_url_updated", "task", id, task?.title ?? null);
    return json(res, 200, withTaskRelations(task));
  }
  if (path.match(/^\/api\/tasks\/\d+\/complete-instance$/) && req.method === "PATCH") {
    const id = Number(path.split("/")[3]);
    const body = await readBody(req);
    const existing = tasks.find((t) => t.id === id);
    const wasCompleted = existing?.status === "completed";
    tasks = tasks.map((t) => (t.id === id ? {
      ...t,
      submissionUrl: body.url ?? body.submissionUrl ?? t.submissionUrl,
      status: "completed",
      progress: 100,
      completedAt: new Date().toISOString(),
    } : t));
    const task = tasks.find((t) => t.id === id);
    if (task && !wasCompleted) notifyAdminsTaskCompleted(task);
    log("task_completed", "task", id, task?.title ?? null);
    return json(res, 200, withTaskRelations(task));
  }
  if (path.match(/^\/api\/tasks\/\d+$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[3]);
    const existing = tasks.find((t) => t.id === id);
    if (!existing) return json(res, 404, { error: "المهمة غير موجودة" });
    if (!canDeleteTask(currentUser(), existing)) return json(res, 403, { error: "Forbidden" });
    tasks = tasks.map((t) => (t.id === id ? { ...t, deletedAt: new Date().toISOString() } : t));
    return ok(res);
  }
  if (path.match(/^\/api\/tasks\/\d+\/comments$/) && req.method === "GET") {
    const taskId = Number(path.split("/")[3]);
    return json(res, 200, comments[taskId] ?? []);
  }
  if (path.match(/^\/api\/tasks\/\d+\/comments$/) && req.method === "POST") {
    const taskId = Number(path.split("/")[3]);
    const body = await readBody(req);
    const user = currentUser();
    comments[taskId] ??= [];
    const comment = { id: nextId(Object.values(comments).flat()), taskId, memberId: user.memberId, authorName: user.displayName, content: body.content || "", createdAt: now() };
    comments[taskId].push(comment);
    log("comment_created", "comment", comment.id, null);
    return json(res, 201, comment);
  }
  if (path.match(/^\/api\/tasks\/\d+\/comments\/\d+$/) && req.method === "DELETE") {
    const taskId = Number(path.split("/")[3]);
    const commentId = Number(path.split("/")[5]);
    comments[taskId] = (comments[taskId] ?? []).filter((comment) => comment.id !== commentId);
    log("comment_deleted", "comment", commentId, null);
    return ok(res);
  }

  if (path === "/api/notifications" && req.method === "GET") {
    const archive = url.searchParams.get("archive") === "true";
    return json(res, 200, notifications.filter((notification) => archive ? !!notification.deletedAt : !notification.deletedAt));
  }
  if (path === "/api/notifications/read-all" && req.method === "POST") {
    notifications = notifications.map((notification) => ({ ...notification, isRead: true }));
    return ok(res);
  }
  if (path.match(/^\/api\/notifications\/\d+$/) && req.method === "PATCH") {
    const id = Number(path.split("/")[3]);
    notifications = notifications.map((notification) => (notification.id === id ? { ...notification, isRead: true } : notification));
    return ok(res, notifications.find((notification) => notification.id === id));
  }
  if (path.match(/^\/api\/notifications\/\d+$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[3]);
    notifications = notifications.map((notification) => (notification.id === id ? { ...notification, deletedAt: now() } : notification));
    return ok(res);
  }
  if (path === "/api/notifications" && req.method === "DELETE") {
    notifications = notifications.map((notification) => ({ ...notification, deletedAt: now() }));
    return ok(res);
  }
  if (path === "/api/stats/overview") return json(res, 200, {
    totalTasks: tasks.length,
    completedTasks: tasks.filter((t) => t.status === "completed").length,
    pendingTasks: tasks.filter((t) => t.status !== "completed").length,
    completionRate: Math.round((tasks.filter((t) => t.status === "completed").length / Math.max(tasks.length, 1)) * 100),
  });
  if (path === "/api/stats/members") return json(res, 200, members.map((member) => {
    const assigned = tasks.filter((task) => task.members.some((m) => m.id === member.id) && !task.deletedAt);
    return { member, memberId: member.id, memberName: member.name, totalTasks: assigned.length, completedTasks: assigned.filter((task) => task.status === "completed").length };
  }));
  if (path === "/api/stats/platforms") return json(res, 200, platforms.map((platform) => {
    const assigned = tasks.filter((task) => task.platformId === platform.id && !task.deletedAt);
    return { platform, platformId: platform.id, platformName: platform.name, totalTasks: assigned.length, completedTasks: assigned.filter((task) => task.status === "completed").length };
  }));
  if (path === "/api/stats/reciters") return json(res, 200, reciters.map((reciter) => {
    const assigned = tasks.filter((task) => task.reciterId === reciter.id && !task.deletedAt);
    return { reciter, reciterId: reciter.id, reciterName: reciter.name, totalTasks: assigned.length, completedTasks: assigned.filter((task) => task.status === "completed").length };
  }));
  if (path === "/api/admin/users" && req.method === "GET") return json(res, 200, users);
  if (path === "/api/admin/users" && req.method === "POST") {
    const body = await readBody(req);
    const user = { id: nextId(users), username: body.username || `user${nextId(users)}`, displayName: body.displayName || body.username || "مستخدم جديد", email: body.email ?? null, role: body.role || "editor", isApproved: body.isApproved ?? true, memberId: body.memberId ?? null, permissions: body.permissions ?? null, createdAt: now() };
    users.push(user);
    log("user_created", "user", user.id, user.displayName);
    return json(res, 201, user);
  }
  if (path.match(/^\/api\/admin\/users\/\d+$/) && ["PUT", "PATCH"].includes(req.method)) {
    const id = Number(path.split("/")[4]);
    const body = await readBody(req);
    const index = users.findIndex((u) => u.id === id);
    if (index === -1) return json(res, 404, { error: "الحساب غير موجود" });
    users[index] = { ...users[index], ...body };
    log("user_updated", "user", id, users[index].displayName);
    return json(res, 200, users[index]);
  }
  if (path.match(/^\/api\/admin\/users\/\d+$/) && req.method === "DELETE") {
    const id = Number(path.split("/")[4]);
    const index = users.findIndex((u) => u.id === id);
    if (index !== -1 && id !== 1) users.splice(index, 1);
    log("user_deleted", "user", id, null);
    return ok(res);
  }
  if (path === "/api/activity-log") return json(res, 200, activityLog);

  return json(res, 404, { error: "Mock endpoint not found", path });
});

server.listen(3001, "0.0.0.0", () => {
  console.log("Mock API ready on http://localhost:3001");
});
