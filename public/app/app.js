// Mini App frontend. Plain ES module, no build. All server strings go through textContent.
const tg = window.Telegram?.WebApp;
try { tg?.ready(); tg?.expand(); } catch { /* not inside Telegram */ }

const NO_ACCESS = "فقط مدیران به این بخش دسترسی دارند";
const PAGE = 30;

// --- helpers -------------------------------------------------------------------------

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (s) => s.replace(/\d/g, (d) => FA[d]);
const intFmt = new Intl.NumberFormat("fa-IR");

/** Format a decimal string without ever converting it to a lossy Number. */
function fmt(str) {
  if (str === null || str === undefined || str === "") return "—";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(str));
  if (!m) return faDigits(String(str));
  const frac = (m[3] ?? "").replace(/0+$/, "");
  return (m[1] ? "-" : "") + intFmt.format(BigInt(m[2])) + (frac ? "٫" + faDigits(frac) : "");
}
const dateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" });
function jdate(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? dateFmt.format(d) : "";
}
const assetName = (a) => (a === "IRT" ? "تومان" : a === "USDT" ? "تتر" : a);
const money = (v, asset) => `${fmt(v)} ${assetName(asset)}`;
const KIND = { BUY: "خرید", SELL: "فروش", PAY: "پرداخت", RECEIVE: "دریافت" };
const STATUS = { pending: "در انتظار", approved: "تایید شده", rejected: "رد شده", cancelled: "لغو شده" };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value" || k === "checked" || k === "disabled") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Authorization: `tma ${tg?.initData ?? ""}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("اتصال به سرور برقرار نشد.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403 ? NO_ACCESS : data?.error ?? "خطای ناشناخته.";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Run an action; toast any error. Returns the result or undefined on failure. */
async function attempt(fn) {
  try { return await fn(); } catch (e) { toast(e.message); return undefined; }
}

function confirmAsk(msg) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(msg, resolve);
    else resolve(window.confirm(msg));
  });
}

/** Two-step confirmation for permanent deletes. */
async function confirmDelete(what) {
  return (await confirmAsk(`${what} حذف شود؟`)) && (await confirmAsk("این کار برگشت‌پذیر نیست. مطمئنی؟"));
}

function openModal(title, content) {
  const m = $("modal");
  m.replaceChildren(h("div", { class: "sheet" }, h("h2", {}, title), content));
  m.hidden = false;
  m.onclick = (ev) => { if (ev.target === m) closeModal(); };
}
function closeModal() { $("modal").hidden = true; $("modal").replaceChildren(); }

// --- shared state ---------------------------------------------------------------------

let tab = "dash";
let clientId = null; // detail view when non-null
let names = new Map(); // chatId -> name
const dealsState = { status: "", kind: "", chatId: "", entries: [], more: false };

async function loadNames() {
  const d = await api("GET", "/api/accounts?archived=1");
  names = new Map(d.accounts.map((a) => [a.chatId, a.name]));
  return d.accounts;
}
const clientName = (id) => names.get(id) ?? String(id);

function owedLines(owed) {
  const keys = Object.keys(owed ?? {});
  if (!keys.length) return [h("div", { class: "muted" }, "تسویه")];
  return keys.map((a) => {
    const v = owed[a];
    return h("div", { class: v.startsWith("-") ? "green" : "red" }, money(v.replace(/^-/, ""), a));
  });
}

// --- views -----------------------------------------------------------------------------

const view = $("view");
function render(title, ...nodes) {
  $("title").textContent = title;
  view.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}
const loading = () => view.replaceChildren(h("div", { class: "empty" }, "در حال بارگذاری…"));

function sumLines(m) {
  const keys = Object.keys(m ?? {});
  return keys.length ? keys.map((a) => h("div", {}, money(m[a], a))) : [h("div", { class: "muted" }, "—")];
}

