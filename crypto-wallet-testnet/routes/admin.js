const express = require('express');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Stake = require('../models/Stake');
const Settings = require('../models/Settings');
const Referral = require('../models/Referral');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Position = require('../models/Position');
const { addAddressesToWebhook } = require('../utils/alchemyWebhook');
const { auth, adminOnly } = require('../middleware/auth');
const { notify } = require('../middleware/notify');
const router = express.Router();

router.use(auth, adminOnly);

/* ============ STATS ============ */
router.get('/stats', async (req, res) => {
  const [users, pending, completed, activeStakes, pendingKyc, stakedAgg, maintenance] = await Promise.all([
    User.countDocuments(),
    Transaction.countDocuments({ status: 'pending' }),
    Transaction.countDocuments({ status: 'completed' }),
    Stake.countDocuments({ status: 'active' }),
    User.countDocuments({ kycStatus: 'pending' }),
    Stake.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Settings.findOne({ key: 'maintenance' })
  ]);
  res.json({
    users, pending, completed, activeStakes, pendingKyc,
    totalStaked: stakedAgg[0]?.total || 0,
    maintenance: !!maintenance?.value?.active
  });
});

/* ============ USERS ============ */
router.get('/users', async (req, res) => {
  const users = await User.find().select('username email role displayName country balances depositAddresses kycStatus kycDocuments kycSelfie isBanned createdAt').sort({ createdAt: -1 });
  res.json(users);
});

router.put('/users/:id/deposit-addresses', async (req, res) => {
  try {
    const { network, address } = req.body || {};
    const allowed = ['TRC20', 'ERC20', 'BEP20'];
    if (!allowed.includes(network)) return res.status(400).json({ error: 'Unsupported network' });
    const value = String(address || '').trim();
    if (!value) return res.status(400).json({ error: 'Wallet address cannot be empty' });
    const valid = network === 'TRC20'
      ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)
      : /^0x[a-fA-F0-9]{40}$/.test(value);
    if (!valid) return res.status(400).json({ error: `Invalid ${network} address format` });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const previous = user.depositAddresses?.[network] || '';
    if (previous === value) return res.json({ updated: false, depositAddresses: user.depositAddresses });
    const addressMatch = network === 'TRC20' ? value : { $regex: `^${value}$`, $options: 'i' };
    const assignedElsewhere = await User.findOne({ _id: { $ne: user._id }, $or: [
      { [`depositAddresses.${network}`]: addressMatch },
      { depositAddressHistory: { $elemMatch: { network, address: addressMatch } } }
    ] }).select('_id');
    if (assignedElsewhere) return res.status(409).json({ error: 'That address is already assigned to another user on this network' });
    if (previous) user.depositAddressHistory.push({ network, address: previous, changedAt: new Date(), changedBy: req.user._id });
    user.depositAddresses[network] = value;
    await user.save();
    if (network === 'ERC20' || network === 'BEP20') {
      addAddressesToWebhook(network, [value.toLowerCase()]).catch(err => console.warn('Webhook address registration failed:', err.message));
    }
    await Transaction.create({
      user: user._id, type: 'earn', category: 'admin_wallet_address_change', currency: 'USDT', amount: 0,
      status: 'completed', network,
      note: `Admin ${req.user?._id || 'unknown'} changed ${network} deposit address from ${previous || '[empty]'} to ${value}`
    });
    await notify(user._id, 'system', 'Deposit address updated', `Your ${network} deposit address was updated by platform support. Verify the address and network before sending funds.`).catch(() => {});
    res.json({ updated: true, network, depositAddresses: user.depositAddresses });
  } catch (e) { res.status(500).json({ error: 'Unable to update deposit address' }); }
});

router.post('/users/:id/ban', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.isBanned = !user.isBanned;
  user.tokenVersion = (user.tokenVersion || 0) + 1; // force logout
  await user.save();
  res.json({ isBanned: user.isBanned });
});

router.post('/users/:id/balance', async (req, res) => {
  const { currency = 'USDT', amount } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.balances[currency] = (user.balances[currency] || 0) + Number(amount);
  await user.save();
  await notify(user._id, 'system',
    'Balance updated',
    `Admin adjusted your ${currency} balance by ${amount > 0 ? '+' : ''}${amount}.`);
  res.json(user);
});

