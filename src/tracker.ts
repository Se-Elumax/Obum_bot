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

// Minimal web server to keep Render Free Web Service alive
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Crypto Tracker is running.');
}).listen(PORT, () => {
  console.log(`Port binding active on port ${PORT}`);
});

async function sendAlert(data: {
  chain: string;
  name: string;
  symbol: string;
  address: string;
  mcap: number;
  creator: string;
  creatorReputation: string;
}) {
  const message = `🚨 *New Token Detected ($0 - $50k Mcap)* 🚨\n\n` +
    `• *Chain:* ${data.chain.toUpperCase()}\n` +
    `• *Token:* ${data.name} ($${data.symbol})\n` +
    `• *Contract:* \`${data.address}\`\n` +
    `• *Market Cap:* $${Math.round(data.mcap).toLocaleString()}\n` +
    `• *Creator:* \`${data.creator}\`\n` +
    `• *Reputation:* ${data.creatorReputation}\n\n` +
    `🔗 [DexScreener Link](https://dexscreener.com/${data.chain.toLowerCase()}/${data.address})`;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[ALERT LOG]', message);
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

async function checkReputation(chain: string, wallet: string): Promise<string> {
  if (!wallet || wallet.length < 10) return '⚖️ Unranked / New';
  
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
        const winRate = total > 0 ? ((data.total_win / total) * 100).toFixed(1) : '0';
        return `🔥 Birdeye Win Rate: ${winRate}% (${total} trades)`;
      }
    } catch (e) {
      // Fallback
    }
  }
  return '✅ Active On-Chain Wallet';
}

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

        const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
        const pair = pairRes.data.pairs?.[0];
        if (!pair) continue;

        const mcap = pair.marketCap || pair.fdv || 0;
        if (mcap < MIN_MCAP || mcap > MAX_MCAP) continue;

        const creator = pair.txns?.buys?.[0] || 'Deployer';
        const rep = await checkReputation(chain, creator);

        await sendAlert({
          chain,
          name: pair.baseToken.name,
          symbol: pair.baseToken.symbol,
          address,
          mcap,
          creator,
          creatorReputation: rep,
        });
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
  });

  ws.on('message', async (data: string) => {
    try {
      const event = JSON.parse(data);
      if (event.txType === 'create' || event.mint) {
        const approxUsdMcap = (event.marketCapSol || 30) * 150;
        if (approxUsdMcap > MAX_MCAP) return;

        const creator = event.traderPublicKey || 'PumpFun Deployer';
        const rep = await checkReputation('solana', creator);

        await sendAlert({
          chain: 'solana',
          name: event.name,
          symbol: event.symbol,
          address: event.mint,
          mcap: approxUsdMcap,
          creator,
          creatorReputation: rep,
        });
      }
    } catch (err) {}
  });

  ws.on('close', () => setTimeout(startPumpFun, 5000));
}

startDexScreener();
startPumpFun();
        
