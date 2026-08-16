import WebSocket from 'ws';
import axios from 'axios';
import * as dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const MAX_MCAP = Number(process.env.MAX_MCAP_USD) || 50000;
const MIN_MCAP = Number(process.env.MIN_MCAP_USD) || 0;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';

// Minimal web server to keep Render Free tier active
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Smart Money & Reputation Tracker Running');
}).listen(PORT, () => {
  console.log(`Port binding active on port ${PORT}`);
});

// ==========================================
// 1. STORAGE & DEDUPLICATION ENGINE
// ==========================================
class MemoryStorage {
  private alertedTokens = new Set<string>();
  private walletCooldowns = new Map<string, number>();

  hasAlerted(tokenAddress: string): boolean {
    return this.alertedTokens.has(tokenAddress.toLowerCase());
  }

  markAlerted(tokenAddress: string) {
    const key = tokenAddress.toLowerCase();
    this.alertedTokens.add(key);
    // Expire cache after 1 hour to free memory
    setTimeout(() => this.alertedTokens.delete(key), 60 * 60 * 1000);
  }

  isOnCooldown(wallet: string, cooldownMins = 10): boolean {
    const lastAlert = this.walletCooldowns.get(wallet.toLowerCase()) || 0;
    return Date.now() - lastAlert < cooldownMins * 60 * 1000;
  }

  markCooldown(wallet: string) {
    this.walletCooldowns.set(wallet.toLowerCase(), Date.now());
  }
}

const storage = new MemoryStorage();

// Known Whale / KOL / Smart Money Wallets
const VIP_WALLETS = new Set<string>([
  'WhaleWalletAddress1',
  'TopKolWallet2',
]);

// ==========================================
// 2. REPUTATION & WIN-RATE EVALUATOR
// ==========================================
interface WalletProfile {
  address: string;
  isEligible: boolean;
  score: number;
  summary: string;
}

