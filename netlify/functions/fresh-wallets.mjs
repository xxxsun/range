import { DLMM_PROGRAM_ID, heliusRpc, parseEnhancedTransactions, shortAddress } from './_lib/helius.mjs';

const METEORA_API = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30, stale-while-revalidate=90', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

function isSolanaAddress(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function ageLabel(hours) {
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h seen`;
  return `${Math.round(hours / 24)}d seen`;
}

async function portfolioTotal(wallet) {
  const response = await fetch(`${METEORA_API}/portfolio/total?user=${encodeURIComponent(wallet)}`, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Meteora PnL ${response.status}`);
  return payload;
}

export default async function handler(event) {
  const query = event.queryStringParameters || {};
  const windowDays = Math.min(30, Math.max(1, Number(query.days || 7)));
  const minRoi = Number.isFinite(Number(query.min_roi)) ? Number(query.min_roi) : 20;
  const minPnl = Number.isFinite(Number(query.min_pnl)) ? Number(query.min_pnl) : 100;
  const limit = Math.min(20, Math.max(1, Number(query.limit || 6)));
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const noCopy = new Set(String(process.env.NON_COPYABLE_WALLETS || '').split(',').map(item => item.trim()).filter(isSolanaAddress));

  try {
    const signatures = await heliusRpc('getSignaturesForAddress', [DLMM_PROGRAM_ID, { limit: 100, commitment: 'confirmed' }]);
    const successful = (signatures || []).filter(item => !item.err && (!item.blockTime || item.blockTime >= cutoff)).map(item => item.signature);
    const transactions = await parseEnhancedTransactions(successful);
    const candidates = new Map();
    for (const transaction of transactions) {
      if (transaction.source !== 'METEORA' || !isSolanaAddress(transaction.feePayer)) continue;
      const timestamp = Number(transaction.timestamp || 0);
      if (timestamp && timestamp < cutoff) continue;
      const current = candidates.get(transaction.feePayer) || { wallet: transaction.feePayer, firstObserved: timestamp || null, lastObserved: timestamp || null, txCount: 0, types: new Set(), signatures: [] };
      current.firstObserved = current.firstObserved ? Math.min(current.firstObserved, timestamp || current.firstObserved) : timestamp || current.firstObserved;
      current.lastObserved = current.lastObserved ? Math.max(current.lastObserved, timestamp || current.lastObserved) : timestamp || current.lastObserved;
      current.txCount += 1;
      current.types.add(transaction.type || 'METEORA');
      if (transaction.signature) current.signatures.push(transaction.signature);
      candidates.set(transaction.feePayer, current);
    }

    const orderedCandidates = [...candidates.values()].sort((a, b) => b.txCount - a.txCount).slice(0, 30);
    const settled = await Promise.allSettled(orderedCandidates.map(async candidate => {
      const total = await portfolioTotal(candidate.wallet);
      const roi = Number(total?.totalPnlPctChange || 0);
      const pnl = Number(total?.totalPnlUsd || 0);
      const closed = Number(total?.totalClosedPositions || 0);
      if (!Number.isFinite(roi) || !Number.isFinite(pnl) || roi < minRoi || pnl < minPnl || closed < 1) return null;
      const seenHours = candidate.firstObserved ? Math.max(1, (Date.now() / 1000 - candidate.firstObserved) / 3600) : windowDays * 24;
      const score = Math.max(0, Math.min(99, Math.round(60 + Math.min(30, roi) * 0.7 + Math.min(12, Math.log10(closed + 1) * 5) - Math.min(8, seenHours / 24))));
      return {
        wallet: candidate.wallet,
        walletShort: shortAddress(candidate.wallet),
        roi,
        pnl,
        pnlLabel: `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        closedPositions: closed,
        dlmmTransactions: candidate.txCount,
        entryAge: ageLabel(seenHours),
        firstObservedAt: candidate.firstObserved ? new Date(candidate.firstObserved * 1000).toISOString() : null,
        lastObservedAt: candidate.lastObserved ? new Date(candidate.lastObserved * 1000).toISOString() : null,
        actionMix: [...candidate.types].slice(0, 3).join(' · '),
        score,
        copyable: !noCopy.has(candidate.wallet),
        signal: 'positive PnL + recent DLMM activity'
      };
    }));

    const wallets = settled.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value).sort((a, b) => b.score - a.score).slice(0, limit);
    return json({ source: 'helius + meteora', syncedAt: new Date().toISOString(), windowDays, minRoi, minPnl, wallets });
  } catch (error) {
    return json({ error: error.message, wallets: [] }, 503);
  }
}
