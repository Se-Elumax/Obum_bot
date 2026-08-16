import WebSocket from 'ws';
import axios from 'axios';
import * as dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const MAX_MCAP = Number(process.env.MAX_MCAP_USD) || 50000;
const MIN_MCAP = Number(process.env.MIN_MCAP_USD) || 0;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Minimal web server to keep Render Free instance active
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Reputation Tracker Running');
}).listen(PORT);

// Add known Alpha / Smart Money Wallets here
const KNOWN_SMART_WALLETS = new Set<string>([
  'WhaleWalletAddress1',
  'TopKolWallet2',
]);

interface WalletStats {
  address: string;
  isHighReputation: boolean;
  winRate: number;
  totalTrades: number;
  realizedPnl: number;
  reason: string;
}

// 1. Send Alert
async function sendAlert(data: {
  chain: string;
  name: string;
  symbol: string;
  address: string;
  mcap: number;
  detectedType: 'CREATOR' | 'SMART_BUYER';
  wallet: string;
  reputationDetails: string;
}) {
  const message = `🚨 *HIGH REPUTATION SIGNAL DETECTED* 🚨\n\n` +
    `• *Trigger:* ${data.detectedType === 'CREATOR' ? '🌟 Reputable Deployer' : '🎯 Smart Money Buyer'}\n` +
    `• *Chain:* ${data.chain.toUpperCase()}\n` +
    `• *Token:* ${data.name} ($${data.symbol})\n` +
    `• *Contract:* \`${data.address}\`\n` +
    `• *Market Cap:* $${Math.round(data.mcap).toLocaleString()}\n` +
    `• *Wallet:* \`${data.wallet}\`\n` +
    `• *Stats:* ${data.reputationDetails}\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/${data.chain.toLowerCase()}/${data.address})`;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[FILTERED ALERT]', message);
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
    });
  } catch (err: any) {
    console.error('Telegram dispatch error:', err.message);
  }
}

// 2. Strict Reputation Check using GMGN API
async function evaluateReputation(chain: string, wallet: string): Promise<WalletStats> {
  if (KNOWN_SMART_WALLETS.has(wallet)) {
    return {
      address: wallet,
      isHighReputation: true,
      winRate: 100,
      totalTrades: 50,
      realizedPnl: 50000,
      reason: '🌟 Hardcoded Alpha / VIP Watchlist',
    };
  }

  const targetChain = chain.toLowerCase() === 'solana' ? 'sol' : chain.toLowerCase();

  try {
    const res = await axios.get(
      `https://gmgn.ai/defi/quotation/v1/smartmoney/${targetChain}/walletNew/${wallet}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 3500,
      }
    );

    const stats = res.data?.data;
    if (stats) {
      const winRate = (stats.winrate || stats.winrate_7d || 0) * 100;
      const totalTrades = stats.total_trade || (stats.buy_count || 0) + (stats.sell_count || 0);
      const realizedPnl = stats.realized_profit || stats.pnl_7d || 0;

      // STRICT FILTER: Minimum 5 trades, Win Rate >= 60%, and Positive PnL
      if (totalTrades >= 5 && winRate >= 60 && realizedPnl > 1000) {
        return {
          address: wallet,
          isHighReputation: true,
          winRate,
          totalTrades,
          realizedPnl,
          reason: `🔥 ${winRate.toFixed(1)}% WR | +$${Math.round(realizedPnl).toLocaleString()} Realized PnL (${totalTrades} trades)`,
        };
      }
    }
  } catch (e) {
    // Fails quietly for unranked/fresh wallets
  }

  // Not a reputable wallet -> block alert
  return {
    address: wallet,
    isHighReputation: false,
    winRate: 0,
    totalTrades: 0,
    realizedPnl: 0,
    reason: 'Rejected (Fresh or Low Win Rate)',
  };
}

// 3. DEXScreener Stream with Reputation Gating
function startDexScreener() {
  const ws = new WebSocket('wss://api.dexscreener.com/token-profiles/latest/v1');

  ws.on('open', () => console.log('✅ DEXScreener Listener Active'));
  ws.on('message', async (raw: string) => {
    try {
      const payload = JSON.parse(raw);
      const items = Array.isArray(payload) ? payload : (payload.data || []);

      for (const token of items) {
        const chain = token.chainId;
        const address = token.tokenAddress;
        if (!['ethereum', 'bsc', 'base', 'solana', 'sui'].includes(chain?.toLowerCase())) continue;

        const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
        const pair = pairRes.data.pairs?.[0];
        if (!pair) continue;

        const mcap = pair.marketCap || pair.fdv || 0;
        if (mcap < MIN_MCAP || mcap > MAX_MCAP) continue;

        // Check the deployer/first buyer wallet
        const creatorWallet = pair.txns?.buys?.[0];
        if (!creatorWallet) continue;

        const rep = await evaluateReputation(chain, creatorWallet);
        
        // STRICT GATE: Only alert if high reputation
        if (rep.isHighReputation) {
          await sendAlert({
            chain,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            address,
            mcap,
            detectedType: 'CREATOR',
            wallet: creatorWallet,
            reputationDetails: rep.reason,
          });
        }
      }
    } catch (err) {}
  });

  ws.on('close', () => setTimeout(startDexScreener, 5000));
}

// 4. Pump.fun Real-Time Trade Stream (Tracks Creators AND Early Buyers)
function startPumpFun() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    console.log('✅ Pump.fun Trade & Launch Listener Active');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
  });

  ws.on('message', async (data: string) => {
    try {
      const event = JSON.parse(data);

      // Check New Coin Creator
      if (event.txType === 'create') {
        const mcap = (event.marketCapSol || 30) * 150;
        if (mcap > MAX_MCAP) return;

        const creator = event.traderPublicKey;
        const rep = await evaluateReputation('solana', creator);

        if (rep.isHighReputation) {
          await sendAlert({
            chain: 'solana',
            name: event.name,
            symbol: event.symbol,
            address: event.mint,
            mcap,
            detectedType: 'CREATOR',
            wallet: creator,
            reputationDetails: rep.reason,
          });
        }
      }

      // Check Early Buyers Buying Tokens Under $50k Mcap
      if (event.txType === 'buy') {
        const mcap = (event.marketCapSol || 30) * 150;
        if (mcap > MAX_MCAP) return;

        const buyer = event.traderPublicKey;
        const rep = await evaluateReputation('solana', buyer);

        if (rep.isHighReputation) {
          await sendAlert({
            chain: 'solana',
            name: event.name || 'Pump Token',
            symbol: event.symbol || 'PUMP',
            address: event.mint,
            mcap,
            detectedType: 'SMART_BUYER',
            wallet: buyer,
            reputationDetails: rep.reason,
          });
        }
      }
    } catch (err) {}
  });

  ws.on('close', () => setTimeout(startPumpFun, 5000));
}

startDexScreener();
startPumpFun();
    
