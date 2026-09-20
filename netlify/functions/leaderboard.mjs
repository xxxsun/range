const METEORA_API = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30, stale-while-revalidate=120',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify(body)
  };
}

function isSolanaAddress(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

async function getWalletScore(wallet) {
  const [portfolioResponse, totalResponse] = await Promise.all([
    fetch(`${METEORA_API}/portfolio?user=${encodeURIComponent(wallet)}&page=1&pageSize=100`, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } }),
    fetch(`${METEORA_API}/portfolio/total?user=${encodeURIComponent(wallet)}`, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } })
  ]);
  if (!portfolioResponse.ok || !totalResponse.ok) throw new Error(`Meteora profile error for ${wallet}`);
  const portfolio = await portfolioResponse.json();
  const total = await totalResponse.json();
  const roi = Number(total.totalPnlPctChange || 0);
  const pnl = Number(total.totalPnlUsd || 0);
  const closed = Number(total.totalClosedPositions || 0);
  const open = Number(portfolio.totalPositions || 0);
  // Score is deliberately conservative: without a persisted event index we do not
  // invent drawdown or fee-adjusted fields. The UI should label this as live PnL.
  const score = Math.max(0, Math.min(99, Math.round(55 + Math.min(30, Math.max(-30, roi)) * 0.9 + Math.min(14, Math.log10(Math.max(1, closed + open)) * 4))));
  const noCopy = new Set(String(process.env.NON_COPYABLE_WALLETS || '')
    .split(',')
    .map(value => value.trim())
    .filter(isSolanaAddress));
  return {
    id: wallet,
    name: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`,
    address: wallet,
    roi,
    pnl: `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    drawdown: null,
    score,
    risk: 'LIVE PNL',
    copyable: !noCopy.has(wallet),
    totalClosedPositions: closed,
    totalPositions: open
  };
}

export default async function handler() {
  // Best option: an indexed JSON feed produced by the Helius/worker pipeline.
  const sourceUrl = process.env.LEADERBOARD_SOURCE_URL;
  if (sourceUrl) {
    try {
      const response = await fetch(sourceUrl, { headers: { accept: 'application/json' } });
      const payload = await response.json();
      if (!response.ok) return json({ error: 'Leaderboard source returned an error', detail: payload }, response.status);
      return json({ source: sourceUrl, syncedAt: new Date().toISOString(), wallets: payload.wallets || payload });
    } catch (error) {
      return json({ error: 'Unable to reach leaderboard source', detail: error.message }, 502);
    }
  }

  // Useful immediately with a small allowlist. Keep this server-side; the Helius
  // key is never sent to the browser. For automatic discovery, use a scheduled
  // indexer that writes LEADERBOARD_SOURCE_URL after scanning DLMM program logs.
  const wallets = String(process.env.WATCH_WALLETS || '')
    .split(',')
    .map(value => value.trim())
    .filter(isSolanaAddress)
    .slice(0, 25);
  const noCopy = new Set(String(process.env.NON_COPYABLE_WALLETS || '')
    .split(',')
    .map(value => value.trim())
    .filter(isSolanaAddress));

  if (!wallets.length) {
    return json({
      source: 'demo',
      syncedAt: new Date().toISOString(),
      message: 'Set WATCH_WALLETS or LEADERBOARD_SOURCE_URL to enable live wallet PnL ranking.',
      wallets: []
    });
  }

  const results = await Promise.allSettled(wallets.map(getWalletScore));
  const liveWallets = results.filter(item => item.status === 'fulfilled').map(item => item.value).sort((a, b) => b.score - a.score);
  return json({ source: 'meteora-wallet-pnl', syncedAt: new Date().toISOString(), total: liveWallets.length, wallets: liveWallets });
}
