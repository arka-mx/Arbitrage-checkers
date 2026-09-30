import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

const BACKEND_DIR = path.join(process.cwd(), "..", "backend");
const VENV_PYTHON =
  process.platform === "win32"
    ? path.join(BACKEND_DIR, ".venv", "Scripts", "python.exe")
    : path.join(BACKEND_DIR, ".venv", "bin", "python");
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python";

type Param = { name: string; min?: number; max?: number };
const NUMERIC_PARAMS: Param[] = [
  { name: "spot", min: 0 },
  { name: "strike", min: 0 },
  { name: "timeToExpiry", min: 0 },
  { name: "vol", min: 0 },
  { name: "halfSpread", min: 0 },
];

// Optional, >= 0 (0 is a normal value — unlike the params above, whose CLI
// defaults require them present and strictly positive).
const OPTIONAL_NONNEGATIVE_PARAMS = [
  { name: "optionCommissionPerContract", flag: "--option-commission-per-contract" },
  { name: "stockCommissionPerShare", flag: "--stock-commission-per-share" },
] as const;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const optionType = sp.get("optionType");
  if (optionType !== "CE" && optionType !== "PE") {
    return NextResponse.json({ error: "optionType must be CE or PE" }, { status: 400 });
  }

  const side = sp.get("side") ?? "short";
  if (side !== "short" && side !== "long") {
    return NextResponse.json({ error: "side must be short or long" }, { status: 400 });
  }

  const values: Record<string, number> = {};
  for (const { name, min, max } of NUMERIC_PARAMS) {
    const raw = sp.get(name);
    const v = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(v) || (min !== undefined && v <= min) || (max !== undefined && v > max)) {
      return NextResponse.json({ error: `${name} must be a number > ${min ?? "-inf"}, got ${raw}` }, { status: 400 });
    }
    values[name] = v;
  }

  const args = [
    "-m", "options_edge.hedge_cli",
    "--spot", String(values.spot),
    "--strike", String(values.strike),
    "--option-type", optionType,
    "--time-to-expiry", String(values.timeToExpiry),
    "--vol", String(values.vol),
    "--side", side,
    "--half-spread", String(values.halfSpread),
  ];

  for (const { name, flag } of OPTIONAL_NONNEGATIVE_PARAMS) {
    const raw = sp.get(name);
    if (raw === null) continue; // let hedge_cli's own default apply
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) {
      return NextResponse.json({ error: `${name} must be a number >= 0, got ${raw}` }, { status: 400 });
    }
    args.push(flag, String(v));
  }

  try {
    const { stdout } = await execFileAsync(PYTHON, args, { cwd: BACKEND_DIR, timeout: 30_000 });
    const result = JSON.parse(stdout);
    if (result.error) return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Simulation failed: ${message.slice(0, 500)}` }, { status: 500 });
  }
}
