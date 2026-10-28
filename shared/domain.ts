import { z } from "zod";
export const kinds = [
  "receipt",
  "transfer",
  "withdrawal",
  "expense",
  "bill",
  "invoice",
  "client_payment",
  "vendor_payment",
  "advance",
  "advance_expense",
  "advance_return",
  "asset_purchase",
  "intercompany",
  "opening",
  "adjustment",
  "depreciation",
] as const;
// Keep historical kinds readable while limiting new financial workflows.
export const retiredKinds = [
  "advance",
  "advance_expense",
  "advance_return",
  "asset_purchase",
  "depreciation",
] as const;
export const activeKinds = kinds.filter(
  (kind) => !(retiredKinds as readonly string[]).includes(kind),
);
const money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/)
  .refine(
    (v) => Number(v) > 0 && Number(v) <= 1e13,
    "Enter a positive amount up to 10 trillion",
  );
export const documentSchema = z.object({
  kind: z.enum(kinds),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: money,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("PKR"),
  rate: z
    .string()
    .regex(/^\d+(\.\d{1,8})?$/)
    .refine((v) => Number(v) > 0 && Number(v) < 1e9)
    .default("1"),
  description: z.string().trim().min(1).max(2000),
  reference: z.string().max(120).default(""),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  sourceId: z.number().int().positive().nullable().optional(),
  targetId: z.number().int().positive().nullable().optional(),
  headId: z.number().int().positive().nullable().optional(),
  contactId: z.number().int().positive().nullable().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  relatedId: z.number().int().positive().nullable().optional(),
  otherCompanyId: z.number().int().positive().nullable().optional(),
  assetName: z.string().max(150).optional(),
  usefulLife: z.number().int().min(1).max(600).optional(),
  salvage: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional(),
  openingSide: z.enum(["debit", "credit"]).default("debit"),
  targetAmount: money.optional(),
  targetRate: z
    .string()
    .regex(/^\d+(\.\d{1,8})?$/)
    .refine((v) => Number(v) > 0 && Number(v) < 1e9)
    .optional(),
});
export type DocumentInput = z.infer<typeof documentSchema>;
