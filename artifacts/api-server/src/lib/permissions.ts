type PermissionMap = Record<string, unknown> | null | undefined;

type UserLike = {
  role?: string | null;
  memberId?: number | null;
  permissions?: PermissionMap;
};

type TaskLike = {
  memberId?: number | null;
  memberIds?: number[];
  members?: Array<{ id: number }>;
};

function hasPermission(user: UserLike, keys: string[]) {
  const permissions = user.permissions;
  if (!permissions || typeof permissions !== "object") return false;
  return keys.some((key) => permissions[key] === true);
}

function taskMemberIds(task: TaskLike) {
  const ids = new Set<number>();
  if (typeof task.memberId === "number") ids.add(task.memberId);
  for (const id of task.memberIds ?? []) ids.add(id);
  for (const member of task.members ?? []) ids.add(member.id);
  return ids;
}

function isAssignedToTask(user: UserLike, task: TaskLike) {
  return typeof user.memberId === "number" && taskMemberIds(task).has(user.memberId);
}

export function canViewTask(user: UserLike, task: TaskLike) {
  if (user.role === "admin") return true;
  if (hasPermission(user, ["canViewAllTasks", "viewAllTasks", "canManageTasks", "manageTasks", "tasksManage"])) return true;
  return isAssignedToTask(user, task);
}

export function canEditTask(user: UserLike, task: TaskLike) {
  if (user.role === "admin") return true;
  if (hasPermission(user, ["canEditAllTasks", "editAllTasks", "canManageTasks", "manageTasks", "tasksManage"])) return true;
  return isAssignedToTask(user, task);
}

export function canDeleteTask(user: UserLike, task: TaskLike) {
  if (user.role === "admin") return true;
  if (hasPermission(user, ["canDeleteTasks", "deleteTasks", "canManageTasks", "manageTasks", "tasksManage"])) return true;
  return isAssignedToTask(user, task);
}

export function canCreateTask(user: UserLike, memberIds: number[]) {
  if (user.role === "admin") return true;
  if (hasPermission(user, ["canCreateTasks", "createTasks", "canManageTasks", "manageTasks", "tasksManage"])) return true;
  return typeof user.memberId === "number"
    && memberIds.length > 0
    && memberIds.every((memberId) => memberId === user.memberId);
}