router.post('/users/:id/kyc', async (req, res) => {
  const { status } = req.body;
  if (!['unverified', 'pending', 'verified'].includes(status))
    return res.status(400).json({ error: 'Invalid KYC status' });
  const user = await User.findByIdAndUpdate(req.params.id, { kycStatus: status }, { new: true }).select('-password');
  await notify(user._id, 'kyc',
    `KYC ${status}`,
    status === 'verified' ? 'Your identity has been verified. Higher withdrawal limits are now active.'
    : status === 'pending' ? 'Your documents are under review.'
    : 'Your verification was rejected. Please resubmit valid documents.');
  res.json(user);
});

/* ============ TRANSACTIONS ============ */
router.get('/transactions', async (req, res) => {
  const txs = await Transaction.find().populate('user', 'username email').sort({ createdAt: -1 });
  res.json(txs);
});

router.post('/transactions/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const { amount, note } = req.body;

    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ error: 'Invalid action' });

    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const user = await User.findById(tx.user);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (action === 'approve') {
      if (tx.type === 'deposit') {
        const received = Number(amount);
        if (!received || received <= 0)
          return res.status(400).json({ error: 'Enter the amount received' });
        tx.amount = received;
        user.balances[tx.currency] = (user.balances[tx.currency] || 0) + received;
        await user.save();

        // Pay referral bonus on first deposit
        if (user.referredBy) {
          const ref = await Referral.findOne({ referee: user._id });
          if (ref && !ref.bonusPaid) {
            const referrer = await User.findById(user.referredBy);
            if (referrer) {
              referrer.balances.USDT += ref.bonus;
              await referrer.save();
              ref.bonusPaid = true;
              await ref.save();
              await notify(referrer._id, 'referral',
                'Referral bonus credited',
                `+${ref.bonus} USDT for your referral ${user.username}'s first deposit.`);
            }
          }
        }

        await notify(user._id, 'deposit',
          'Deposit confirmed',
          `${received} ${tx.currency} has been credited to your wallet.`);
      }

      if (tx.type === 'withdraw') {
        // Funds are already locked; just drain locked
        user.locked[tx.currency] = Math.max(0, (user.locked[tx.currency] || 0) - tx.amount);
        await user.save();
        await notify(user._id, 'withdraw',
          'Withdrawal sent',
          `${tx.amount} ${tx.currency} sent to ${tx.address.slice(0, 10)}…`);
      }

      tx.status = 'completed';
    } else {
      // Reject: release locked funds back to balance
      if (tx.type === 'withdraw') {
        user.locked[tx.currency] = Math.max(0, (user.locked[tx.currency] || 0) - tx.amount);
        user.balances[tx.currency] = (user.balances[tx.currency] || 0) + tx.amount;
        await user.save();
      }
      tx.status = 'rejected';
      if (note) tx.note = `${tx.note ? tx.note + ' · ' : ''}${note}`;
      await notify(user._id, 'withdraw',
        `${tx.type[0].toUpperCase() + tx.type.slice(1)} rejected`,
        note || 'Please contact support for details.');
    }

    tx.updatedAt = Date.now();
    await tx.save();
    res.json(tx);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============ STAKES ============ */
router.get('/stakes', async (req, res) => {
  const stakes = await Stake.find().populate('user', 'username email').sort({ startedAt: -1 });
  res.json(stakes);
});

/* ============ BANNER & MAINTENANCE ============ */
router.post('/banner', async (req, res) => {
  const { message, active } = req.body;
  const s = await Settings.findOneAndUpdate(
    { key: 'banner' },
    { value: { message: message || '', active: !!active } },
    { upsert: true, new: true }
  );
  res.json(s);
});

router.post('/maintenance', async (req, res) => {
  const { active, message } = req.body;
  const s = await Settings.findOneAndUpdate(
    { key: 'maintenance' },
    { value: { active: !!active, message: message || 'We are upgrading. Please check back shortly.' } },
    { upsert: true, new: true }
  );
  res.json(s);
});



/* ============ DATABASE ADMIN TOOLS (READ-ONLY) ============ */
router.get('/database/status', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) return res.status(503).json({ connected: false, state: mongoose.connection.readyState, collections: [] });
    const listed = await db.listCollections({}, { nameOnly: true }).toArray();
    const collections = await Promise.all(listed.map(async item => {
      const collection = db.collection(item.name);
      const count = await collection.countDocuments();
      let indexCount = 0;
      try { indexCount = (await collection.listIndexes().toArray()).length; } catch (_) {}
      return { name: item.name, documents: count, indexes: indexCount };
    }));
    res.json({ connected: true, database: db.databaseName, collections, checkedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: 'Database status check failed' }); }
});

