const HELIUS_BASE = 'https://api-mainnet.helius-rpc.com';
const EXCLUDED = new Set([
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'So11111111111111111111111111111111111111112'
]);

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

function addEdge(map, wallet, address, kind, tx) {
  if (!address || address === wallet || EXCLUDED.has(address) || !isSolanaAddress(address)) return;
  const key = address;
  const current = map.get(key) || { address, transactions: new Set(), nativeTransfers: 0, tokenTransfers: 0, nativeLamports: 0, tokenMints: new Set(), directions: new Set(), firstSeen: null, lastSeen: null };
  current.transactions.add(tx.signature);
  current[kind === 'native' ? 'nativeTransfers' : 'tokenTransfers'] += 1;
  if (kind === 'native') current.nativeLamports += Math.abs(Number(tx.amount || 0));
  if (kind === 'token' && tx.mint) current.tokenMints.add(tx.mint);
  if (tx.direction) current.directions.add(tx.direction);
  if (tx.timestamp) {
    current.firstSeen = !current.firstSeen ? tx.timestamp : Math.min(current.firstSeen, tx.timestamp);
    current.lastSeen = !current.lastSeen ? tx.timestamp : Math.max(current.lastSeen, tx.timestamp);
  }
  map.set(key, current);
}

function short(address) { return `${address.slice(0, 4)}…${address.slice(-4)}`; }

export default async function handler(event) {
  const wallet = String(event.queryStringParameters?.wallet || '').trim();
  if (!isSolanaAddress(wallet)) return json({ error: 'Paste a full Solana wallet address' }, 400);
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return json({ error: 'HELIUS_API_KEY is not configured' }, 503);
  const watched = new Set(String(process.env.WATCH_WALLETS || '').split(',').map(item => item.trim()).filter(isSolanaAddress));

  try {
    const url = new URL(`${HELIUS_BASE}/v0/addresses/${wallet}/transactions`);
    url.searchParams.set('api-key', apiKey);
    url.searchParams.set('limit', '100');
    url.searchParams.set('token-accounts', 'all');
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const transactions = await response.json();
    if (!response.ok || !Array.isArray(transactions)) return json({ error: 'Helius history request failed', detail: transactions }, 502);

    const edges = new Map();
    for (const transaction of transactions) {
      const timestamp = transaction.timestamp || transaction.blockTime || null;
      for (const transfer of transaction.nativeTransfers || []) {
        if (transfer.fromUserAccount === wallet) addEdge(edges, wallet, transfer.toUserAccount, 'native', { ...transfer, signature: transaction.signature, timestamp, direction: 'out' });
        if (transfer.toUserAccount === wallet) addEdge(edges, wallet, transfer.fromUserAccount, 'native', { ...transfer, signature: transaction.signature, timestamp, direction: 'in' });
      }
      for (const transfer of transaction.tokenTransfers || []) {
        if (transfer.fromUserAccount === wallet) addEdge(edges, wallet, transfer.toUserAccount, 'token', { ...transfer, signature: transaction.signature, timestamp, direction: 'out' });
        if (transfer.toUserAccount === wallet) addEdge(edges, wallet, transfer.fromUserAccount, 'token', { ...transfer, signature: transaction.signature, timestamp, direction: 'in' });
      }
    }

    const nodes = [...edges.values()].map(edge => {
      const txCount = edge.transactions.size;
      const types = [];
      if (edge.nativeTransfers) types.push('SOL flow');
      if (edge.tokenTransfers) types.push('token flow');
      const tracked = watched.has(edge.address);
      const strength = Math.min(99, 25 + txCount * 9 + Math.min(30, edge.tokenTransfers * 2));
      return {
        address: edge.address,
        addressShort: short(edge.address),
        relationship: tracked ? 'tracked smart wallet' : txCount >= 4 ? 'frequent counterparty' : 'direct counterparty',
        relationshipType: types.join(' + '),
        tracked,
        transactions: txCount,
        nativeTransfers: edge.nativeTransfers,
        tokenTransfers: edge.tokenTransfers,
        tokenMints: [...edge.tokenMints].slice(0, 5),
        nativeLamports: edge.nativeLamports,
        directions: [...edge.directions],
        firstSeen: edge.firstSeen ? new Date(edge.firstSeen * 1000).toISOString() : null,
        lastSeen: edge.lastSeen ? new Date(edge.lastSeen * 1000).toISOString() : null,
        strength
      };
    }).sort((a, b) => b.strength - a.strength || b.transactions - a.transactions).slice(0, 20);

    return json({ source: 'helius-enhanced-transactions', wallet, walletShort: short(wallet), scannedTransactions: transactions.length, syncedAt: new Date().toISOString(), nodes, disclaimer: 'Connections are on-chain interaction signals, not proof of common ownership or coordinated control.' });
  } catch (error) {
    return json({ error: error.message }, 503);
  }
}
