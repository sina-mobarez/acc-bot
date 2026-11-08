import { fetchCoinUsdt, fetchUsdtToman } from "./prices";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health/prices") {
      const [nobitex, kucoinBtc] = await Promise.all([
        fetchUsdtToman(fetch),
        fetchCoinUsdt("BTC", fetch),
      ]);
      return Response.json({
        nobitex: nobitex?.latest.toString() ?? null,
        kucoinBtc: kucoinBtc?.toString() ?? null,
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
