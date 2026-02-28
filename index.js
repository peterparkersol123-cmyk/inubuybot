require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const {
  HELIUS_API_KEY,
  TELEGRAM_BOT_TOKEN,
  AUTH_TOKEN,
  RAILWAY_PUBLIC_DOMAIN,
  STORAGE_DIR,
  PORT = 3000,
} = process.env;

// ─── Storage ──────────────────────────────────────────────────────────────────
// Structure: { webhookId: null, subscriptions: [{ chatId, ownerId, tokenMint, settings }] }
const STORAGE_FILE = path.join(STORAGE_DIR || __dirname, 'subscriptions.json');

function loadStorage() {
  if (!fs.existsSync(STORAGE_FILE)) return { webhookId: null, subscriptions: [] };
  return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
}
function saveStorage(data) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}
function getUniqueMints(storage) {
  return [...new Set(storage.subscriptions.map((s) => s.tokenMint))];
}
function findSub(groupChatId) {
  return loadStorage().subscriptions.find((s) => s.chatId === groupChatId) || null;
}
function saveSub(sub) {
  const storage = loadStorage();
  const idx = storage.subscriptions.findIndex((s) => s.chatId === sub.chatId);
  if (idx >= 0) storage.subscriptions[idx] = sub;
  else storage.subscriptions.push(sub);
  saveStorage(storage);
}
function defaultSettings() {
  return {
    gif: null,         // { fileId, type: 'photo'|'animation' } or null
    minBuyUsd: 1,      // minimum buy in USD to trigger alert (default $1, 0 = all)
    emoji: '🐕',       // emoji shown in alert header (fallback text)
    emojiId: null,     // custom emoji ID if set via Telegram custom emoji
    stepUsd: 0,        // step size in USD — 1 emoji per step (0 = always 1 emoji)
    showPrice: false,  // show token price per unit in alert
    whaleUsd: 50000,   // whale alert threshold in USD (0 = off)
    linkTg: '',        // project Telegram link (legacy — use links[] instead)
    links: [],         // up to 3 custom links: [{ label: 'Chart', url: 'https://...' }]
    circSupply: 0,     // circulating supply for market cap calc
    tokenName: '',     // token symbol fetched from Helius metadata
    active: false,     // whether alerts are currently enabled (must be started manually)
    icons: {           // per-field icon overrides { emoji, emojiId }
      header:  { emoji: '🤑', emojiId: null },
      whale:   { emoji: '🐋', emojiId: null },
      spent:   { emoji: '🤑', emojiId: null },
      got:     { emoji: '💰', emojiId: null },
      buyer:   { emoji: '💳', emojiId: null },
      chart:   { emoji: '📈', emojiId: null },
      mcap:    { emoji: '📊', emojiId: null },
      holders: { emoji: '💠', emojiId: null },
    },
  };
}

// ─── SOL Price (updated every 2 min) ──────────────────────────────────────────
let solPriceUsd = 0;
async function updateSolPrice() {
  // Try CoinGecko first (no geo-restrictions), fall back to Kraken
  const sources = [
    async () => {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const data = await res.json();
      return data?.solana?.usd;
    },
    async () => {
      const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD');
      const data = await res.json();
      return parseFloat(data?.result?.SOLUSD?.c?.[0]);
    },
  ];

  for (const source of sources) {
    try {
      const price = await source();
      if (price > 0) {
        solPriceUsd = price;
        console.log(`SOL price updated: $${solPriceUsd}`);
        return;
      }
    } catch (e) {
      console.error('SOL price source failed:', e.message);
    }
  }
  console.error('All SOL price sources failed, keeping last value:', solPriceUsd);
}

// ─── Custom Emoji ──────────────────────────────────────────────────────────────
// Helper: wraps a custom emoji ID with a plain-text fallback
const ce = (id, fallback) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;

const CE = {
  // Theinucoinemoji pack (own pack)
  buy        : () => ce('5791791406137744300', '🤑'),   // inu buy icon

  // SpyDefi_classic pack (arrows, icons)
  arrowRight : () => ce('5082729418380543512', '➡️'),   // green right arrow
  arrowLeft  : () => ce('5050816424096826643', '⬅️'),   // green left arrow
  whale      : () => ce('5051129106305909986', '🐋'),   // whale
  buyer      : () => ce('5087015559518750311', '👤'),   // buyer / person
  chart      : () => ce('5082455498251306031', '📈'),   // chart
  mcap       : () => ce('5084645137003316287', '📊'),   // market cap
  money      : () => ce('5084875076667442421', '💰'),   // money bag
  holders    : () => ce('5179533127919338363', '📊'),   // holders (bar chart)
};

// Render a single icon field — custom emoji if emojiId set, else plain emoji
function renderIcon(icon) {
  if (!icon) return '';
  return icon.emojiId
    ? `<tg-emoji emoji-id="${icon.emojiId}">${icon.emoji}</tg-emoji>`
    : icon.emoji;
}

// Merge saved icons with defaults so existing subs get all fields
function getIcons(s) {
  const d = defaultSettings().icons;
  const saved = s.icons || {};
  const fields = ['header', 'whale', 'spent', 'got', 'buyer', 'chart', 'mcap', 'holders'];
  const result = {};
  for (const f of fields) result[f] = saved[f] ?? d[f];
  return result;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────
function formatUsd(amount) {
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(0)}K`;
  return `$${amount.toFixed(2)}`;
}

function formatTokenAmount(amount) {
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(1)}K`;
  return amount.toLocaleString();
}

// ─── Wallet Position Tracking (in-memory) ─────────────────────────────────────
// Tracks each wallet's average buy price per token to show PnL on repeat buys
// key: "${walletAddress}|${tokenMint}" → { totalSpentUsd, totalTokens }
const walletPositions = new Map();

function getPosition(wallet, mint) {
  return walletPositions.get(`${wallet}|${mint}`) || null;
}

function updatePosition(wallet, mint, usdSpent, tokensReceived) {
  if (!usdSpent || !tokensReceived) return;
  const key = `${wallet}|${mint}`;
  const existing = walletPositions.get(key);
  if (existing) {
    existing.totalSpentUsd  += usdSpent;
    existing.totalTokens    += tokensReceived;
  } else {
    walletPositions.set(key, { totalSpentUsd: usdSpent, totalTokens: tokensReceived });
  }
}

// ─── Seen-signature dedup (shared by polling + legacy webhook endpoint) ───────
const seenSignatures = new Set();
function markSeen(sig) {
  seenSignatures.add(sig);
  // Keep newest ~5 000 sigs; drop oldest half when over limit
  if (seenSignatures.size > 5000) {
    const it = seenSignatures.values();
    for (let i = 0; i < 2500; i++) seenSignatures.delete(it.next().value);
  }
}

// Signatures currently being fetched by the WS handler (not yet marked seen).
// The polling loop checks this to avoid duplicating an in-flight WS fetch.
const pendingSigs = new Set();

// Per-mint timestamp of the last log notification received on the WS.
const wsLastActivity = new Map();

// ─── Holder Count (cached, 30-min TTL) ────────────────────────────────────────
const holderCache = new Map(); // mint → { count, ts }

// Count non-zero-balance token accounts on-chain via getProgramAccounts.
// Uses dataSlice to fetch only the 8-byte amount field per account (very small payload).
// Tries SPL Token first (165-byte accounts), then Token-2022 (variable size).
async function getHolderCount(mint) {
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.count;

  const attempts = [
    // [programId, dataSize filter or null]
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 165],  // standard SPL Token
    ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', null], // Token-2022 (variable size)
  ];

  for (const [programId, dataSize] of attempts) {
    for (const rpc of FREE_RPCS) {
      try {
        const filters = [{ memcmp: { offset: 0, bytes: mint } }];
        if (dataSize) filters.push({ dataSize });

        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getProgramAccounts',
            params: [programId, {
              encoding: 'base64',
              dataSlice: { offset: 64, length: 8 }, // amount field only
              filters,
              commitment: 'confirmed',
            }],
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        if (!Array.isArray(data.result) || data.result.length === 0) continue;

        // Count accounts with non-zero balance
        let count = 0;
        for (const { account } of data.result) {
          const raw = Buffer.from(account.data[0], 'base64');
          const amount = raw.readBigUInt64LE(0);
          if (amount > 0n) count++;
        }

        if (count > 0) {
          holderCache.set(mint, { count, ts: Date.now() });
          return count;
        }
      } catch (e) {
        // try next RPC
      }
    }
  }

  console.warn(`[HOLDERS] getProgramAccounts failed for ${mint.slice(0, 8)} — no count available`);
  return null;
}

