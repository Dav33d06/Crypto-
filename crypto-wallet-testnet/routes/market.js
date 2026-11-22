const express = require('express');
const router = express.Router();
const ids = 'bitcoin,ethereum,tether,binancecoin,solana,ripple,usd-coin,dogecoin,cardano,tron';
let marketCache = { at: 0, data: [] };
router.get('/strip', async (req, res) => {
  try {
    if (Date.now() - marketCache.at > 30000 || !marketCache.data.length) {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=10&page=1&sparkline=false`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error('Market data temporarily unavailable');
      const rows = await r.json();
      marketCache = { at: Date.now(), data: rows.map(c => ({ symbol: String(c.symbol).toUpperCase(), name: c.name, price: c.current_price, change24h: c.price_change_percentage_24h })) };
    }
    res.json({ data: marketCache.data, updatedAt: marketCache.at });
  } catch (e) { res.status(503).json({ error: 'Live market strip unavailable' }); }
});
module.exports = router;
