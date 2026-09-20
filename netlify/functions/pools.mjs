const API_BASE = 'https://dlmm.datapi.meteora.ag';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=15, stale-while-revalidate=60',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify(body)
  };
}

export default async function handler(event) {
  const params = new URLSearchParams(event.queryStringParameters || {});
  const page = Math.max(1, Number(params.get('page') || 1));
  const pageSize = Math.min(100, Math.max(1, Number(params.get('page_size') || 20)));
  const upstream = new URL(`${API_BASE}/pools`);
  upstream.searchParams.set('page', String(page));
  upstream.searchParams.set('page_size', String(pageSize));
  upstream.searchParams.set('sort_by', params.get('sort_by') || 'volume_24h:desc');
  if (params.get('query')) upstream.searchParams.set('query', params.get('query'));
  if (params.get('filter_by')) upstream.searchParams.set('filter_by', params.get('filter_by'));

  try {
    const response = await fetch(upstream, { headers: { accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok) return json({ error: 'Meteora Data API returned an error', detail: payload }, response.status);

    const pools = Array.isArray(payload.data) ? payload.data : [];
    return json({
      source: 'meteora-dlmm-data-api',
      syncedAt: new Date().toISOString(),
      currentPage: payload.current_page || page,
      pageSize: payload.page_size || pageSize,
      total: payload.total || pools.length,
      pools
    });
  } catch (error) {
    return json({ error: 'Unable to reach Meteora Data API', detail: error.message }, 502);
  }
}
