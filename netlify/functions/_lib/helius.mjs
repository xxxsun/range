export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

function requireKey() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY is not configured');
  return key;
}

export async function heliusRpc(method, params = []) {
  const key = requireKey();
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message || `Helius RPC ${response.status}`);
  return payload.result;
}

export async function parseEnhancedTransactions(signatures) {
  if (!signatures.length) return [];
  const key = requireKey();
  const response = await fetch(`https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ transactions: signatures.slice(0, 100) })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `Helius Enhanced Transactions ${response.status}`);
  return Array.isArray(payload) ? payload : [];
}

export function shortAddress(address) {
  return address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '—';
}