async function showDash() {
  loading();
  const d = await attempt(() => api("GET", "/api/dashboard"));
  if (!d) return render("داشبورد", h("div", { class: "empty" }, "بارگذاری نشد."));
  $("price").textContent = d.usdt ? `تتر: ${fmt(d.usdt.latest)} ت` : "";
  const kpi = (label, cls, ...v) => h("div", { class: "kpi" }, h("div", { class: "muted" }, label), h("div", { class: `v ${cls}` }, v));
  render(
    "داشبورد",
    h("div", { class: "kpis" },
      kpi("کل طلب ما", "red", sumLines(d.receivable)),
      kpi("کل بدهی ما", "green", sumLines(d.payable)),
      kpi("حجم امروز", "", money(d.todayVolumeUsdt, "USDT")),
      kpi("در انتظار تایید", "amber", fmt(String(d.pendingCount))),
    ),
    h("h3", {}, "بیشترین بدهکارها"),
    d.topDebtors.length
      ? h("div", { class: "list" }, d.topDebtors.map((x) =>
          h("div", { class: "row tap", onclick: () => openClient(x.chatId) },
            h("span", { class: "grow" }, x.name), h("span", { class: "nums" }, owedLines(x.owed)))))
      : h("div", { class: "empty" }, "بدهکاری وجود ندارد."),
  );
}

async function showClients() {
  loading();
  const list = await attempt(loadNames);
  if (!list) return render("مشتری‌ها", h("div", { class: "empty" }, "بارگذاری نشد."));
  const box = h("div", { class: "list" });
  const draw = (q) => {
    const f = list.filter((a) => a.name.includes(q));
    box.replaceChildren(...(f.length ? f.map((a) =>
      h("div", { class: "row tap", onclick: () => openClient(a.chatId) },
        h("span", { class: "grow" }, a.name, a.archived ? h("span", { class: "pill" }, "بایگانی") : null),
        h("span", { class: "nums" }, owedLines(a.owed)))) : [h("div", { class: "empty" }, "مشتری‌ای پیدا نشد.")]));
  };
  draw("");
  render("مشتری‌ها", h("input", { placeholder: "جستجوی نام…", oninput: (e) => draw(e.target.value.trim()) }), h("div", { style: "height:10px" }), box);
}

function openClient(id) { clientId = id; tab = "clients"; markTab(); showClient(); }

async function showClient() {
  loading();
  const d = await attempt(() => api("GET", `/api/accounts/${clientId}`));
  if (!d) return render("مشتری", backBtn(), h("div", { class: "empty" }, "بارگذاری نشد."));
  const a = d.account;
  const patch = async (body) => {
    if (await attempt(() => api("PATCH", `/api/accounts/${clientId}`, body))) { await loadNames().catch(() => {}); showClient(); }
  };
  const toggle = (label, key) => h("label", { class: "sw" }, h("span", {}, label),
    h("input", { type: "checkbox", checked: a[key], onchange: (e) => patch({ [key]: e.target.checked }) }));
  render(
    a.name,
    backBtn(),
    h("div", { class: "card" }, h("div", { class: "muted" }, "مانده حساب"), h("div", { class: "nums" }, owedLines(a.owed))),
    h("h3", {}, "معامله‌های باز"),
    d.openDeals.length
      ? h("div", { class: "list" }, d.openDeals.map((deal) =>
          h("div", { class: "row" }, h("span", { class: "grow" }, deal.code),
            h("span", { class: "nums" }, deal.legs.map((l) =>
              h("div", { class: "muted" }, `${l.dir === "client_owes" ? "طلب ما" : "بدهی ما"}: ${money(l.remaining, l.asset)} از ${fmt(l.total)}`))))))
      : h("div", { class: "empty" }, "معامله‌ی بازی نیست."),
    h("h3", {}, "ثبت واریز"),
    paymentForm(d),
    h("h3", {}, "تنظیمات مشتری"),
    h("div", { class: "list" },
      toggle("یادآوری بدهی", "reminders_on"),
      toggle("شوخی‌ها", "humor_on"),
      toggle("بایگانی", "archived")),
    h("div", { style: "height:8px" }),
    h("button", { class: "btn ghost", onclick: () => renameModal(a, patch) }, "تغییر نام"),
    h("h3", {}, "تاریخچه"),
    d.entries.length
      ? h("div", { class: "list" }, d.entries.map((e) => dealRow(e, { client: false, refresh: showClient })))
      : h("div", { class: "empty" }, "سابقه‌ای نیست."),
    h("div", { style: "height:16px" }),
    h("button", { class: "btn danger", onclick: async (ev) => {
      if (!(await confirmDelete("این مشتری"))) return;
      ev.target.disabled = true;
      if (await attempt(() => api("DELETE", `/api/accounts/${clientId}`))) {
        toast("حذف شد.");
        clientId = null;
        await loadNames().catch(() => {});
        showTab();
      } else ev.target.disabled = false;
    } }, "🗑 حذف مشتری"),
  );
}

