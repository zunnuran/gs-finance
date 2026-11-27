import type { Connection } from "./db";

type DocumentRow = Record<string, any>;

/** Add filter membership without changing, validating, or posting a document. */
export async function withDocumentAccounts<T extends DocumentRow>(
  c: Connection,
  company: number,
  rows: T[],
  visibleAccountIds?: readonly number[],
): Promise<(T & { account_ids: number[] })[]> {
  if (!rows.length) return [];
  const documentIds = [...new Set(rows.map((row) => row.id))];
  const categoryIds = [
    ...new Set(rows.map((row) => row.category_id).filter(Boolean)),
  ];
  const [accountResult, categoryResult, journalResult] = await Promise.all([
    // Disabled accounts still belong to historical and saved transactions.
    c.query("SELECT id,purpose FROM accounts WHERE company_id=$1 ORDER BY id", [
      company,
    ]),
    c.query(
      "SELECT id,account_id FROM categories WHERE company_id=$1 AND id=ANY($2::int[])",
      [company, categoryIds],
    ),
    c.query(
      `SELECT j.document_id,j.id journal_id,j.reversal_of,
        array_agg(DISTINCT l.account_id ORDER BY l.account_id) account_ids
      FROM journals j JOIN journal_lines l ON l.journal_id=j.id AND l.company_id=$1
      JOIN accounts a ON a.id=l.account_id AND a.company_id=$1
      WHERE j.company_id=$1 AND j.document_id=ANY($2::int[])
      GROUP BY j.document_id,j.id,j.reversal_of`,
      [company, documentIds],
    ),
  ]);
  const companyAccounts = new Set<number>(
    accountResult.rows.map((account) => account.id),
  );
  const allowed =
    visibleAccountIds === undefined
      ? companyAccounts
      : new Set(
          visibleAccountIds.filter((accountId) =>
            companyAccounts.has(accountId),
          ),
        );
  const purposes = new Map<string, number>(
    accountResult.rows.map((account) => [account.purpose, account.id]),
  );
  const categoryAccounts = new Map<number, number>(
    categoryResult.rows.map((category) => [category.id, category.account_id]),
  );
  const originals = new Map<number, number[]>();
  const reversals = new Map<
    number,
    { documentId: number; accounts: number[] }
  >();
  for (const journal of journalResult.rows) {
    if (journal.reversal_of == null)
      originals.set(journal.document_id, journal.account_ids);
    else
      reversals.set(journal.journal_id, {
        documentId: journal.document_id,
        accounts: journal.account_ids,
      });
  }
  const configured = (row: DocumentRow): (number | undefined | null)[] => {
    // An incoming inter-company document can only expose its own posted journal.
    if (row.company_id !== company) return [];
    const head = row.category_id
      ? categoryAccounts.get(row.category_id)
      : row.head_id;
    const system = (purpose: string) => purposes.get(purpose);
    switch (row.kind) {
      case "receipt":
        return [row.target_id, head];
      case "transfer":
      case "withdrawal":
      case "adjustment":
        return [row.source_id, row.target_id];
      case "expense":
        return [row.source_id, head];
      case "capital_purchase":
        return [row.source_id, system("fixed_asset")];
      case "bill":
        return [head, system("payable")];
      case "invoice":
        return [head, system("receivable")];
      case "client_payment":
        return [
          row.target_id,
          row.related_id ? system("receivable") : row.head_id,
        ];
      case "vendor_payment":
        return [row.source_id, system("payable")];
      case "advance":
        return [row.source_id, system("advance")];
      case "advance_expense":
        return [head, system("advance")];
      case "advance_return":
        return [row.target_id, system("advance")];
      case "asset_purchase":
        return [row.source_id || system("payable"), system("fixed_asset")];
      case "intercompany":
        return [row.source_id, system("due_from")];
      case "opening":
        return [row.target_id, system("opening")];
      case "depreciation":
        return [system("depreciation"), system("accum_depreciation")];
      default:
        return [];
    }
  };
  return rows.map((row) => {
    const reversal = reversals.get(row.journal_id);
    const accounts =
      row.activity_type === "reversal"
        ? reversal && reversal.documentId === row.id
          ? reversal.accounts
          : []
        : ["posted", "reversed"].includes(row.status)
          ? originals.get(row.id) || []
          : configured(row);
    // Never infer posted history from an account/category that may have changed.
    // Permission filtering is applied to the final IDs, before they leave the API.
    const account_ids = [
      ...new Set(
        accounts.filter(
          (accountId): accountId is number =>
            accountId != null && allowed.has(accountId),
        ),
      ),
    ].sort((a, b) => a - b);
    return { ...row, account_ids };
  });
}
