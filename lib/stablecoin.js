// Stablecoin payments on Polygon (JPYC + native USDC) — design: STABLECOIN.md.
// The service only ever knows a receiving ADDRESS (env STABLECOIN_ADDRESS);
// no private key exists server-side. Without the address the rail is
// unavailable and accept fails closed, like the Stripe webhook does without
// its secret.
//
// Amount identification: an EVM transfer carries no memo, so each payment is
// identified by its exact amount. The amount is the quote total plus a unique
// tail taken from a persistent per-service sequence (store incrementCounter):
// tail granularity is 1e-6 of a token for both JPYC and USDC.
//
// Token contracts (verified 2026-11-23 against Polygon mainnet via eth_call
// symbol()/decimals() on a public RPC, cross-checked with the issuers'
// official publications):
// - JPYC (current, funds-transfer type; JPYC Inc. official developer docs —
//   the same address on every chain; older prepaid/v1 contracts also answer
//   to "JPYC"/18, so the issuer source is what disambiguates):
//   0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 → symbol "JPYC", 18 decimals.
// - Native USDC on Polygon (Circle's official USDC contract-address list;
//   NOT the bridged USDC.e at 0x2791Bca1…):
//   0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 → symbol "USDC", 6 decimals.
// Both are env-overridable (JPYC_CONTRACT / USDC_CONTRACT) for completeness.
import { incrementCounter, putRecord } from "./store.js";
import { recordPaymentReceived } from "./payments.js";
import { fxRate } from "./pricing.js";

export const CHAIN = "polygon";
export const MIN_CONFIRMATIONS = 32;
export const DEFAULT_RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SEQ_WINDOW_SEC = 10 * 365 * 24 * 3600; // sequence must never reset in practice
const MAX_SCAN_BLOCKS = 120000; // ~2.7 days of Polygon blocks; quotes expire in 48h
const CHUNK_BLOCKS = 50000;
const RPC_TIMEOUT_MS = 10000;