function backBtn() {
  return h("button", { class: "back", onclick: () => { clientId = null; showTab(); } }, "‹ بازگشت");
}

function renameModal(a, patch) {
  const input = h("input", { value: a.display_name ?? "", placeholder: a.title ?? "" });
  openModal("تغییر نام", h("div", {}, h("label", { class: "f" }, "نام نمایشی (خالی = نام گروه)", input),
    h("div", { class: "btns" },
      h("button", { class: "btn", onclick: () => { closeModal(); patch({ display_name: input.value.trim() || null }); } }, "ذخیره"),
      h("button", { class: "btn ghost", onclick: closeModal }, "انصراف"))));
}

function paymentForm(d) {
  const dir = h("select", {}, h("option", { value: "RECEIVE" }, "دریافت از مشتری"), h("option", { value: "PAY" }, "پرداخت به مشتری"));
  const amount = h("input", { inputmode: "decimal", placeholder: "مثلاً ۵۰ میلیون" });
  const asset = h("input", { placeholder: "تومان (پیش‌فرض)" });
  const note = h("input", { placeholder: "اختیاری" });
  const deal = h("select", {}, h("option", { value: "" }, "بدون ارتباط با معامله"),
    d.openDeals.map((x) => h("option", { value: x.id }, x.code)));
  const btn = h("button", { class: "btn", onclick: async () => {
    btn.disabled = true;
    const body = { direction: dir.value, amount: amount.value, note: note.value };
    if (asset.value.trim()) body.asset = asset.value.trim();
    if (deal.value) body.linkedDealId = Number(deal.value);
    const r = await attempt(() => api("POST", `/api/accounts/${clientId}/payments`, body));
    btn.disabled = false;
    if (r) { toast("ثبت شد."); showClient(); }
  } }, "ثبت");
  return h("div", { class: "card" },
    h("label", { class: "f" }, "جهت", dir), h("label", { class: "f" }, "مبلغ", amount),
    h("label", { class: "f" }, "دارایی", asset), h("label", { class: "f" }, "توضیحات", note),
    h("label", { class: "f" }, "معامله‌ی مرتبط", deal), btn);
}

// --- deals -----------------------------------------------------------------------------

function dealRow(e, { client, refresh }) {
  const isPay = e.kind === "PAY" || e.kind === "RECEIVE";
  const title = `${KIND[e.kind] ?? e.kind} ${money(e.amount, e.asset)}`;
  const sub = [e.code, client ? clientName(e.chatId) : null, e.rate ? `فی ${fmt(e.rate)}` : null, e.note || null]
    .filter(Boolean).join(" · ");
  const act = (label, cls, fn) => h("button", { class: `btn sm ${cls}`, onclick: async (ev) => {
    ev.target.disabled = true;
    await fn();
    ev.target.disabled = false;
  } }, label);
  const post = async (path, ok) => { if (await attempt(() => api("POST", path))) { if (ok) toast(ok); refresh(); } };
  const actions = [];
  if (e.status === "pending") {
    actions.push(act("تایید", "", () => post(`/api/entries/${e.id}/approve`)));
    actions.push(act("رد", "ghost", () => post(`/api/entries/${e.id}/reject`)));
  }
  if (e.status === "pending" || e.status === "approved") {
    actions.push(act("ویرایش", "ghost", async () => editModal(e, isPay, refresh)));
    actions.push(act("لغو", "danger", async () => {
      if (await confirmAsk(`«${e.code}» لغو شود؟`)) await post(`/api/entries/${e.id}/cancel`, "لغو شد.");
    }));
  }
  actions.push(act("🗑 حذف", "danger", async () => {
    if (!(await confirmDelete("این مورد"))) return;
    if (await attempt(() => api("DELETE", `/api/entries/${e.id}`))) { toast("حذف شد."); refresh(); }
  }));
  return h("div", { class: "row" },
    h("div", { class: "grow" },
      h("div", {}, title, h("span", { class: `pill ${e.status}` }, STATUS[e.status] ?? e.status)),
      h("div", { class: "muted" }, sub),
      h("div", { class: "muted" }, jdate(e.createdAt)),
      h("div", { class: "actions" }, actions)));
}

