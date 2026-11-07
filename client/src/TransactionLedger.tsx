import { useEffect, useState } from "react";
import { Check, CircleAlert, RefreshCw } from "lucide-react";
import Decimal from "decimal.js";

const LedgerDecimal = Decimal.clone({ precision: 40 });
export const formatLedgerAmount = (value: Decimal.Value) =>
  new LedgerDecimal(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

type Journal = {
  id: number;
  date: string;
  reversal_of: number | null;
  lines: {
    id: number;
    account_id: number | null;
    account_code: string | null;
    account_name: string;
    debit: string;
    credit: string;
    currency: string;
    foreign_amount: string;
  }[];
};

export function TransactionLedger({
  base,
  documentId,
  status,
  companyName,
  request,
}: {
  base: string;
  documentId: number;
  status: string;
  companyName: string;
  request: (url: string) => Promise<{ journals: Journal[] }>;
}) {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setJournals([]);
    request(`${base}/documents/${documentId}/ledger`)
      .then((result) => {
        if (active) setJournals(result.journals);
      })
      .catch((reason) => {
        if (active)
          setError(reason.message || "Could not load accounting entries.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, documentId, status, request, attempt]);

  return (
    <section className="transaction-ledger" aria-label="Accounting entries">
      <div className="transaction-ledger-heading">
        <h3>Accounting entries</h3>
        <p>{companyName} · Debit and credit amounts in PKR</p>
      </div>
      {loading ? (
        <p className="subtle" role="status">
          Loading accounting entries…
        </p>
      ) : error ? (
        <div className="ledger-error" role="alert">
          <span>{error}</span>
          <button
            className="button secondary compact"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : !journals.length ? (
        <p className="ledger-empty">
          {status === "pending"
            ? "This transaction is pending. Accounting entries will appear after it is posted."
            : status === "cancelled"
              ? "This transaction was cancelled before posting. No accounting entries were created."
              : "No accounting entries are available for this transaction."}
        </p>
      ) : (
        journals.map((journal) => {
          const debit = journal.lines.reduce(
            (sum, line) => sum.plus(line.debit),
            new LedgerDecimal(0),
          );
          const credit = journal.lines.reduce(
            (sum, line) => sum.plus(line.credit),
            new LedgerDecimal(0),
          );
          const balanced = journal.lines.length > 0 && debit.eq(credit);
          const foreign = journal.lines.some((line) => line.currency !== "PKR");
          return (
            <div className="ledger-journal" key={journal.id}>
              <div className="ledger-journal-heading">
                <div>
                  <strong>
                    {journal.reversal_of ? "Reversal" : "Original posting"} ·
                    Journal #{journal.id}
                  </strong>
                  <span>
                    {new Date(
                      `${journal.date.slice(0, 10)}T12:00:00`,
                    ).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {journal.reversal_of
                      ? ` · Reverses journal #${journal.reversal_of}`
                      : ""}
                  </span>
                </div>
                <span
                  className={`ledger-balance ${balanced ? "is-balanced" : "is-unbalanced"}`}
                >
                  {balanced ? <Check size={13} /> : <CircleAlert size={13} />}
                  {balanced ? "Balanced" : "Out of balance"}
                </span>
              </div>
              <div
                className="ledger-table-scroll"
                tabIndex={0}
                role="region"
                aria-label={`Journal ${journal.id}; scroll horizontally to see all columns`}
              >
                <table
                  className="ledger-table"
                  aria-label={`Journal ${journal.id} debit and credit entries`}
                >
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col" className="ledger-number">
                        Debit (PKR)
                      </th>
                      <th scope="col" className="ledger-number">
                        Credit (PKR)
                      </th>
                      {foreign && (
                        <th scope="col" className="ledger-number">
                          Original amount
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {journal.lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <span className="ledger-account-name">
                            {line.account_name}
                          </span>
                          {line.account_code && (
                            <span className="ledger-account-code">
                              {line.account_code}
                            </span>
                          )}
                        </td>
                        <td className="ledger-number">
                          {formatLedgerAmount(line.debit)}
                        </td>
                        <td className="ledger-number">
                          {formatLedgerAmount(line.credit)}
                        </td>
                        {foreign && (
                          <td className="ledger-number">
                            {line.currency !== "PKR" &&
                            !new LedgerDecimal(line.foreign_amount).isZero()
                              ? `${line.currency} ${formatLedgerAmount(line.foreign_amount)}`
                              : "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td className="ledger-number">
                        {formatLedgerAmount(debit)}
                      </td>
                      <td className="ledger-number">
                        {formatLedgerAmount(credit)}
                      </td>
                      {foreign && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