router.get('/database/export', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database is not connected' });
    const listed = await db.listCollections({}, { nameOnly: true }).toArray();
    const snapshot = { kind: 'NovaWallet redacted data snapshot', exportedAt: new Date().toISOString(), database: db.databaseName, collections: {} };
    for (const item of listed) {
      let docs = await db.collection(item.name).find({}).toArray();
      if (item.name === 'users') docs = docs.map(doc => {
        for (const key of ['password','twoFASecret','twoFAPendingSecret','twoFARecoveryCodes','securityQuestions','resetToken','resetTokenExpires','kycDocuments','kycSelfie','loginHistory','lastLogin']) delete doc[key];
        return doc;
      });
      snapshot.collections[item.name] = docs;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="novawallet-data-snapshot-${new Date().toISOString().slice(0,10)}.json"`);
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (e) { res.status(500).json({ error: 'Could not export database snapshot' }); }
});

/* ============ INTERNAL TRADING POSITION MANAGEMENT ============ */
router.get('/positions', async (req, res) => {
  try {
    const positions = await Position.find({ amount: { $gt: 0 } })
      .populate('user', 'username email').sort({ updatedAt: -1 }).lean();
    res.json(positions);
  } catch (e) { res.status(500).json({ error: 'Unable to load open positions' }); }
});

// Admin may close at an explicitly entered simulated execution price. This is
// an internal ledger operation; it does not submit an order to an exchange.
router.post('/positions/:id/close', async (req, res) => {
  const closePrice = Number(req.body.closePrice);
  const reason = String(req.body.reason || 'Admin manual close').trim().slice(0, 240);
  if (!Number.isFinite(closePrice) || closePrice <= 0)
    return res.status(400).json({ error: 'Enter a valid positive close price' });
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const pos = await Position.findOne({ _id: req.params.id, amount: { $gt: 0 } }).session(session);
      if (!pos) throw new Error('Position not found or already closed');
      const user = await User.findById(pos.user).session(session);
      if (!user) throw new Error('Position owner not found');
      const [base, quote] = pos.pair.split('/');
      if (!base || quote !== 'USDT') throw new Error('Only supported USDT-quoted positions can be closed here');
      const amount = Number(pos.amount);
      const proceeds = Number((amount * closePrice).toFixed(8));
      const pnl = Number((amount * (closePrice - pos.avgCost)).toFixed(8));
      if ((user.balances[base] || 0) + 1e-10 < amount)
        throw new Error(`Owner has insufficient ${base} balance to settle this position`);
      user.balances[base] = Number(((user.balances[base] || 0) - amount).toFixed(12));
      user.balances[quote] = Number(((user.balances[quote] || 0) + proceeds).toFixed(8));
      pos.realized = Number(((pos.realized || 0) + pnl).toFixed(8));
      pos.amount = 0; pos.avgCost = 0; pos.stopLoss = 0; pos.takeProfit = 0; pos.updatedAt = new Date();
      await user.save({ session }); await pos.save({ session });
      const [order] = await Order.create([{
        user: user._id, side: 'sell', pair: pos.pair, type: 'market', price: closePrice,
        amount, filled: amount, avgFillPrice: closePrice, status: 'filled', closeReason: reason
      }], { session });
      await Transaction.create([{
        user: user._id, type: 'earn', category: 'admin_trade_close', direction: 'credit', currency: quote,
        amount: proceeds, pair: pos.pair, side: 'sell', quantity: amount, price: closePrice,
        referenceId: String(order._id), status: 'completed',
        note: `${reason}; admin closed ${pos.pair} ${amount} ${base} at ${closePrice} ${quote}; realized PnL ${pnl} ${quote}`
      }], { session });
      result = { positionId: String(pos._id), userId: String(user._id), username: user.username, pair: pos.pair, amount, closePrice, proceeds, pnl, quote };
    });
    if (result) await notify(result.userId, 'system', 'Position closed by platform admin', `${result.pair}: ${result.amount} closed at ${result.closePrice} ${result.quote}. Realized PnL: ${result.pnl} ${result.quote}.`).catch(() => {});
    res.json({ closed: true, ...result });
  } catch (e) {
    res.status(e.message.includes('not found') || e.message.includes('already closed') ? 404 : 400).json({ error: e.message });
  } finally { await session.endSession(); }
});

module.exports = router;