function editModal(e, isPay, refresh) {
  const amount = h("input", { inputmode: "decimal", value: e.amount });
  const rate = h("input", { inputmode: "decimal", value: e.rate ?? "" });
  const note = h("input", { value: e.note ?? "" });
  const save = h("button", { class: "btn", onclick: async () => {
    const body = {};
    if (amount.value.trim() !== e.amount) body.amount = amount.value.trim();
    if (!isPay && rate.value.trim() !== (e.rate ?? "")) body.rate = rate.value.trim();
    if (note.value.trim() !== (e.note ?? "")) body.note = note.value.trim();
    if (!Object.keys(body).length) return closeModal();
    save.disabled = true;
    const r = await attempt(() => api("PATCH", `/api/entries/${e.id}`, body));
    save.disabled = false;
    if (r) { closeModal(); toast("ویرایش شد."); refresh(); }
  } }, "ذخیره");
  openModal(`ویرایش ${e.code}`, h("div", {},
    h("label", { class: "f" }, `مبلغ (${assetName(e.asset)})`, amount),
    isPay ? null : h("label", { class: "f" }, "قیمت", rate),
    h("label", { class: "f" }, "توضیحات", note),
    h("div", { class: "btns" }, save, h("button", { class: "btn ghost", onclick: closeModal }, "انصراف"))));
}

async function fetchDeals(append) {
  const q = new URLSearchParams({ limit: String(PAGE) });
  for (const k of ["status", "kind", "chatId"]) if (dealsState[k]) q.set(k, dealsState[k]);
  if (append && dealsState.entries.length) q.set("before", String(dealsState.entries.at(-1).id));
  const d = await attempt(() => api("GET", `/api/entries?${q}`));
  if (!d) return false;
  dealsState.entries = append ? dealsState.entries.concat(d.entries) : d.entries;
  dealsState.more = d.entries.length === PAGE;
  return true;
}

async function showDeals() {
  loading();
  if (!names.size) await attempt(loadNames);
  await fetchDeals(false);
  drawDeals();
}

function drawDeals() {
  const chip = (key, val, label) => h("button", { class: `chip ${dealsState[key] === val ? "on" : ""}`, onclick: async () => {
    dealsState[key] = val; loading(); await fetchDeals(false); drawDeals();
  } }, label);
  const clientSel = h("select", { onchange: async (ev) => { dealsState.chatId = ev.target.value; loading(); await fetchDeals(false); drawDeals(); } },
    h("option", { value: "" }, "همه‌ی مشتری‌ها"),
    [...names].map(([id, n]) => h("option", { value: id, selected: String(id) === dealsState.chatId }, n)));
  const refresh = async () => { await fetchDeals(false); drawDeals(); };
  render("معاملات",
    h("div", { class: "chips" }, chip("status", "", "همه"), chip("status", "pending", "در انتظار"), chip("status", "approved", "تایید شده"),
      chip("status", "rejected", "رد شده"), chip("status", "cancelled", "لغو شده")),
    h("div", { class: "chips" }, chip("kind", "", "همه‌ی انواع"), chip("kind", "BUY", "خرید"), chip("kind", "SELL", "فروش"),
      chip("kind", "PAY", "پرداخت"), chip("kind", "RECEIVE", "دریافت")),
    clientSel, h("div", { style: "height:10px" }),
    dealsState.entries.length
      ? h("div", { class: "list" }, dealsState.entries.map((e) => dealRow(e, { client: true, refresh })))
      : h("div", { class: "empty" }, "موردی نیست."),
    dealsState.more ? h("button", { class: "btn ghost", style: "width:100%;margin-top:10px", onclick: async (ev) => {
      ev.target.disabled = true;
      if (await fetchDeals(true)) drawDeals(); else ev.target.disabled = false;
    } }, "بیشتر") : null);
}

