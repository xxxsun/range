import { DLMM_PROGRAM_ID, heliusRpc, parseEnhancedTransactions, shortAddress } from './_lib/helius.mjs';

const METEORA_API = 'https://dlmm.datapi.meteora.ag';
const DEFAULT_HOURS = 24;
const MAX_MINTS = 24;
const IGNORED_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
]);

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=15, stale-while-revalidate=60', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

function formatUsd(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '—';
  if (number >= 1e6) return `$${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(0)}K`;
  return `$${number.toFixed(0)}`;
}

function formatAge(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function getMints(transaction) {
  return [...new Set((transaction.tokenTransfers || []).map(item => item.mint).filter(mint => mint && !IGNORED_MINTS.has(mint)))].slice(0, 4);
}

function actionFor(transaction) {
  const type = String(transaction.type || '').toUpperCase();
  if (type.includes('LIQUIDITY') || type.includes('POSITION')) return 'LP entry';
  if (type.includes('SWAP')) return 'Wallet entry';
  return 'DLMM activity';
}

async function getAsset(mint) {
  try {
    const asset = await heliusRpc('getAsset', [{ id: mint }]);
    const metadata = asset?.content?.metadata || {};
    const tokenInfo = asset?.token_info || {};
    const authorities = asset?.authorities || [];
    const hasMintAuthority = authorities.some(item => String(item?.scopes || '').toLowerCase().includes('full')) || Boolean(tokenInfo.mint_authority);
    const hasFreezeAuthority = Boolean(tokenInfo.freeze_authority);
    return {
      mint,
      symbol: metadata.symbol || tokenInfo.symbol || `${mint.slice(0, 4)}…`,
      name: metadata.name || tokenInfo.name || 'Unknown token',
      decimals: tokenInfo.decimals,
      hasMintAuthority,
      hasFreezeAuthority,
      createdAt: asset?.created_at || metadata.created_at || null
    };
  } catch (_) {
    return { mint, symbol: `${mint.slice(0, 4)}…`, name: 'Unknown token', hasMintAuthority: null, hasFreezeAuthority: null, createdAt: null };
  }
}

async function getPoolForMint(mint) {
  try {
    const url = new URL(`${METEORA_API}/pools`);
    url.searchParams.set('query', mint);
    url.searchParams.set('page', '1');
    url.searchParams.set('page_size', '5');
    url.searchParams.set('sort_by', 'volume_24h:desc');
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } });
    if (!response.ok) return null;
    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data[0] || null : null;
  } catch (_) {
    return null;
  }
}

export default async function handler(event) {
  const requestedHours = Number(event.queryStringParameters?.hours || DEFAULT_HOURS);
  const hours = Math.min(72, Math.max(1, Number.isFinite(requestedHours) ? requestedHours : DEFAULT_HOURS));
  const requestedLimit = Number(event.queryStringParameters?.limit || 20);
  const limit = Math.min(50, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));
  const cutoff = Math.floor(Date.now() / 1000) - hours * 60 * 60;

  try {
    const signatures = await heliusRpc('getSignaturesForAddress', [DLMM_PROGRAM_ID, { limit: 100, commitment: 'confirmed' }]);
    const successful = (signatures || []).filter(item => !item.err && (!item.blockTime || item.blockTime >= cutoff)).map(item => item.signature);
    const transactions = await parseEnhancedTransactions(successful);
    const meteoraTransactions = transactions.filter(item => item.source === 'METEORA' && item.feePayer && (!item.timestamp || item.timestamp >= cutoff));

    const mintSet = new Set();
    for (const transaction of meteoraTransactions) {
      for (const mint of getMints(transaction)) {
        mintSet.add(mint);
        if (mintSet.size >= MAX_MINTS) break;
      }
      if (mintSet.size >= MAX_MINTS) break;
    }

    const [assets, pools] = await Promise.all([
      Promise.all([...mintSet].map(getAsset)),
      Promise.all([...mintSet].map(getPoolForMint))
    ]);
    const assetMap = new Map(assets.map(item => [item.mint, item]));
    const poolMap = new Map([...mintSet].map((mint, index) => [mint, pools[index]]));
    const radar = [];
    const seen = new Set();

    for (const transaction of meteoraTransactions) {
      const timestamp = Number(transaction.timestamp || 0);
      const ageMinutes = timestamp ? Math.max(1, (Date.now() / 1000 - timestamp) / 60) : hours * 60;
      for (const mint of getMints(transaction)) {
        const dedupe = `${transaction.feePayer}-${mint}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const asset = assetMap.get(mint) || { mint, symbol: `${mint.slice(0, 4)}…`, name: 'Unknown token' };
        const pool = poolMap.get(mint);
        const tvl = Number(pool?.tvl || 0);
        const riskFlags = [];
        if (ageMinutes <= 60) riskFlags.push('very fresh');
        if (tvl > 0 && tvl < 50000) riskFlags.push('thin liquidity');
        if (asset.hasMintAuthority === true) riskFlags.push('mint authority active');
        if (asset.hasFreezeAuthority === true) riskFlags.push('freeze authority active');
        const risk = riskFlags.length >= 2 ? 'HIGH RISK' : riskFlags.length === 1 ? 'WATCH' : 'REVIEW';
        radar.push({
          id: dedupe,
          token: asset.symbol,
          tokenName: asset.name,
          mint,
          pair: pool?.name || `${asset.symbol} / SOL`,
          poolAddress: pool?.address || null,
          wallet: transaction.feePayer,
          walletShort: shortAddress(transaction.feePayer),
          action: actionFor(transaction),
          age: formatAge(ageMinutes),
          ageMinutes: Math.round(ageMinutes),
          firstSeenAt: timestamp ? new Date(timestamp * 1000).toISOString() : null,
          tvl: formatUsd(tvl),
          tvlUsd: tvl,
          apr: pool?.apr != null ? `+${Number(pool.apr).toFixed(1)}%` : '—',
          risk,
          riskFlags,
          signature: transaction.signature,
          source: 'helius + meteora'
        });
      }
    }

    radar.sort((a, b) => a.ageMinutes - b.ageMinutes || b.tvlUsd - a.tvlUsd);
    return json({ source: 'helius + meteora', syncedAt: new Date().toISOString(), hours, programId: DLMM_PROGRAM_ID, radar: radar.slice(0, limit) });
  } catch (error) {
    return json({ error: error.message, radar: [] }, 503);
  }
}
