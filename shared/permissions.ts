export const permissionKeys = [
  "dashboard.view",
  "masters.manage",
  "transactions.view",
  "transactions.create",
  "transactions.purchase_assets",
  "transactions.post",
  "transactions.reverse",
  "reports.view",
  "accounting.manage",
  "users.manage",
  "audit.view",
] as const;
export const permissionDetails: Record<
  (typeof permissionKeys)[number],
  { label: string; description: string }
> = {
  "dashboard.view": {
    label: "View dashboard",
    description: "View the company's financial overview.",
  },
  "masters.manage": {
    label: "Manage accounts, categories & contacts",
    description:
      "Add and edit bank/cash accounts, accounting accounts, categories, clients and vendors.",
  },
  "transactions.view": {
    label: "View transactions",
    description: "View transactions within the user's data visibility.",
  },
  "transactions.create": {
    label: "Create transactions",
    description:
      "Save pending transactions. Accounting adjustments also require accounting access below.",
  },
  "transactions.post": {
    label: "Post transactions",
    description:
      "Post pending entries to update balances. Accounting adjustments also require accounting access below.",
  },
  "transactions.purchase_assets": {
    label: "Record asset purchases",
    description:
      "Record paid asset purchases. Own-data users can pay only from their assigned cash. Also requires Create transactions to save and Post transactions to post; it does not grant company-wide access.",
  },
  "transactions.reverse": {
    label: "Reverse transactions",
    description: "Reverse posted transactions while preserving their history.",
  },
  "reports.view": {
    label: "View reports",
    description: "View and export company financial reports.",
  },
  "accounting.manage": {
    label: "Accounting adjustments & opening balances",
    description:
      "Also includes Chart of accounts and Company settings. Requires company data visibility, Create transactions to save entries, and Post transactions to post them.",
  },
  "users.manage": {
    label: "Manage users & permissions",
    description:
      "Manage staff, roles, company access and individual permission overrides.",
  },
  "audit.view": {
    label: "View audit trail",
    description: "View the history of changes to company records.",
  },
};
export const roleDefaults: Record<string, string[]> = {
  super_admin: [...permissionKeys],
  // Staff asset-purchase access is granted explicitly, separately from data visibility.
  finance: permissionKeys.filter(
    (p) => !["users.manage", "transactions.purchase_assets"].includes(p),
  ),
  manager: ["dashboard.view", "transactions.view", "reports.view"],
  employee: ["transactions.view", "transactions.create"],
  viewer: ["dashboard.view", "transactions.view", "reports.view"],
};
