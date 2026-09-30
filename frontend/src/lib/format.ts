const DAY_MS = 86_400_000;

/** "2026-09-28T00:00:00.000" -> "2026-09-28". Expiries are calendar dates.
 *  Lives here (not lib/data.ts) so client components can import it without
 *  pulling in that module's server-only fs access. */
export const expiryKey = (iso: string) => iso.slice(0, 10);

export const fmtPrice = (n: number | null | undefined, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtInt = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US");

/** 0.1834 -> "18.3%" */
export const fmtPct = (n: number | null | undefined, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${(n * 100).toFixed(digits)}%`;

/** A vol difference in vol points: 0.0123 -> "1.23 pts" */
export const fmtVolPts = (n: number | null | undefined, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : `${(n * 100).toFixed(digits)} pts`;

/** "2026-09-28" -> "Mon 28 Sep" (expiries are dates; format in UTC to avoid TZ drift). */
export const fmtExpiry = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });

export const fmtUtcTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

/** Whole calendar days from the fetch date to expiry. */
export const daysToExpiry = (expiryKey: string, fetchedAtIso: string) =>
  Math.round(
    (Date.parse(`${expiryKey}T00:00:00Z`) - Date.parse(`${fetchedAtIso.slice(0, 10)}T00:00:00Z`)) / DAY_MS,
  );

/** Serializable formatter presets: server components pass the name, client charts resolve it
 *  (functions can't cross the server -> client boundary). */
export const UNITS = {
  volPts: { value: (v: number) => fmtVolPts(v), tick: (v: number) => (v * 100).toFixed(1) },
  vol: { value: (v: number) => fmtPct(v), tick: (v: number) => `${Math.round(v * 100)}%` },
  count: { value: (v: number) => fmtInt(v), tick: (v: number) => fmtInt(v) },
} as const;
export type Unit = keyof typeof UNITS;
