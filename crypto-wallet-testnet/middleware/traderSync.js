const CopyTrader = require('../models/CopyTrader');
const CopyRelation = require('../models/CopyRelation');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { getPlatformRate, calcFees, recordFees } = require('../utils/copyFees');
const { realAllocations } = require('../utils/copyStats');
const { notify } = require('./notify');

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = n => Number(Number(n || 0).toFixed(4));

function makeHistory(roi, days = 180) {
  const out = [];
  let value = Number(roi || 0);
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(12, 0, 0, 0);
    if (i > 0) value = clamp(value + (Math.random() - 0.53) * 1.15, -80, 250);
    else value = Number(roi || 0);
    out.push({ date: d, roi30d: round(value) });
  }
  return out;
}

/* ------------------------------------------------------------
   Assets under management (AUM)
   AUM shown to followers = audience AUM (aumBase, evolves here) + real allocations on the platform.
   Each trader's audience AUM changes at its own random moment: followers joining or leaving,
   larger deposits or withdrawals, and market movement on allocated funds.
   ------------------------------------------------------------ */
const AVG_ALLOCATION = { diamond: 2400, gold: 1100, silver: 520, bronze: 260 };
const stableUnit = t => parseInt(String(t._id).slice(-6), 16) / 0xffffff;       // stable 0..1 per trader
const allocUnit = t => (AVG_ALLOCATION[t.tier] || 260) * (0.7 + 0.9 * stableUnit(t));
const between = (a, b) => a + Math.random() * (b - a);

function nextAumDelayMs() {
  const r = Math.random();
  if (r < 0.70) return between(20_000, 150_000);      // most updates: every 20s - 2.5min
  if (r < 0.95) return between(150_000, 420_000);     // sometimes: 2.5 - 7 min
  return between(420_000, 900_000);                   // occasionally: 7 - 15 min
}

function baselineAum(t) { return round(Math.max(0, Number(t.followers || 0)) * allocUnit(t)); }

async function updateAum() {
  try {
    const now = new Date();
    const due = await CopyTrader.find({
      active: true, user: null,
      $or: [{ aumSeeded: { $ne: true } }, { nextAumAt: null }, { nextAumAt: { $lte: now } }]
    }).select('tier followers aumBase aumSeeded').lean();
    if (!due.length) return;

    const allocations = await realAllocations();
    const ops = [];
    for (const t of due) {
      if (!t.aumSeeded) {
        ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: {
          aumBase: baselineAum(t), aumSeeded: true, nextAumAt: new Date(Date.now() + between(1_000, 40_000))
        } } } });
        continue;
      }
      const realCount = (allocations.get(String(t._id)) || {}).count || 0;
      let base = Number(t.aumBase || 0);
      let followers = Number(t.followers || 0);
      const unit = allocUnit(t);
      const roll = Math.random();
      if (roll < 0.30) {                                  // followers join or leave
        const n = 1 + Math.floor(Math.random() * 3);
        const joined = Math.random() < 0.62;
        followers = Math.max(realCount, followers + (joined ? n : -n));
        base = Math.max(0, base + (joined ? n : -n) * unit * between(0.6, 1.4));
      } else if (roll < 0.40) {                           // larger deposit or withdrawal by existing followers
        base *= 1 + (Math.random() < 0.6 ? 1 : -1) * between(0.01, 0.035);
      } else {                                            // market movement on allocated funds
        base *= 1 + between(-0.0045, 0.0055);
      }
      ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: {
        aumBase: round(Math.max(0, base)), followers, nextAumAt: new Date(Date.now() + nextAumDelayMs())
      } } } });
    }
    if (ops.length) await CopyTrader.bulkWrite(ops);
  } catch (e) { console.error('AUM update error:', e.message); }
}

/* Performance of a trader who trades on the platform, taken from their own closed trades (last 30 days). */
async function realTraderStats(userId) {
  const since = new Date(Date.now() - 30 * 864e5);
  const [closes, trades, owner] = await Promise.all([
    Transaction.find({ user: userId, category: 'trade_close', createdAt: { $gte: since } }).select('note').lean(),
    Order.countDocuments({ user: userId, status: 'filled' }),
    User.findById(userId).select('balances locked').lean()
  ]);
  const pnls = closes.map(c => Number((/realized PnL\s+(-?[\d.]+(?:e[-+]?\d+)?)/i.exec(c.note || '') || [])[1])).filter(Number.isFinite);
  const wins = pnls.filter(p => p > 0).length;
  const equity = Math.max(Number(owner?.balances?.USDT || 0) + Number(owner?.locked?.USDT || 0), 100);
  return {
    roi30d: round(pnls.reduce((a, b) => a + b, 0) / equity * 100),
    winRate: pnls.length ? round(wins / pnls.length * 100) : 0,
    totalTrades: trades
  };
}

