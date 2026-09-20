import { DLMM_PROGRAM_ID, heliusRpc, parseEnhancedTransactions, shortAddress } from './_lib/helius.mjs';

const METEORA_API = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=15, stale-while-revalidate=60', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function ageLabel(timestamp) { if (!timestamp) return 'recent'; const minutes = Math.max(1, (Date.now() / 1000 - timestamp) / 60); return minutes < 60 ? `${Math.round(minutes)}m ago` : `${Math.round(minutes / 60)}h ago`; }
function actionFor(type) { const value = String(type || '').toUpperCase(); if (value.includes('LIQUIDITY') || value.includes('POSITION')) return 'LP entry'; if (value.includes('SWAP')) return 'swap'; return 'DLMM activity'; }

async function getTrendingPools() {
  const sorts = ['volume_1h:desc', 'fee_tvl_ratio_1h:desc', 'volume_24h:desc'];
  const responses = await Promise.all(sorts.map(async sortBy => {
    const url = new URL(`${METEORA_API}/pools`);
    url.searchParams.set('page', '1'); url.searchParams.set('page_size', '30'); url.searchParams.set('sort_by', sortBy);
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Meteora trending ${response.status}`);
    return payload.data || [];
  }));
  const byAddress = new Map();
  for (const pool of responses.flat()) {
    if (!pool.address || pool.is_blacklisted) continue;
    const current = byAddress.get(pool.address) || pool;
    const volume1h = num(pool.volume?.['1h']);
    const feeTvl1h = num(pool.fee_tvl_ratio?.['1h']);
    const score = Math.log10(Math.max(1, volume1h)) * 14 + Math.min(35, feeTvl1h * 2) + Math.log10(Math.max(1, num(pool.tvl))) * 3;
    if (!current.trendScore || score > current.trendScore) byAddress.set(pool.address, { ...pool, trendScore: score, trendVolume1h: volume1h, trendFeeTvl1h: feeTvl1h });
  }
  return [...byAddress.values()].sort((a, b) => b.trendScore - a.trendScore).slice(0, 30);
}

async function getKnownSmartWallets() {
  const known = new Set(String(process.env.WATCH_WALLETS || '').split(',').map(item => item.trim()).filter(Boolean));
  try {
    const module = await import('./leaderboard.mjs');
    const result = await module.default({ httpMethod: 'GET', queryStringParameters: {} });
    const body = JSON.parse(result.body || '{}');
    for (const wallet of body.wallets || []) if (wallet.address || wallet.id) known.add(wallet.address || wallet.id);
  } catch (_) {}
  return known;
}

export default async function handler(event) {
  const requested = Number(event.queryStringParameters?.limit || 12);
  const limit = Math.min(30, Math.max(1, Number.isFinite(requested) ? requested : 12));
  const windowHours = Math.min(24, Math.max(1, Number(event.queryStringParameters?.hours || 6)));
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  try {
    const [pools, smartWallets] = await Promise.all([getTrendingPools(), getKnownSmartWallets()]);
    const poolMap = new Map(pools.map(pool => [pool.address, pool]));
    const signatures = await heliusRpc('getSignaturesForAddress', [DLMM_PROGRAM_ID, { limit: 100, commitment: 'confirmed' }]);
    const successful = (signatures || []).filter(item => !item.err && (!item.blockTime || item.blockTime >= cutoff)).map(item => item.signature);
    const transactions = await parseEnhancedTransactions(successful);
    const matches = [];
    const seen = new Set();
    for (const transaction of transactions) {
      if (transaction.source !== 'METEORA' || !transaction.feePayer) continue;
      if (transaction.timestamp && transaction.timestamp < cutoff) continue;
      const accounts = new Set([
        ...(transaction.accountData || []).map(item => item.account),
        ...(transaction.instructions || []).flatMap(item => item.accounts || [])
      ]);
      for (const [address, pool] of poolMap) {
        if (!accounts.has(address)) continue;
        const key = `${address}-${transaction.feePayer}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          pool: pool.name || `${pool.token_x?.symbol || 'TOKEN'} / ${pool.token_y?.symbol || 'TOKEN'}`,
          poolAddress: address,
          wallet: transaction.feePayer,
          walletShort: shortAddress(transaction.feePayer),
          isTrackedSmartWallet: smartWallets.size ? smartWallets.has(transaction.feePayer) : null,
          action: actionFor(transaction.type),
          age: ageLabel(transaction.timestamp),
          signature: transaction.signature,
          trendScore: Math.round(pool.trendScore),
          volume1h: pool.trendVolume1h,
          feeTvl1h: pool.trendFeeTvl1h,
          tvl: num(pool.tvl),
          apr: num(pool.apr || pool.farm_apr)
        });
      }
    }
    const filtered = smartWallets.size ? matches.filter(item => item.isTrackedSmartWallet) : matches;
    filtered.sort((a, b) => b.trendScore - a.trendScore);
    return json({ source: 'meteora trending + helius', syncedAt: new Date().toISOString(), windowHours, trendingPools: pools.slice(0, limit).map(pool => ({ address: pool.address, name: pool.name, trendScore: Math.round(pool.trendScore), volume1h: pool.trendVolume1h, feeTvl1h: pool.trendFeeTvl1h, tvl: num(pool.tvl), apr: num(pool.apr || pool.farm_apr) })), smartWalletSetSize: smartWallets.size, matches: filtered.slice(0, limit) });
  } catch (error) {
    return json({ error: error.message, matches: [], trendingPools: [] }, 503);
  }
}
