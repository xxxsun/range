export async function requestToEvent(request) {
  const url = new URL(request.url);
  return {
    httpMethod: request.method,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(request.headers.entries()),
    body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text()
  };
}

export async function webEntry(legacyHandler, request) {
  const event = await requestToEvent(request);
  const result = await legacyHandler(event);
  return new Response(result?.body ?? '', {
    status: result?.statusCode || 200,
    headers: result?.headers || { 'content-type': 'application/json; charset=utf-8' }
  });
}
