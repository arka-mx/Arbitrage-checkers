import Link from "next/link";

export type SegmentOption = { value: string; label: string; hint?: string };

/** URL-driven segmented control: each option is a link, so state is shareable and needs no JS. */
export function Segmented({
  label,
  options,
  value,
  hrefFor,
}: {
  label: string;
  options: SegmentOption[];
  value: string;
  hrefFor: (value: string) => string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface p-0.5 sm:flex-wrap sm:overflow-visible"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Link
            key={o.value}
            href={hrefFor(o.value)}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={`flex shrink-0 items-baseline gap-1.5 rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap transition-colors ${
              active ? "bg-surface-2 font-medium text-ink shadow-[inset_0_0_0_1px_var(--line)]" : "text-ink-2 hover:text-ink"
            }`}
          >
            {o.label}
            {o.hint && <span className={`text-[11px] tabular-nums ${active ? "text-ink-2" : "text-muted"}`}>{o.hint}</span>}
          </Link>
        );
      })}
    </div>
  );
}

/** Build "/path?a=1&b=2" from the current params with some overridden. */
export function withParams(path: string, current: Record<string, string>, next: Record<string, string>) {
  const q = new URLSearchParams({ ...current, ...next });
  return `${path}?${q.toString()}`;
}
