import type { ReactNode } from "react";

// Wide tables must scroll inside their own box; the page body never scrolls
// sideways. The tabIndex makes that region reachable by keyboard.
export function TableScroll({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function TableSkeleton({ columns, rows = 5 }: { columns: string[]; rows?: number }) {
  return (
    <TableScroll label="Loading">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={i === 0 ? undefined : "num"}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-busy="true">
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {columns.map((c, i) => (
                <td key={c} className={i === 0 ? undefined : "num"}>
                  <span className="skeleton cell" style={{ width: i === 0 ? "70%" : "48%" }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true" />
      <strong>{title}</strong>
      {hint && <span className="empty-hint">{hint}</span>}
      {action}
    </div>
  );
}
