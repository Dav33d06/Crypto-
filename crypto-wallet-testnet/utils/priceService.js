/* Single source of market prices for the whole backend.
   - Providers are tried in order: Binance, Bybit, CoinGecko.
   - Every price carries the time it was fetched.
   - There are NO hardcoded fallback prices. If no sufficiently fresh price exists, callers get a
     PriceUnavailableError and money-moving operations must refuse to run.
   - USDT is the platform's unit of account and is fixed at 1. */

const SYMBOLS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', ADA: 'cardano',
  DOGE: 'dogecoin', LTC: 'litecoin', TRX: 'tron', DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink',
  BCH: 'bitcoin-cash', TON: 'the-open-network', NEAR: 'near', ATOM: 'cosmos', UNI: 'uniswap'
};

const REFRESH_AFTER_MS = 5_000;         // reuse a price this recent without refetching
const LIVE_WITHIN_MS   = 30_000;        // anything newer than this is labelled "live"
const EXEC_MAX_AGE_MS  = 60_000;        // trades, swaps and protective orders need prices at least this fresh
const DISPLAY_MAX_AGE_MS = 15 * 60_000; // balances/portfolio views tolerate older (labelled delayed) prices

class PriceUnavailableError extends Error {
  constructor(message = 'Live prices are temporarily unavailable. Please try again shortly.') {
    super(message); this.name = 'PriceUnavailableError'; this.status = 503; this.code = 'PRICE_UNAVAILABLE';
  }
}

const cache = Object.create(null);      // SYMBOL -> { price, at, provider }
let inflight = null;

const valid = n => Number.isFinite(n) && n > 0;
async function getJson(url, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const providers = [
  ['binance', async symbols => {
    const pairs = symbols.map(s => `${s}USDT`);
    const data = await getJson(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`);
    return Object.fromEntries(data.map(x => [String(x.symbol).replace(/USDT$/, ''), Number(x.price)]));
  }],
  ['bybit', async symbols => {
    const data = await getJson('https://api.bybit.com/v5/market/tickers?category=spot');
    const want = new Set(symbols.map(s => `${s}USDT`));
    const out = {};
    for (const t of data?.result?.list || []) if (want.has(t.symbol)) out[t.symbol.replace(/USDT$/, '')] = Number(t.lastPrice);
    return out;
  }],
  ['coingecko', async symbols => {
    const ids = symbols.map(s => SYMBOLS[s]).join(',');
    const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`, 6000);
    return Object.fromEntries(symbols.map(s => [s, Number(data?.[SYMBOLS[s]]?.usd)]));
  }]
];

async function refresh(symbols) {
  let missing = symbols.slice();
  for (const [name, fetcher] of providers) {
    if (!missing.length) break;
    try {
      const got = await fetcher(missing);
      for (const s of missing) if (valid(got[s])) cache[s] = { price: got[s], at: Date.now(), provider: name };
      missing = missing.filter(s => !(cache[s] && Date.now() - cache[s].at < 2000));
    } catch (e) { /* try the next provider */ }
  }
}

/* Returns { prices: { SYM: number }, source: 'live' | 'delayed', ageMs, asOf }.
   Throws PriceUnavailableError when any requested price is missing or older than maxAgeMs. */
async function getPrices(symbols = Object.keys(SYMBOLS), { maxAgeMs = EXEC_MAX_AGE_MS } = {}) {
  const wanted = [...new Set(symbols.map(s => String(s).toUpperCase()))].filter(s => s !== 'USDT');
  for (const s of wanted) if (!SYMBOLS[s]) throw new PriceUnavailableError(`No price feed for ${s}`);

  const needsRefresh = s => !cache[s] || Date.now() - cache[s].at > REFRESH_AFTER_MS;
  let stale = wanted.filter(needsRefresh);
  if (stale.length) {
    if (inflight) await inflight;                       // share an in-progress refresh
    stale = wanted.filter(needsRefresh);
    if (stale.length) { inflight = refresh(stale).finally(() => { inflight = null; }); await inflight; }
  }

  const prices = { USDT: 1 };
  let oldest = 0, asOf = Date.now();
  for (const s of wanted) {
    const entry = cache[s];
    const age = entry ? Date.now() - entry.at : Infinity;
    if (!entry || age > maxAgeMs) throw new PriceUnavailableError();
    prices[s] = entry.price;
    oldest = Math.max(oldest, age); asOf = Math.min(asOf, entry.at);
  }
  return { prices, source: oldest <= LIVE_WITHIN_MS ? 'live' : 'delayed', ageMs: oldest, asOf };
}

/* Convenience: single price, or null if unavailable (callers must treat null as "do not proceed"). */
async function getPriceOrNull(symbol, opts) {
  try { return (await getPrices([symbol], opts)).prices[String(symbol).toUpperCase()] ?? (String(symbol).toUpperCase() === 'USDT' ? 1 : null); }
  catch { return null; }
}

module.exports = { SYMBOLS, PriceUnavailableError, getPrices, getPriceOrNull, EXEC_MAX_AGE_MS, DISPLAY_MAX_AGE_MS, LIVE_WITHIN_MS };
