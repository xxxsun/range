const METEORA_API = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  };
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function safeText(value, max = 140) { return String(value || '').slice(0, max); }

async function invoke(functionModule, queryStringParameters = {}) {
  const result = await functionModule.default({ httpMethod: 'GET', queryStringParameters });
  let body = {};
  try { body = JSON.parse(result.body || '{}'); } catch (_) {}
  return { statusCode: result.statusCode || 500, body };
}

async function fetchPoolSnapshot() {
  const url = new URL(`${METEORA_API}/pools`);
  url.searchParams.set('page', '1');
  url.searchParams.set('page_size', '50');
  url.searchParams.set('sort_by', 'fee_tvl_ratio_24h:desc');
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'range-scout/0.1' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Meteora pool scan ${response.status}`);
  return payload;
}

function poolCandidate(pool, riskProfile, freshPairs, externalRisk = null) {
  const tvl = num(pool.tvl);
  const apr = num(pool.apr || pool.farm_apr);
  const volume24h = num(pool.volume?.['24h']);
  const feeTvl24h = num(pool.fee_tvl_ratio?.['24h']);
  const verified = Boolean(pool.token_x?.is_verified && pool.token_y?.is_verified);
  const pairName = pool.name || `${pool.token_x?.symbol || 'TOKEN'} / ${pool.token_y?.symbol || 'TOKEN'}`;
  const matchingFresh = freshPairs.filter(pair => pair && pair.toLowerCase().split(/\s+/).some(part => pairName.toLowerCase().includes(part) && part.length > 2));
  const riskFlags = [];
  if (tvl < 250000) riskFlags.push('TVL below conservative floor');
  if (!verified) riskFlags.push('token verification incomplete');
  if (pool.is_blacklisted) riskFlags.push('pool blacklisted');
  if (volume24h <= 0) riskFlags.push('volume unavailable');
  if (matchingFresh.length) riskFlags.push('fresh-wallet activity can increase volatility');
  if (externalRisk?.blocked) riskFlags.push(`automatic blocklist: ${externalRisk.severity || 'HIGH'} risk`);
  if (externalRisk?.flags?.length) riskFlags.push(...externalRisk.flags.slice(0, 2));
  const liquidityScore = clamp(Math.log10(Math.max(1, tvl)) * 5.4 - 15, 0, 28);
  const activityScore = clamp((volume24h / Math.max(tvl, 1)) * 12, 0, 24);
  const feeScore = clamp(apr / 4, 0, 24);
  const verificationScore = verified ? 16 : 6;
  const freshnessScore = matchingFresh.length ? 4 : 0;
  let score = liquidityScore + activityScore + feeScore + verificationScore + freshnessScore;
  if (pool.is_blacklisted) score -= 60;
  if (externalRisk?.blocked) score -= 80;
  if (riskProfile === 'conservative') score -= riskFlags.length * 8;
  if (riskProfile === 'aggressive') score += matchingFresh.length * 8;
  const confidence = Math.round(clamp(score, 0, 97));
  const allocationUsd = Math.round(Math.max(10, Math.min(250, confidence / 100 * 50)));
  return {
    pool: pairName,
    poolAddress: pool.address,
    confidence,
    score: confidence,
    tvlUsd: tvl,
    tvl: tvl >= 1e6 ? `$${(tvl / 1e6).toFixed(1)}M` : tvl >= 1e3 ? `$${(tvl / 1e3).toFixed(0)}K` : '—',
    apr,
    volume24h,
    feeTvl24h,
    verified,
    strategy: riskProfile === 'conservative' ? 'Spot · wider range' : 'Spot · balanced',
    allocationUsd,
    reasons: [
      `TVL ${tvl >= 1e6 ? `$${(tvl / 1e6).toFixed(1)}M` : `$${(tvl / 1e3).toFixed(0)}K`}`,
      `APR ${apr ? `${apr.toFixed(1)}%` : 'n/a'}`,
      volume24h ? `24h volume $${(volume24h / 1e6).toFixed(2)}M` : 'volume belum tersedia'
    ],
    riskFlags,
    blocked: Boolean(externalRisk?.blocked || pool.is_blacklisted),
    riskScore: externalRisk?.riskScore ?? null,
    lossSample: externalRisk?.lossSample || null,
    freshSignals: matchingFresh.length
  };
}

function buildRulesRecommendation(pools, freshWallets, riskProfile, capitalUsd, riskByAddress = new Map()) {
  const freshPairs = freshWallets.map(item => item.actionMix || item.pool || '').filter(Boolean);
  const candidates = pools
    .filter(pool => !pool.is_blacklisted)
    .map(pool => poolCandidate(pool, riskProfile, freshPairs, riskByAddress.get(pool.address)))
    .filter(item => item.poolAddress && !item.blocked && item.confidence >= (riskProfile === 'conservative' ? 45 : 30) && (riskProfile !== 'conservative' || (item.tvlUsd >= 250000 && item.verified && !item.riskFlags.includes('pool blacklisted'))))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map(item => ({ ...item, allocationUsd: Math.min(item.allocationUsd, Math.max(10, capitalUsd / 3)) }));
  return {
    summary: candidates.length ? `Screened ${pools.length} Meteora pools. ${candidates.length} candidates passed the ${riskProfile} filter.` : `Screened ${pools.length} pools but none passed the ${riskProfile} filter.`,
    recommendations: candidates,
    warnings: [
      'This is a research recommendation, not a profit guarantee.',
      riskProfile === 'conservative' ? 'Fresh token opportunities are down-weighted until liquidity and history are stronger.' : 'Fresh signals can have high volatility and out-of-range risk.'
    ]
  };
}

async function askModel(evidence, riskProfile) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { engine: 'rules', reason: 'OPENAI_API_KEY is not configured' };
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const system = `You are RANGE Scout, a conservative Solana Meteora DLMM research agent. Use only the supplied evidence. Never promise profit. Do not invent pool addresses, APR, TVL, or wallet PnL. Return valid JSON only with keys summary, recommendations, warnings. Each recommendation must include pool, poolAddress, confidence (0-100), strategy, allocationUsd, reasons (array), riskFlags (array). The user wants recommendations only; never say that you executed a transaction. Risk profile: ${riskProfile}.`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(evidence) }]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Agent model ${response.status}`);
  const content = payload?.choices?.[0]?.message?.content || '{}';
  const cleaned = String(content).replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  return { engine: 'openai-compatible', model, result: parsed };
}