async function checkWalletReputation(chain: string, wallet: string): Promise<WalletProfile> {
  if (!wallet || wallet.length < 15) {
    return { address: wallet, isEligible: false, score: 0, summary: 'Invalid/Contract' };
  }

  // VIP Watchlist priority match
  if (VIP_WALLETS.has(wallet)) {
    return {
      address: wallet,
      isEligible: true,
      score: 100,
      summary: '🌟 Hardcoded VIP / Smart Money Watchlist',
    };
  }

  const targetChain = chain.toLowerCase() === 'solana' ? 'sol' : chain.toLowerCase();

  // Try GMGN API First
  try {
    const res = await axios.get(
      `https://gmgn.ai/defi/quotation/v1/smartmoney/${targetChain}/walletNew/${wallet}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 3000,
      }
    );

    const stats = res.data?.data;
    if (stats) {
      const winRate = (stats.winrate || stats.winrate_7d || 0) * 100;
      const totalTrades = stats.total_trade || (stats.buy_count || 0) + (stats.sell_count || 0);
      const pnl = stats.realized_profit || stats.pnl_7d || 0;

      // Filter: Win Rate >= 55%, minimum 5 trades, OR realized profit > $2,000
      const isEligible = (winRate >= 55 && totalTrades >= 5) || pnl > 2000;

      return {
        address: wallet,
        isEligible,
        score: Math.min(100, Math.round(winRate)),
        summary: `🔥 Win Rate: ${winRate.toFixed(1)}% (${totalTrades} trades) | Realized PnL: +$${Math.round(pnl).toLocaleString()}`,
      };
    }
  } catch (err) {}

  // Fallback to Birdeye API if Key is provided
  if (BIRDEYE_API_KEY) {
    try {
      const res = await axios.get('https://public-api.birdeye.so/v1/wallet/pnl_summary', {
        params: { wallet },
        headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': chain.toLowerCase() },
        timeout: 3000,
      });
      const data = res.data?.data;
      if (data) {
        const total = (data.total_win || 0) + (data.total_loss || 0);
        const winRate = total > 0 ? (data.total_win / total) * 100 : 0;
        const pnl = data.realized_profit_usd || 0;

        return {
          address: wallet,
          isEligible: winRate >= 55 && total >= 5,
          score: Math.min(100, Math.round(winRate)),
          summary: `Birdeye: ${winRate.toFixed(1)}% Win Rate (${total} trades) | PnL: +$${Math.round(pnl).toLocaleString()}`,
        };
      }
    } catch (err) {}
  }

  // Not a proven profitable wallet -> Discard
  return {
    address: wallet,
    isEligible: false,
    score: 0,
    summary: 'Fresh / Low Win Rate',
  };
}

// ==========================================
// 3. TELEGRAM DISPATCHER
// ==========================================
async function sendAlert(data: {
  chain: string;
  name: string;
  symbol: string;
  address: string;
  mcap: number;
  triggerType: 'CREATOR' | 'SMART_BUYER';
  wallet: string;
  reputationSummary: string;
}) {
  if (storage.hasAlerted(data.address) || storage.isOnCooldown(data.wallet)) {
    return;
  }

  storage.markAlerted(data.address);
  storage.markCooldown(data.wallet);

  const message = `🚨 *HIGH REPUTATION SIGNAL* 🚨\n\n` +
    `• *Signal:* ${data.triggerType === 'CREATOR' ? '👑 Reputable Deployer' : '🎯 Smart Money Inflow'}\n` +
    `• *Chain:* ${data.chain.toUpperCase()}\n` +
    `• *Token:* ${data.name} ($${data.symbol})\n` +
    `• *Contract:* \`${data.address}\`\n` +
    `• *Market Cap:* $${Math.round(data.mcap).toLocaleString()}\n` +
    `• *Wallet:* \`${data.wallet}\`\n` +
    `• *Reputation:* ${data.reputationSummary}\n\n` +
    `🔗 [DexScreener Link](https://dexscreener.com/${data.chain.toLowerCase()}/${data.address})`;

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

// ==========================================
// 4. STREAM LISTENERS (DEXSCREENER & PUMP.FUN)
// ==========================================
function startDexScreener() {
  const ws = new WebSocket('wss://api.dexscreener.com/token-profiles/latest/v1');

  ws.on('open', () => console.log('Connected to DEXScreener Stream'));
  ws.on('message', async (raw: string) => {
    try {
      const payload = JSON.parse(raw);
      const items = Array.isArray(payload) ? payload : (payload.data || []);

      for (const token of items) {
        const chain = token.chainId;
        const address = token.tokenAddress;
        if (!['ethereum', 'bsc', 'base', 'solana', 'sui'].includes(chain?.toLowerCase())) continue;
        if (storage.hasAlerted(address)) continue;

        const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
        const pair = pairRes.data.pairs?.[0];
        if (!pair) continue;

        const mcap = pair.marketCap || pair.fdv || 0;
        if (mcap < MIN_MCAP || mcap > MAX_MCAP) continue;

        // Extract contract deployer or base token address
        const deployer = pair.baseToken?.address;
        const rep = await checkWalletReputation(chain, deployer);

        if (rep.isEligible) {
          await sendAlert({
            chain,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            address,
            mcap,
            triggerType: 'CREATOR',
            wallet: deployer,
            reputationSummary: rep.summary,
          });
        }
      }
    } catch (err) {}
  });

  ws.on('close', () => setTimeout(startDexScreener, 5000));
}

function startPumpFun() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    console.log('Connected to Pump.fun Stream');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
  });

  ws.on('message', async (data: string) => {
    try {
      const event = JSON.parse(data);

      if (event.txType === 'create') {
        const mcap = (event.marketCapSol || 30) * 150;
        if (mcap > MAX_MCAP) return;

        const creator = event.traderPublicKey;
        const rep = await checkWalletReputation('solana', creator);

        if (rep.isEligible) {
          await sendAlert({
            chain: 'solana',
            name: event.name,
            symbol: event.symbol,
            address: event.mint,
            mcap,
            triggerType: 'CREATOR',
            wallet: creator,
            reputationSummary: rep.summary,
          });
        }
      } else if (event.txType === 'buy') {
        const mcap = (event.marketCapSol || 30) * 150;
        if (mcap > MAX_MCAP) return;

        const buyer = event.traderPublicKey;
        const rep = await checkWalletReputation('solana', buyer);

        if (rep.isEligible) {
          await sendAlert({
            chain: 'solana',
            name: event.name || 'Pump Token',
            symbol: event.symbol || 'PUMP',
            address: event.mint,
            mcap,
            triggerType: 'SMART_BUYER',
            wallet: buyer,
            reputationSummary: rep.summary,
          });
        }
      }
    } catch (err) {}
  });

  ws.on('close', () => setTimeout(startPumpFun, 5000));
}

startDexScreener();
startPumpFun();