export function tokenConfig(token) {
  if (token === "jpyc") {
    return {
      token: "jpyc",
      symbol: "JPYC",
      decimals: 18,
      contract: process.env.JPYC_CONTRACT || "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    };
  }
  if (token === "usdc") {
    return {
      token: "usdc",
      symbol: "USDC",
      decimals: 6,
      contract: process.env.USDC_CONTRACT || "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    };
  }
  return null;
}

export function stablecoinAddress() {
  const a = String(process.env.STABLECOIN_ADDRESS || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a : null;
}

export function stablecoinEnabled() {
  return stablecoinAddress() !== null;
}

async function rpc(method, params) {
  const url = process.env.POLYGON_RPC_URL || DEFAULT_RPC_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (data.error) throw new Error(`RPC ${method} failed: ${data.error.message || data.error.code}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function currentBlock() {
  return Number(BigInt(await rpc("eth_blockNumber", [])));
}

// Exact decimal rendering of the amount (trailing zeros trimmed, but the
// 1e-6 tail always stays visible so the payer can copy it digit for digit).
function formatAmount(units, decimals) {
  const base = 10n ** BigInt(decimals);
  const int = units / base;
  let frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 6) frac = frac.padEnd(6, "0");
  return `${int}.${frac}`;
}

function amountUnitsFor(cfg, totalMajor, seq) {
  // totalMajor: number with at most 2 decimal places (JPY total is an integer;
  // USD total is rounded to cents at quote time). Work in micro-units (1e-6)
  // to avoid float drift, then scale to the token's smallest unit.
  const micro = BigInt(Math.round(totalMajor * 1e6)) + BigInt(seq);
  const scale = 10n ** BigInt(cfg.decimals - 6);
  return micro * scale;
}

// Build the payment assignment for an accepted live quote. Returns null when
// the rail is not configured (callers fail closed before creating the task).
export async function buildPaymentInstructions({ token, quote }) {
  const address = stablecoinAddress();
  if (!address) return null;
  const cfg = tokenConfig(token);
  if (!cfg) return null;
  const totalJpy = quote.breakdown.total_jpy;
  let totalMajor;
  let fxJpyPerUsd = null;
  if (token === "jpyc") {
    totalMajor = totalJpy;
  } else if (quote.fx?.total_usd != null) {
    totalMajor = quote.fx.total_usd;
    fxJpyPerUsd = quote.fx.jpy_per_usd;
  } else {
    fxJpyPerUsd = fxRate();
    totalMajor = Math.round((totalJpy / fxJpyPerUsd) * 100) / 100;
  }
  const seq = await incrementCounter("stablecoin-seq", SEQ_WINDOW_SEC);
  const units = amountUnitsFor(cfg, totalMajor, seq);
  let fromBlock = null;
  try {
    fromBlock = await currentBlock();
  } catch {
    /* RPC down at accept time: the checker falls back to a bounded window */
  }
  return {
    payment_id: null, // set by the caller once the task id exists
    chain: CHAIN,
    token,
    symbol: cfg.symbol,
    contract: cfg.contract,
    address,
    amount: formatAmount(units, cfg.decimals),
    amount_units: units.toString(),
    total_jpy: totalJpy,
    fx_jpy_per_usd: fxJpyPerUsd,
    from_block: fromBlock,
    expires_at: quote.expires_at,
    note: `Send exactly ${formatAmount(units, cfg.decimals)} ${cfg.symbol} on Polygon to ${address}. The exact amount (including its fractional tail) identifies your payment; a different amount cannot be matched automatically.`,
  };
}

// Check the chain for this task's payment. On a confirmed exact-amount match
// the task is marked paid through the same path the Stripe webhook uses
// (recordPaymentReceived in lib/payments.js). Returns a status object; never
// throws for "not found" — only for RPC failures, which callers may swallow.
export async function checkStablecoinPayment(task) {
  const a = task?.payment_instructions;
  if (!a) return { paid: task?.payment?.status === "paid", checked: false, reason: "no_stablecoin_assignment" };
  if (task.payment?.status === "paid") return { paid: true, checked: false, reason: "already_paid" };
  if (!stablecoinEnabled()) return { paid: false, checked: false, reason: "stablecoin_not_configured" };
  const cfg = tokenConfig(a.token);
  if (!cfg) return { paid: false, checked: false, reason: "unknown_token" };

  const latest = await currentBlock();
  let from = a.from_block != null ? a.from_block : Math.max(0, latest - 90000);
  if (latest - from > MAX_SCAN_BLOCKS) from = latest - MAX_SCAN_BLOCKS;
  const toTopic = `0x${a.address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const want = BigInt(a.amount_units);

  for (let start = from; start <= latest; start += CHUNK_BLOCKS) {
    const end = Math.min(start + CHUNK_BLOCKS - 1, latest);
    const logs = await rpc("eth_getLogs", [
      {
        address: cfg.contract,
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
        topics: [TRANSFER_TOPIC, null, toTopic],
      },
    ]);
    for (const log of logs || []) {
      let value;
      try {
        value = BigInt(log.data);
      } catch {
        continue;
      }
      if (value !== want) continue;
      const blockNumber = Number(BigInt(log.blockNumber));
      const confirmations = latest - blockNumber + 1;
      if (confirmations < MIN_CONFIRMATIONS) continue;
      const now = new Date().toISOString();
      await putRecord("payments", a.payment_id, {
        task_id: task.id,
        token: a.token,
        chain: CHAIN,
        amount: a.amount,
        amount_units: a.amount_units,
        address: a.address,
        tx_hash: log.transactionHash || null,
        block_number: blockNumber,
        confirmations,
        confirmed_at: now,
      });
      await recordPaymentReceived(task, {
        via: "stablecoin_polygon",
        amountTotal: a.amount,
        paymentExtra: {
          token: a.token,
          chain: CHAIN,
          tx_hash: log.transactionHash || null,
          block_number: blockNumber,
        },
      });
      return { paid: true, checked: true, tx_hash: log.transactionHash || null, block_number: blockNumber, confirmations };
    }
  }
  return { paid: false, checked: true, reason: "no_matching_transfer_yet" };
}
