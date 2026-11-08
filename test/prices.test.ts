import { describe, expect, test } from "vitest";
import { SELF } from "cloudflare:test";
import { fetchCoinUsdt, fetchUsdtToman, quoteCoins } from "../src/prices";
import { fakeFetch } from "./fakes";

const nobitexOk = {
  status: "ok",
  stats: { "usdt-rls": { latest: "2660010", bestBuy: "2660000", bestSell: "2661320" } },
};
const kucoin = (price: string) => ({ code: "200000", data: { price } });

describe("prices", () => {
  test("nobitex rial → toman", async () => {
    const p = await fetchUsdtToman(fakeFetch({ "apiv2.nobitex.ir": nobitexOk }));
    expect(p!.latest.toString()).toBe("266001");
    expect(p!.bestBuy.toString()).toBe("266000");
    expect(p!.bestSell.toString()).toBe("266132");
  });

  test("nobitex failure → null", async () => {
    expect(await fetchUsdtToman(fakeFetch({ "apiv2.nobitex.ir": 500 }))).toBeNull();
  });

  test("nobitex non-ok status or missing field → null", async () => {
    expect(await fetchUsdtToman(fakeFetch({ "apiv2.nobitex.ir": { status: "failed" } }))).toBeNull();
    expect(
      await fetchUsdtToman(
        fakeFetch({ "apiv2.nobitex.ir": { status: "ok", stats: { "usdt-rls": { latest: "1" } } } }),
      ),
    ).toBeNull();
  });

  test("kucoin unknown symbol → null", async () => {
    expect(
      await fetchCoinUsdt("ZZZ", fakeFetch({ "api.kucoin.com": { code: "200000", data: null } })),
    ).toBeNull();
  });

  test("kucoin price", async () => {
    const p = await fetchCoinUsdt("btc", fakeFetch({ "api.kucoin.com": kucoin("75929.2") }));
    expect(p!.toString()).toBe("75929.2");
  });

  test("quote converts to toman", async () => {
    const f = fakeFetch({ "apiv2.nobitex.ir": nobitexOk, "api.kucoin.com": kucoin("75929.2") });
    const [q] = await quoteCoins(["btc"], f);
    expect(q.coin).toBe("BTC");
    expect(q.usdt!.toString()).toBe("75929.2");
    expect(q.toman!.toString()).toBe("20197243129.2");
  });

  test("USDT quotes as 1 without hitting kucoin", async () => {
    const [q] = await quoteCoins(["usdt"], fakeFetch({ "apiv2.nobitex.ir": nobitexOk }));
    expect(q.usdt!.toString()).toBe("1");
    expect(q.toman!.toString()).toBe("266001");
  });

  test("quote with nobitex down → toman null", async () => {
    const f = fakeFetch({ "apiv2.nobitex.ir": 500, "api.kucoin.com": kucoin("2") });
    const [q] = await quoteCoins(["eth"], f);
    expect(q.usdt!.toString()).toBe("2");
    expect(q.toman).toBeNull();
  });
});

describe("worker routes", () => {
  test("unknown path → 404", async () => {
    expect((await SELF.fetch("https://example.com/nope")).status).toBe(404);
  });
});
