import { webEntry } from './_lib/netlify.mjs';
export async function handler() {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ok: true, service: 'range-scout', network: 'solana-mainnet', at: new Date().toISOString() })
  };
}

export default (request) => webEntry(handler, request);