// ─── Market Cap (DexScreener, cached 5 min) ───────────────────────────────────
const mcapCache = new Map(); // mint → { mcap, ts }

async function getMarketCap(mint) {
  const cached = mcapCache.get(mint);
  if (cached && Date.now() - cached.ts < 15 * 60 * 1000) return cached.mcap;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await res.json();
    const pairs = data?.pairs;
    if (!pairs || pairs.length === 0) return null;
    // Pick the pair with highest liquidity
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const mcap = best?.fdv ?? best?.marketCap ?? null;
    if (mcap != null) mcapCache.set(mint, { mcap, ts: Date.now() });
    return mcap;
  } catch (e) {
    console.error('Market cap fetch failed:', e.message);
    return null;
  }
}

// ─── Token Metadata ────────────────────────────────────────────────────────────
async function getTokenName(mint) {
  // 1. DexScreener — completely free, already used for market cap
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await res.json();
    const pairs = data?.pairs;
    if (pairs?.length > 0) {
      const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const symbol = best?.baseToken?.symbol;
      if (symbol) return symbol;
    }
  } catch (e) { /* fall through */ }

  // 2. Helius token metadata — fallback (costs credits)
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: [mint] }),
      }
    );
    const data = await res.json();
    const meta = data[0];
    return (
      meta?.onChainMetadata?.metadata?.data?.symbol ||
      meta?.legacyMetadata?.symbol ||
      mint.slice(0, 6) + '...'
    );
  } catch (e) {
    return mint.slice(0, 6) + '...';
  }
}

// ─── Helius Webhook ────────────────────────────────────────────────────────────
async function createHeliusWebhook(body) {
  const res = await fetch(
    `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!data.webhookID) throw new Error(`Helius create failed: ${JSON.stringify(data)}`);
  return data.webhookID;
}

async function syncHeliusWebhook() {
  const storage = loadStorage();
  const mints = getUniqueMints(storage);
  const webhookURL = getWebhookURL();

  console.log(`[HELIUS] Syncing webhook | url=${webhookURL} | mints=${mints.length} | existing id=${storage.webhookId || 'none'}`);

  const body = {
    webhookURL,
    transactionTypes: ['SWAP'],
    accountAddresses: mints.length > 0 ? mints : ['11111111111111111111111111111111'],
    webhookType: 'enhanced',
    authHeader: AUTH_TOKEN,
  };

  if (storage.webhookId) {
    // Try to update existing webhook; recreate if Helius says it's gone
    const res = await fetch(
      `https://api.helius.xyz/v0/webhooks/${storage.webhookId}?api-key=${HELIUS_API_KEY}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (res.ok) {
      console.log(`[HELIUS] Webhook updated OK (id=${storage.webhookId})`);
      return;
    }
    // Stale / deleted — drop the old id and create a fresh one
    console.warn(`[HELIUS] PUT failed (${res.status}) — webhook likely deleted, creating new one`);
    storage.webhookId = null;
    saveStorage(storage);
  }

  // Create new webhook
  const newId = await createHeliusWebhook(body);
  storage.webhookId = newId;
  saveStorage(storage);
  console.log(`[HELIUS] Webhook created (id=${newId})`);
}

function getWebhookURL() {
  if (RAILWAY_PUBLIC_DOMAIN) return `https://${RAILWAY_PUBLIC_DOMAIN}/webhook`;
  return `http://localhost:${PORT}/webhook`;
}

// ─── Core transaction processor (used by both polling and legacy webhook) ─────
async function processTransaction(tx, storage) {
  if (tx.type !== 'SWAP') return;
  const swap = tx.events?.swap;
  if (!swap) return;

  // Check top-level tokenOutputs, then Jupiter innerSwaps
  let tokenOut = swap.tokenOutputs?.find((t) =>
    storage.subscriptions.some((s) => s.tokenMint === t.mint)
  );
  if (!tokenOut && Array.isArray(swap.innerSwaps)) {
    for (const inner of swap.innerSwaps) {
      tokenOut = inner.tokenOutputs?.find((t) =>
        storage.subscriptions.some((s) => s.tokenMint === t.mint)
      );
      if (tokenOut) break;
    }
  }
  if (!tokenOut) return;

  const matchingSubs = storage.subscriptions.filter((s) => s.tokenMint === tokenOut.mint);
  for (const sub of matchingSubs) {
    try {
      await sendBuyAlert(sub, tx, swap, tokenOut);
      console.log(`[ALERT] → chat=${sub.chatId} tx=${tx.signature?.slice(0, 12)}`);
    } catch (err) {
      console.error(`[ERROR] chat=${sub.chatId}:`, err.message);
    }
  }
}

