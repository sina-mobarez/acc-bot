export type FakeRoutes = Record<string, unknown>;

/**
 * Fake `fetch` matched by request hostname. A number value responds with
 * that status (empty body); anything else is returned as a JSON body (200).
 * Unrouted hosts throw, like a network failure.
 */
export function fakeFetch(routes: FakeRoutes): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!(url.hostname in routes)) throw new Error(`fakeFetch: no route for ${url.hostname}`);
    const r = routes[url.hostname];
    if (typeof r === "number") return new Response(null, { status: r });
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
