import { webEntry } from './_lib/netlify.mjs';
import { heliusRpc } from './_lib/helius.mjs';

const METEORA_API = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function isSolanaAddress(value) { return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value); }

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Upstream ${response.status}`);
  return payload;
}

async function getPool(poolAddress, mint) {
  if (poolAddress) return getJson(`${METEORA_API}/pools/${encodeURIComponent(poolAddress)}`);
  if (!mint) return null;
  const url = new URL(`${METEORA_API}/pools`);
  url.searchParams.set('query', mint); url.searchParams.set('page', '1'); url.searchParams.set('page_size', '5');
  const payload = await getJson(url);
  return payload.data?.[0] || null;
}

async function getAsset(mint) {
  if (!mint || !process.env.HELIUS_API_KEY) return null;
  try {
    return await heliusRpc('getAsset', [{ id: mint }]);
  } catch (_) { return null; }
}

async function getLossSample(poolAddress) {
  const wallets = String(process.env.WATCH_WALLETS || '').split(',').map(item => item.trim()).filter(isSolanaAddress).slice(0, 20);
  if (!poolAddress || !wallets.length) return { sampleCount: 0, lossCount: 0, lossRate: null, pnlUsd: 0, coverage: 'no tracked-wallet sample' };
  const results = await Promise.allSettled(wallets.map(async wallet => {
    const url = `${METEORA_API}/positions/${encodeURIComponent(poolAddress)}/pnl?user=${encodeURIComponent(wallet)}&status=all&page=1&page_size=100`;
    const payload = await getJson(url);
    return (payload.positions || []).map(position => num(position.pnlUsd ?? position.pnl ?? position.pnlSol, NaN)).filter(Number.isFinite);
  }));
  const values = results.flatMap(item => item.status === 'fulfilled' ? item.value : []);
  const lossCount = values.filter(value => value < 0).length;
  return { sampleCount: values.length, lossCount, lossRate: values.length ? lossCount / values.length : null, pnlUsd: values.reduce((sum, value) => sum + value, 0), coverage: `${wallets.length} tracked wallets queried` };
}

export async function handler(event) {
  const params = event.queryStringParameters || {};
  const poolAddress = String(params.poolAddress || '').trim();
  const mint = String(params.mint || '').trim();
  if (!poolAddress && !mint) return json({ error: 'poolAddress or mint is required' }, 400);
  try {
    const pool = await getPool(poolAddress, mint);
    if (!pool) return json({ error: 'Pool not found' }, 404);
    const tokenMints = [pool.token_x?.address, pool.token_y?.address].filter(Boolean);
    const assets = await Promise.all(tokenMints.map(getAsset));
    const lossSample = await getLossSample(pool.address || poolAddress);
    const tvl = num(pool.tvl);
    const volume24h = num(pool.volume?.['24h']);
    const apr = num(pool.apr || pool.farm_apr);
    const flags = [];
    let score = 0;
    if (pool.is_blacklisted) { flags.push('Meteora marked pool as blacklisted'); score += 100; }
    if (tvl < 25000) { flags.push('very thin TVL'); score += 30; }
    else if (tvl < 100000) { flags.push('low TVL'); score += 15; }
    if (volume24h > 0 && tvl > 0 && volume24h / tvl > 50) { flags.push('volume/TVL anomaly'); score += 20; }
    if (apr > 200 && tvl < 250000) { flags.push('abnormally high APR on small TVL'); score += 25; }
    for (const asset of assets) {
      const tokenInfo = asset?.token_info || {};
      if (tokenInfo.mint_authority) { flags.push(`mint authority active on ${tokenInfo.symbol || 'token'}`); score += 20; }
      if (tokenInfo.freeze_authority) { flags.push(`freeze authority active on ${tokenInfo.symbol || 'token'}`); score += 20; }
      if (asset?.content?.metadata?.symbol && !asset.content.metadata.symbol) { flags.push('missing token metadata'); score += 5; }
    }
    if (lossSample.sampleCount >= 3 && lossSample.lossRate >= 0.6) { flags.push(`${lossSample.lossCount}/${lossSample.sampleCount} sampled positions lost`); score += 40; }
    else if (lossSample.sampleCount >= 3 && lossSample.lossRate >= 0.4) { flags.push(`${lossSample.lossCount}/${lossSample.sampleCount} sampled positions negative`); score += 20; }
    const severity = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
    return json({
      source: { pool: 'meteora', asset: 'helius-das', losses: lossSample.coverage },
      checkedAt: new Date().toISOString(),
      pool: { address: pool.address, name: pool.name, tvl, apr, volume24h, blacklisted: Boolean(pool.is_blacklisted) },
      lossSample,
      riskScore: Math.min(100, score),
      severity,
      blocked: score >= 60 || Boolean(pool.is_blacklisted),
      flags,
      disclaimer: 'Heuristic blocklist only. It reduces exposure to suspicious pools; it cannot prove or predict a rug pull.'
    });
  } catch (error) {
    return json({ error: error.message }, 502);
  }
}

export default (request) => webEntry(handler, request);
