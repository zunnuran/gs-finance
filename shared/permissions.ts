export const permissionKeys = [
  "dashboard.view",
  "masters.manage",
  "transactions.view",
  "transactions.create",
  "transactions.post",
  "transactions.reverse",
  "reports.view",
  "accounting.manage",
  "users.manage",
  "audit.view",
] as const;
export const roleDefaults: Record<string, string[]> = {
  super_admin: [...permissionKeys],
  finance: permissionKeys.filter((p) => p !== "users.manage"),
  manager: ["dashboard.view", "transactions.view", "reports.view"],
  employee: ["transactions.view", "transactions.create"],
  viewer: ["dashboard.view", "transactions.view", "reports.view"],
};