// ─── Free Solana RPC — replaces Helius Enhanced Transaction API ───────────────
// Uses standard getTransaction + getSignaturesForAddress (free, no API key).
// Parses token balance diffs to extract buyer, SOL spent, and tokens received.

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// RPC endpoints tried in order on failure.
// Helius node first (standard JSON-RPC — does NOT cost Enhanced API credits),
// then free public fallbacks.
const FREE_RPCS = [
  ...(HELIUS_API_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`] : []),
  'https://rpc.ankr.com/solana',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com',
];

const DEX_SOURCE_NAMES = {
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'JUPITER',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'RAYDIUM',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'RAYDIUM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':  'ORCA',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':  'PUMP_FUN',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':  'PUMP_FUN',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'METEORA',
  'Eo7WjKq67rjJQDd1d1ck1DnpxjkK3jFHXKRkBVtiTEkF': 'METEORA',
};

async function fetchRawTx(signature) {
  for (const rpc of FREE_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [signature, {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.result) return data.result;
    } catch (e) {
      console.warn(`[RPC] ${rpc.slice(0, 35)} failed: ${e.message}`);
    }
  }
  return null;
}

async function fetchSigsForAddress(mint, limit = 20) {
  for (const rpc of FREE_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [mint, { limit, commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.result)) return data.result.map(s => s.signature);
    } catch (e) {
      console.warn(`[RPC] getSignaturesForAddress failed: ${e.message}`);
    }
  }
  return [];
}

// Parse a raw jsonParsed transaction into the same shape processTransaction expects.
// Returns null if the tx is not a buy swap for one of the monitored mints.
function parseSwapFromRaw(rawTx, monitoredMints) {
  if (!rawTx || rawTx.meta?.err) return null;

  const { transaction, meta } = rawTx;
  const accountKeys = (transaction.message.accountKeys || []).map(k =>
    typeof k === 'string' ? k : k.pubkey
  );
  if (!accountKeys.length) return null;
  const buyer = accountKeys[0]; // fee payer / signer is always first key

  // Find a known DEX in all instructions + inner instructions
  const allIxs = [
    ...(transaction.message.instructions || []),
    ...(meta.innerInstructions || []).flatMap(ii => ii.instructions || []),
  ];
  const programIds = allIxs.map(ix => ix.programId).filter(Boolean);
  const dexId = programIds.find(id => DEX_PROGRAM_IDS.has(id));
  if (!dexId) return null;

  const preBals  = meta.preTokenBalances  || [];
  const postBals = meta.postTokenBalances || [];
  const preMap   = Object.fromEntries(preBals.map(b => [b.accountIndex, b]));

  // Find which monitored mint the buyer received (positive token delta for buyer)
  let tokenOut = null;
  for (const mint of monitoredMints) {
    const post = postBals.find(b => b.mint === mint && b.owner === buyer);
    if (!post) continue;
    const pre    = preMap[post.accountIndex];
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0');
    const postAmt = BigInt(post.uiTokenAmount.amount);
    if (postAmt > preAmt) {
      tokenOut = {
        mint,
        rawTokenAmount: {
          tokenAmount: (postAmt - preAmt).toString(),
          decimals: post.uiTokenAmount.decimals,
        },
      };
      break;
    }
  }
  if (!tokenOut) return null; // sell, LP action, or unrelated tx

  // SOL spent = fee payer balance decrease minus tx fee
  const solLamports = Math.max(
    0,
    (meta.preBalances[0] ?? 0) - (meta.postBalances[0] ?? 0) - (meta.fee ?? 0)
  );

  // WSOL fallback — for WSOL→Token swaps the native SOL balance barely changes
  let nativeInput = { amount: solLamports };
  if (solLamports < 1000) {
    const preWsol  = preBals.find(b => b.mint === WSOL_MINT && b.owner === buyer);
    const postWsol = preWsol
      ? postBals.find(b => b.accountIndex === preWsol.accountIndex)
      : null;
    if (preWsol && postWsol) {
      const wsolDelta = Number(preWsol.uiTokenAmount.amount) - Number(postWsol.uiTokenAmount.amount);
      if (wsolDelta > 0) nativeInput = { amount: wsolDelta };
    }
    if (nativeInput.amount < 1000) return null; // non-SOL buy (USDC etc.) — skip
  }

  return {
    type: 'SWAP',
    feePayer: buyer,
    signature: transaction.signatures?.[0] ?? null,
    source: DEX_SOURCE_NAMES[dexId] ?? 'UNKNOWN',
    events: {
      swap: {
        nativeInput,
        tokenOutputs: [tokenOut],
        innerSwaps: [],
      },
    },
  };
}

// ─── Polling — safety net for WS gaps ─────────────────────────────────────────
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 min

async function pollForSwaps() {
  const storage = loadStorage();
  const mints = getUniqueMints(storage);
  if (mints.length === 0) return;

  for (const mint of mints) {
    try {
      const sigs = await fetchSigsForAddress(mint, 20);
      let newCount = 0;
      for (const sig of sigs) {
        if (!sig || seenSignatures.has(sig) || pendingSigs.has(sig)) continue;
        markSeen(sig);
        newCount++;
        const rawTx = await fetchRawTx(sig);
        const tx = rawTx ? parseSwapFromRaw(rawTx, [mint]) : null;
        if (tx) await processTransaction(tx, storage);
      }
      if (newCount > 0) console.log(`[POLL] ${mint.slice(0, 8)} +${newCount} new tx(s)`);
    } catch (e) {
      console.error(`[POLL] Error for ${mint.slice(0, 8)}:`, e.message);
    }
  }
}

// ─── Real-time WebSocket subscriptions ────────────────────────────────────────
// logsSubscribe fires on every transaction mentioning the mint.
// DEX filter cuts ~90% of notifications. Remaining ones are parsed via free RPC.
const WebSocket = require('ws');
const wsConnections = new Map(); // mint → ws instance

// Known DEX program IDs — we only call fetchRawTx when one of these appears
// in the transaction logs. Skips transfers, ATA creations, etc. (~90% of notifications).
const DEX_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpools
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // pump.fun AMM (graduated tokens)
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQDd1d1ck1DnpxjkK3jFHXKRkBVtiTEkF', // Meteora AMM
]);

// Rate limiter for free RPC getTransaction calls.
// Max 2 concurrent, min 300ms between starts (~3 req/sec) — safe for public RPC.
let _rpcConcurrent = 0;
const _rpcWaiters = [];
const RPC_MAX_CONCURRENT = 2;
const RPC_MIN_INTERVAL_MS = 300;
let _rpcLastStart = 0;

function _drainRpcQueue() {
  if (_rpcConcurrent >= RPC_MAX_CONCURRENT || _rpcWaiters.length === 0) return;
  const now = Date.now();
  const wait = Math.max(0, _rpcLastStart + RPC_MIN_INTERVAL_MS - now);
  if (wait > 0) { setTimeout(_drainRpcQueue, wait); return; }

  const { sig, resolve, reject } = _rpcWaiters.shift();
  _rpcConcurrent++;
  _rpcLastStart = Date.now();
  fetchRawTx(sig)
    .then(resolve)
    .catch(reject)
    .finally(() => { _rpcConcurrent--; _drainRpcQueue(); });
  _drainRpcQueue();
}

function fetchRawTxQueued(signature) {
  return new Promise((resolve, reject) => {
    _rpcWaiters.push({ sig: signature, resolve, reject });
    _drainRpcQueue();
  });
}

function startWsForMint(mint) {
  if (wsConnections.has(mint)) return;

  // Use Helius WS if key is set, fall back to public Solana mainnet-beta
  const wsUrl = HELIUS_API_KEY
    ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : `wss://api.mainnet-beta.solana.com`;
  const ws = new WebSocket(wsUrl);
  let pingTimer = null;

  ws.on('open', () => {
    console.log(`[WS] Connected for ${mint.slice(0, 8)}`);
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [mint] }, { commitment: 'confirmed' }],
    }));
    // Keep-alive ping every 20 s
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20_000);
    wsLastActivity.set(mint, Date.now());
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Health-check response — clear the pending flag
      if (msg.id === 999) {
        ws._healthCheckPending = false;
        return;
      }

      // Subscription confirmed
      if (msg.id === 1 && msg.result != null) {
        console.log(`[WS] Subscribed for ${mint.slice(0, 8)} (subId=${msg.result})`);
        wsLastActivity.set(mint, Date.now());
        return;
      }
      if (msg.method !== 'logsNotification') return;

      // Any log notification counts as activity
      wsLastActivity.set(mint, Date.now());

      const value = msg.params?.result?.value;
      if (!value || value.err !== null) return; // skip failed txs

      const { signature } = value;
      // Skip if already seen or already being fetched by a concurrent WS handler
      if (!signature || seenSignatures.has(signature) || pendingSigs.has(signature)) return;

      // DEX filter — skip if no known DEX program was invoked.
      // logsSubscribe fires for ALL transactions mentioning the mint (transfers,
      // ATA creations, etc.). This filter cuts ~90% of unnecessary API calls.
      const logs = value.logs || [];
      const isDex = logs.some(l => DEX_PROGRAM_IDS.has(l.match(/^Program (\S+) invoke/)?.[1]));
      if (!isDex) return;

      // Reserve the signature — polling will skip it while we're fetching
      pendingSigs.add(signature);
      console.log(`[WS] New tx ${signature.slice(0, 12)} for ${mint.slice(0, 8)}`);

      try {
        const rawTx = await fetchRawTxQueued(signature);
        const tx = rawTx ? parseSwapFromRaw(rawTx, [mint]) : null;
        if (tx) {
          markSeen(signature);
          const storage = loadStorage();
          await processTransaction(tx, storage);
        } else {
          // Not a buy swap (sell, LP action, non-SOL buy, or tx not yet indexed)
          markSeen(signature);
          console.log(`[WS] tx ${signature.slice(0, 12)} not a buy swap — skipping`);
        }
      } catch (e) {
        // DO NOT markSeen on error — polling fallback will retry
        console.error(`[WS] fetchRawTx failed for ${signature.slice(0, 12)}:`, e.message, '— will retry via polling');
      } finally {
        pendingSigs.delete(signature);
      }
    } catch (e) {
      console.error(`[WS] Handler error for ${mint.slice(0, 8)}:`, e.message);
    }
  });

  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer);
    wsConnections.delete(mint);
    wsLastActivity.delete(mint);
  };

  ws.on('close', (code) => {
    cleanup();
    console.log(`[WS] Closed for ${mint.slice(0, 8)} (code=${code}) — reconnecting in 5 s`);
    setTimeout(() => startWsForMint(mint), 5_000);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${mint.slice(0, 8)}:`, err.message);
    ws.terminate(); // triggers close → reconnect
  });

  wsConnections.set(mint, ws);
}

function stopWsForMint(mint) {
  const ws = wsConnections.get(mint);
  if (!ws) return;
  ws.removeAllListeners('close'); // don't reconnect
  ws.terminate();
  wsConnections.delete(mint);
  console.log(`[WS] Stopped for ${mint.slice(0, 8)}`);
}

function syncWsSubscriptions() {
  const storage = loadStorage();
  const active = new Set(getUniqueMints(storage));
  for (const mint of active) {
    if (!wsConnections.has(mint)) startWsForMint(mint);
  }
  for (const mint of wsConnections.keys()) {
    if (!active.has(mint)) stopWsForMint(mint);
  }
}

// ─── Telegram API helper ───────────────────────────────────────────────────────
async function tgRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    // Telegram returns 400 when editMessageText is called with identical content — not a real error
    if (data.description?.includes('message is not modified')) return data.result;
    throw new Error(`TG ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

// ─── Settings UI ───────────────────────────────────────────────────────────────
function buildSettingsText(sub) {
  const name = sub.settings.tokenName || sub.tokenMint.slice(0, 8) + '...';
  return (
    `🐕🦴 <b>Inu Buy Bot — ${name}</b> 🦴🐕\n\n` +
    `🪙 Token: <code>${sub.tokenMint}</code>\n` +
    `🏠 Group: <code>${sub.chatId}</code>`
  );
}

function buildSettingsKeyboard(sub) {
  const s = sub.settings;
  const c = sub.chatId;
  const isActive = s.active === true;
  return {
    inline_keyboard: [
      [
        { text: isActive ? '⏸ Pause Alerts' : '▶️ Start Alerts', callback_data: `set_active:${c}` },
      ],
      [
        { text: s.gif ? '✅ Gif / Media' : '❌ Gif / Media',                        callback_data: `set_gif:${c}` },
        { text: `🦴 Min Buy $${s.minBuyUsd}`,                                        callback_data: `set_minbuy:${c}` },
      ],
      [
        { text: `${s.emoji} Emoji`,                                                  callback_data: `set_emoji:${c}` },
        { text: `🐾 Step ${s.stepUsd > 0 ? '$' + s.stepUsd : 'Auto'}`,             callback_data: `set_step:${c}` },
      ],
      [
        { text: s.showPrice ? '✅ Show Price' : '✗ Show Price',                      callback_data: `set_price:${c}` },
      ],
      [
        { text: s.whaleUsd > 0 ? `🐋 Whale Alert $${s.whaleUsd} ✅` : '🐋 Whale Alerts', callback_data: `set_whale:${c}` },
      ],
      [
        { text: s.links?.length > 0 ? `🔗 Links: ${s.links.map(l => l.label).join(' | ')}` : '🔗 Links (none set)', callback_data: `set_links:${c}` },
      ],
      [
        { text: '🎨 Customise Icons', callback_data: `set_icons:${c}` },
        { text: '👁 Preview Alert',   callback_data: `set_preview:${c}` },
      ],
      [
        { text: '🗑️ Remove Token', callback_data: `set_remove:${c}` },
      ],
    ],
  };
}

async function showSettings(chatId, sub) {
  await tgRequest('sendMessage', {
    chat_id: chatId,
    text: buildSettingsText(sub),
    parse_mode: 'HTML',
    reply_markup: buildSettingsKeyboard(sub),
  });
}

async function refreshSettings(chatId, messageId, sub) {
  try {
    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: buildSettingsText(sub),
      parse_mode: 'HTML',
      reply_markup: buildSettingsKeyboard(sub),
    });
  } catch {
    await showSettings(chatId, sub);
  }
}