/* Trader performance profiles are refreshed gradually and daily history snapshots are stored. */
async function syncTraders() {
  try {
    const traders = await CopyTrader.find({ active: true });
    if (!traders.length) return;

    for (const t of traders) {
      const previousRoi = Number(t.roi30d || 0);
      if (t.user) {
        // Trader running on the platform: performance comes from their own closed trades.
        const stats = await realTraderStats(t.user);
        t.roi30d = clamp(stats.roi30d, -100, 1000); t.winRate = stats.winRate; t.totalTrades = stats.totalTrades;
        const f = Number(t.followers || 0);
        t.tier = f >= 500 ? 'diamond' : f >= 100 ? 'gold' : f >= 10 ? 'silver' : 'bronze';
      } else {
        const bias = { diamond: 0.018, gold: 0.009, silver: 0.001, bronze: -0.006 }[t.tier] || 0;
        const delta = bias + (Math.random() - 0.5) * 0.12;
        t.roi30d = round(clamp(previousRoi + delta, -60, 180));
        const targetWin = { diamond: 72, gold: 63, silver: 55, bronze: 47 }[t.tier] || 50;
        t.winRate = round(clamp(Number(t.winRate || targetWin) + (targetWin - Number(t.winRate || targetWin)) * 0.004 + (Math.random() - 0.5) * 0.06, 20, 95));
        if (Math.random() > 0.985) t.totalTrades += 1;
      }

      if (!t.user && (!t.performanceHistory || !t.performanceHistory.length)) t.performanceHistory = makeHistory(previousRoi);
      const today = new Date(); today.setHours(12, 0, 0, 0);
      const last = (t.performanceHistory || [])[(t.performanceHistory || []).length - 1];
      if (last && new Date(last.date).toDateString() === today.toDateString()) {
        last.roi30d = t.roi30d;
      } else {
        t.performanceHistory.push({ date: today, roi30d: t.roi30d });
      }
      if (t.performanceHistory.length > 180) t.performanceHistory = t.performanceHistory.slice(-180);
      await t.save();

      // Followers' unrealized PnL follows the trader's change in ROI, based on their allocation.
      const relations = await CopyRelation.find({ trader: t._id, active: true });
      for (const rel of relations) {
        const baseline = rel.lastTraderRoi == null ? previousRoi : Number(rel.lastTraderRoi);
        const roiDelta = t.roi30d - baseline;
        const pnlDelta = round(Number(rel.allocation || 0) * roiDelta / 100);
        // Atomic and limited to active copies so a copy stopped mid-run is never modified afterwards.
        await CopyRelation.updateOne({ _id: rel._id, active: true },
          { $inc: { pnl: pnlDelta }, $set: { lastTraderRoi: t.roi30d } });
      }
    }

    // Follower count: platform traders show exactly their real followers; others never drop below their real followers.
    const relations = await CopyRelation.aggregate([{ $match: { active: true } }, { $group: { _id: '$trader', count: { $sum: 1 } } }]);
    const counts = new Map(relations.map(x => [String(x._id), x.count]));
    for (const t of traders) {
      const real = counts.get(String(t._id)) || 0;
      if (t.user ? Number(t.followers || 0) !== real : Number(t.followers || 0) < real) { t.followers = real; await t.save(); }
    }
  } catch (e) { console.error('traderSync error:', e.message); }
}

/* Profit-sharing settlement. Each relation is settled in its own transaction so an hourly run
   can never double-charge a fee that was already taken when a copy was stopped. */
async function settleFees() {
  try {
    const candidates = await CopyRelation.find({ active: true, pnl: { $gt: 0 } }).select('_id').lean();
    for (const c of candidates) {
      const session = await mongoose.startSession();
      let notice = null;
      try {
        await session.withTransaction(async () => {
          notice = null;
          const rel = await CopyRelation.findOne({ _id: c._id, active: true }).session(session);
          if (!rel || Number(rel.pnl) <= Number(rel.highWaterMark || 0)) return;
          const trader = await CopyTrader.findById(rel.trader).session(session);
          if (!trader) return;
          const fees = calcFees(rel, trader, await getPlatformRate(trader, session));
          if (fees.total <= 0) return;
          const charged = await User.updateOne(
            { _id: rel.follower, 'balances.USDT': { $gte: fees.total } },
            { $inc: { 'balances.USDT': -fees.total } }, { session });
          if (!charged.modifiedCount) return; // insufficient balance: retry on the next run
          await recordFees({ session, rel, trader, fees });
          notice = { user: rel.follower, total: fees.total, name: trader.displayName };
        });
      } catch (e) { console.error('settleFees error:', e.message); }
      finally { await session.endSession(); }
      if (notice) await notify(notice.user, 'system', 'Performance fee charged',
        `${notice.total.toFixed(4)} USDT on profit from ${notice.name}`).catch(() => {});
    }
  } catch (e) { console.error('settleFees error:', e.message); }
}

let intervalHandle = null;
let feeInterval = null;
let aumInterval = null;
function start() {
  if (intervalHandle) return;
  console.log('📈 Trader ROI sync started');
  syncTraders();
  updateAum();
  aumInterval = setInterval(updateAum, 3_000);   // checks who is due; each trader's own timing is randomised
  intervalHandle = setInterval(syncTraders, 60_000);
  feeInterval = setInterval(settleFees, 60 * 60 * 1000);
}
function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  if (feeInterval) { clearInterval(feeInterval); feeInterval = null; }
  if (aumInterval) { clearInterval(aumInterval); aumInterval = null; }
}
module.exports = { start, stop, syncTraders, settleFees, updateAum };
