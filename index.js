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
    linkTg: '',        // project Telegram link shown as button in alert
    circSupply: 0,     // circulating supply for market cap calc
    tokenName: '',     // token symbol fetched from Helius metadata
    active: false,     // whether alerts are currently enabled (must be started manually)
    icons: {           // per-field icon overrides { emoji, emojiId }
      header:  { emoji: '🤑', emojiId: '5791791406137744300' },
      whale:   { emoji: '🐋', emojiId: '5051129106305909986' },
      spent:   { emoji: '➡️', emojiId: '5082729418380543512' },
      got:     { emoji: '⬅️', emojiId: '5050816424096826643' },
      buyer:   { emoji: '👤', emojiId: '5087015559518750311' },
      chart:   { emoji: '📈', emojiId: '5082455498251306031' },
      mcap:    { emoji: '📊', emojiId: '5084645137003316287' },
      holders: { emoji: '📊', emojiId: '5179533127919338363' },
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

// ─── Holder Count (cached, 5-min TTL) ─────────────────────────────────────────
const holderCache = new Map(); // mint → { count, ts }

async function getHolderCount(mint) {
  // Cache for 30 minutes — holder count changes slowly and this call costs credits
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.count;
  try {
    // Use Helius DAS getTokenAccounts (1 credit) instead of getProgramAccounts (100 credits)
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccounts',
          params: {
            page: 1,
            limit: 1,
            displayOptions: { showZeroBalance: false },
            mint,
          },
        }),
      }
    );
    const data = await res.json();
    const count = data.result?.total ?? null;
    if (count != null) holderCache.set(mint, { count, ts: Date.now() });
    return count;
  } catch (e) {
    console.error('Holder count fetch failed:', e.message);
    return null;
  }
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

// ─── Telegram API helper ───────────────────────────────────────────────────────
async function tgRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`TG ${method} failed: ${JSON.stringify(data)}`);
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
        { text: `🐾 Step $${s.stepUsd}`,                                             callback_data: `set_step:${c}` },
      ],
      [
        { text: s.showPrice ? '✅ Show Price' : '✗ Show Price',                      callback_data: `set_price:${c}` },
      ],
      [
        { text: s.whaleUsd > 0 ? `🐋 Whale Alert $${s.whaleUsd} ✅` : '🐋 Whale Alerts', callback_data: `set_whale:${c}` },
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
  const stepCount = s.stepUsd > 0 ? Math.min(Math.max(Math.floor(usdValue / s.stepUsd), 1), 20) : 1;
  const singleEmoji = s.emojiId
    ? `<tg-emoji emoji-id="${s.emojiId}">${s.emoji}</tg-emoji>`
    : s.emoji;
  const emojiRow = Array(stepCount).fill(singleEmoji).join('');

  // Resolve per-field icons
  const icons = getIcons(s);

  // Header
  const header = isWhale
    ? `${renderIcon(icons.whale)}${renderIcon(icons.header)} <b>WHALE BUY! WOOF WOOF!</b>`
    : `${renderIcon(icons.header)} <b>${name} Buy!</b>`;

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

  return (
    `${header}\n` +
    `${emojiRow}\n\n` +
    `${renderIcon(icons.spent)} Spent: <b>${formatUsd(usdValue)} (${solSpent.toFixed(3)} SOL)</b>\n` +
    `${renderIcon(icons.got)} Got: <b>${formatTokenAmount(tokenAmount)} ${name}</b>\n` +
    `${renderIcon(icons.buyer)} <a href="https://solscan.io/account/${buyer}">Buyer</a> | <a href="https://solscan.io/tx/${tx.signature}">Txn</a> | ${renderIcon(icons.chart)}<a href="${chartUrl}">Chart</a> | <a href="${buyUrl}">Buy</a>\n` +
    positionLine +
    priceLine +
    mcapLine +
    holderLine
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

  const text =
    `🐕 <b>Inu Buy Bot — Status</b>\n\n` +
    `💾 Storage: <code>${STORAGE_FILE}</code>\n` +
    `📡 Helius webhook ID: <code>${storage.webhookId || 'none'}</code>\n` +
    `💰 SOL price: <b>$${solPriceUsd > 0 ? solPriceUsd.toFixed(2) : '(not loaded)'}</b>\n` +
    `🌐 Webhook URL: <code>${getWebhookURL()}</code>\n\n` +
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
            `📊 Enter the step size in USD for buy progression.\n\n` +
            `Current: <b>$${sub.settings.stepUsd}</b>\n\n/cancel to abort.`,
          parse_mode: 'HTML',
        });
        break;

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
    try { await syncHeliusWebhook(); } catch (e) { console.error('Helius sync error:', e.message); }
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

    try { await syncHeliusWebhook(); } catch (e) { console.error('Helius sync error:', e.message); }

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

  if (msgId) {
    await refreshSettings(dmChatId, msgId, sub);
  } else {
    await showSettings(dmChatId, sub);
  }
});

