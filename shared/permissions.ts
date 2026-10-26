export const permissionKeys = [
  "dashboard.view",
  "masters.manage",
  "transactions.view",
  "transactions.create",
  "transactions.submit",
  "transactions.approve",
  "transactions.post",
  "transactions.reverse",
  "reports.view",
  "accounting.manage",
  "users.manage",
  "audit.view",
] as const;
export const roleDefaults: Record<string, string[]> = {
  super_admin: [...permissionKeys],
  finance: permissionKeys.filter(
    (p) => !["users.manage", "transactions.approve"].includes(p),
  ),
  manager: [
    "dashboard.view",
    "transactions.view",
    "transactions.approve",
    "reports.view",
  ],
  employee: ["transactions.view", "transactions.create", "transactions.submit"],
  viewer: ["dashboard.view", "transactions.view", "reports.view"],
};