// ─── Icons Sub-Panel ───────────────────────────────────────────────────────────
const ICON_LABELS = {
  header:  'Header',
  whale:   'Whale',
  spent:   'Spent',
  got:     'Got',
  buyer:   'Buyer',
  chart:   'Chart',
  mcap:    'Mkt Cap',
  holders: 'Holders',
};

function buildIconsKeyboard(sub) {
  const ic = getIcons(sub.settings);
  const c  = sub.chatId;
  return {
    inline_keyboard: [
      [
        { text: `${ic.header.emoji} Header`,   callback_data: `icon_header:${c}` },
        { text: `${ic.whale.emoji} Whale`,     callback_data: `icon_whale:${c}` },
      ],
      [
        { text: `${ic.spent.emoji} Spent`,     callback_data: `icon_spent:${c}` },
        { text: `${ic.got.emoji} Got`,         callback_data: `icon_got:${c}` },
      ],
      [
        { text: `${ic.buyer.emoji} Buyer`,     callback_data: `icon_buyer:${c}` },
        { text: `${ic.chart.emoji} Chart`,     callback_data: `icon_chart:${c}` },
      ],
      [
        { text: `${ic.mcap.emoji} Mkt Cap`,    callback_data: `icon_mcap:${c}` },
        { text: `${ic.holders.emoji} Holders`, callback_data: `icon_holders:${c}` },
      ],
      [
        { text: '← Back', callback_data: `back_settings:${c}` },
      ],
    ],
  };
}

async function showIcons(chatId, msgId, sub) {
  const name = sub.settings.tokenName || sub.tokenMint.slice(0, 8) + '...';
  const text = `🎨 <b>Icon Settings — ${name}</b>\n\nTap any icon to change it.\nYou can use any standard or custom emoji.`;
  try {
    await tgRequest('editMessageText', {
      chat_id: chatId, message_id: msgId,
      text, parse_mode: 'HTML',
      reply_markup: buildIconsKeyboard(sub),
    });
  } catch {
    await tgRequest('sendMessage', {
      chat_id: chatId,
      text, parse_mode: 'HTML',
      reply_markup: buildIconsKeyboard(sub),
    });
  }
}

// ─── Alert Builder ─────────────────────────────────────────────────────────────
function buildAlertMessage(sub, tx, swap, tokenOut, holderCount, marketCap, prevPosition) {
  const s = sub.settings;
  const decimals = tokenOut.rawTokenAmount?.decimals ?? 0;
  const rawAmount = tokenOut.rawTokenAmount?.tokenAmount ?? '0';
  const tokenAmount = Number(rawAmount) / Math.pow(10, decimals);

  const solSpent = swap.nativeInput ? swap.nativeInput.amount / 1e9 : 0;
  const usdValue = solSpent * solPriceUsd;
  const isWhale = s.whaleUsd > 0 && usdValue >= s.whaleUsd;

  const buyer = tx.feePayer || 'Unknown';
  const name = s.tokenName || sub.tokenMint.slice(0, 6) + '...';

  // Emoji row — repeat emoji based on step size, capped at 20
  // stepUsd=0 means "auto" → 1 emoji per $10 spent
  const effectiveStep = s.stepUsd > 0 ? s.stepUsd : 10;
  const stepCount = Math.min(Math.max(Math.floor(usdValue / effectiveStep), 1), 20);
  const singleEmoji = s.emojiId
    ? `<tg-emoji emoji-id="${s.emojiId}">${s.emoji}</tg-emoji>`
    : s.emoji;
  const emojiRow = Array(stepCount).fill(singleEmoji).join('');

  // Resolve per-field icons
  const icons = getIcons(s);

  // Header
  const header = isWhale
    ? `${renderIcon(icons.whale)}${renderIcon(icons.header)} <b>WHALE BUY! WOOF WOOF!</b>`
    : `<b>${name} Buy!</b>`;

  // Market cap line — from DexScreener (auto), fallback to manual circSupply
  let mcapLine = '';
  if (marketCap != null) {
    mcapLine = `${renderIcon(icons.mcap)} Market Cap: <b>${formatUsd(marketCap)}</b>\n`;
  } else if (s.circSupply > 0 && usdValue > 0 && tokenAmount > 0) {
    const pricePerToken = usdValue / tokenAmount;
    mcapLine = `${renderIcon(icons.mcap)} Market Cap: <b>${formatUsd(pricePerToken * s.circSupply)}</b>\n`;
  }

  // Price line
  let priceLine = '';
  if (s.showPrice && tokenAmount > 0 && usdValue > 0) {
    const pricePerToken = usdValue / tokenAmount;
    priceLine = `${CE.money()} Price: <b>$${pricePerToken.toFixed(8)}</b>\n`;
  }

  // Holder count line
  const holderLine = holderCount != null
    ? `${renderIcon(icons.holders)} Holders: <b>${holderCount.toLocaleString()}</b>\n`
    : '';

  // Position / PnL line
  let positionLine = '';
  if (usdValue > 0 && tokenAmount > 0) {
    if (!prevPosition) {
      positionLine = `🆕 <b>New Position</b>\n`;
    } else {
      const avgBuyPrice  = prevPosition.totalSpentUsd / prevPosition.totalTokens;
      const currentPrice = usdValue / tokenAmount;
      const pnlPct       = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
      const sign         = pnlPct >= 0 ? '+' : '';
      const pnlIcon      = pnlPct >= 0 ? '📈' : '📉';
      positionLine = `${pnlIcon} Position: <b>${sign}${pnlPct.toFixed(1)}%</b>\n`;
    }
  }

  const chartUrl = `https://dexscreener.com/solana/${sub.tokenMint}`;
  const buyUrl   = `https://jup.ag/swap/SOL-${sub.tokenMint}`;

  // Links — only shown if the user has set custom links
  const customLinks = (s.links || []).filter(l => l?.url && l?.label);
  const linksStr = customLinks.length > 0
    ? customLinks.map(l => `<a href="${l.url}">${l.label}</a>`).join(' | ')
    : '';

  const statsBlock = priceLine + mcapLine + holderLine;

  return (
    `${header}\n` +
    `${emojiRow}\n\n` +
    `${renderIcon(icons.spent)} Spent: <b>${formatUsd(usdValue)} (${solSpent.toFixed(3)} SOL)</b>\n` +
    `${renderIcon(icons.got)} Got: <b>${formatTokenAmount(tokenAmount)} ${name}</b>\n` +
    `\n` +
    `${renderIcon(icons.buyer)} <a href="https://solscan.io/account/${buyer}">Buyer</a> | <a href="https://solscan.io/tx/${tx.signature}">Txn</a>\n` +
    positionLine +
    (statsBlock ? `\n${statsBlock}` : '') +
    (linksStr ? `\n${linksStr}\n` : '')
  );
}

