import Link from "next/link";
import type { ReactNode } from "react";

import { fmtInt } from "@/lib/format";

function PageLink({ href, disabled, children, ariaLabel }: { href: string; disabled: boolean; children: ReactNode; ariaLabel: string }) {
  if (disabled) {
    return (
      <span aria-hidden className="rounded-md border border-line px-2.5 py-1 text-[13px] text-muted opacity-40">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      scroll={false}
      aria-label={ariaLabel}
      className="rounded-md border border-line px-2.5 py-1 text-[13px] font-medium text-ink-2 transition-colors hover:border-series-1 hover:text-series-1"
    >
      {children}
    </Link>
  );
}

/** Discrete-batch pagination (not "load more"): each page replaces the last. */
export function Pagination({
  page, pageSize, total, hrefFor,
}: {
  page: number; pageSize: number; total: number; hrefFor: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[13px] text-ink-2">
        {fmtInt(start)}–{fmtInt(end)} of {fmtInt(total)}
      </span>
      <div className="flex items-center gap-1">
        <PageLink href={hrefFor(1)} disabled={page <= 1} ariaLabel="First page">«</PageLink>
        <PageLink href={hrefFor(page - 1)} disabled={page <= 1} ariaLabel="Previous page">‹ Prev</PageLink>
        <span className="px-2 text-[13px] tabular-nums text-ink-2">
          Page {fmtInt(page)} of {fmtInt(totalPages)}
        </span>
        <PageLink href={hrefFor(page + 1)} disabled={page >= totalPages} ariaLabel="Next page">Next ›</PageLink>
        <PageLink href={hrefFor(totalPages)} disabled={page >= totalPages} ariaLabel="Last page">»</PageLink>
      </div>
    </nav>
  );
}
