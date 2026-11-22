const express = require('express');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { checkWithdrawLimit } = require('../middleware/limits');
const { notify } = require('../middleware/notify');
const { deriveAddress } = require('../utils/hdwallet');
const { addAddressesToWebhook } = require('../utils/alchemyWebhook');
const router = express.Router();

const SUPPORTED_NETWORKS = ['TRC20', 'ERC20', 'BEP20'];

/* Assign the next available address index, then derive addresses */
async function ensureAllAddresses(user) {
  // Assign unique index if new user
  if (user.depositAddressIndex == null) {
    const lastUser = await User.findOne({ depositAddressIndex: { $ne: null } })
      .sort({ depositAddressIndex: -1 });
    user.depositAddressIndex = (lastUser?.depositAddressIndex ?? -1) + 1;
  }

  const SUPPORTED_NETWORKS = ['TRC20', 'ERC20', 'BEP20'];
  const newAddresses = { ERC20: [], BEP20: [] };

  if (!user.depositAddresses) user.depositAddresses = {};

  for (const network of SUPPORTED_NETWORKS) {
    if (!user.depositAddresses[network]) {
      try {
        user.depositAddresses[network] = deriveAddress(network, user.depositAddressIndex);
        if (network === 'ERC20' || network === 'BEP20') {
          newAddresses[network].push(user.depositAddresses[network].toLowerCase());
        }
      } catch (e) {
        console.warn(`Could not derive ${network} address for ${user.username}:`, e.message);
      }
    }
  }

  await user.save();

  // Register new EVM addresses with Alchemy webhooks (non-blocking)
  if (newAddresses.ERC20.length) {
    addAddressesToWebhook('ERC20', newAddresses.ERC20).catch(() => {});
  }
  if (newAddresses.BEP20.length) {
    addAddressesToWebhook('BEP20', newAddresses.BEP20).catch(() => {});
  }

  return user;
}

/* GET balance + all deposit addresses */
router.get('/balance', auth, async (req, res) => {
  let user = await User.findById(req.user._id);
  user = await ensureAllAddresses(user);
  res.json({
    balances: user.balances,
    locked: user.locked,
    depositAddresses: user.depositAddresses
  });
});

/* GET limits */
router.get('/limits', auth, async (req, res) => {
  const user = await User.findById(req.user._id);
  const { LIMITS } = require('../middleware/limits');
  const limit = LIMITS[user.kycStatus] ?? 100;
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const txs = await Transaction.find({
    user: user._id, type: 'withdraw',
    status: { $in: ['pending', 'completed'] },
    createdAt: { $gte: since }
  });
  const used = txs.reduce((s, t) => s + t.amount, 0);
  res.json({
    kycStatus: user.kycStatus,
    limit: limit === Infinity ? null : limit,
    used,
    remaining: limit === Infinity ? null : Math.max(0, limit - used)
  });
});

router.get('/transactions', auth, async (req, res) => {
  const txs = await Transaction.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json(txs);
});

router.get('/transactions/:id', auth, async (req, res) => {
  const tx = await Transaction.findOne({ _id: req.params.id, user: req.user._id });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  res.json(tx);
});