// --- settings ---------------------------------------------------------------------------

async function showSettings() {
  loading();
  const [adm, set] = await Promise.all([attempt(() => api("GET", "/api/admins")), attempt(() => api("GET", "/api/settings"))]);
  if (!adm || !set) return render("تنظیمات", h("div", { class: "empty" }, "بارگذاری نشد."));
  const dev = h("input", { inputmode: "decimal", value: set.deviation_pct });
  const uid = h("input", { inputmode: "numeric", placeholder: "شناسه‌ی عددی تلگرام" });
  const nm = h("input", { placeholder: "نام (اختیاری)" });
  render("تنظیمات",
    h("h3", {}, "درصد انحراف قیمت"),
    h("div", { class: "card" }, h("label", { class: "f" }, "هشدار وقتی قیمت معامله از بازار بیش از این درصد فاصله دارد", dev),
      h("button", { class: "btn", onclick: async () => { if (await attempt(() => api("PATCH", "/api/settings", { deviation_pct: dev.value }))) { toast("ذخیره شد."); showSettings(); } } }, "ذخیره")),
    h("h3", {}, "یادآوری بدهی"),
    h("div", { class: "card" }, h("label", { class: "sw" }, h("span", {}, "یادآوری برای گروه‌های تازه روشن باشد"),
      h("input", { type: "checkbox", checked: set.reminders_default, onchange: async (e) => {
        if (await attempt(() => api("PATCH", "/api/settings", { reminders_default: e.target.checked }))) toast("ذخیره شد.");
        else showSettings();
      } })),
      h("div", { class: "muted" }, "فقط برای گروه‌هایی که از این به بعد اضافه می‌شوند؛ هر گروه را جدا هم می‌شود تغییر داد.")),
    h("h3", {}, "مدیرها"),
    h("div", { class: "list" }, adm.admins.map((a) =>
      h("div", { class: "row" },
        h("span", { class: "grow" }, a.name || "—", " ", h("span", { class: "muted num" }, faDigits(String(a.userId)))),
        a.removable ? h("button", { class: "btn sm danger", onclick: async () => {
          if (!(await confirmAsk("این مدیر حذف شود؟"))) return;
          if (await attempt(() => api("DELETE", `/api/admins/${a.userId}`))) showSettings();
        } }, "حذف") : h("span", { class: "muted" }, "اصلی")))),
    h("div", { class: "card", style: "margin-top:12px" },
      h("label", { class: "f" }, "شناسه", uid), h("label", { class: "f" }, "نام", nm),
      h("button", { class: "btn", onclick: async () => {
        if (await attempt(() => api("POST", "/api/admins", { userId: uid.value.trim(), name: nm.value.trim() }))) { toast("اضافه شد."); showSettings(); }
      } }, "افزودن مدیر")));
}

// --- tabs --------------------------------------------------------------------------------

const TABS = { dash: showDash, clients: showClients, deals: showDeals, settings: showSettings };
function markTab() { for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === tab); }
function showTab() { markTab(); closeModal(); return TABS[tab](); }
$("tabs").addEventListener("click", (ev) => {
  const t = ev.target.closest("button")?.dataset.tab;
  if (!t) return;
  tab = t; clientId = null; showTab();
});

showTab();
