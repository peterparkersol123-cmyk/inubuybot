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
    minBuyUsd: 0,      // minimum buy in USD to trigger alert (0 = all)
    emoji: '🐕',       // emoji shown in alert header
    stepUsd: 0,        // step size in USD (stored, future use)
    showPrice: false,  // show token price per unit in alert
    ignoreMev: true,   // skip txs where feePayer !== token receiver
    whaleUsd: 50000,   // whale alert threshold in USD (0 = off)
    linkTg: '',        // project Telegram link shown as button in alert
    circSupply: 0,     // circulating supply for market cap calc
    tokenName: '',     // token symbol fetched from Helius metadata
  };
}

// ─── SOL Price (updated every 2 min) ──────────────────────────────────────────
let solPriceUsd = 0;
async function updateSolPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    const data = await res.json();
    const price = parseFloat(data.price);
    if (price > 0) solPriceUsd = price;
    console.log(`SOL price updated: $${solPriceUsd}`);
  } catch (e) {
    console.error('SOL price fetch failed:', e.message);
  }
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

// ─── Holder Count (cached, 5-min TTL) ─────────────────────────────────────────
const holderCache = new Map(); // mint → { count, ts }

async function getHolderCount(mint) {
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.count;
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getProgramAccounts',
          params: [
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            {
              encoding: 'base64',
              dataSlice: { offset: 0, length: 0 }, // no data, just count
              filters: [
                { dataSize: 165 },
                { memcmp: { offset: 0, bytes: mint } },
              ],
            },
          ],
        }),
      }
    );
    const data = await res.json();
    const count = data.result?.length ?? 0;
    holderCache.set(mint, { count, ts: Date.now() });
    return count;
  } catch (e) {
    console.error('Holder count fetch failed:', e.message);
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
async function syncHeliusWebhook() {
  const storage = loadStorage();
  const mints = getUniqueMints(storage);
  const webhookURL = getWebhookURL();

  const body = {
    webhookURL,
    transactionTypes: ['SWAP'],
    accountAddresses: mints.length > 0 ? mints : ['11111111111111111111111111111111'],
    webhookType: 'enhanced',
    authHeader: AUTH_TOKEN,
  };

  if (storage.webhookId) {
    const res = await fetch(
      `https://api.helius.xyz/v0/webhooks/${storage.webhookId}?api-key=${HELIUS_API_KEY}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    return res.json();
  } else {
    const res = await fetch(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();
    storage.webhookId = data.webhookID;
    saveStorage(storage);
    console.log('Helius webhook created:', data.webhookID);
    return data;
  }
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
  return {
    inline_keyboard: [
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
        { text: s.ignoreMev ? '✅ Ignore MEVs' : '✗ Ignore MEVs',                   callback_data: `set_mev:${c}` },
      ],
      [
        { text: s.whaleUsd > 0 ? `🐋 Whale Alert $${s.whaleUsd} ✅` : '🐋 Whale Alerts', callback_data: `set_whale:${c}` },
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

// ─── Alert Builder ─────────────────────────────────────────────────────────────
function buildAlertMessage(sub, tx, swap, tokenOut, holderCount) {
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
  const emojiRow = Array(stepCount).fill(s.emoji).join('');

  // Header
  const header = isWhale
    ? `🐋🐕 <b>WHALE BUY! WOOF WOOF!</b>`
    : `<b>${name} Buy!</b>`;

  // Market cap line
  let mcapLine = '';
  if (s.circSupply > 0 && usdValue > 0 && tokenAmount > 0) {
    const pricePerToken = usdValue / tokenAmount;
    const mcap = pricePerToken * s.circSupply;
    mcapLine = `📊 Market Cap: <b>${formatUsd(mcap)}</b>\n`;
  }

  // Price line
  let priceLine = '';
  if (s.showPrice && tokenAmount > 0 && usdValue > 0) {
    const pricePerToken = usdValue / tokenAmount;
    priceLine = `💵 Price: <b>$${pricePerToken.toFixed(8)}</b>\n`;
  }

  // Holder count line
  const holderLine = holderCount != null
    ? `🏠 Holders: <b>${holderCount.toLocaleString()}</b>\n`
    : '';

  const chartUrl = `https://dexscreener.com/solana/${sub.tokenMint}`;
  const buyUrl   = `https://jup.ag/swap/SOL-${sub.tokenMint}`;

  return (
    `${header}\n` +
    `${emojiRow}\n\n` +
    `➡️ Spent: <b>${formatUsd(usdValue)} (${solSpent.toFixed(3)} SOL)</b>\n` +
    `⬅️ Got: <b>${formatTokenAmount(tokenAmount)} ${name}</b>\n` +
    `👤 <a href="https://solscan.io/account/${buyer}">Buyer</a> | <a href="https://solscan.io/tx/${tx.signature}">Txn</a> | <a href="${chartUrl}">Chart</a> | <a href="${buyUrl}">Buy</a>\n` +
    priceLine +
    mcapLine +
    holderLine
  );
}

async function sendBuyAlert(sub, tx, swap, tokenOut) {
  const s = sub.settings;

  // Min buy filter
  const solSpent = swap.nativeInput ? swap.nativeInput.amount / 1e9 : 0;
  const usdValue = solSpent * solPriceUsd;
  if (s.minBuyUsd > 0 && usdValue < s.minBuyUsd) return;

  // Fetch holder count in parallel with building message
  const holderCount = await getHolderCount(sub.tokenMint);
  const message = buildAlertMessage(sub, tx, swap, tokenOut, holderCount);

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
  } else {
    await tgRequest('sendMessage', {
      chat_id: dmChatId,
      text:
        '🐕 <b>Inu Buy Bot</b>\n\n' +
        'Woof! Add me to your group and type /add to set up real-time buy alerts.\n\n' +
        '<b>Commands:</b>\n' +
        '/add — Set up buy alerts (use in your group)\n' +
        '/settings — Manage settings (use in DM)',
      parse_mode: 'HTML',
    });
  }
});

// /add — send "Add Token" button in the group
bot.onText(/\/add(?:@\w+)?/, async (msg) => {
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

// /settings — show settings panel in DM
bot.onText(/\/settings/, async (msg) => {
  const userId = String(msg.from.id);
  const dmChatId = String(msg.chat.id);
  if (msg.chat.type !== 'private') {
    await tgRequest('sendMessage', { chat_id: dmChatId, text: 'Message me directly to manage settings.' });
    return;
  }
  const storage = loadStorage();
  const sub = storage.subscriptions.find((s) => s.ownerId === userId);
  if (!sub) {
    await tgRequest('sendMessage', { chat_id: dmChatId, text: '❌ No token set up yet. Use /add in your group first.' });
    return;
  }
  await showSettings(dmChatId, sub);
});

// /cancel — abort any active input state
bot.onText(/\/cancel/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  userStates.delete(String(msg.from.id));
  await tgRequest('sendMessage', { chat_id: String(msg.chat.id), text: '❌ Cancelled.' });
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

      case 'price':
        sub.settings.showPrice = !sub.settings.showPrice;
        saveSub(sub);
        await refreshSettings(dmChatId, msgId, sub);
        break;

      case 'mev':
        sub.settings.ignoreMev = !sub.settings.ignoreMev;
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
    }
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
      const e = msg.text?.trim();
      if (!e) { error = '❌ Please send an emoji.'; break; }
      sub.settings.emoji = e;
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

  const storage = loadStorage();

  for (const tx of transactions) {
    if (tx.type !== 'SWAP') continue;
    const swap = tx.events?.swap;
    if (!swap) continue;

    const tokenOut = swap.tokenOutputs?.find((t) =>
      storage.subscriptions.some((s) => s.tokenMint === t.mint)
    );
    if (!tokenOut) continue;

    const matchingSubs = storage.subscriptions.filter((s) => s.tokenMint === tokenOut.mint);

    for (const sub of matchingSubs) {
      // Basic MEV filter: skip if fee payer ≠ token receiver
      if (sub.settings.ignoreMev) {
        const receiver = tokenOut.userAccount;
        if (receiver && tx.feePayer && receiver !== tx.feePayer) {
          console.log('Skipping potential MEV tx:', tx.signature);
          continue;
        }
      }
      try {
        await sendBuyAlert(sub, tx, swap, tokenOut);
        console.log(`Alert → chat ${sub.chatId} | tx ${tx.signature}`);
      } catch (err) {
        console.error(`Alert failed for ${sub.chatId}:`, err.message);
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
      { command: 'settings', description: 'Manage your token settings (DM only)' },
      { command: 'cancel',   description: 'Cancel current input (DM only)' },
      { command: 'start',    description: 'Show help' },
    ],
  });
  console.log('Bot commands registered');
}

// ─── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);

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
    console.log('Helius webhook synced');
  } catch (e) {
    console.error('Helius sync failed:', e.message);
  }
});
