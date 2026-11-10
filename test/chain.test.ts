import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import {
  BSC_FINAL_CONFIRMATIONS, explorerUrl, findTxHash, lookupBsc, lookupTron, lookupTx,
} from "../src/chain";
import tronFixture from "./fixtures/tronscan-usdt-transfer.json";
import bscFixture from "./fixtures/bsc-usdt-receipt.json";
import { fakeFetch, jsonRpcFetch } from "./fakes";

const TRON_HASH = "e9eb6c53b09f9f7b502dd31f7e1200c17e97b3b3c01884087f0900a4e52ad94a";
const BSC_HASH = "0xf1184fd7ebae7e0800860eae23dac6ea8817d31f8dde234af0c6ef62d9c40e13";
const BSC_BLOCK = 0x7e9758f;
const hex = (n: number) => `0x${n.toString(16)}`;

describe("findTxHash", () => {
  test("bare 64-hex hash: TRON first, then BSC", () => {
    expect(findTxHash(TRON_HASH)).toEqual({ hash: TRON_HASH, networks: ["TRON", "BSC"] });
  });
  test("0x hash is BSC only", () => {
    expect(findTxHash(BSC_HASH)).toEqual({ hash: BSC_HASH, networks: ["BSC"] });
  });
  test("inside explorer links", () => {
    expect(findTxHash(`https://tronscan.org/#/transaction/${TRON_HASH}`)?.hash).toBe(TRON_HASH);
    expect(findTxHash(`https://bscscan.com/tx/${BSC_HASH}`)?.hash).toBe(BSC_HASH);
  });
  test("inside Persian text with ZWNJ and RTL marks", () => {
    expect(findTxHash(`واریز شد‌ ‏${TRON_HASH}‏ ممنون`)?.hash).toBe(TRON_HASH);
  });
  test("uppercase is lowercased", () => {
    expect(findTxHash(BSC_HASH.toUpperCase().replace("0X", "0x"))?.hash).toBe(BSC_HASH);
    expect(findTxHash(TRON_HASH.toUpperCase())?.hash).toBe(TRON_HASH);
  });
  test("63 or 65 hex chars and plain text are not hashes", () => {
    expect(findTxHash(TRON_HASH.slice(1))).toBeNull();
    expect(findTxHash(`${TRON_HASH}a`)).toBeNull();
    expect(findTxHash("۱۰۰ تتر خریدم")).toBeNull();
  });
});

describe("lookupTron", () => {
  test("USDT transfer fixture", async () => {
    const r = await lookupTron(TRON_HASH, fakeFetch({ "apilist.tronscanapi.com": tronFixture }));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    const { tx } = r;
    expect(tx.network).toBe("TRON");
    expect(tx.hash).toBe(TRON_HASH);
    expect(tx.succeeded).toBe(true);
    expect(tx.transfers).toHaveLength(1);
    expect(tx.transfers[0].from).toBe("TWTV2WWNBZ9crFQyv1mnoFTDi25YDrjsBZ");
    expect(tx.transfers[0].to).toBe("TFxi6L2JoLudi9Y22nRJ9xtTHTCGpkGfT4");
    expect(tx.transfers[0].amount.eq(1000)).toBe(true);
    expect(tx.confirmations).toBe(2);
    expect(tx.final).toBe(false);
    expect(tx.fee.eq("6.7735")).toBe(true);
    expect(tx.feeAsset).toBe("TRX");
  });
  test("confirmed is final", async () => {
    const r = await lookupTron(TRON_HASH, fakeFetch({ "apilist.tronscanapi.com": { ...tronFixture, confirmed: true } }));
    expect(r.kind === "found" && r.tx.final).toBe(true);
  });
  test("{} is not found", async () => {
    expect((await lookupTron(TRON_HASH, fakeFetch({ "apilist.tronscanapi.com": {} }))).kind).toBe("not_found");
  });
  test("HTTP 500 or a network failure is an error", async () => {
    expect((await lookupTron(TRON_HASH, fakeFetch({ "apilist.tronscanapi.com": 500 }))).kind).toBe("error");
    expect((await lookupTron(TRON_HASH, fakeFetch({}))).kind).toBe("error");
  });
  test("reverted transaction did not succeed", async () => {
    const r = await lookupTron(TRON_HASH, fakeFetch({ "apilist.tronscanapi.com": { ...tronFixture, contractRet: "REVERT" } }));
    expect(r.kind === "found" && r.tx.succeeded).toBe(false);
  });
  test("transfers of other contracts are dropped", async () => {
    const other = tronFixture.trc20TransferInfo.map((t) => ({ ...t, contract_address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj" }));
    const r = await lookupTron(TRON_HASH, fakeFetch({ "apilist.tronscanapi.com": { ...tronFixture, trc20TransferInfo: other } }));
    expect(r.kind === "found" && r.tx.transfers).toEqual([]);
  });
  test("API key header only when a key is given", async () => {
    const seen: (string | null)[] = [];
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("TRON-PRO-API-KEY"));
      return new Response(JSON.stringify(tronFixture), { status: 200 });
    }) as typeof fetch;
    await lookupTron(TRON_HASH, f);
    await lookupTron(TRON_HASH, f, "k-123");
    expect(seen).toEqual([null, "k-123"]);
  });
});

