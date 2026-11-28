const CopyRelation = require('../models/CopyRelation');

/* Real allocations from active copies, grouped by trader: Map(traderId -> { count, sum }) */
async function realAllocations() {
  const rows = await CopyRelation.aggregate([
    { $match: { active: true } },
    { $group: { _id: '$trader', count: { $sum: 1 }, sum: { $sum: '$allocation' } } }
  ]);
  return new Map(rows.map(r => [String(r._id), { count: r.count, sum: r.sum }]));
}

const round2 = n => Math.round(Number(n || 0) * 100) / 100;

/* Public trader shape: assets under management = seeded audience AUM + real allocations on the platform. */
function withAum(trader, allocations) {
  const real = allocations.get(String(trader._id)) || { count: 0, sum: 0 };
  const { aumBase, aumSeeded, nextAumAt, totalEarned, user, ...rest } = trader;
  return { ...rest, aum: round2(Number(aumBase || 0) + real.sum) };
}

module.exports = { realAllocations, withAum, round2 };
