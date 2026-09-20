import { heliusRpc } from './_lib/helius.mjs';

const METEORA_API = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

function isSolanaAddress(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

async function meteoraJson(path) {
  const response = await fetch(`${METEORA_API}${path}`, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Meteora Data API ${response.status}`);
  return payload;
}

export default async function handler(event) {
  const wallet = String(event.queryStringParameters?.wallet || '').trim();
  if (!isSolanaAddress(wallet)) return json({ error: 'A valid Solana wallet is required' }, 400);
  try {
    const [portfolio, total, balance] = await Promise.all([
      meteoraJson(`/portfolio?user=${encodeURIComponent(wallet)}&page=1&pageSize=100`),
      meteoraJson(`/portfolio/total?user=${encodeURIComponent(wallet)}`),
      heliusRpc('getBalance', [wallet, { commitment: 'confirmed' }])
    ]);
    return json({
      source: { portfolio: 'meteora-dlmm-data-api', balance: 'helius-rpc' },
      syncedAt: new Date().toISOString(),
      wallet,
      balanceSol: Number(balance?.value || 0) / 1e9,
      metrics: {
        totalPnlUsd: Number(total?.totalPnlUsd || 0),
        totalPnlPctChange: Number(total?.totalPnlPctChange || 0),
        totalClosedPositions: Number(total?.totalClosedPositions || 0),
        totalPositions: Number(portfolio?.totalPositions || 0),
        totalPools: Number(portfolio?.totalCount || 0)
      },
      portfolio
    });
  } catch (error) {
    return json({ error: error.message }, 502);
  }
}