describe("lookupBsc", () => {
  const rpc = (receipt: unknown, head: number) =>
    jsonRpcFetch((method) => (method === "eth_getTransactionReceipt" ? receipt : hex(head)));
  const receipt = bscFixture.result;

  test("USDT receipt fixture, 15 confirmations is final", async () => {
    const r = await lookupBsc(BSC_HASH, rpc(receipt, BSC_BLOCK + BSC_FINAL_CONFIRMATIONS - 1));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    const { tx } = r;
    expect(tx.network).toBe("BSC");
    expect(tx.succeeded).toBe(true);
    expect(tx.transfers).toHaveLength(1);
    expect(tx.transfers[0].from).toBe("0xa010ec4e43c6448f2fe13340991bededf8763bf4");
    expect(tx.transfers[0].to).toBe("0x7c9e2d0cb5ec9ea82ddffd35bb4a1cb65d487809");
    expect(tx.transfers[0].amount.eq(new Decimal("0x542253a126ce40000").div("1e18"))).toBe(true);
    expect(tx.transfers[0].amount.eq(97)).toBe(true);
    expect(tx.confirmations).toBe(15);
    expect(tx.final).toBe(true);
    expect(tx.fee.eq(new Decimal(0xc99f).mul(0x5f5e100).div("1e18"))).toBe(true);
    expect(tx.feeAsset).toBe("BNB");
  });
  test("14 confirmations is not final", async () => {
    const r = await lookupBsc(BSC_HASH, rpc(receipt, BSC_BLOCK + 13));
    expect(r.kind === "found" && r.tx.final).toBe(false);
  });
  test("null receipt is not found", async () => {
    expect((await lookupBsc(BSC_HASH, rpc(null, BSC_BLOCK))).kind).toBe("not_found");
  });
  test("status 0x0 did not succeed", async () => {
    const r = await lookupBsc(BSC_HASH, rpc({ ...receipt, status: "0x0" }, BSC_BLOCK));
    expect(r.kind === "found" && r.tx.succeeded).toBe(false);
  });
  test("logs of other contracts or other topics are ignored", async () => {
    const [log] = receipt.logs;
    const logs = [
      { ...log, address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
      { ...log, topics: [`0x${"11".repeat(32)}`, ...log.topics.slice(1)] },
    ];
    const r = await lookupBsc(BSC_HASH, rpc({ ...receipt, logs }, BSC_BLOCK));
    expect(r.kind === "found" && r.tx.transfers).toEqual([]);
  });
  test("an RPC failure is an error", async () => {
    const f = jsonRpcFetch(() => {
      throw new Error("down");
    });
    expect((await lookupBsc(BSC_HASH, async (...a) => {
      try {
        return await f(...a);
      } catch {
        return new Response(null, { status: 502 });
      }
    })).kind).toBe("error");
  });
});

describe("lookupTx", () => {
  test("bare hash: TRON not found, BSC found", async () => {
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tronscanapi")) return new Response("{}", { status: 200 });
      return jsonRpcFetch((m) => (m === "eth_getTransactionReceipt" ? bscFixture.result : hex(BSC_BLOCK + 20)))(input, init);
    }) as typeof fetch;
    const r = await lookupTx({ hash: BSC_HASH.slice(2), networks: ["TRON", "BSC"] }, f, {});
    expect(r.kind === "found" && r.tx.network).toBe("BSC");
    expect(r.kind === "found" && r.tx.hash).toBe(BSC_HASH);
  });
  test("TRON error and BSC not found is an error", async () => {
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("tronscanapi")) return new Response(null, { status: 500 });
      return jsonRpcFetch((m) => (m === "eth_getTransactionReceipt" ? null : hex(BSC_BLOCK)))(input, init);
    }) as typeof fetch;
    expect((await lookupTx({ hash: TRON_HASH, networks: ["TRON", "BSC"] }, f, {})).kind).toBe("error");
  });
});

test("explorerUrl", () => {
  expect(explorerUrl("TRON", TRON_HASH)).toBe(`https://tronscan.org/#/transaction/${TRON_HASH}`);
  expect(explorerUrl("BSC", BSC_HASH)).toBe(`https://bscscan.com/tx/${BSC_HASH}`);
});