/* Manual deposit fallback — creates a pending deposit for admin review */
router.post('/deposit', auth, async (req, res) => {
  try {
    const { currency = 'USDT', network = 'TRC20', note = '' } = req.body;

    const SUPPORTED = {
      TRC20: ['USDT'],
      ERC20: ['USDT', 'ETH'],
      BEP20: ['USDT', 'BNB']
    };
    if (!SUPPORTED[network]?.includes(currency)) {
      return res.status(400).json({ error: `Unsupported asset/network combination` });
    }

    const requiredConfs = {
      TRC20: 19, ERC20: 12, BEP20: 15
    }[network];

    const user = await User.findById(req.user._id);

    // Prevent spamming — limit 1 pending manual deposit per (currency, network) per 10 min
    const recent = await Transaction.findOne({
      user: user._id,
      type: 'deposit',
      currency,
      network,
      status: 'pending',
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
    });
    if (recent) {
      return res.status(429).json({
        error: 'A pending deposit request for this asset already exists. Please wait for review.'
      });
    }

    const tx = await Transaction.create({
      user: user._id,
      type: 'deposit',
      currency,
      amount: 0,
      status: 'pending',
      confirmations: 0,
      requiredConfirmations: requiredConfs,
      network,
      note: `Manual deposit request — ${currency} via ${network}${note ? ' · ' + note : ''}`,
      address: user.depositAddresses?.[network] || ''
    });

    await notify(
      user._id,
      'deposit',
      'Deposit request submitted',
      `We will verify your ${currency} ${network} deposit shortly.`
    );

    res.json(tx);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Withdraw — user specifies amount + address + currency */
router.post('/withdraw', auth, async (req, res) => {
  const amount = Number(req.body.amount);
  const currency = String(req.body.currency || 'USDT').toUpperCase();
  const network = String(req.body.network || '').toUpperCase();
  const address = String(req.body.address || '').trim();
  const note = String(req.body.note || '').slice(0, 500);
  const code = String(req.body.code || '').replace(/\s/g, '');
  const fees = {
    TRC20: { USDT: { fee: 1, min: 10 } },
    ERC20: { USDT: { fee: 8, min: 20 }, ETH: { fee: 0.003, min: 0.005 } },
    BEP20: { USDT: { fee: 0.5, min: 5 }, BNB: { fee: 0.001, min: 0.05 } }
  };
  const rule = fees[network]?.[currency];
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return res.status(400).json({ error: 'Enter a valid withdrawal amount' });
  if (!rule) return res.status(400).json({ error: 'Unsupported asset/network combination' });
  if (amount < rule.min) return res.status(400).json({ error: `Minimum withdrawal is ${rule.min} ${currency}` });
  if (amount <= rule.fee) return res.status(400).json({ error: `Amount must exceed the ${rule.fee} ${currency} network fee` });
  if (!address || address.length < 10 || address.length > 200) return res.status(400).json({ error: 'Invalid destination address' });
  if (network === 'TRC20' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return res.status(400).json({ error: 'Invalid TRC20 address format' });
  if (['ERC20','BEP20'].includes(network) && !/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: `Invalid ${network} address format` });

  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let recoveryCode = false;
  if (user.twoFA) {
    if (!code) return res.status(400).json({ error: '2FA code required' });
    const { verifyTOTP } = require('../utils/totp');
    const isTotp = verifyTOTP(code, user.twoFASecret);
    recoveryCode = (user.twoFARecoveryCodes || []).includes(code.toUpperCase());
    if (!isTotp && !recoveryCode) return res.status(400).json({ error: 'Invalid 2FA code' });
  }
  if (currency === 'USDT') {
    const check = await checkWithdrawLimit(user, amount);
    if (!check.ok) return res.status(400).json({ error: check.message });
  }

  const session = await mongoose.startSession();
  let tx;
  try {
    await session.withTransaction(async () => {
      const fresh = await User.findById(req.user._id).session(session);
      if (!fresh) throw new Error('User not found');
      if ((fresh.balances?.[currency] || 0) + 1e-8 < amount) throw new Error(`Insufficient ${currency} balance`);
      if (fresh.twoFA && recoveryCode) {
        const codes = fresh.twoFARecoveryCodes || [];
        const idx = codes.indexOf(code.toUpperCase());
        if (idx < 0) throw new Error('Recovery code has already been used');
        codes.splice(idx, 1); fresh.twoFARecoveryCodes = codes;
      }
      fresh.set(`balances.${currency}`, Number((fresh.balances[currency] - amount).toFixed(12)));
      fresh.set(`locked.${currency}`, Number(((fresh.locked?.[currency] || 0) + amount).toFixed(12)));
      await fresh.save({ session });
      const created = await Transaction.create([{
        user: fresh._id, type: 'withdraw', currency, amount, fee: rule.fee,
        netAmount: Number((amount - rule.fee).toFixed(12)), address, network, note,
        status: 'pending'
      }], { session });
      tx = created[0].toObject();
    });
    await notify(req.user._id, 'withdraw', 'Withdrawal requested', `${amount} ${currency} (${amount - rule.fee} after fee) to ${address.slice(0, 10)}… is awaiting review.`).catch(() => {});
    res.status(201).json(tx);
  } catch (e) { res.status(/Insufficient|already been used/.test(e.message) ? 400 : 500).json({ error: e.message }); }
  finally { await session.endSession(); }
});

module.exports = router;