async function sendSettingsPreview(dmChatId, sub) {
  const s = sub.settings;
  const price = solPriceUsd > 0 ? solPriceUsd : 150;

  // Target ~3 emoji steps so the row looks meaningful
  const targetUsd    = s.stepUsd > 0 ? s.stepUsd * 3 : 150;
  const mockLamports = (targetUsd / price) * 1e9;
  const mockDecimals = 6;
  const mockRawAmt   = String(1_000_000 * Math.pow(10, mockDecimals)); // 1M tokens

  const mockTx = {
    feePayer:  'PreviewWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signature: 'PreviewTxSigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  const mockSwap = {
    nativeInput:  { amount: mockLamports },
    tokenOutputs: [{ mint: sub.tokenMint, rawTokenAmount: { tokenAmount: mockRawAmt, decimals: mockDecimals } }],
  };
  const mockTokenOut = {
    mint: sub.tokenMint,
    rawTokenAmount: { tokenAmount: mockRawAmt, decimals: mockDecimals },
  };

  // Use cached data if available, else show plausible placeholders
  const marketCap  = mcapCache.get(sub.tokenMint)?.mcap ?? null;
  const holderCount = holderCache.get(sub.tokenMint)?.count ?? null;

  const message = buildAlertMessage(sub, mockTx, mockSwap, mockTokenOut, holderCount, marketCap, null);
  const preview = `👁 <i>Preview — not a real buy</i>\n\n` + message;

  if (s.gif) {
    const method   = s.gif.type === 'animation' ? 'sendAnimation' : 'sendPhoto';
    const mediaKey = s.gif.type === 'animation' ? 'animation' : 'photo';
    await tgRequest(method, {
      chat_id: dmChatId,
      [mediaKey]: s.gif.fileId,
      caption: preview,
      parse_mode: 'HTML',
    });
  } else {
    await tgRequest('sendMessage', {
      chat_id: dmChatId,
      text: preview,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

async function sendBuyAlert(sub, tx, swap, tokenOut) {
  const s = sub.settings;
  const sig = tx.signature?.slice(0, 12);

  // Skip if alerts are paused (active===false; undefined = legacy sub = treat as active)
  if (s.active === false) {
    console.log(`[SKIP] tx=${sig} chat=${sub.chatId} reason=paused`);
    return;
  }

  // Min buy filter — bypass entirely if SOL price hasn't loaded yet (avoids silent drops)
  const solSpent = swap.nativeInput ? swap.nativeInput.amount / 1e9 : 0;
  const usdValue = solPriceUsd > 0 ? solSpent * solPriceUsd : 0;
  if (s.minBuyUsd > 0) {
    if (solPriceUsd === 0) {
      console.warn(`[WARN] tx=${sig} chat=${sub.chatId} solPrice=0 — bypassing minBuy filter, sending alert anyway`);
    } else if (usdValue < s.minBuyUsd) {
      console.log(`[SKIP] tx=${sig} chat=${sub.chatId} reason=minBuy usd=$${usdValue.toFixed(2)} < min=$${s.minBuyUsd}`);
      return;
    }
  }

  // Auto-refresh token name if it's still showing a truncated address
  if (!s.tokenName || s.tokenName.endsWith('...')) {
    const fresh = await getTokenName(sub.tokenMint);
    if (fresh && !fresh.endsWith('...')) {
      sub.settings.tokenName = fresh;
      s.tokenName = fresh;
      saveSub(sub);
      console.log(`[NAME] Refreshed token name → ${fresh}`);
    }
  }

  // Fetch holder count + market cap in parallel
  const [holderCount, marketCap] = await Promise.all([
    getHolderCount(sub.tokenMint),
    getMarketCap(sub.tokenMint),
  ]);

  // Snapshot position BEFORE this buy (so PnL reflects previous avg vs current price)
  const buyer = tx.feePayer;
  const prevPosition = buyer ? getPosition(buyer, sub.tokenMint) : null;
  const message = buildAlertMessage(sub, tx, swap, tokenOut, holderCount, marketCap, prevPosition);

  // Update position AFTER building message
  if (buyer && usdValue > 0) {
    const decimals   = swap.tokenOutputs?.find(t => t.mint === sub.tokenMint)?.rawTokenAmount?.decimals ?? 0;
    const rawAmount  = swap.tokenOutputs?.find(t => t.mint === sub.tokenMint)?.rawTokenAmount?.tokenAmount ?? '0';
    const tokenAmt   = Number(rawAmount) / Math.pow(10, decimals);
    updatePosition(buyer, sub.tokenMint, usdValue, tokenAmt);
  }

  if (s.gif) {
    const method = s.gif.type === 'animation' ? 'sendAnimation' : 'sendPhoto';
    const mediaKey = s.gif.type === 'animation' ? 'animation' : 'photo';
    await tgRequest(method, {
      chat_id: sub.chatId,
      [mediaKey]: s.gif.fileId,
      caption: message,
      parse_mode: 'HTML',
    });
  } else {
    await tgRequest('sendMessage', {
      chat_id: sub.chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

// ─── User state machine (in-memory, ephemeral setup flow) ─────────────────────
// States per userId:
//   { step: 'awaiting_chain', groupChatId }
//   { step: 'awaiting_mint',  groupChatId }
//   { step: 'awaiting_gif:<chatId>',     msgId }
//   { step: 'awaiting_minbuy:<chatId>',  msgId }
//   { step: 'awaiting_emoji:<chatId>',   msgId }
//   { step: 'awaiting_step:<chatId>',    msgId }
//   { step: 'awaiting_whale:<chatId>',   msgId }
//   { step: 'awaiting_linktg:<chatId>',  msgId }
//   { step: 'awaiting_supply:<chatId>',  msgId }
const userStates = new Map();

// ─── Bot Setup ─────────────────────────────────────────────────────────────────
let botUsername = '';
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// /start — regular help or deep-link setup from group
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = String(msg.from.id);
  const dmChatId = String(msg.chat.id);
  const param = match?.[1]?.trim();

  if (param?.startsWith('setup_')) {
    const groupChatId = param.slice(6);
    userStates.set(userId, { step: 'awaiting_chain', groupChatId });
    await tgRequest('sendMessage', {
      chat_id: dmChatId,
      text: '🐕 <b>Inu Buy Bot Setup</b>\n\nGM! Please select the chain of your token:',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Solana', callback_data: 'chain_solana' }],
        ],
      },
    });
  } else if (param?.startsWith('settings_')) {
    const groupChatId = param.slice(9);
    const sub = findSub(groupChatId);
    if (!sub) {
      await tgRequest('sendMessage', {
        chat_id: dmChatId,
        text: '❌ No token set up for that group yet. Use /add in the group first.',
      });
      return;
    }
    await showSettings(dmChatId, sub);
  } else {
    await tgRequest('sendMessage', {
      chat_id: dmChatId,
      text:
        '🐕 <b>Inu Buy Bot</b>\n\n' +
        'Woof! Add me to your group and type /add to set up real-time buy alerts.\n\n' +
        '<b>Commands:</b>\n' +
        '/add — Set up buy alerts (use in your group)\n' +
        '/settings — Manage settings (group or DM)',
      parse_mode: 'HTML',
    });
  }
});

// /add — send "Add Token" button in the group
bot.onText(/\/add/, async (msg) => {
  // Ignore if tagged at a different bot
  const tag = msg.text?.match(/^\/add@(\w+)/i)?.[1]?.toLowerCase();
  if (tag && tag !== botUsername?.toLowerCase()) return;

  if (msg.chat.type === 'private') {
    await tgRequest('sendMessage', {
      chat_id: String(msg.chat.id),
      text: 'Use /add inside the group or channel where you want buy alerts.',
    });
    return;
  }
  const groupChatId = String(msg.chat.id);
  const link = `https://t.me/${botUsername}?start=setup_${groupChatId}`;
  await tgRequest('sendMessage', {
    chat_id: groupChatId,
    text: '🐕 <b>Inu Buy Bot</b>\n\nClick below to add your token for buy alerts!',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🐾 Add Token', url: link }]],
    },
  });
});

// /settings — show settings panel (works in group or DM)
bot.onText(/\/settings/, async (msg) => {
  const tag = msg.text?.match(/^\/settings@(\w+)/i)?.[1]?.toLowerCase();
  if (tag && tag !== botUsername?.toLowerCase()) return;
  const userId = String(msg.from.id);
  const chatId = String(msg.chat.id);

  // In a group: send a deep-link button to open settings in DM
  if (msg.chat.type !== 'private') {
    const sub = findSub(chatId);
    if (!sub) {
      await tgRequest('sendMessage', { chat_id: chatId, text: '❌ No token set up yet. Use /add first.' });
      return;
    }
    const link = `https://t.me/${botUsername}?start=settings_${chatId}`;
    await tgRequest('sendMessage', {
      chat_id: chatId,
      text: `🐕 <b>Inu Buy Bot — Settings</b>\n\nClick below to manage settings for <b>${sub.settings.tokenName || sub.tokenMint.slice(0, 8) + '...'}</b>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Open Settings', url: link }]],
      },
    });
    return;
  }

  // In DM: show settings directly
  const storage = loadStorage();
  const sub = storage.subscriptions.find((s) => s.ownerId === userId);
  if (!sub) {
    await tgRequest('sendMessage', { chat_id: chatId, text: '❌ No token set up yet. Use /add in your group first.' });
    return;
  }
  await showSettings(chatId, sub);
});

// /cancel — abort any active input state
bot.onText(/\/cancel/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  userStates.delete(String(msg.from.id));
  await tgRequest('sendMessage', { chat_id: String(msg.chat.id), text: '❌ Cancelled.' });
});

// /status — show system status (DM only)
bot.onText(/\/status/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const storage = loadStorage();
  const subs = storage.subscriptions;

  const subLines = subs.length === 0
    ? '  <i>No subscriptions</i>'
    : subs.map((s) =>
        `  • <b>${s.settings.tokenName || s.tokenMint.slice(0, 8) + '...'}</b>\n` +
        `    chat: <code>${s.chatId}</code>\n` +
        `    mint: <code>${s.tokenMint}</code>\n` +
        `    active: ${s.settings.active === true ? '▶️ yes' : '⏸ no'}\n` +
        `    minBuy: $${s.settings.minBuyUsd}`
      ).join('\n');

  const wsStateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
  const wsLines = wsConnections.size === 0
    ? '  <i>No active WebSocket connections</i>'
    : [...wsConnections.entries()].map(([m, w]) => {
        const state = wsStateNames[w.readyState] ?? '?';
        const lastAct = wsLastActivity.get(m);
        const ageSec = lastAct ? Math.round((Date.now() - lastAct) / 1000) : null;
        const ageStr = ageSec != null ? `${ageSec}s ago` : 'never';
        const health = w._healthCheckPending ? ' ⚠️ health check pending' : '';
        return `  • <code>${m.slice(0, 8)}</code> ${state} | last msg: ${ageStr}${health}`;
      }).join('\n');

  const text =
    `🐕 <b>Inu Buy Bot — Status</b>\n\n` +
    `💾 Storage: <code>${STORAGE_FILE}</code>\n` +
    `📡 Helius webhook ID: <code>${storage.webhookId || 'none'}</code>\n` +
    `💰 SOL price: <b>$${solPriceUsd > 0 ? solPriceUsd.toFixed(2) : '(not loaded)'}</b>\n` +
    `🌐 Webhook URL: <code>${getWebhookURL()}</code>\n` +
    `🔌 Seen sigs: ${seenSignatures.size} | Pending: ${pendingSigs.size}\n\n` +
    `<b>WebSocket connections (${wsConnections.size}):</b>\n${wsLines}\n\n` +
    `<b>Subscriptions (${subs.length}):</b>\n${subLines}`;

  await tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
});

// ─── Callback query handler (all button presses) ───────────────────────────────
bot.on('callback_query', async (query) => {
  const userId = String(query.from.id);
  const dmChatId = String(query.message.chat.id);
  const msgId = query.message.message_id;
  const data = query.data;

  // ── Chain selection ──
  if (data === 'chain_solana') {
    const state = userStates.get(userId);
    if (!state) {
      await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
      return;
    }
    state.step = 'awaiting_mint';
    userStates.set(userId, state);
    await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
    await tgRequest('editMessageText', {
      chat_id: dmChatId,
      message_id: msgId,
      text: '🐾 <b>Send the token address to track [SOL]</b>\n\nPaste the contract address below:',
      parse_mode: 'HTML',
    });
    return;
  }

  // ── Settings buttons ──
  if (data.startsWith('set_')) {
    const colonIdx = data.indexOf(':');
    const key = data.slice(4, colonIdx);         // e.g. 'gif', 'minbuy'
    const groupChatId = data.slice(colonIdx + 1); // e.g. '-1001234...'

    // Stub buttons
    if (['trending'].includes(key)) {
      await tgRequest('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '🔜 Coming soon!',
        show_alert: true,
      });
      return;
    }

    await tgRequest('answerCallbackQuery', { callback_query_id: query.id });

    const sub = findSub(groupChatId);
    if (!sub) {
      await tgRequest('sendMessage', { chat_id: dmChatId, text: '❌ Subscription not found.' });
      return;
    }

    switch (key) {
      case 'gif':
        if (sub.settings.gif) {
          sub.settings.gif = null;
          saveSub(sub);
          await refreshSettings(dmChatId, msgId, sub);
        } else {
          userStates.set(userId, { step: `awaiting_gif:${groupChatId}`, msgId });
          await tgRequest('sendMessage', {
            chat_id: dmChatId,
            text: '🖼 Send a GIF or image to show with every buy alert.\nSend /cancel to abort.',
          });
        }
        break;

      case 'minbuy':
        userStates.set(userId, { step: `awaiting_minbuy:${groupChatId}`, msgId });
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text:
            `💵 Enter the minimum buy amount in USD.\nBuys below this are ignored.\n\n` +
            `Current: <b>$${sub.settings.minBuyUsd}</b> — send <code>0</code> to disable.\n\n/cancel to abort.`,
          parse_mode: 'HTML',
        });
        break;

      case 'emoji':
        userStates.set(userId, { step: `awaiting_emoji:${groupChatId}`, msgId });
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text:
            `🎨 Send an emoji to use in buy alert headers.\n\n` +
            `Current: <b>${sub.settings.emoji}</b>\n\n/cancel to abort.`,
          parse_mode: 'HTML',
        });
        break;

      case 'step':
        userStates.set(userId, { step: `awaiting_step:${groupChatId}`, msgId });
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text:
            `📊 Enter the step size in USD — one emoji is added per step.\n\n` +
            `Current: <b>${sub.settings.stepUsd > 0 ? '$' + sub.settings.stepUsd : 'Auto ($10/emoji)'}</b>\n\n` +
            `Send <code>0</code> for auto-scale ($10/emoji), or a dollar amount e.g. <code>25</code>.\n/cancel to abort.`,
          parse_mode: 'HTML',
        });
        break;

      case 'links': {
        const currentLinks = sub.settings.links || [];
        userStates.set(userId, {
          step: `awaiting_links:${groupChatId}`,
          msgId,
          linkPhase: 'url',
          linkIdx: 0,
          linkDraft: [],
        });
        let prompt = '🔗 <b>Custom Links Setup</b>\n\nSet up to 3 links shown on every buy alert.\n\n';
        if (currentLinks.length > 0) {
          prompt += '<b>Current links:</b>\n' +
            currentLinks.map((l, i) => `  ${i + 1}. <b>${l.label}</b> — ${l.url}`).join('\n') +
            '\n\n';
        }
        prompt += `Send a URL for <b>Link 1</b>\n(type <code>skip</code> to skip this slot, /cancel to abort):`;
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text: prompt,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        break;
      }

      case 'active':
        sub.settings.active = !sub.settings.active;
        saveSub(sub);
        await tgRequest('answerCallbackQuery', {
          callback_query_id: query.id,
          text: sub.settings.active ? '▶️ Alerts started! Woof!' : '⏸ Alerts paused.',
          show_alert: true,
        });
        await refreshSettings(dmChatId, msgId, sub);
        return;

      case 'price':
        sub.settings.showPrice = !sub.settings.showPrice;
        saveSub(sub);
        await refreshSettings(dmChatId, msgId, sub);
        break;

      case 'whale':
        if (sub.settings.whaleUsd > 0) {
          sub.settings.whaleUsd = 0;
          saveSub(sub);
          await refreshSettings(dmChatId, msgId, sub);
        } else {
          userStates.set(userId, { step: `awaiting_whale:${groupChatId}`, msgId });
          await tgRequest('sendMessage', {
            chat_id: dmChatId,
            text:
              `🐋 Enter the USD threshold for whale alerts.\nBuys above this get special 🐋 formatting.\n\n` +
              `/cancel to abort.`,
            parse_mode: 'HTML',
          });
        }
        break;

      case 'linktg':
        userStates.set(userId, { step: `awaiting_linktg:${groupChatId}`, msgId });
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text:
            `🔗 Send your project's Telegram link.\nIt will appear as a button on every buy alert.\n\n` +
            `Current: <b>${sub.settings.linkTg || 'Not set'}</b>\n\n/cancel to abort.`,
          parse_mode: 'HTML',
        });
        break;

      case 'supply':
        userStates.set(userId, { step: `awaiting_supply:${groupChatId}`, msgId });
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text:
            `🔄 Enter the circulating supply (used to calculate market cap).\n\n` +
            `Current: <b>${sub.settings.circSupply > 0 ? sub.settings.circSupply.toLocaleString() : 'Not set'}</b>\n\n/cancel to abort.`,
          parse_mode: 'HTML',
        });
        break;

      case 'icons':
        await showIcons(dmChatId, msgId, sub);
        break;

      case 'preview':
        await sendSettingsPreview(dmChatId, sub);
        break;

      case 'remove':
        await tgRequest('editMessageText', {
          chat_id: dmChatId,
          message_id: msgId,
          text:
            `🗑️ <b>Remove Token</b>\n\n` +
            `Are you sure you want to remove <b>${sub.settings.tokenName || sub.tokenMint.slice(0, 8) + '...'}</b> and stop all alerts for this group?`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Yes, remove it', callback_data: `confirm_remove:${groupChatId}` },
              { text: '❌ Cancel',         callback_data: `back_settings:${groupChatId}` },
            ]],
          },
        });
        break;
    }
  }

  // ── Confirm remove ──
  if (data.startsWith('confirm_remove:')) {
    const groupChatId = data.slice(15);
    await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
    const storage = loadStorage();
    storage.subscriptions = storage.subscriptions.filter((s) => s.chatId !== groupChatId);
    saveStorage(storage);
    syncWsSubscriptions(); // close WS for any mint no longer tracked
    await tgRequest('editMessageText', {
      chat_id: dmChatId,
      message_id: msgId,
      text: '✅ Token removed. Alerts for this group have been stopped.\n\nUse /add in the group to set up a new token.',
    });
    return;
  }

  // ── Back to settings ──
  if (data.startsWith('back_settings:')) {
    const groupChatId = data.slice(14);
    await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
    const sub = findSub(groupChatId);
    if (sub) await refreshSettings(dmChatId, msgId, sub);
    return;
  }

  // ── Icon field buttons (from icons sub-panel) ──
  if (data.startsWith('icon_')) {
    const colonIdx    = data.indexOf(':');
    const field       = data.slice(5, colonIdx);       // e.g. 'header', 'spent'
    const groupChatId = data.slice(colonIdx + 1);
    await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
    const sub = findSub(groupChatId);
    if (!sub) return;
    const ic = getIcons(sub.settings);
    userStates.set(userId, { step: `awaiting_icon_${field}:${groupChatId}`, msgId });
    await tgRequest('sendMessage', {
      chat_id: dmChatId,
      text:
        `🎨 <b>Change ${ICON_LABELS[field] || field} icon</b>\n\n` +
        `Send any emoji or custom emoji.\n` +
        `Current: ${ic[field]?.emoji || '?'}\n\n/cancel to abort.`,
      parse_mode: 'HTML',
    });
    return;
  }
});

