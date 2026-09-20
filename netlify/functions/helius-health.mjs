import { webEntry } from './_lib/netlify.mjs';
import { heliusRpc } from './_lib/helius.mjs';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

export async function handler() {
  try {
    const slot = await heliusRpc('getSlot', [{ commitment: 'finalized' }]);
    return json({ ok: true, provider: 'helius', network: 'solana-mainnet', slot, checkedAt: new Date().toISOString() });
  } catch (error) {
    return json({ ok: false, provider: 'helius', error: error.message }, 503);
  }
}

export default (request) => webEntry(handler, request);
