#!/usr/bin/env node
/**
 * try-hum-x402.mjs — call Hum's x402-paid LLM endpoint from anywhere.
 *
 * x402 is permissionless: any wallet that can sign EIP-3009
 * transferWithAuthorization may pay. No Sly account, no API key, no
 * provider relationship required.
 *
 * This script:
 *   1. POSTs to /api/x402-inference (no payment) → HTTP 402 + price quote
 *   2. Signs EIP-3009 locally using viem + a private key (auto-generated
 *      if PRIVATE_KEY is not set — fine for the demo since the dev-mode
 *      facilitator mocks settlement; on a real chain you'd need USDC).
 *   3. Retries with X-PAYMENT → Hum settles via Sly facilitator, then runs
 *      OpenRouter, returns the model output + receipt.
 *
 * Setup (one time):
 *   npm install viem    # ~150KB, no other deps needed
 *
 * Run:
 *   node try-hum-x402.mjs "your prompt"
 *   node try-hum-x402.mjs "your prompt" --model claude
 *   PRIVATE_KEY=0xabc... node try-hum-x402.mjs "your prompt"   # use your own wallet
 *
 * Env:
 *   HUM_URL       Hum endpoint base URL (default: demo tunnel).
 *   PRIVATE_KEY   secp256k1 hex private key (optional; random if absent).
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { randomBytes } from 'node:crypto';

const DEFAULT_HUM = 'https://moved-captain-shipments-crest.trycloudflare.com';
const HUM_URL = (process.env.HUM_URL || DEFAULT_HUM).replace(/\/$/, '');

// All chain-specific values (chainId, USDC contract, EIP-712 domain name)
// are derived from Hum's 402 quote — the same script works on any chain Hum
// is configured for (base-sepolia, base mainnet, etc).
const NETWORK_TO_CHAIN_ID = {
  'base-sepolia': 84532,
  'base': 8453,
  'base-mainnet': 8453,
};

const MODEL_ALIASES = {
  local:   'local/phi3-mini',
  phi3:    'local/phi3-mini',
  claude:  'anthropic/claude-haiku-4.5',
  gpt:     'openai/gpt-4o-mini',
  gemini:  'google/gemini-2.5-flash-lite',
  llama:   'meta-llama/llama-4-scout',
  mistral: 'mistralai/mistral-small-3.2-24b-instruct',
};

// ───── argv ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage:  node try-hum-x402.mjs "your prompt" [--model claude|gpt|gemini|llama|mistral] [--max N]');
  console.log('        PRIVATE_KEY=0x... node try-hum-x402.mjs "your prompt"   # use your own wallet');
  process.exit(argv.length ? 0 : 1);
}

let model = 'anthropic/claude-haiku-4.5';
let maxTokens = 200;
const promptParts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') {
    const v = argv[++i];
    model = MODEL_ALIASES[v] ?? v;
  } else if (a === '--max') {
    maxTokens = Number(argv[++i]) || 200;
  } else {
    promptParts.push(a);
  }
}
const prompt = promptParts.join(' ');
if (!prompt) { console.error('Need a prompt.'); process.exit(1); }

// ───── wallet ────────────────────────────────────────────────────────────
const privateKey = process.env.PRIVATE_KEY || generatePrivateKey();
const wasGenerated = !process.env.PRIVATE_KEY;
const account = privateKeyToAccount(privateKey);

// ───── colors ────────────────────────────────────────────────────────────
const c = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = c(2), bold = c(1), cyan = c(36), green = c(32), yellow = c(33), red = c(31);
const log = {
  step:  (n, t) => console.log(`${dim(`[${n}/3]`)} ${cyan(t)}`),
  kv:    (k, v) => console.log(`        ${dim(k.padEnd(10))} ${v}`),
  blank: ()    => console.log(),
};

// ───── helpers ───────────────────────────────────────────────────────────
async function jsonFetch(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: r.status, headers: r.headers, json };
}

function genNonce() {
  return '0x' + randomBytes(32).toString('hex');
}

async function signEIP3009({ from, to, value, validAfter, validBefore, nonce, chainId, usdcAddress, usdcName, usdcVersion }) {
  // USDC's EIP-712 domain — values come from Hum's 402 quote so the same
  // script works on Sepolia (name='USDC') and mainnet (name='USD Coin').
  const domain = {
    name: usdcName,
    version: usdcVersion,
    chainId,
    verifyingContract: usdcAddress,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from',        type: 'address' },
      { name: 'to',          type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'validAfter',  type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce',       type: 'bytes32' },
    ],
  };
  const message = {
    from,
    to,
    value: BigInt(value),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };
  return await account.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });
}

function encodeXPayment({ signature, from, to, value, validAfter, validBefore, nonce, network }) {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      signature,
      authorization: {
        from,
        to,
        value: String(value),
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

const formatUsdc = (m) => (Number(m) / 1_000_000).toFixed(6) + ' USDC';
const formatCost = (m) => {
  const cents = m / 10_000;
  if (cents < 1)   return cents.toFixed(2) + '¢';
  if (cents < 100) return cents.toFixed(1) + '¢';
  return '$' + (cents / 100).toFixed(2);
};
const indent = (s, p) => s.split('\n').map((l) => p + l).join('\n');

// ───── main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`${bold(cyan('🌐 Hum'))} ${dim('— phone-side LLM marketplace · permissionless x402')}`);
  log.kv('Hum',     HUM_URL);
  log.kv('model',   model);
  log.kv('wallet',  account.address + (wasGenerated ? dim('  ← random for this run') : ''));
  log.blank();

  // ── 1. quote ──────────────────────────────────────────────────────────
  log.step(1, 'POST without payment → expect HTTP 402 with a price quote');
  const reqBody = JSON.stringify({ prompt, model, maxTokens });
  const quoteRes = await jsonFetch(`${HUM_URL}/api/x402-inference`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: reqBody,
  });
  if (quoteRes.status !== 402) {
    console.error(`${red('✖')} expected 402, got ${quoteRes.status}: ${JSON.stringify(quoteRes.json).slice(0, 200)}`);
    process.exit(2);
  }
  const accepts = quoteRes.json.accepts?.[0];
  if (!accepts) {
    console.error(`${red('✖')} 402 had no accepts[] block`);
    process.exit(2);
  }
  const p = quoteRes.json.pricing;
  log.kv('payTo',     accepts.payTo);
  log.kv('asset',     accepts.asset);
  log.kv('network',   accepts.network);
  log.kv('quote',     `${bold(formatUsdc(accepts.maxAmountRequired))} ${dim(`(${accepts.maxAmountRequired} µ)`)}`);
  if (p) log.kv('breakdown', `est ${p.estInputTokens}→${p.estOutputTokens} tok · base $${(p.baseCostMicroUsd/1e6).toFixed(6)} × ${p.markup}×`);
  log.blank();

  // Derive everything we need to sign from the 402 quote.
  const chainId = NETWORK_TO_CHAIN_ID[accepts.network];
  if (!chainId) {
    console.error(`${red('✖')} unsupported network in 402 quote: ${accepts.network}`);
    process.exit(2);
  }
  const usdcName = accepts.extra?.name ?? 'USDC';
  const usdcVersion = accepts.extra?.version ?? '2';

  // ── 2. sign locally with viem ─────────────────────────────────────────
  log.step(2, 'Sign EIP-3009 locally with viem — no server, no Sly account');
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  const nonce = genNonce();
  const signature = await signEIP3009({
    from: account.address,
    to: accepts.payTo,
    value: accepts.maxAmountRequired,
    validAfter, validBefore, nonce,
    chainId,
    usdcAddress: accepts.asset,
    usdcName,
    usdcVersion,
  });
  log.kv('from',    account.address);
  log.kv('to',      accepts.payTo);
  log.kv('value',   `${accepts.maxAmountRequired} µ`);
  log.kv('chainId', chainId);
  log.kv('domain',  `${usdcName} v${usdcVersion} @ ${accepts.asset}`);
  log.kv('sig',     signature.slice(0, 20) + '…' + signature.slice(-8));
  log.kv('nonce',   nonce.slice(0, 14) + '…');
  log.blank();

  // ── 3. retry with X-PAYMENT ───────────────────────────────────────────
  log.step(3, 'Retry POST with X-PAYMENT → settlement + OpenRouter inference');
  const xPayment = encodeXPayment({
    signature,
    from: account.address,
    to: accepts.payTo,
    value: accepts.maxAmountRequired,
    validAfter, validBefore, nonce,
    network: accepts.network,
  });
  const t0 = Date.now();
  const paidRes = await jsonFetch(`${HUM_URL}/api/x402-inference`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment },
    body: reqBody,
  });
  const wallMs = Date.now() - t0;
  if (paidRes.status !== 200 || !paidRes.json?.ok) {
    console.error(`${red('✖')} paid request failed (${paidRes.status}): ${JSON.stringify(paidRes.json).slice(0, 400)}`);
    process.exit(2);
  }
  const d = paidRes.json;
  log.kv('settled',  d.x402.settled ? green('YES') : red('no'));
  log.kv('settleTx', d.x402.settlementTxHash);
  log.kv('paid',     `${d.x402.paidMicroUsdc} µ ${dim(`= ${formatUsdc(d.x402.paidMicroUsdc)}`)}`);
  log.kv('paidAt',   d.x402.settledAt);
  log.blank();

  // ── receipt ───────────────────────────────────────────────────────────
  const pr = d.pricing;
  console.log(`${green('💬 model output')} ${dim(`— ${d.model}, ${pr.actualInputTokens}→${pr.actualOutputTokens} tok, ${d.latencyMs}ms`)}`);
  log.blank();
  console.log(indent(d.output.trim(), '   '));
  log.blank();
  console.log(dim(`Hum revenue: ${formatUsdc(pr.revenueMicroUsdc)} · LLM cost: ${formatCost(pr.actualCostMicroUsd)} · margin: ${formatCost(pr.marginMicroUsd)} (${pr.marginPct}%)`));
  console.log(dim(`wall ${wallMs}ms · sig ${signature.slice(0, 14)} · settle ${d.x402.settlementTxHash.slice(0, 18)}…`));
  if (wasGenerated) {
    console.log(dim(`(wallet was random; for a persistent identity, set PRIVATE_KEY=0x...)`));
  }
}

main().catch((err) => { console.error(red('FATAL:'), err); process.exit(99); });
