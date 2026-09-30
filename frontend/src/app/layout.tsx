import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { Nav } from "@/components/shell/Nav";
import { loadMeta, SYMBOL } from "@/lib/data";
import { fmtPrice, fmtUtcTime } from "@/lib/format";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Edge vs. Costs", template: "%s · Edge vs. Costs" },
  description: "How much theoretical options edge survives the bid-ask spread?",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const meta = await loadMeta();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 pt-3 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
              <Link href="/" className="flex items-baseline gap-2 font-semibold tracking-tight">
                <span className="text-[15px]">Edge vs. Costs</span>
                <span className="text-[13px] font-normal text-muted">{SYMBOL} options</span>
              </Link>
              {meta && (
                <dl className="flex items-center gap-4 text-[13px] text-ink-2">
                  <div className="flex gap-1.5">
                    <dt className="text-muted">{meta.symbol}</dt>
                    <dd className="tabular-nums text-ink">{fmtPrice(meta.underlying)}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-muted">Snapshot</dt>
                    <dd className="tabular-nums">{fmtUtcTime(meta.fetchedAt)}</dd>
                  </div>
                </dl>
              )}
            </div>
            <Nav />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
