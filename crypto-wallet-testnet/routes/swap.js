const express = require('express');
const mongoose = require('mongoose');
const Swap = require('../models/Swap');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');
const router = express.Router();

const ASSETS = {
  USDT: { id: 'tether', fallback: 1 }, BTC: { id: 'bitcoin', fallback: 68000 },
  ETH: { id: 'ethereum', fallback: 3500 }, SOL: { id: 'solana', fallback: 150 },
  BNB: { id: 'binancecoin', fallback: 600 }, XRP: { id: 'ripple', fallback: 0.55 },
  ADA: { id: 'cardano', fallback: 0.45 }, DOGE: { id: 'dogecoin', fallback: 0.15 },
  LTC: { id: 'litecoin', fallback: 80 }, TRX: { id: 'tron', fallback: 0.12 },
  DOT: { id: 'polkadot', fallback: 6 }, AVAX: { id: 'avalanche-2', fallback: 35 },
  LINK: { id: 'chainlink', fallback: 14 }, BCH: { id: 'bitcoin-cash', fallback: 380 },
  TON: { id: 'the-open-network', fallback: 5 }, NEAR: { id: 'near', fallback: 5 },
  ATOM: { id: 'cosmos', fallback: 8 }, UNI: { id: 'uniswap', fallback: 7 }
};
const FEE_RATE = 0.005;
const cache = { at: 0, prices: {}, source: 'development-fallback' };

async function getUsdPrices() {
  if (Date.now() - cache.at < 15000 && Object.keys(cache.prices).length) return cache.prices;
  const ids = [...new Set(Object.values(ASSETS).map(a => a.id))].join(',');
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error(`Price provider returned ${response.status}`);
    const data = await response.json();
    const prices = {};
    for (const [symbol, asset] of Object.entries(ASSETS)) {
      const value = Number(data[asset.id]?.usd);
      if (Number.isFinite(value) && value > 0) prices[symbol] = value;
    }
    if (Object.keys(prices).length !== Object.keys(ASSETS).length) throw new Error('Incomplete market price response');
    cache.prices = prices; cache.at = Date.now(); cache.source = 'market-reference';
    return prices;
  } catch (_) {
    // Explicit development fallback; quotes remain usable while provider is unavailable.
    cache.source = 'development-fallback';
    return Object.fromEntries(Object.entries(ASSETS).map(([symbol, asset]) => [symbol, asset.fallback]));
  }
}
function quote(from, to, amount, prices) {
  if (!ASSETS[from] || !ASSETS[to] || from === to) throw new Error('Unsupported currency pair');
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new Error('Enter a valid swap amount');
  const rate = prices[from] / prices[to];
  const gross = amount * rate;
  const fee = gross * FEE_RATE;
  return { rate, gross, fee, net: gross - fee };
}
async function inTransaction(work) {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}

router.get('/assets', auth, (req, res) => res.json(Object.keys(ASSETS)));
router.get('/quote', auth, async (req, res) => {
  try {
    const from = String(req.query.from || '').toUpperCase();
    const to = String(req.query.to || '').toUpperCase();
    const amount = Number(req.query.amount || 0);
    const prices = await getUsdPrices();
    res.json({ from, to, ...quote(from, to, amount, prices), feeRate: FEE_RATE, source: cache.source });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/', auth, async (req, res) => {
  try {
    const from = String(req.body.from || '').toUpperCase();
    const to = String(req.body.to || '').toUpperCase();
    const amount = Number(req.body.amount);
    const prices = await getUsdPrices();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid swap amount');
    const q = quote(from, to, amount, prices);
    const result = await inTransaction(async session => {
      const user = await User.findById(req.user._id).session(session);
      if (!user) throw new Error('User not found');
      if ((user.balances[from] || 0) + 1e-12 < amount) throw new Error(`Insufficient ${from} balance`);
      user.balances[from] = Number((user.balances[from] - amount).toFixed(12));
      user.balances[to] = Number(((user.balances[to] || 0) + q.net).toFixed(12));
      await user.save({ session });
      const [swap] = await Swap.create([{ user: user._id, from, to, fromAmount: amount, toAmount: q.net, rate: q.rate }], { session });
      await Transaction.create([
        { user: user._id, type: 'earn', category: 'swap', direction: 'debit', currency: from, amount, referenceId: String(swap._id), status: 'completed', note: `Swap input: ${amount} ${from} to ${to}` },
        { user: user._id, type: 'earn', category: 'swap', direction: 'credit', currency: to, amount: q.net, referenceId: String(swap._id), status: 'completed', note: `Swap output: ${q.net} ${to} from ${from}; fee ${q.fee} ${to}` }
      ], { session });
      return { swap, balances: user.balances, fee: q.fee, gross: q.gross };
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/history', auth, async (req, res) => {
  try { res.json(await Swap.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean()); }
  catch (e) { res.status(500).json({ error: 'Unable to load swap history' }); }
});
module.exports = router;