export default async function handler(event) {
  if (event.httpMethod !== 'POST') return json({ error: 'POST required' }, 405);
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }
  const riskProfile = ['conservative', 'balanced', 'aggressive'].includes(input.riskProfile) ? input.riskProfile : 'conservative';
  const capitalUsd = clamp(num(input.capitalUsd, 250), 10, 100000);

  try {
    const [poolSnapshot, freshResult, radarResult, leaderboardResult, trendingResult] = await Promise.all([
      fetchPoolSnapshot(),
      import('./fresh-wallets.mjs').then(module => invoke(module, { days: String(input.freshWindowDays || 7), min_roi: String(input.minRoi || 20), min_pnl: String(input.minPnl || 100), limit: '20' })),
      import('./new-token-radar.mjs').then(module => invoke(module, { hours: String(input.radarHours || 24), limit: '30' })),
      import('./leaderboard.mjs').then(module => invoke(module)),
      import('./trending-entries.mjs').then(module => invoke(module, { hours: String(input.trendingHours || 6), limit: '20' }))
    ]);
    const pools = Array.isArray(poolSnapshot.data) ? poolSnapshot.data : [];
    const freshWallets = freshResult.statusCode < 300 ? (freshResult.body.wallets || []) : [];
    const freshTokens = radarResult.statusCode < 300 ? (radarResult.body.radar || []) : [];
    const trackedWallets = leaderboardResult.statusCode < 300 ? (leaderboardResult.body.wallets || []) : [];
    const trendingEntries = trendingResult.statusCode < 300 ? (trendingResult.body.matches || []) : [];
    const riskModule = await import('./pool-risk.mjs');
    const riskSettled = await Promise.allSettled(pools.slice(0, 12).map(pool => invoke(riskModule, { poolAddress: pool.address })));
    const riskByAddress = new Map();
    riskSettled.forEach((item, index) => { if (item.status === 'fulfilled' && item.value.statusCode < 300) riskByAddress.set(pools[index].address, item.value.body); });
    const rules = buildRulesRecommendation(pools, freshWallets, riskProfile, capitalUsd, riskByAddress);
    const evidence = {
      generatedAt: new Date().toISOString(),
      riskProfile,
      capitalUsd,
      poolCandidates: pools.slice(0, 30).map(pool => ({ address: pool.address, name: pool.name, apr: pool.apr, tvl: pool.tvl, volume24h: pool.volume?.['24h'], feeTvl24h: pool.fee_tvl_ratio?.['24h'], tokenXVerified: pool.token_x?.is_verified, tokenYVerified: pool.token_y?.is_verified, blacklisted: pool.is_blacklisted, riskScore: riskByAddress.get(pool.address)?.riskScore ?? null, blocked: riskByAddress.get(pool.address)?.blocked ?? false, lossSample: riskByAddress.get(pool.address)?.lossSample ?? null })),
      freshWallets: freshWallets.slice(0, 20).map(wallet => ({ wallet: wallet.walletShort, roi: wallet.roi, pnl: wallet.pnl, entryAge: wallet.entryAge, transactions: wallet.dlmmTransactions, copyable: wallet.copyable })),
      freshTokens: freshTokens.slice(0, 20).map(token => ({ token: token.token, pair: token.pair, action: token.action, age: token.age, tvl: token.tvl, apr: token.apr, risk: token.risk })),
      trackedWallets: trackedWallets.slice(0, 20).map(wallet => ({ wallet: wallet.address || wallet.id, roi: wallet.roi, pnl: wallet.pnl, score: wallet.score, copyable: wallet.copyable !== false })),
      trendingEntries: trendingEntries.slice(0, 20).map(entry => ({ pool: entry.pool, wallet: entry.walletShort, action: entry.action, age: entry.age, trendScore: entry.trendScore }))
    };

    let agent = { engine: 'rules', model: null, fallback: true, aiError: null };
    try {
      const modelResult = await askModel(evidence, riskProfile);
      if (modelResult.result) {
        agent = { ...modelResult, fallback: false, aiError: null };
      } else {
        agent = { ...agent, reason: modelResult.reason };
      }
    } catch (error) {
      agent.aiError = error.message;
    }

    const result = agent.result || rules;
    const knownPoolAddresses = new Set(pools.map(pool => pool.address).filter(Boolean));
    const blockedAddresses = new Set([...riskByAddress.entries()].filter(([, risk]) => risk.blocked).map(([address]) => address));
    // Safety invariant: the reasoning model can rank or explain candidates, but it
    // cannot re-enable a pool that the deterministic guardrail blocked or invent a
    // pool address that was not in the Meteora snapshot.
    const safeRecommendations = (Array.isArray(result.recommendations) ? result.recommendations : [])
      .filter(item => item && knownPoolAddresses.has(item.poolAddress) && !blockedAddresses.has(item.poolAddress))
      .slice(0, 5);
    const warnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 5) : [...rules.warnings];
    if (blockedAddresses.size) warnings.push(`${blockedAddresses.size} pool(s) removed by deterministic risk guardrail.`);
    return json({
      source: { pools: 'meteora-dlmm-data-api', activity: 'helius', reasoning: agent.engine },
      syncedAt: new Date().toISOString(),
      riskProfile,
      capitalUsd,
      agent,
      screening: { poolCount: pools.length, blockedPoolCount: blockedAddresses.size, freshWalletCount: freshWallets.length, freshTokenCount: freshTokens.length, trackedWalletCount: trackedWallets.length, trendingEntryCount: trendingEntries.length },
      summary: safeText(result.summary, 300),
      recommendations: safeRecommendations,
      warnings
    });
  } catch (error) {
    return json({ error: error.message, recommendations: [], warnings: ['Agent scan failed; no recommendation was produced.'] }, 502);
  }
}
