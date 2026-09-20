const API_BASE = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify(body)
  };
}

const allowedStrategies = new Set(['spot', 'curve', 'bid-ask']);

export default async function handler(event) {
  if (event.httpMethod !== 'POST') return json({ error: 'POST required' }, 405);
  let input;
  try { input = JSON.parse(event.body || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const poolAddress = String(input.poolAddress || '').trim();
  const wallet = String(input.wallet || '').trim();
  const strategy = String(input.strategy || 'spot').toLowerCase();
  const amountUsd = Number(input.amountUsd || 0);
  const rangeBins = Number(input.rangeBins || 10);
  const slippageBps = Number(input.slippageBps || 50);

  if (!poolAddress || poolAddress.length < 32) return json({ error: 'A valid Meteora pool address is required' }, 400);
  if (!wallet || wallet.length < 32) return json({ error: 'A connected Solana wallet is required' }, 400);
  if (!Number.isFinite(amountUsd) || amountUsd < 10 || amountUsd > 250) return json({ error: 'Amount must be between $10 and $250 in this safe-mode MVP' }, 400);
  if (!allowedStrategies.has(strategy)) return json({ error: 'Unsupported strategy' }, 400);
  if (![5, 10, 20].includes(rangeBins)) return json({ error: 'Range must be 5, 10, or 20 bins' }, 400);
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 100) return json({ error: 'Slippage cap must be 1–100 bps' }, 400);

  try {
    const response = await fetch(`${API_BASE}/pools/${encodeURIComponent(poolAddress)}`, { headers: { accept: 'application/json' } });
    const pool = await response.json();
    if (!response.ok) return json({ error: 'Pool not found in Meteora Data API', detail: pool }, 404);

    return json({
      mode: 'unsigned-plan',
      execution: 'client-wallet-signature-required',
      warning: 'This endpoint prepares a reviewable copy plan only. It never receives or stores a private key.',
      wallet,
      pool: {
        address: pool.address || poolAddress,
        name: pool.name,
        tokenX: pool.token_x?.symbol || pool.token_x?.name,
        tokenY: pool.token_y?.symbol || pool.token_y?.name,
        currentPrice: pool.current_price,
        apr: pool.apr,
        tvl: pool.tvl
      },
      parameters: { amountUsd, strategy, rangeBins, slippageBps },
      nextStep: 'Use the Meteora DLMM SDK in the browser to build the unsigned transaction, then request wallet approval.'
    });
  } catch (error) {
    return json({ error: 'Unable to prepare plan', detail: error.message }, 502);
  }
}
