/* Earn → Become a trader */
(function () {
  if (!localStorage.getItem('token')) return;

  const root = () => document.getElementById('trader-root');
  const STRATEGIES = [['swing', 'Swing trading'], ['scalping', 'Scalping'], ['long-term', 'Long-term'], ['mixed', 'Mixed']];
  const EXPERIENCE = [['<1', 'Less than 1 year'], ['1-3', '1–3 years'], ['3-5', '3–5 years'], ['5+', 'More than 5 years']];
  let state = null;
  let loaded = false;

  const money = n => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = n => { n = Number(n || 0); return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0); };

  document.addEventListener('DOMContentLoaded', () => { if (location.hash === '#trader') load(); });
  document.addEventListener('tabshown', e => { if (e.detail.tab === 'trader' && !loaded) load(); });

  async function load() {
    loaded = true;
    const el = root(); if (!el) return;
    if (!state) el.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
    try { state = await api('/api/copy/trader/status'); render(); }
    catch (e) { loaded = false; el.innerHTML = emptyState('⚠️', 'Could not load this page', e.message || 'Please try again.'); }
  }

  const intro = () => `
    <div class="card">
      <h3>Become a trader</h3>
      <p class="tag" style="margin-bottom:14px;">Share your strategy and earn a performance fee on the profits of people who copy you.</p>
      <div class="grid grid-3">
        <div><b>1. Apply</b><div class="tag">Tell us about your trading style and set your performance fee.</div></div>
        <div><b>2. Get reviewed</b><div class="tag">Our team reviews every application and notifies you of the decision.</div></div>
        <div><b>3. Earn</b><div class="tag">Once approved, your results are public and you earn fees on follower profits.</div></div>
      </div>
    </div>`;

  function render() {
    const el = root(); if (!el) return;
    if (state.trader) return (el.innerHTML = dashboard(state.trader));
    const app = state.application;
    let html = intro();
    if (app && app.status === 'pending') {
      html += `<div class="card"><h3>Application under review</h3>
        <div class="row"><div class="row-label">Trader name</div><div class="row-sub">${escHtml(app.displayName)}</div></div>
        <div class="row"><div class="row-label">Performance fee</div><div class="row-sub">${app.performanceFee}%</div></div>
        <div class="row"><div class="row-label">Submitted</div><div class="row-sub">${new Date(app.createdAt).toLocaleString()}</div></div>
        <p class="tag" style="margin-top:12px;">You will be notified as soon as a decision is made.</p></div>`;
    } else {
      if (app && app.status === 'rejected') {
        html += `<div class="card" style="border-color:rgba(248,113,113,.4);"><h3>Your last application was not approved</h3>
          <p class="tag">${app.adminNote ? 'Reason: ' + escHtml(app.adminNote) : 'You can improve your details and apply again.'}</p></div>`;
      }
      html += requirements() + form();
    }
    el.innerHTML = html;
    bindForm();
  }

  function requirements() {
    const r = state.requirements;
    const row = (ok, title, sub, href, cta) => `
      <div class="set-row"><div><b>${ok ? '✅' : '⚠️'} ${title}</b><div class="tag">${sub}</div></div>
      ${ok ? '<span class="badge completed">Done</span>' : `<a class="btn sm" href="${href}">${cta}</a>`}</div>`;
    return `<div class="card"><h3>Requirements</h3>
      ${row(r.kyc, 'Verified identity', r.kyc ? 'Your identity is verified.' : r.kycStatus === 'pending' ? 'Your documents are under review.' : 'Traders must complete identity verification.', '/profile.html#verification', 'Verify identity')}
      ${row(r.twoFA, 'Two-factor authentication', r.twoFA ? 'Enabled on your account.' : 'Required to protect your trader account and fee payouts.', '/profile.html#security', 'Enable 2FA')}
    </div>`;
  }

  function form() {
    const L = state.limits, disabled = state.eligible ? '' : 'disabled';
    const platform = state.platformFeePercent;
    return `<div class="card"><h3>Application</h3>
      <fieldset ${disabled} style="border:0;padding:0;margin:0;${state.eligible ? '' : 'opacity:.55;'}">
        <label>Trader name</label>
        <input id="tr-name" maxlength="${L.nameMax}" placeholder="e.g. Atlas Capital" />
        <label>About your strategy</label>
        <textarea id="tr-bio" rows="4" maxlength="${L.bioMax}" placeholder="Describe how you trade: markets, entries and exits, risk management."></textarea>
        <div class="tag" id="tr-bio-count" style="margin:-6px 0 12px;">0 / ${L.bioMax}</div>
        <div class="grid grid-2">
          <div><label>Trading style</label><select id="tr-strategy">${STRATEGIES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>
          <div><label>Experience</label><select id="tr-exp">${EXPERIENCE.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>
        </div>
        <label>Main markets (optional)</label>
        <input id="tr-markets" maxlength="80" placeholder="e.g. BTC/USDT, ETH/USDT" />
        <label>Performance fee: <b id="tr-fee-val">10</b>%</label>
        <input id="tr-fee" type="range" min="${L.minFee}" max="${L.maxFee}" step="1" value="10" />
        <p class="tag" id="tr-fee-note" style="margin-bottom:14px;"></p>
        <label style="display:flex;gap:10px;align-items:flex-start;font-weight:400;">
          <input id="tr-agree" type="checkbox" style="width:auto;margin-top:3px;" />
          <span>I agree to the <a href="/terms.html" target="_blank" style="color:var(--accent);">Terms of Service</a> and <a href="/risk.html" target="_blank" style="color:var(--accent);">Risk Disclosure</a>, and understand that my results will be shown publicly.</span>
        </label>
        <button id="tr-submit" style="width:100%;margin-top:14px;">Submit application</button>
      </fieldset>
      ${state.eligible ? '' : '<p class="tag" style="margin-top:10px;">Complete the requirements above to apply.</p>'}
    </div>`;
  }

  function bindForm() {
    const fee = document.getElementById('tr-fee'); if (!fee) return;
    const platform = state.platformFeePercent;
    const upd = () => {
      document.getElementById('tr-fee-val').textContent = fee.value;
      document.getElementById('tr-fee-note').textContent = `Followers pay you ${fee.value}% of their profits` + (platform != null ? `, plus a ${platform}% platform fee that goes to NovaWallet.` : '. A platform fee also applies.');
    };
    fee.addEventListener('input', upd); upd();
    const bio = document.getElementById('tr-bio'), cnt = document.getElementById('tr-bio-count');
    bio.addEventListener('input', () => { cnt.textContent = `${bio.value.length} / ${state.limits.bioMax}`; });
    document.getElementById('tr-submit').addEventListener('click', submit);
  }

  async function submit() {
    const body = {
      displayName: document.getElementById('tr-name').value.trim(),
      bio: document.getElementById('tr-bio').value.trim(),
      strategy: document.getElementById('tr-strategy').value,
      experience: document.getElementById('tr-exp').value,
      markets: document.getElementById('tr-markets').value.trim(),
      performanceFee: Number(document.getElementById('tr-fee').value),
      agree: document.getElementById('tr-agree').checked
    };
    const L = state.limits;
    if (body.displayName.length < L.nameMin) return toast(`Trader name must be at least ${L.nameMin} characters`, 'warn');
    if (body.bio.length < L.bioMin) return toast(`Describe your strategy in at least ${L.bioMin} characters`, 'warn');
    if (!body.agree) return toast('Please accept the terms to continue', 'warn');
    const ok = await confirmAction({
      title: 'Submit application?',
      message: 'Our team will review it and notify you of the decision.',
      details: [['Trader name', body.displayName], ['Style', STRATEGIES.find(s => s[0] === body.strategy)[1]], ['Performance fee', `${body.performanceFee}%`]],
      confirmText: 'Submit application'
    });
    if (!ok) return;
    await withBusy(document.getElementById('tr-submit'), 'Submitting…', async () => {
      try {
        await api('/api/copy/trader/apply', { method: 'POST', body: JSON.stringify(body) });
        toast('Application submitted', 'success');
        state = null; await load();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function dashboard(t) {
    const stat = (label, value, cls = '') => `<div class="card"><h3>${label}</h3><div class="balance ${cls}" style="font-size:22px;">${value}</div></div>`;
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div><h3 style="margin:0;">${escHtml(t.displayName)}</h3><div class="tag">${escHtml(t.tier)} tier · ${t.active ? 'Live' : 'Paused'}</div></div>
          <button class="secondary sm" onclick="openTraderProfile('${t._id}')">View public profile</button>
        </div>
      </div>
      <div class="grid grid-3">
        ${stat('Followers', Number(t.followers || 0).toLocaleString())}
        ${stat('AUM', `${compact(t.aum)} USDT`)}
        ${stat('Fees earned', `${money(t.totalEarned)} USDT`, 'positive')}
        ${stat('30d ROI', `${Number(t.roi30d || 0) >= 0 ? '+' : ''}${Number(t.roi30d || 0).toFixed(2)}%`, Number(t.roi30d || 0) >= 0 ? 'positive' : 'negative')}
        ${stat('Win rate', `${Number(t.winRate || 0).toFixed(1)}%`)}
        ${stat('Performance fee', `${t.performanceFee}%`)}
      </div>
      <div class="card">
        <h3>Your public description</h3>
        <textarea id="tr-edit-bio" rows="4" maxlength="${state.limits.bioMax}">${escHtml(t.bio)}</textarea>
        <button id="tr-save-bio" onclick="saveTraderBio()">Save description</button>
        <p class="tag" style="margin-top:12px;">Your performance is calculated from your closed trades on NovaWallet. To change your performance fee, contact support.</p>
      </div>`;
  }

  window.saveTraderBio = async () => {
    const bio = document.getElementById('tr-edit-bio').value.trim();
    if (bio.length < state.limits.bioMin) return toast(`Description must be at least ${state.limits.bioMin} characters`, 'warn');
    await withBusy(document.getElementById('tr-save-bio'), 'Saving…', async () => {
      try { await api('/api/copy/trader/profile', { method: 'PUT', body: JSON.stringify({ bio }) }); toast('Description updated', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    });
  };
})();
