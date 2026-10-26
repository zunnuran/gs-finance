import type {
  Express,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pool, transaction, type Connection } from "./db";
import { authenticated, requirePermission, canAccess } from "./auth";
import {
  audit,
  createCompany,
  createDocument,
  postDocument,
  reverseDocument,
  fail,
  value,
} from "./accounting";
import { reports } from "./reports";
import { permissionKeys } from "../shared/permissions";
import Decimal from "decimal.js";
import { documentSchema } from "../shared/domain";
import { administrator } from "./config";
import {
  assertOwnDocument,
  assertOwnInput,
  denyScope,
  documentInput,
  ownBootstrap,
  ownCashBalances,
  ownContext,
  ownDocumentWhere,
  redactOwnDocument,
} from "./access";
const route =
  (fn: (req: Request, res: Response) => Promise<any>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
const id = (s: any) => z.coerce.number().int().positive().parse(s);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "Invalid date",
  );
const name = z.string().trim().min(1).max(150);
// Explicit next() wrapper, since successful guards must continue routing.
const scoped: RequestHandler = (req, res, next) => {
  Promise.resolve()
    .then(async () => {
      if (!(await canAccess(req.actor, id(req.params.company))))
        res.status(403).json({ message: "Company access denied" });
      else next();
    })
    .catch(next);
};
const masterSchemas = {
  accounts: z.object({
    code: z.string().min(1).max(30),
    name,
    type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
    purpose: z.enum(["general", "bank", "cash"]).default("general"),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("PKR"),
    custodian_id: z.number().int().positive().nullable().optional(),
    parent_id: z.number().int().positive().nullable().optional(),
    active: z.boolean().default(true),
    restricted: z.boolean().optional(),
  }),
  contacts: z.object({
    name,
    kind: z.enum(["customer", "vendor", "employee"]),
    email: z.string().max(200).default(""),
    phone: z.string().max(100).default(""),
    tax_number: z.string().max(100).default(""),
    bank_details: z.string().max(1000).default(""),
    active: z.boolean().default(true),
  }),
  projects: z.object({ name, active: z.boolean().default(true) }),
  categories: z.object({
    name,
    parent_id: z.number().int().positive().nullable().optional(),
    account_id: z.number().int().positive(),
    position: z.number().int().min(0).default(0),
    active: z.boolean().default(true),
  }),
};
export function registerRoutes(app: Express) {
  app.use("/api", (req, res, next) => {
    if (["/login", "/logout", "/auth/user"].includes(req.path)) next();
    else authenticated(req, res, next);
  });
  app.get(
    "/api/companies",
    route(async (req, res) =>
      res.json(
        (
          await pool.query(
            "SELECT c.* FROM companies c WHERE $2='super_admin' OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=c.id AND m.user_id=$1) ORDER BY c.id",
            [req.actor.id, req.actor.role],
          )
        ).rows,
      ),
    ),
  );
  app.post(
    "/api/companies",
    requirePermission("masters.manage"),
    route(async (req, res) =>
      res.json(
        await transaction((c) =>
          createCompany(
            c,
            req.actor.id,
            z.object({ name }).parse(req.body).name,
          ),
        ),
      ),
    ),
  );
  app.patch(
    "/api/companies/:company",
    scoped,
    requirePermission("accounting.manage"),
    route(async (req, res) => {
      const d = z
        .object({
          name,
          approvals: z.boolean(),
          locked_through: day.nullable(),
        })
        .parse(req.body);
      res.json(
        await transaction(async (c) => {
          const before = (
            await c.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [
              id(req.params.company),
            ])
          ).rows[0];
          const row = (
            await c.query(
              "UPDATE companies SET name=$1,approvals=$2,locked_through=$3 WHERE id=$4 RETURNING *",
              [d.name, d.approvals, d.locked_through, id(req.params.company)],
            )
          ).rows[0];
          await audit(
            c,
            row.id,
            req.actor.id,
            "update",
            "company",
            row.id,
            before,
            row,
          );
          return row;
        }),
      );
    }),
  );
  app.use("/api/c/:company", scoped);
  app.use("/api/c/:company", (req, res, next) => {
    if (
      req.actor.dataScope === "own" &&
      !/^\/(bootstrap|my-cash|documents(?:\/.*)?)$/.test(req.path)
    )
      return void res.status(403).json({
        message: "Company-wide data is not available with own-data access",
      });
    next();
  });
  app.get(
    "/api/c/:company/my-cash",
    requirePermission("transactions.view"),
    route(async (req, res) => {
      res.json(await ownCashBalances(pool, req.actor, id(req.params.company)));
    }),
  );
  app.get(
    "/api/c/:company/bootstrap",
    route(async (req, res) => {
      const company = id(req.params.company),
        data: Record<string, any> = {};
      if (req.actor.dataScope === "own") {
        res.json(await ownBootstrap(pool, req.actor, company));
        return;
      }
      for (const table of ["accounts", "contacts", "projects", "categories"])
        data[table] = (
          await pool.query(
            `SELECT * FROM ${table} WHERE company_id=$1 ORDER BY id`,
            [company],
          )
        ).rows;
      if (!req.actor.permissions.includes("masters.manage"))
        data.contacts = data.contacts.map(
          ({ bank_details, tax_number, ...contact }: any) => contact,
        );
      data.company = (
        await pool.query("SELECT * FROM companies WHERE id=$1", [company])
      ).rows[0];
      res.json(data);
    }),
  );
  for (const [table, schema] of Object.entries(masterSchemas)) {
    for (const method of ["post", "patch"] as const)
      app[method](
        `/api/c/:company/${table}${method === "patch" ? "/:id" : ""}`,
        requirePermission("masters.manage"),
        route(async (req, res) => {
          const company = id(req.params.company),
            d = schema.parse(req.body) as Record<string, any>;
          res.json(
            await transaction(async (c) => {
              let before: any = null;
              if (method === "patch")
                before =
                  (
                    await c.query(
                      `SELECT * FROM ${table} WHERE id=$1 AND company_id=$2 FOR UPDATE`,
                      [id(req.params.id), company],
                    )
                  ).rows[0] ?? fail("Record not found");
              if (table === "accounts") {
                if (["bank", "cash"].includes(d.purpose) && d.type !== "asset")
                  fail("Bank and cash accounts must be assets");
                if (
                  before &&
                  !["bank", "cash", "general"].includes(before.purpose)
                ) {
                  d.purpose = before.purpose;
                  if (before.type !== d.type)
                    fail("System account type cannot change");
                }
                if (
                  before &&
                  (before.currency !== d.currency ||
                    before.type !== d.type ||
                    before.purpose !== d.purpose) &&
                  (
                    await c.query(
                      "SELECT 1 FROM journal_lines WHERE account_id=$1 LIMIT 1",
                      [before.id],
                    )
                  ).rows.length
                )
                  fail("Cannot change currency, purpose or type after posting");
                if (
                  before &&
                  before.custodian_id !== (d.custodian_id ?? null) &&
                  (
                    await c.query(
                      "SELECT 1 FROM journal_lines WHERE account_id=$1 LIMIT 1",
                      [before.id],
                    )
                  ).rows.length
                )
                  fail(
                    "Create a new cash account and transfer the balance to change custody",
                  );
                if (
                  d.custodian_id &&
                  !(
                    await c.query(
                      "SELECT 1 FROM contacts WHERE id=$1 AND company_id=$2 AND kind='employee' AND active",
                      [d.custodian_id, company],
                    )
                  ).rows.length
                )
                  fail("Select an active employee custodian");
              }
              if (
                table === "contacts" &&
                before &&
                before.kind !== d.kind &&
                (
                  await c.query(
                    "SELECT 1 FROM documents WHERE contact_id=$1 UNION ALL SELECT 1 FROM accounts WHERE custodian_id=$1 UNION ALL SELECT 1 FROM user_contacts WHERE contact_id=$1 LIMIT 1",
                    [before.id],
                  )
                ).rows.length
              )
                fail(
                  "Contact type cannot change after use in transactions or cash custody",
                );
              if (table === "categories") {
                if (
                  !(
                    await c.query(
                      "SELECT 1 FROM accounts WHERE id=$1 AND company_id=$2 AND active AND (type='expense' OR purpose='fixed_asset')",
                      [d.account_id, company],
                    )
                  ).rows.length
                )
                  fail(
                    "Category must map to an expense or fixed asset account",
                  );
                if (d.parent_id) {
                  const parents = (
                    await c.query(
                      "WITH RECURSIVE chain AS (SELECT id,parent_id FROM categories WHERE id=$1 AND company_id=$2 UNION SELECT p.id,p.parent_id FROM categories p JOIN chain x ON p.id=x.parent_id) SELECT id FROM chain",
                      [d.parent_id, company],
                    )
                  ).rows;
                  if (
                    !parents.length ||
                    parents.some((p) => p.id === before?.id)
                  )
                    fail("Category hierarchy cannot contain a cycle");
                }
              }
              if (table === "accounts" && d.parent_id) {
                const parents = (
                  await c.query(
                    "WITH RECURSIVE chain AS (SELECT id,parent_id FROM accounts WHERE id=$1 AND company_id=$2 UNION SELECT p.id,p.parent_id FROM accounts p JOIN chain x ON p.id=x.parent_id) SELECT id FROM chain",
                    [d.parent_id, company],
                  )
                ).rows;
                if (!parents.length || parents.some((p) => p.id === before?.id))
                  fail("Account hierarchy cannot contain a cycle");
              }
              const keys = Object.keys(d),
                values = Object.values(d);
              const q =
                method === "post"
                  ? `INSERT INTO ${table}(company_id,${keys.join(",")}) VALUES($1,${keys.map((_, i) => "$" + (i + 2)).join(",")}) RETURNING *`
                  : `UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(",")} WHERE id=$${keys.length + 1} AND company_id=$${keys.length + 2} RETURNING *`;
              const row = (
                await c.query(
                  q,
                  method === "post"
                    ? [company, ...values]
                    : [...values, id(req.params.id), company],
                )
              ).rows[0];
              await audit(
                c,
                company,
                req.actor.id,
                method === "post" ? "create" : "update",
                table,
                row.id,
                before,
                row,
              );
              return row;
            }),
          );
        }),
      );
  }
  app.get(
    "/api/c/:company/documents",
    requirePermission("transactions.view"),
    route(async (req, res) => {
      const company = id(req.params.company);
      if (req.actor.dataScope === "own") {
        const context = await ownContext(pool, req.actor, company);
        const docs = (
          await pool.query(
            `SELECT d.*,false inbound,ct.name contact_name,p.name project_name,u.full_name creator,
          COALESCE((SELECT sum(a.amount) FROM allocations a JOIN documents x ON x.id=a.document_id WHERE a.related_id=d.id AND x.status='posted'),0) allocated,
          COALESCE((SELECT sum(a.base_amount) FROM allocations a JOIN documents x ON x.id=a.document_id WHERE a.related_id=d.id AND x.status='posted'),0) allocated_base
          FROM documents d LEFT JOIN contacts ct ON ct.id=d.contact_id LEFT JOIN projects p ON p.id=d.project_id JOIN users u ON u.id=d.created_by
          WHERE ${ownDocumentWhere} ORDER BY d.date DESC,d.id DESC`,
            [company, req.actor.id],
          )
        ).rows;
        res.json(docs.map((d) => redactOwnDocument(d, req.actor, context)));
        return;
      }
      res.json(
        (
          await pool.query(
            `SELECT d.*,d.company_id<>$1 inbound,ct.name contact_name,p.name project_name,u.full_name creator,COALESCE((SELECT sum(a.amount) FROM allocations a JOIN documents x ON x.id=a.document_id WHERE a.related_id=d.id AND x.status='posted'),0) allocated,COALESCE((SELECT sum(a.base_amount) FROM allocations a JOIN documents x ON x.id=a.document_id WHERE a.related_id=d.id AND x.status='posted'),0) allocated_base FROM documents d LEFT JOIN contacts ct ON ct.id=d.contact_id LEFT JOIN projects p ON p.id=d.project_id JOIN users u ON u.id=d.created_by WHERE (d.company_id=$1 OR (d.other_company_id=$1 AND d.status IN ('posted','reversed'))) AND ($2::integer IS NULL OR d.created_by=$2) ORDER BY d.date DESC,d.id DESC`,
            [company, null],
          )
        ).rows,
      );
    }),
  );
  app.post(
    "/api/c/:company/documents",
    requirePermission("transactions.create"),
    route(async (req, res) => {
      if (
        req.actor.dataScope !== "own" &&
        req.actor.role === "employee" &&
        !["expense", "advance"].includes(req.body.kind)
      )
        fail("Employees can submit expenses and advances");
      if (
        ["opening", "adjustment", "depreciation"].includes(req.body.kind) &&
        !req.actor.permissions.includes("accounting.manage")
      )
        fail("Accounting permission is required");
      if (
        req.body.otherCompanyId &&
        !(await canAccess(req.actor, id(req.body.otherCompanyId)))
      )
        fail("Receiving company access required");
      res.json(
        await transaction(async (c) => {
          const input = documentSchema.parse(req.body);
          await assertOwnInput(c, req.actor, id(req.params.company), input);
          return createDocument(c, id(req.params.company), req.actor.id, input);
        }),
      );
    }),
  );
  app.patch(
    "/api/c/:company/documents/:id",
    requirePermission("transactions.create"),
    route(async (req, res) =>
      res.json(
        await transaction(async (c) => {
          const company = id(req.params.company),
            doc = id(req.params.id),
            d = documentSchema.parse(req.body);
          await assertOwnDocument(c, req.actor, company, doc, true);
          await assertOwnInput(c, req.actor, company, d);
          const before =
            (
              await c.query(
                "SELECT * FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE",
                [doc, company],
              )
            ).rows[0] ?? fail("Document not found");
          if (!["draft", "rejected"].includes(before.status))
            fail("Only drafts and rejected transactions can be edited");
          if (
            req.actor.dataScope !== "own" &&
            req.actor.role === "employee" &&
            (before.created_by !== req.actor.id ||
              !["expense", "advance"].includes(d.kind))
          )
            fail("Employees can edit their own expense or advance submissions");
          if (
            ["opening", "adjustment", "depreciation"].includes(d.kind) &&
            !req.actor.permissions.includes("accounting.manage")
          )
            fail("Accounting permission is required");
          if (
            d.otherCompanyId &&
            !(await canAccess(req.actor, d.otherCompanyId))
          )
            fail("Receiving company access required");
          if (
            new Date(d.date).toISOString().slice(0, 10) !== d.date ||
            (d.currency === "PKR" && !new Decimal(d.rate).eq(1))
          )
            fail("Check date and exchange rate");
          if (
            d.dueDate &&
            (new Date(d.dueDate).toISOString().slice(0, 10) !== d.dueDate ||
              d.dueDate < d.date)
          )
            fail("Due date must be on or after transaction date");
          const extra = {
            assetName: d.assetName,
            usefulLife: d.usefulLife,
            salvage: d.salvage,
            openingSide: d.openingSide,
            targetAmount: d.targetAmount,
            targetRate: d.targetRate,
          };
          const row = (
            await c.query(
              `UPDATE documents SET kind=$1,date=$2,amount=$3,currency=$4,rate=$5,base_amount=$6,description=$7,reference=$8,due_date=$9,source_id=$10,target_id=$11,head_id=$12,contact_id=$13,project_id=$14,category_id=$15,related_id=$16,other_company_id=$17,extra=$18,status='draft',approved_by=NULL WHERE id=$19 RETURNING *`,
              [
                d.kind,
                d.date,
                d.amount,
                d.currency,
                d.rate,
                value(new Decimal(d.amount).mul(d.rate)),
                d.description,
                d.reference,
                d.dueDate,
                d.sourceId,
                d.targetId,
                d.headId,
                d.contactId,
                d.projectId,
                d.categoryId,
                d.relatedId,
                d.otherCompanyId,
                extra,
                doc,
              ],
            )
          ).rows[0];
          await audit(
            c,
            company,
            req.actor.id,
            "edit",
            "document",
            doc,
            before,
            row,
          );
          return row;
        }),
      ),
    ),
  );
  app.post(
    "/api/c/:company/documents/:id/:action(submit|approve|reject|cancel|post|reverse)",
    route(async (req, res) => {
      const action = z
          .enum(["submit", "approve", "reject", "cancel", "post", "reverse"])
          .parse(req.params.action),
        company = id(req.params.company),
        doc = id(req.params.id);
      const required = {
        submit: "transactions.submit",
        approve: "transactions.approve",
        reject: "transactions.approve",
        cancel: "transactions.create",
        post: "transactions.post",
        reverse: "transactions.reverse",
      }[action];
      if (!req.actor.permissions.includes(required))
        return res.status(403).json({ message: "Permission denied" });
      res.json(
        await transaction(async (c) => {
          if (action === "post" || action === "reverse")
            await c.query("SELECT id FROM companies ORDER BY id FOR UPDATE");
          await assertOwnDocument(c, req.actor, company, doc, true);
          if (req.actor.dataScope === "own") {
            const current = (
              await c.query(
                "SELECT * FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE",
                [doc, company],
              )
            ).rows[0];
            if (!current) denyScope();
            await assertOwnInput(c, req.actor, company, documentInput(current));
          }
          if (action === "post" || action === "reverse") {
            // Stable company locks also make two-company posting/reversal atomic without deadlocks.
            const d =
              (
                await c.query(
                  "SELECT * FROM documents WHERE id=$1 AND company_id=$2",
                  [doc, company],
                )
              ).rows[0] ?? fail("Transaction not found");
            if (
              d.other_company_id &&
              !(await canAccess(req.actor, d.other_company_id))
            )
              fail("Receiving company access required");
            if (
              ["opening", "adjustment", "depreciation"].includes(d.kind) &&
              !req.actor.permissions.includes("accounting.manage")
            )
              fail("Accounting permission is required");
            if (action === "post")
              return postDocument(c, company, req.actor.id, doc);
            await reverseDocument(
              c,
              company,
              req.actor.id,
              doc,
              day.parse(req.body.date),
            );
            return { success: true };
          }
          const d =
            (
              await c.query(
                "SELECT * FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE",
                [doc, company],
              )
            ).rows[0] ?? fail("Transaction not found");
          if (
            req.actor.role === "employee" &&
            d.created_by !== req.actor.id &&
            !["approve", "reject"].includes(action)
          )
            fail("Only your own submissions can be changed");
          if (
            ["approve", "reject"].includes(action) &&
            d.status !== "submitted"
          )
            fail("Only submitted transactions can be approved or rejected");
          if (action === "submit" && !["draft", "rejected"].includes(d.status))
            fail("Only drafts or rejected transactions can be submitted");
          if (
            action === "cancel" &&
            !["draft", "rejected", "submitted", "approved"].includes(d.status)
          )
            fail("Posted transactions require reversal");
          const status = (
            {
              submit: "submitted",
              approve: "approved",
              reject: "rejected",
              cancel: "cancelled",
            } as Record<string, string>
          )[action];
          await c.query(
            "UPDATE documents SET status=$1,approved_by=$2 WHERE id=$3",
            [status, action === "approve" ? req.actor.id : null, doc],
          );
          await audit(c, company, req.actor.id, action, "document", doc, d, {
            status,
          });
          return { success: true };
        }),
      );
    }),
  );
  app.get(
    "/api/c/:company/reports",
    route(async (req, res) => {
      if (
        !req.actor.permissions.some((p) =>
          ["reports.view", "dashboard.view"].includes(p),
        )
      )
        return res.status(403).json({ message: "Permission denied" });
      const from = day.parse(
          req.query.from || new Date().toISOString().slice(0, 7) + "-01",
        ),
        to = day.parse(req.query.to || new Date().toISOString().slice(0, 10));
      if (from > to) fail("Start date must precede end date");
      const result = await reports(
        pool,
        id(req.params.company),
        from,
        to,
        req.query.project ? id(req.query.project) : null,
      );
      res.json(
        req.actor.permissions.includes("reports.view")
          ? result
          : { summary: result.summary, cashPosition: result.cashPosition },
      );
    }),
  );
  app.get(
    "/api/c/:company/audit",
    requirePermission("audit.view"),
    route(async (req, res) =>
      res.json(
        (
          await pool.query(
            "SELECT a.*,u.full_name FROM audit a JOIN users u ON u.id=a.user_id WHERE a.company_id=$1 OR (a.company_id IS NULL AND $2) ORDER BY a.id DESC LIMIT 500",
            [
              id(req.params.company),
              req.actor.permissions.includes("users.manage"),
            ],
          )
        ).rows,
      ),
    ),
  );
  app.get(
    "/api/c/:company/assets",
    requirePermission("transactions.view"),
    route(async (req, res) =>
      res.json(
        (
          await pool.query(
            `SELECT a.*,COALESCE((SELECT sum(d.base_amount) FROM documents d WHERE d.related_id=a.document_id AND d.kind='depreciation' AND d.status='posted'),0) depreciated FROM assets a WHERE a.company_id=$1 ORDER BY a.id DESC`,
            [id(req.params.company)],
          )
        ).rows,
      ),
    ),
  );
  app.post(
    "/api/c/:company/assets/:id/depreciate",
    requirePermission("accounting.manage"),
    route(async (req, res) =>
      res.json(
        await transaction(async (c) => {
          const company = id(req.params.company),
            date = day.parse(req.body.date);
          await c.query("SELECT id FROM companies ORDER BY id FOR UPDATE");
          const co = (
            await c.query("SELECT * FROM companies WHERE id=$1", [company])
          ).rows[0];
          if (co.locked_through && date <= co.locked_through)
            fail("Period is locked");
          const a =
            (
              await c.query(
                "SELECT * FROM assets WHERE id=$1 AND company_id=$2 AND active FOR UPDATE",
                [id(req.params.id), company],
              )
            ).rows[0] ?? fail("Asset not found");
          if (date < a.acquired) fail("Depreciation date precedes acquisition");
          const runs = (
            await c.query(
              "SELECT date,base_amount FROM documents WHERE related_id=$1 AND kind='depreciation' AND status='posted'",
              [a.document_id],
            )
          ).rows;
          if (runs.some((r) => r.date.slice(0, 7) === date.slice(0, 7)))
            fail("Depreciation already posted for this month");
          const months =
            (Number(date.slice(0, 4)) - Number(a.acquired.slice(0, 4))) * 12 +
            Number(date.slice(5, 7)) -
            Number(a.acquired.slice(5, 7)) +
            1;
          if (runs.length >= months)
            fail("No additional depreciation is due by this date");
          if (runs.some((r) => r.date > date))
            fail(
              "Depreciation cannot precede a later posted depreciation period",
            );
          const depreciated = runs.reduce(
            (s, r) => s.plus(r.base_amount),
            new Decimal(0),
          );
          const remaining = new Decimal(a.cost)
            .minus(a.salvage)
            .minus(depreciated);
          if (remaining.lte(0)) fail("Asset is fully depreciated");
          const target = new Decimal(a.cost)
            .minus(a.salvage)
            .mul(Math.min(months, a.useful_life))
            .div(a.useful_life)
            .toDecimalPlaces(2);
          const amount = value(target.minus(depreciated));
          if (new Decimal(amount).lte(0))
            fail("No additional depreciation is due by this date");
          const original = (
            await c.query("SELECT project_id FROM documents WHERE id=$1", [
              a.document_id,
            ])
          ).rows[0];
          const d = await createDocument(c, company, req.actor.id, {
            kind: "depreciation",
            date,
            amount,
            description: `Monthly depreciation — ${a.name}`,
            relatedId: a.document_id,
            projectId: original.project_id,
          });
          const jid = (
            await c.query(
              "INSERT INTO journals(company_id,document_id,date) VALUES($1,$2,$3) RETURNING id",
              [company, d.id, date],
            )
          ).rows[0].id;
          for (const [purpose, debit, credit] of [
            ["depreciation", amount, "0"],
            ["accum_depreciation", "0", amount],
          ])
            await c.query(
              "INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,currency,project_id) SELECT $1,$2,id,$3,$4,'PKR',$6 FROM accounts WHERE company_id=$2 AND purpose=$5",
              [jid, company, debit, credit, purpose, original.project_id],
            );
          await c.query(
            "UPDATE documents SET status='posted',posted_at=now() WHERE id=$1",
            [d.id],
          );
          await audit(
            c,
            company,
            req.actor.id,
            "depreciate",
            "asset",
            a.id,
            null,
            { documentId: d.id, amount, date },
          );
          return d;
        }),
      ),
    ),
  );
  app.get(
    "/api/c/:company/reconciliation",
    requirePermission("accounting.manage"),
    route(async (req, res) =>
      res.json(
        (
          await pool.query(
            "SELECT l.*,a.name,j.date,d.description,rl.reconciliation_id FROM journal_lines l JOIN accounts a ON a.id=l.account_id JOIN journals j ON j.id=l.journal_id JOIN documents d ON d.id=j.document_id LEFT JOIN reconciliation_lines rl ON rl.line_id=l.id WHERE l.company_id=$1 AND a.purpose='bank' ORDER BY j.date,l.id",
            [id(req.params.company)],
          )
        ).rows,
      ),
    ),
  );
  app.post(
    "/api/c/:company/reconciliation",
    requirePermission("accounting.manage"),
    route(async (req, res) =>
      res.json(
        await transaction(async (c) => {
          const d = z
              .object({
                accountId: z.number().int().positive(),
                date: day,
                balance: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
                lineIds: z.array(z.number().int().positive()).min(1),
              })
              .parse(req.body),
            company = id(req.params.company);
          await c.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
            company,
          ]);
          const a =
            (
              await c.query(
                "SELECT * FROM accounts WHERE id=$1 AND company_id=$2 AND purpose='bank'",
                [d.accountId, company],
              )
            ).rows[0] ?? fail("Bank account not found");
          const lines = (
            await c.query(
              "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN reconciliation_lines r ON r.line_id=l.id WHERE l.id=ANY($1::int[]) AND l.account_id=$2 AND l.company_id=$3 AND j.date<=$4 AND r.line_id IS NULL",
              [d.lineIds, a.id, company, d.date],
            )
          ).rows;
          if (lines.length !== d.lineIds.length)
            fail("Some selected lines are unavailable or already reconciled");
          const prior = (
            await c.query(
              "SELECT COALESCE(sum(l.foreign_amount),0) total FROM journal_lines l JOIN reconciliation_lines r ON r.line_id=l.id WHERE l.account_id=$1",
              [a.id],
            )
          ).rows[0].total;
          if (
            !lines
              .reduce((s, l) => s.plus(l.foreign_amount), new Decimal(prior))
              .eq(d.balance)
          )
            fail(
              "Selected cleared transactions do not match the statement balance",
            );
          const row = (
            await c.query(
              "INSERT INTO reconciliations(company_id,account_id,statement_date,statement_balance,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
              [company, a.id, d.date, d.balance, req.actor.id],
            )
          ).rows[0];
          for (const line of lines)
            await c.query("INSERT INTO reconciliation_lines VALUES($1,$2)", [
              row.id,
              line.id,
            ]);
          await audit(
            c,
            company,
            req.actor.id,
            "reconcile",
            "bank",
            a.id,
            null,
            row,
          );
          return row;
        }),
      ),
    ),
  );
  const uploads = path.resolve(process.env.UPLOAD_DIR || "uploads");
  mkdirSync(uploads, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploads,
      filename: (_req, _file, cb) => cb(null, randomUUID()),
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 },
    fileFilter: (_req, file, cb) =>
      cb(
        null,
        ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
          file.mimetype,
        ),
      ),
  });
  const documentAccess = async (req: Request, c: Connection = pool) => {
    await assertOwnDocument(
      c,
      req.actor,
      id(req.params.company),
      id(req.params.id),
      req.method !== "GET",
    );
    const d =
      (
        await c.query("SELECT * FROM documents WHERE id=$1 AND company_id=$2", [
          id(req.params.id),
          id(req.params.company),
        ])
      ).rows[0] ?? fail("Document not found");
    if (
      req.actor.dataScope !== "own" &&
      req.actor.role === "employee" &&
      d.created_by !== req.actor.id &&
      req.method !== "GET"
    )
      fail("Document access denied");
    return d;
  };
  app.get(
    "/api/c/:company/documents/:id/attachments",
    requirePermission("transactions.view"),
    route(async (req, res) => {
      await documentAccess(req);
      res.json(
        (
          await pool.query(
            "SELECT id,filename,mime,size FROM attachments WHERE document_id=$1",
            [id(req.params.id)],
          )
        ).rows,
      );
    }),
  );
  app.post(
    "/api/c/:company/documents/:id/attachments",
    requirePermission("transactions.create"),
    (req, res, next) => {
      documentAccess(req)
        .then(() => next())
        .catch(next);
    },
    (req, res, next) => upload.array("files", 5)(req, res, next),
    route(async (req, res) => {
      const files = req.files as Express.Multer.File[];
      if (!files?.length)
        fail("Upload PDF, PNG, JPEG or WebP files, up to 20 MB each");
      try {
        await transaction(async (c) => {
          for (const f of files) {
            const row = (
              await c.query(
                "INSERT INTO attachments(document_id,filename,storage_key,mime,size,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
                [
                  id(req.params.id),
                  f.originalname,
                  f.filename,
                  f.mimetype,
                  f.size,
                  req.actor.id,
                ],
              )
            ).rows[0];
            await audit(
              c,
              id(req.params.company),
              req.actor.id,
              "attach",
              "document",
              id(req.params.id),
              null,
              { attachmentId: row.id, filename: f.originalname },
            );
          }
        });
        res.json({ success: true });
      } catch (e) {
        for (const f of files) unlinkSync(f.path);
        throw e;
      }
    }),
  );
  app.get(
    "/api/c/:company/documents/:id/attachments/:attachment",
    requirePermission("transactions.view"),
    route(async (req, res) => {
      await documentAccess(req);
      const a =
        (
          await pool.query(
            "SELECT * FROM attachments WHERE id=$1 AND document_id=$2",
            [id(req.params.attachment), id(req.params.id)],
          )
        ).rows[0] ?? fail("Attachment not found");
      res.download(path.join(uploads, a.storage_key), a.filename);
    }),
  );
  app.get(
    "/api/admin",
    requirePermission("users.manage"),
    route(async (req, res) =>
      res.json({
        users: (
          await pool.query(
            "SELECT id,username,email,full_name,role_id,active,overrides,data_scope FROM users ORDER BY id",
          )
        ).rows,
        roles: (await pool.query("SELECT * FROM roles ORDER BY id")).rows,
        memberships: (await pool.query("SELECT * FROM memberships")).rows,
        employeeLinks: (await pool.query("SELECT * FROM user_contacts")).rows,
        employees: (
          await pool.query(
            "SELECT id,company_id,name FROM contacts WHERE kind='employee' AND active ORDER BY company_id,name",
          )
        ).rows,
        permissions: permissionKeys,
      }),
    ),
  );
  app.post(
    "/api/admin/roles",
    requirePermission("users.manage"),
    route(async (req, res) => {
      const d = z
        .object({
          id: z.number().int().positive().optional(),
          name,
          permissions: z.array(z.enum(permissionKeys)),
        })
        .parse(req.body);
      res.json(
        await transaction(async (c) => {
          const before = d.id
            ? (
                await c.query("SELECT * FROM roles WHERE id=$1 FOR UPDATE", [
                  d.id,
                ])
              ).rows[0]
            : null;
          if (before?.name === "super_admin" || d.name === "super_admin")
            fail("Super admin role cannot be changed");
          if (
            before &&
            ["employee", "finance", "manager", "viewer"].includes(
              before.name,
            ) &&
            d.name !== before.name
          )
            fail(
              "Built-in role names are fixed; their permissions remain configurable",
            );
          const row = (
            await c.query(
              d.id
                ? "UPDATE roles SET name=$1,permissions=$2 WHERE id=$3 RETURNING *"
                : "INSERT INTO roles(name,permissions) VALUES($1,$2) RETURNING *",
              d.id
                ? [d.name, JSON.stringify(d.permissions), d.id]
                : [d.name, JSON.stringify(d.permissions)],
            )
          ).rows[0];
          await audit(
            c,
            null,
            req.actor.id,
            "save",
            "role",
            row.id,
            before,
            row,
          );
          return row;
        }),
      );
    }),
  );
  app.post(
    "/api/admin/users",
    requirePermission("users.manage"),
    route(async (req, res) => {
      const d = z
        .object({
          id: z.number().int().positive().optional(),
          username: z
            .string()
            .trim()
            .min(2)
            .max(100)
            .regex(
              /^[a-zA-Z0-9_.-]+$/,
              "Use letters, numbers, dots, underscores or hyphens for usernames",
            )
            .transform((s) => s.toLowerCase()),
          email: z
            .string()
            .trim()
            .email()
            .max(254)
            .transform((s) => s.toLowerCase())
            .nullable()
            .optional(),
          full_name: name,
          password: z.string().min(12).max(200).optional(),
          role_id: z.number().int().positive(),
          active: z.boolean(),
          overrides: z.partialRecord(z.enum(permissionKeys), z.boolean()).default({}),
          companies: z.array(z.number().int().positive()),
          data_scope: z.enum(["own", "company"]).nullable().optional(),
          employee_links: z
            .array(
              z.object({
                company_id: z.number().int().positive(),
                contact_id: z.number().int().positive(),
              }),
            )
            .optional(),
        })
        .parse(req.body);
      if (d.id === req.actor.id)
        fail(
          "Your access cannot be changed here. Use Change password to update your password.",
          403,
        );
      res.json(
        await transaction(async (c) => {
          const before = d.id
            ? (
                await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
                  d.id,
                ])
              ).rows[0]
            : null;
          if (d.id && !before) fail("User not found", 404);
          if (
            before?.username === administrator.username ||
            d.username === administrator.username
          )
            fail(
              "The admin account is reserved and cannot be changed here",
              403,
            );
          if (!before && !d.password) fail("Password is required");
          const password = d.password
            ? await bcrypt.hash(d.password, 12)
            : before.password;
          const dataScope =
            d.data_scope === undefined
              ? (before?.data_scope ?? null)
              : d.data_scope;
          const selectedRole = (
            await c.query("SELECT name FROM roles WHERE id=$1", [d.role_id])
          ).rows[0];
          if (!selectedRole) fail("Select a valid role");
          if (selectedRole.name === "super_admin")
            fail(
              "admin is the only super administrator; select another role",
              403,
            );
          const email =
            d.email === undefined ? (before?.email ?? null) : d.email;
          if (email === administrator.email)
            fail("This email belongs to the super administrator", 403);
          const previousLinks = before
            ? (
                await c.query(
                  "SELECT company_id,contact_id FROM user_contacts WHERE user_id=$1",
                  [before.id],
                )
              ).rows
            : [];
          const links =
            d.employee_links ??
            previousLinks.filter((link) =>
              d.companies.includes(link.company_id),
            );
          if (
            new Set(links.map((link) => link.company_id)).size !== links.length
          )
            fail("Link one employee per company");
          for (const link of links) {
            if (!d.companies.includes(link.company_id))
              fail("Employee link requires company access");
            if (
              !(
                await c.query(
                  "SELECT 1 FROM contacts WHERE id=$1 AND company_id=$2 AND kind='employee' AND active",
                  [link.contact_id, link.company_id],
                )
              ).rows.length
            )
              fail("Select an active employee in the assigned company");
            if (
              (
                await c.query(
                  "SELECT 1 FROM user_contacts WHERE company_id=$1 AND contact_id=$2 AND user_id<>$3",
                  [link.company_id, link.contact_id, d.id || 0],
                )
              ).rows.length
            )
              fail("This employee is already linked to another user");
          }
          const row = (
            await c.query(
              d.id
                ? "UPDATE users SET username=$1,full_name=$2,password=$3,role_id=$4,active=$5,overrides=$6 WHERE id=$7 RETURNING id"
                : "INSERT INTO users(username,full_name,password,role_id,active,overrides) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
              d.id
                ? [
                    d.username,
                    d.full_name,
                    password,
                    d.role_id,
                    d.active,
                    d.overrides,
                    d.id,
                  ]
                : [
                    d.username,
                    d.full_name,
                    password,
                    d.role_id,
                    d.active,
                    d.overrides,
                  ],
            )
          ).rows[0];
          await c.query("UPDATE users SET data_scope=$1,email=$3 WHERE id=$2", [
            dataScope,
            row.id,
            email,
          ]);
          await c.query("DELETE FROM memberships WHERE user_id=$1", [row.id]);
          for (const company of new Set(d.companies))
            await c.query(
              "INSERT INTO memberships(user_id,company_id) VALUES($1,$2)",
              [row.id, company],
            );
          for (const link of links)
            await c.query(
              "INSERT INTO user_contacts(user_id,company_id,contact_id) VALUES($1,$2,$3)",
              [row.id, link.company_id, link.contact_id],
            );
          if (d.password || !d.active)
            await c.query(
              "DELETE FROM sessions WHERE (sess->>'userId')::integer=$1",
              [row.id],
            );
          await audit(
            c,
            null,
            req.actor.id,
            "save",
            "user",
            row.id,
            before
              ? {
                  ...before,
                  employee_links: previousLinks,
                  password: "[redacted]",
                }
              : null,
            {
              ...d,
              data_scope: dataScope,
              employee_links: links,
              password: "[redacted]",
            },
          );
          return row;
        }),
      );
    }),
  );
}
