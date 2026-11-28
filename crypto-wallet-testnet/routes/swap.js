const express = require('express');
const mongoose = require('mongoose');
const Swap = require('../models/Swap');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');
const router = express.Router();

const priceService = require('../utils/priceService');
const { PriceUnavailableError, EXEC_MAX_AGE_MS } = priceService;

const ASSETS = Object.fromEntries([['USDT', { id: 'tether' }], ...Object.entries(priceService.SYMBOLS).map(([symbol, id]) => [symbol, { id }])]);
const FEE_RATE = 0.005;

/* Live prices only. If no fresh price exists the swap is refused: there are no reference/fallback rates. */
async function getPrices(from, to) {
  const info = await priceService.getPrices([from, to], { maxAgeMs: EXEC_MAX_AGE_MS });
  return { prices: info.prices, source: info.source === 'live' ? 'Live market feed' : 'Delayed market feed' };
}
function round(value, decimals = 12) {
  return Number(Number(value).toFixed(decimals));
}
function computeRate(from, to, prices) {
  if (!ASSETS[from] || !ASSETS[to] || from === to) return null;
  return Number(prices[from]) / Number(prices[to]);
}

router.get('/assets', auth, (req, res) => {
  res.json(Object.entries(ASSETS).map(([symbol, asset]) => ({ symbol, name: symbol, id: asset.id })));
});

router.get('/quote', auth, async (req, res) => {
  try {
    const from = String(req.query.from || '').toUpperCase();
    const to = String(req.query.to || '').toUpperCase();
    if (!ASSETS[from] || !ASSETS[to] || from === to) return res.status(400).json({ error: 'Invalid or unsupported pair' });
    const amt = Number(req.query.amount) || 0;
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Invalid amount' });
    const { prices, source } = await getPrices(from, to);
    const rate = computeRate(from, to, prices);
    const gross = amt * rate;
    const fee = gross * FEE_RATE;
    res.json({ from, to, rate, fee, gross, net: gross - fee, feeRate: FEE_RATE, priceSource: source });
  } catch (e) {
    if (e instanceof PriceUnavailableError) return res.status(503).json({ error: e.message });
    res.status(500).json({ error: 'Could not calculate swap quote' });
  }
});

router.post('/', auth, async (req, res) => {
  const from = String(req.body.from || '').toUpperCase();
  const to = String(req.body.to || '').toUpperCase();
  const amt = Number(req.body.amount);
  if (!ASSETS[from] || !ASSETS[to] || from === to) return res.status(400).json({ error: 'Invalid or unsupported pair' });
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1e15) return res.status(400).json({ error: 'Invalid amount' });

  let quote;
  try { quote = await getPrices(from, to); }
  catch (e) {
    if (e instanceof PriceUnavailableError) return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: 'Could not fetch swap price' });
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(req.user._id).session(session);
      if (!user) throw new Error('User not found');
      const available = Number(user.balances?.[from] || 0);
      if (available + 1e-12 < amt) throw new Error(`Insufficient ${from} balance`);
      const rate = computeRate(from, to, quote.prices);
      const gross = amt * rate;
      const fee = gross * FEE_RATE;
      const net = gross - fee;
      if (!Number.isFinite(net) || net <= 0) throw new Error('Unable to calculate swap amount');

      user.set(`balances.${from}`, round(available - amt));
      user.set(`balances.${to}`, round(Number(user.balances?.[to] || 0) + net));
      await user.save({ session });

      const [swap] = await Swap.create([{
        user: user._id, from, to, fromAmount: amt, toAmount: round(net), rate
      }], { session, ordered: true });
      const referenceId = String(swap._id);
      await Transaction.create([
        { user: user._id, type: 'earn', category: 'swap', direction: 'debit', currency: from, amount: amt, status: 'completed', referenceId, note: `Swap debit ${amt} ${from} → ${to}` },
        { user: user._id, type: 'earn', category: 'swap', direction: 'credit', currency: to, amount: round(net), fee: round(fee), status: 'completed', referenceId, note: `Swap credit ${round(net)} ${to} from ${from}` }
      ], { session, ordered: true });
      result = { swap, balances: user.balances, fee: round(fee) };
    });
    res.json(result);
  } catch (e) {
    res.status(/insufficient|invalid|not found/i.test(e.message) ? 400 : 500).json({ error: e.message });
  } finally { await session.endSession(); }
});

router.get('/history', auth, async (req, res) => {
  try {
    const swaps = await Swap.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
    res.json(swaps);
  } catch (e) { res.status(500).json({ error: 'Could not load swap history' }); }
});

module.exports = router;