// ─── Express (Helius webhook receiver) ────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Solana Buy Alert Bot is running!'));

app.post('/webhook', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== AUTH_TOKEN) {
    console.warn('Unauthorized webhook attempt');
    return res.status(401).send('Unauthorized');
  }

  const transactions = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) return res.send('OK');

  console.log(`[WEBHOOK] Received ${transactions.length} tx(s)`);
  const storage = loadStorage();

  for (const tx of transactions) {
    if (tx.type !== 'SWAP') {
      console.log(`[SKIP] tx=${tx.signature?.slice(0, 12)} reason=type:${tx.type}`);
      continue;
    }
    const swap = tx.events?.swap;
    if (!swap) {
      console.log(`[SKIP] tx=${tx.signature?.slice(0, 12)} reason=no_swap_event`);
      continue;
    }

    // Check top-level tokenOutputs first, then Jupiter innerSwaps
    let tokenOut = swap.tokenOutputs?.find((t) =>
      storage.subscriptions.some((s) => s.tokenMint === t.mint)
    );

    if (!tokenOut && Array.isArray(swap.innerSwaps)) {
      for (const inner of swap.innerSwaps) {
        tokenOut = inner.tokenOutputs?.find((t) =>
          storage.subscriptions.some((s) => s.tokenMint === t.mint)
        );
        if (tokenOut) {
          console.log(`[INNER] Found token in innerSwaps for tx=${tx.signature?.slice(0, 12)}`);
          break;
        }
      }
    }

    if (!tokenOut) {
      const outMints = (swap.tokenOutputs || []).map((t) => t.mint?.slice(0, 8)).join(',');
      console.log(`[SKIP] tx=${tx.signature?.slice(0, 12)} reason=no_matching_token outMints=[${outMints}]`);
      continue;
    }

    const matchingSubs = storage.subscriptions.filter((s) => s.tokenMint === tokenOut.mint);

    // Log what we found so we can debug
    console.log(`[MATCH] tx=${tx.signature?.slice(0, 12)} feePayer=${tx.feePayer?.slice(0, 8)} nativeInput.account=${swap.nativeInput?.account?.slice(0, 8)} tokenOut.userAccount=${tokenOut.userAccount?.slice(0, 8)} subs=${matchingSubs.length}`);

    for (const sub of matchingSubs) {
      try {
        await sendBuyAlert(sub, tx, swap, tokenOut);
        console.log(`[ALERT] → chat=${sub.chatId} tx=${tx.signature?.slice(0, 12)}`);
      } catch (err) {
        console.error(`[ERROR] Alert failed chat=${sub.chatId}:`, err.message);
      }
    }
  }

  res.send('OK');
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
  setInterval(updateSolPrice, 2 * 60 * 1000);

  try {
    await syncHeliusWebhook();
  } catch (e) {
    console.error('[HELIUS] Sync failed:', e.message);
  }
});
