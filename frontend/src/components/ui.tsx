import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface ${className}`}>{children}</section>;
}

export function CardHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
      <div className="max-w-2xl">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-5 text-ink-2">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatTile({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="text-[13px] text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      {detail && <div className="mt-0.5 text-[12px] leading-4 text-muted">{detail}</div>}
    </div>
  );
}

/** Table twin for a chart: every plotted value reachable without hovering. */
export function TableView({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="group border-t border-line px-5 sm:px-6">
      <summary className="cursor-pointer list-none select-none py-3 text-[13px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="inline-block transition-transform group-open:rotate-90">›</span> Table view
      </summary>
      <div className="-mx-5 overflow-x-auto px-5 pb-4 sm:-mx-6 sm:px-6">
        <table className="w-full text-[13px] tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              {head.map((h, i) => (
                <th key={h} className={`py-1.5 font-normal ${i > 0 ? "text-right" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {r.map((c, j) => (
                  <td key={j} className={`py-1.5 ${j > 0 ? "text-right" : "text-ink-2"}`}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function EmptyState({ title, command }: { title: string; command: string }) {
  return (
    <Card className="px-6 py-10 text-center">
      <p className="text-sm text-ink">{title}</p>
      <p className="mt-2 text-[13px] text-ink-2">From <code className="font-mono">backend/</code>, run:</p>
      <pre className="mx-auto mt-3 max-w-full overflow-x-auto rounded-lg bg-surface-2 px-4 py-3 text-left font-mono text-xs text-ink">{command}</pre>
    </Card>
  );
}

export const PIPELINE_COMMAND = "python -m options_edge.cli --also-json --svi --arb";