// ─── Message handler — handles all awaiting-input states in DM ────────────────
bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;
  if (msg.text?.startsWith('/')) return; // handled by onText

  const userId = String(msg.from.id);
  const dmChatId = String(msg.chat.id);
  const state = userStates.get(userId);
  if (!state) return;

  const { step } = state;

  // ── Awaiting token mint ──
  if (step === 'awaiting_mint') {
    const tokenMint = msg.text?.trim();
    if (!tokenMint || tokenMint.length < 32 || tokenMint.length > 44) {
      await tgRequest('sendMessage', {
        chat_id: dmChatId,
        text: '❌ That doesn\'t look like a valid Solana address. Try again or /cancel.',
      });
      return;
    }

    userStates.delete(userId);

    await tgRequest('sendMessage', { chat_id: dmChatId, text: '⏳ Fetching token info...' });

    const tokenName = await getTokenName(tokenMint);
    const settings = defaultSettings();
    settings.tokenName = tokenName;

    const sub = { chatId: state.groupChatId, ownerId: userId, tokenMint, settings };
    const storage = loadStorage();
    storage.subscriptions = storage.subscriptions.filter((s) => s.chatId !== state.groupChatId);
    storage.subscriptions.push(sub);
    saveStorage(storage);

    syncWsSubscriptions(); // open WS for the new mint immediately

    await tgRequest('sendMessage', {
      chat_id: dmChatId,
      text: `✅ <b>${tokenName}</b> is set up!\n\nCustomise your alert below, then press <b>▶️ Start Alerts</b> when you're ready.`,
      parse_mode: 'HTML',
    });
    await showSettings(dmChatId, sub);
    return;
  }

  // ── Awaiting settings input ──
  // step format: 'awaiting_<action>:<groupChatId>'
  const colonIdx = step.indexOf(':');
  if (colonIdx < 0) return;
  const action = step.slice(9, colonIdx); // strip 'awaiting_'
  const groupChatId = step.slice(colonIdx + 1);
  const { msgId } = state;

  const sub = findSub(groupChatId);
  if (!sub) {
    userStates.delete(userId);
    await tgRequest('sendMessage', { chat_id: dmChatId, text: '❌ Subscription not found.' });
    return;
  }

  let error = null;

  // ── Links wizard (URL → label → URL → label → …, up to 3 links) ──
  if (action === 'links') {
    const { linkPhase, linkIdx, linkDraft } = state;
    const text = msg.text?.trim();

    if (linkPhase === 'url') {
      if (text?.toLowerCase() === 'skip' || text?.toLowerCase() === 'done') {
        // Finish early — save whatever links have been collected so far
        sub.settings.links = (linkDraft || []).filter(l => l?.url && l?.label);
        saveSub(sub);
        userStates.delete(userId);
        const n = sub.settings.links.length;
        await tgRequest('sendMessage', { chat_id: dmChatId, text: `✅ Links saved! (${n} link${n !== 1 ? 's' : ''} set)` });
        await showSettings(dmChatId, sub);
        if (msgId) { try { await tgRequest('editMessageReplyMarkup', { chat_id: dmChatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }); } catch {} }
        return;
      }
      if (!text?.startsWith('http')) {
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text: '❌ Please send a valid URL starting with <code>https://</code>\n\nOr type <code>skip</code> to finish, /cancel to abort.',
          parse_mode: 'HTML',
        });
        return;
      }
      const draft = linkDraft || [];
      draft[linkIdx] = { url: text, label: '' };
      state.linkDraft = draft;
      state.linkPhase = 'label';
      userStates.set(userId, state);
      await tgRequest('sendMessage', {
        chat_id: dmChatId,
        text: `✅ URL saved!\n\nNow send a <b>label</b> for Link ${linkIdx + 1} (max 7 chars, e.g. <code>Chart</code>, <code>X</code>, <code>Web</code>):`,
        parse_mode: 'HTML',
      });
    } else {
      // 'label' phase
      if (!text) {
        await tgRequest('sendMessage', { chat_id: dmChatId, text: '❌ Please send a label (max 7 characters).' });
        return;
      }
      const label = text.slice(0, 7);
      const draft = linkDraft || [];
      draft[linkIdx] = { ...(draft[linkIdx] || {}), label };
      state.linkDraft = draft;

      if (linkIdx < 2) {
        state.linkPhase = 'url';
        state.linkIdx = linkIdx + 1;
        userStates.set(userId, state);
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text:
            `✅ Link ${linkIdx + 1} saved as "<b>${label}</b>"!\n\n` +
            `Send a URL for <b>Link ${linkIdx + 2}</b>\n(or type <code>skip</code> to finish, /cancel to abort):`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } else {
        // All 3 done
        sub.settings.links = draft.filter(l => l?.url && l?.label);
        saveSub(sub);
        userStates.delete(userId);
        await tgRequest('sendMessage', {
          chat_id: dmChatId,
          text: `✅ Link 3 saved as "<b>${label}</b>"! All links updated.`,
          parse_mode: 'HTML',
        });
        await showSettings(dmChatId, sub);
        if (msgId) { try { await tgRequest('editMessageReplyMarkup', { chat_id: dmChatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }); } catch {} }
      }
    }
    return;
  }

  // ── Icon field input ──
  if (action.startsWith('icon_')) {
    const field = action.slice(5); // e.g. 'header'
    if (!sub.settings.icons) sub.settings.icons = {};
    const customEntity = msg.entities?.find(e => e.type === 'custom_emoji');
    if (customEntity) {
      const fallback = msg.text?.slice(customEntity.offset, customEntity.offset + customEntity.length) || '❓';
      sub.settings.icons[field] = { emoji: fallback, emojiId: customEntity.custom_emoji_id };
    } else {
      const e = msg.text?.trim();
      if (!e) {
        await tgRequest('sendMessage', { chat_id: dmChatId, text: '❌ Please send an emoji.' });
        return;
      }
      sub.settings.icons[field] = { emoji: e, emojiId: null };
    }
    saveSub(sub);
    userStates.delete(userId);
    await showIcons(dmChatId, msgId, sub);
    return;
  }

  switch (action) {
    case 'gif':
      if (msg.animation) {
        sub.settings.gif = { fileId: msg.animation.file_id, type: 'animation' };
      } else if (msg.photo) {
        sub.settings.gif = { fileId: msg.photo[msg.photo.length - 1].file_id, type: 'photo' };
      } else if (msg.document?.mime_type?.startsWith('image/')) {
        sub.settings.gif = { fileId: msg.document.file_id, type: 'animation' };
      } else {
        error = '❌ Please send a GIF or image file.';
      }
      break;

    case 'minbuy': {
      const val = parseFloat(msg.text);
      if (isNaN(val) || val < 0) { error = '❌ Please enter a valid number, e.g. <code>15</code>.'; break; }
      sub.settings.minBuyUsd = val;
      break;
    }

    case 'emoji': {
      // Custom emoji come in via entities, not msg.text
      const customEntity = msg.entities?.find(e => e.type === 'custom_emoji');
      if (customEntity) {
        const fallback = msg.text?.slice(customEntity.offset, customEntity.offset + customEntity.length) || '🐕';
        sub.settings.emoji   = fallback;
        sub.settings.emojiId = customEntity.custom_emoji_id;
      } else {
        const e = msg.text?.trim();
        if (!e) { error = '❌ Please send an emoji.'; break; }
        sub.settings.emoji   = e;
        sub.settings.emojiId = null;
      }
      break;
    }

    case 'step': {
      const val = parseFloat(msg.text);
      if (isNaN(val) || val < 0) { error = '❌ Please enter a valid number.'; break; }
      sub.settings.stepUsd = val;
      break;
    }

    case 'whale': {
      const val = parseFloat(msg.text);
      if (isNaN(val) || val <= 0) { error = '❌ Please enter a positive USD amount, e.g. <code>1000</code>.'; break; }
      sub.settings.whaleUsd = val;
      break;
    }

    case 'linktg': {
      const link = msg.text?.trim();
      if (!link?.startsWith('http')) { error = '❌ Please send a valid URL starting with https://'; break; }
      sub.settings.linkTg = link;
      break;
    }

    case 'supply': {
      const val = parseInt(msg.text?.replace(/[,_]/g, ''), 10);
      if (isNaN(val) || val <= 0) { error = '❌ Please enter a valid whole number.'; break; }
      sub.settings.circSupply = val;
      break;
    }

    default:
      return;
  }

  if (error) {
    await tgRequest('sendMessage', { chat_id: dmChatId, text: error, parse_mode: 'HTML' });
    return;
  }

  saveSub(sub);
  userStates.delete(userId);

  // Always send a fresh menu below the conversation so the user can see
  // it immediately and continue editing — the old menu is now scrolled up.
  await showSettings(dmChatId, sub);
  // Strip buttons from the old menu message so stale buttons can't be clicked.
  if (msgId) {
    try {
      await tgRequest('editMessageReplyMarkup', {
        chat_id: dmChatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch { /* ignore — old message may have been deleted */ }
  }
});

// ─── Express (Helius webhook receiver) ────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Solana Buy Alert Bot is running!'));

// Legacy webhook endpoint — kept as a fallback in case Helius still delivers events
// for a while after the webhook is deleted. Polling is now the primary mechanism.
app.post('/webhook', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== AUTH_TOKEN) return res.status(401).send('Unauthorized');
  res.send('OK'); // respond immediately so Helius doesn't retry

  const transactions = req.body;
  if (!Array.isArray(transactions)) return;
  const storage = loadStorage();
  for (const tx of transactions) {
    if (!tx.signature || seenSignatures.has(tx.signature)) continue;
    markSeen(tx.signature);
    console.log(`[WEBHOOK] Processing tx=${tx.signature?.slice(0, 12)}`);
    await processTransaction(tx, storage);
  }
});

