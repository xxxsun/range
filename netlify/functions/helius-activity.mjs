import { DLMM_PROGRAM_ID, heliusRpc, parseEnhancedTransactions, shortAddress } from './_lib/helius.mjs';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=10', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

export default async function handler(event) {
  const requested = Number(event.queryStringParameters?.limit || 30);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requested) ? requested : 30));
  try {
    const signatures = await heliusRpc('getSignaturesForAddress', [DLMM_PROGRAM_ID, { limit, commitment: 'confirmed' }]);
    const successful = (signatures || []).filter(item => !item.err).map(item => item.signature);
    const parsed = await parseEnhancedTransactions(successful);
    const activities = parsed.filter(tx => tx.source === 'METEORA').map(tx => ({
      signature: tx.signature,
      timestamp: tx.timestamp,
      slot: tx.slot,
      type: tx.type || 'UNKNOWN',
      source: tx.source,
      wallet: tx.feePayer,
      walletShort: shortAddress(tx.feePayer),
      description: tx.description || '',
      feeLamports: tx.fee || 0
    }));
    return json({ source: 'helius-enhanced-transactions', programId: DLMM_PROGRAM_ID, syncedAt: new Date().toISOString(), activities });
  } catch (error) {
    return json({ error: error.message }, 503);
  }
}
