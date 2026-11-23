const CopyTrader = require('../models/CopyTrader');
const CopyRelation = require('../models/CopyRelation');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
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

/* Demo trader profiles evolve gradually. History is explicitly presented as simulated. */
async function syncTraders() {
  try {
    const traders = await CopyTrader.find({ active: true });
    if (!traders.length) return;

    for (const t of traders) {
      const previousRoi = Number(t.roi30d || 0);
      const bias = { diamond: 0.018, gold: 0.009, silver: 0.001, bronze: -0.006 }[t.tier] || 0;
      const delta = bias + (Math.random() - 0.5) * 0.12;
      t.roi30d = round(clamp(previousRoi + delta, -60, 180));
      const targetWin = { diamond: 72, gold: 63, silver: 55, bronze: 47 }[t.tier] || 50;
      t.winRate = round(clamp(Number(t.winRate || targetWin) + (targetWin - Number(t.winRate || targetWin)) * 0.004 + (Math.random() - 0.5) * 0.06, 20, 95));
      if (Math.random() > 0.985) t.totalTrades += 1;
      if (Math.random() > 0.992) t.followers += 1;

      if (!t.performanceHistory || !t.performanceHistory.length) t.performanceHistory = makeHistory(previousRoi);
      const today = new Date(); today.setHours(12, 0, 0, 0);
      const last = t.performanceHistory[t.performanceHistory.length - 1];
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
        if (Math.abs(roiDelta) > 0) rel.pnl = round(Number(rel.pnl || 0) + Number(rel.allocation || 0) * roiDelta / 100);
        rel.lastTraderRoi = t.roi30d;
        await rel.save();
      }
    }

    // Followers are the count of active platform relations plus the trader's seeded audience.
    const relations = await CopyRelation.aggregate([{ $match: { active: true } }, { $group: { _id: '$trader', count: { $sum: 1 } } }]);
    const counts = new Map(relations.map(x => [String(x._id), x.count]));
    for (const t of traders) {
      const real = counts.get(String(t._id)) || 0;
      if (Number(t.followers || 0) < real) { t.followers = real; await t.save(); }
    }
  } catch (e) { console.error('traderSync error:', e.message); }
}

/* Profit-sharing settlement: global platform rate overrides per-trader fallback. */
async function settleFees() {
  try {
    const globalSetting = await Settings.findOne({ key: 'copyPlatformFeePercent' }).lean();
    const globalPlatformFee = globalSetting && Number.isFinite(Number(globalSetting.value)) ? Number(globalSetting.value) : null;
    const relations = await CopyRelation.find({ active: true, pnl: { $gt: 0 } }).populate('trader');
    for (const rel of relations) {
      if (!rel.trader || rel.pnl <= rel.highWaterMark) continue;
      const newProfit = rel.pnl - rel.highWaterMark;
      const traderFee = newProfit * (Number(rel.trader.performanceFee || 0) / 100);
      const platformRate = globalPlatformFee == null ? Number(rel.trader.platformFee || 0) : globalPlatformFee;
      const platformFee = newProfit * (platformRate / 100);
      const follower = await User.findById(rel.follower);
      if (!follower) continue;
      const totalFee = traderFee + platformFee;
      if (Number(follower.balances?.USDT || 0) < totalFee) continue;
      follower.balances.USDT = Number(follower.balances.USDT || 0) - totalFee;
      await follower.save();
      if (rel.trader.user && traderFee > 0) {
        const traderUser = await User.findById(rel.trader.user);
        if (traderUser) { traderUser.balances.USDT = Number(traderUser.balances.USDT || 0) + traderFee; await traderUser.save(); }
      }
      rel.trader.totalEarned = Number(rel.trader.totalEarned || 0) + traderFee;
      await rel.trader.save();
      rel.traderFees = Number(rel.traderFees || 0) + traderFee;
      rel.platformFees = Number(rel.platformFees || 0) + platformFee;
      rel.highWaterMark = rel.pnl;
      rel.lastFeeSettledAt = new Date();
      await rel.save();
      await Transaction.create({ user: follower._id, type: 'earn', currency: 'USDT', amount: -totalFee, status: 'completed', note: `Copy performance fee: ${traderFee.toFixed(4)} to trader, ${platformFee.toFixed(4)} to platform` });
      await notify(follower._id, 'system', 'Performance fee charged', `${totalFee.toFixed(4)} USDT on profit from ${rel.trader.displayName}`).catch(() => {});
    }
  } catch (e) { console.error('settleFees error:', e.message); }
}

let intervalHandle = null;
let feeInterval = null;
function start() {
  if (intervalHandle) return;
  console.log('📈 Trader ROI sync started');
  syncTraders();
  intervalHandle = setInterval(syncTraders, 60_000);
  feeInterval = setInterval(settleFees, 60 * 60 * 1000);
}
function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  if (feeInterval) { clearInterval(feeInterval); feeInterval = null; }
}
module.exports = { start, stop, syncTraders, settleFees };
