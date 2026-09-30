"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePositions } from "@/lib/positions";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/chain", label: "Chain" },
  { href: "/surface", label: "Vol surface" },
  { href: "/arbitrage", label: "Arbitrage" },
  { href: "/hedge", label: "Hedge" },
] as const;

export function Nav() {
  const pathname = usePathname();
  const openCount = usePositions().filter((p) => p.status === "open").length;

  return (
    <nav aria-label="Sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="-ml-3 flex text-sm">
        {LINKS.map(({ href, label }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          const badge = href === "/" && openCount > 0 ? openCount : null;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 pt-1.5 pb-3 transition-colors ${
                  active ? "text-ink font-medium" : "text-ink-2 hover:text-ink"
                }`}
              >
                {label}
                {badge !== null && (
                  <span
                    aria-hidden
                    className="flex h-4 min-w-4 items-center justify-center rounded-full bg-series-1 px-1 text-[10px] font-medium text-white"
                  >
                    {badge}
                  </span>
                )}
                {/* Inside the link box: the nav's overflow-x scroller would clip anything below it. */}
                {active && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ink" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