// ─── Register bot commands ─────────────────────────────────────────────────────
async function registerBotCommands() {
  await tgRequest('setMyCommands', {
    commands: [
      { command: 'add',      description: 'Set up buy alerts in this group' },
      { command: 'settings', description: 'Manage your token settings' },
      { command: 'status',   description: 'Show bot status & subscriptions (DM)' },
      { command: 'cancel',   description: 'Cancel current input (DM only)' },
      { command: 'start',    description: 'Show help' },
    ],
  });
  console.log('Bot commands registered');
}

// ─── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`[STORAGE] File: ${STORAGE_FILE}`);

  // Log what's in storage right now
  const startupStorage = loadStorage();
  console.log(`[STORAGE] Loaded ${startupStorage.subscriptions.length} subscription(s), webhookId=${startupStorage.webhookId || 'none'}`);
  for (const s of startupStorage.subscriptions) {
    console.log(`  ↳ chat=${s.chatId} mint=${s.tokenMint} active=${s.settings.active} name=${s.settings.tokenName}`);
  }

  // Get bot username (needed for deep links in /add)
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await res.json();
    botUsername = data.result.username;
    console.log(`Bot: @${botUsername}`);
  } catch (e) {
    console.error('Failed to get bot info:', e.message);
  }

  try { await registerBotCommands(); } catch (e) { console.error('Commands error:', e.message); }

  await updateSolPrice();
  setInterval(updateSolPrice, 15 * 60 * 1000); // every 15 min — price doesn't need to be real-time

  // ── Delete existing Helius webhook so we stop being billed per-event ──────
  if (startupStorage.webhookId) {
    try {
      const delRes = await fetch(
        `https://api.helius.xyz/v0/webhooks/${startupStorage.webhookId}?api-key=${HELIUS_API_KEY}`,
        { method: 'DELETE' }
      );
      if (delRes.ok) {
        console.log(`[HELIUS] Webhook deleted (id=${startupStorage.webhookId}) — switching to polling`);
        startupStorage.webhookId = null;
        saveStorage(startupStorage);
      } else {
        console.warn(`[HELIUS] Could not delete webhook: HTTP ${delRes.status}`);
      }
    } catch (e) {
      console.error('[HELIUS] Webhook delete error:', e.message);
    }
  }

  // ── Seed seen-signatures so we don't re-alert on old txs after restart ───
  const initMints = getUniqueMints(startupStorage);
  for (const mint of initMints) {
    try {
      const sigs = await fetchSigsForAddress(mint, 10);
      sigs.forEach(sig => sig && seenSignatures.add(sig));
    } catch (e) { /* non-fatal */ }
  }
  console.log(`[POLL] Seeded ${seenSignatures.size} recent signature(s)`);

  // ── Start real-time WebSocket subscriptions ───────────────────────────────
  syncWsSubscriptions();

  // ── WS health check — send JSON-RPC getHealth every 60 s ─────────────────
  // If the previous health check went unanswered, the connection is silently
  // dead and we force a reconnect via terminate() → close → startWsForMint.
  setInterval(() => {
    for (const [mint, ws] of wsConnections.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      if (ws._healthCheckPending) {
        // Previous ping was never answered — connection is stale
        console.warn(`[WS] Health check unanswered for ${mint.slice(0, 8)} — forcing reconnect`);
        ws.terminate(); // triggers close → 5 s → startWsForMint
        continue;
      }

      // Send a new health ping
      ws._healthCheckPending = true;
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'getHealth' }));
      } catch (e) {
        console.error(`[WS] Health ping send failed for ${mint.slice(0, 8)}:`, e.message);
        ws.terminate();
      }
    }
  }, 60_000);

  // ── Polling fallback (catches anything the WS misses, e.g. failed fetchRawTx)
  setInterval(pollForSwaps, POLL_INTERVAL_MS);
  console.log(`[POLL] Fallback polling started — interval=${POLL_INTERVAL_MS / 1000}s`);
  setTimeout(pollForSwaps, 8000); // one initial poll after startup
});
