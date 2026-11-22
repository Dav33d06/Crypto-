const user = requireAuth(true);

if (user) {
  document.addEventListener('DOMContentLoaded', refreshAll);
}

async function refreshAll() {
  await Promise.all([
    loadStats(),
    loadPending(),
    loadUsers(),
    loadKycQueue(),
    loadStakes(),
    loadAllTxs(),
    loadAdminPositions(),
    loadDatabaseStatus(),
    loadBanner(),
    loadMaintenance()
  ]);
}

/* ============ STATS ============ */
async function loadStats() {
  const el = document.getElementById('stats');
  el.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(3);
  try {
    const s = await api('/api/admin/stats');
    el.innerHTML = `
      <div class="card"><h3>Total Users</h3><div class="balance">${s.users}</div></div>
      <div class="card"><h3>Pending Txs</h3><div class="balance" style="background:linear-gradient(135deg,#fbbf24,#f59e0b);-webkit-background-clip:text;background-clip:text;color:transparent;">${s.pending}</div></div>
      <div class="card"><h3>Pending KYC</h3><div class="balance" style="background:linear-gradient(135deg,#a855f7,#6366f1);-webkit-background-clip:text;background-clip:text;color:transparent;">${s.pendingKyc || 0}</div></div>
      <div class="card"><h3>Total Staked</h3><div class="balance">${(s.totalStaked || 0).toFixed(2)}</div></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ PENDING TXS (inline amount entry) ============ */
async function loadPending() {
  const el = document.getElementById('pending');
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(2);
  try {
    const txs = await api('/api/admin/transactions');
    const pending = txs.filter(t => t.status === 'pending');

    if (!pending.length) {
      el.innerHTML = '<div class="empty">No pending transactions</div>';
      return;
    }

    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead>
          <tr>
            <th>User</th>
            <th>Type</th>
            <th>Currency</th>
            <th>Amount</th>
            <th>Details</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${pending.map(t => {
            const isDeposit = t.type === 'deposit';
            const amountCell = isDeposit
              ? `<input
                   type="number"
                   step="0.01"
                   min="0"
                   class="inline-amount"
                   id="amt-${t._id}"
                   placeholder="0.00"
                 />`
              : `<span class="locked-amount" id="amt-${t._id}" data-value="${t.amount}">
                   ${t.amount.toFixed(2)}
                 </span>`;

            const rejectBox = `
              <input
                type="text"
                class="inline-reason"
                id="reason-${t._id}"
                placeholder="Reject reason (optional)"
                style="display:none; width: 160px; margin: 6px 0 0 0; font-size: 12px; padding: 6px 8px;"
              />`;

            return `
              <tr data-txid="${t._id}">
                <td>${t.user?.username || '-'}</td>
                <td style="text-transform: capitalize;">${t.type}</td>
                <td>${t.currency}</td>
                <td>
                  ${amountCell}
                  ${rejectBox}
                </td>
                <td class="tag">${t.address || t.note || '-'}</td>
                <td>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <button class="sm" title="Approve"
                      onclick="approveTx('${t._id}','${t.type}')">✓ Approve</button>
                    <button class="danger sm" title="Reject"
                      onclick="toggleReject('${t._id}')">✕ Reject</button>
                    <button class="danger sm" id="confirm-reject-${t._id}"
                      style="display:none;"
                      onclick="confirmReject('${t._id}')">Confirm</button>
                  </div>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ APPROVE / REJECT ============ */
window.approveTx = async (id, type) => {
  try {
    const payload = {};

    if (type === 'deposit') {
      const input = document.getElementById(`amt-${id}`);
      const amt = Number(input.value);
      if (!amt || amt <= 0) {
        input.style.borderColor = 'var(--danger)';
        input.style.boxShadow = '0 0 0 4px rgba(239,68,68,.12)';
        input.focus();
        toast('Enter the amount received before approving', 'warn');
        return;
      }
      payload.amount = amt;
    }

    await api(`/api/admin/transactions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    toast('Transaction approved', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

window.toggleReject = (id) => {
  const reasonInput = document.getElementById(`reason-${id}`);
  const confirmBtn = document.getElementById(`confirm-reject-${id}`);
  const visible = reasonInput.style.display === 'block';
  reasonInput.style.display = visible ? 'none' : 'block';
  confirmBtn.style.display = visible ? 'none' : 'inline-flex';
  if (!visible) reasonInput.focus();
};

window.confirmReject = async (id) => {
  try {
    const reason = document.getElementById(`reason-${id}`).value.trim();
    const payload = {};
    if (reason) payload.note = `Rejected: ${reason}`;

    await api(`/api/admin/transactions/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    toast('Transaction rejected', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ USERS ============ */
async function loadUsers() {
  const el = document.getElementById('users');
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(3);
  try {
    const users = await api('/api/admin/users');
    window.adminUsersById = Object.fromEntries(users.map(u => [u._id, u]));
    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Username</th><th>Email</th><th>USDT</th><th>Role</th><th>KYC</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${users.map(u => `
          <tr>
            <td>${u.username}</td>
            <td class="tag">${u.email}</td>
            <td style="font-weight: 600;">${u.balances.USDT.toFixed(2)}</td>
            <td>${u.role}</td>
            <td><span class="badge ${
              u.kycStatus === 'verified' ? 'completed'
              : u.kycStatus === 'pending' ? 'pending'
              : 'rejected'
            }">${u.kycStatus}</span></td>
            <td>${u.isBanned ? '<span class="badge rejected">banned</span>' : '<span class="badge completed">active</span>'}</td>
            <td style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="secondary sm" onclick="credit('${u._id}')">+10 USDT</button>
              <button class="secondary sm" onclick="kyc('${u._id}')">Set KYC</button>
              <button class="secondary sm" onclick="editDepositAddresses('${u._id}')">Deposit Addresses</button>
              <button class="${u.isBanned ? 'secondary' : 'danger'} sm" onclick="ban('${u._id}')">${u.isBanned ? 'Unban' : 'Ban'}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ KYC QUEUE ============ */
async function loadKycQueue() {
  const el = document.getElementById('kyc-queue');
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(2);
  try {
    const users = await api('/api/admin/users');
    const pending = users.filter(u => u.kycStatus === 'pending');
    if (!pending.length) {
      el.innerHTML = '<div class="empty">No KYC submissions awaiting review</div>';
      return;
    }
    el.innerHTML = pending.map(u => `
      <div class="card" style="margin-bottom: 12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom: 12px;">
          <div>
            <div style="font-weight:700;">${u.username}</div>
            <div class="tag">${u.email}</div>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="sm" onclick="approveKyc('${u._id}')">Verify</button>
            <button class="danger sm" onclick="rejectKyc('${u._id}')">Reject</button>
          </div>
        </div>
        <div class="grid grid-2">
          ${(u.kycDocuments || []).map(d => `
            <div class="doc-card">
              ${d.mimetype.startsWith('image/')
                ? `<a href="${d.url}" target="_blank"><img src="${d.url}" class="doc-thumb" /></a>`
                : `<a href="${d.url}" target="_blank" class="doc-thumb doc-file">📄<div class="tag">${d.filename.split('.').pop().toUpperCase()}</div></a>`}
              <div style="flex:1; min-width:0;">
                <div style="font-size:12px; word-break:break-all;">${d.filename}</div>
                <div class="tag">${(d.size/1024).toFixed(0)} KB</div>
              </div>
            </div>`).join('') || '<div class="empty">No documents</div>'}
        </div>
      </div>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ STAKES ============ */
async function loadStakes() {
  const el = document.getElementById('stakes');
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(3);
  try {
    const stakes = await api('/api/admin/stakes');
    if (!stakes.length) { el.innerHTML = '<div class="empty">No stakes yet</div>'; return; }
    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>APY</th><th>Accrued</th><th>Status</th></tr></thead>
        <tbody>${stakes.map(s => `
          <tr>
            <td>${s.user?.username || '-'}</td>
            <td>${s.plan.toUpperCase()}</td>
            <td style="font-weight: 600;">${s.amount.toFixed(2)}</td>
            <td>${s.apy}%</td>
            <td style="color: var(--accent); font-weight: 600;">+${s.accrued.toFixed(4)}</td>
            <td><span class="badge ${s.status === 'active' ? 'completed' : 'rejected'}">${s.status}</span></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ ALL TRANSACTIONS ============ */
async function loadAllTxs() {
  const el = document.getElementById('alltx');
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(3);
  try {
    const txs = await api('/api/admin/transactions');
    if (!txs.length) { el.innerHTML = '<div class="empty">No transactions</div>'; return; }
    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>User</th><th>Type</th><th>Currency</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${txs.slice(0, 50).map(t => `
          <tr>
            <td>${new Date(t.createdAt).toLocaleString()}</td>
            <td>${t.user?.username || '-'}</td>
            <td style="text-transform: capitalize;">${t.type}</td>
            <td>${t.currency}</td>
            <td style="font-weight: 600;">${t.amount}</td>
            <td><span class="badge ${t.status}">${t.status}</span></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ BANNER ============ */
async function loadBanner() {
  try {
    const s = await api('/api/settings');
    if (s.banner) {
      document.getElementById('banner-msg').value = s.banner.message || '';
      document.getElementById('banner-active').checked = !!s.banner.active;
    }
  } catch {}
}

/* ============ OTHER USER ACTIONS ============ */
window.ban = async (id) => {
  try {
    await api(`/api/admin/users/${id}/ban`, { method: 'POST' });
    toast('User status updated', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ MAINTENANCE MODE ============ */
async function loadMaintenance() {
  try {
    const s = await api('/api/settings');
    const sw = document.getElementById('maintenance-switch');
    const msg = document.getElementById('maintenance-msg');
    if (!sw) return;
    if (s.maintenance) {
      if (s.maintenance.active) sw.classList.add('on');
      msg.value = s.maintenance.message || '';
    }
    sw.onclick = async () => {
      sw.classList.toggle('on');
      await api('/api/admin/maintenance', {
        method: 'POST',
        body: JSON.stringify({
          active: sw.classList.contains('on'),
          message: msg.value || undefined
        })
      });
      toast(`Maintenance ${sw.classList.contains('on') ? 'enabled' : 'disabled'}`, 'success');
    };
  } catch {}
}

window.credit = async (id) => {
  try {
    await api(`/api/admin/users/${id}/balance`, {
      method: 'POST',
      body: JSON.stringify({ currency: 'USDT', amount: 10 })
    });
    toast('+10 USDT credited', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

window.kyc = async (id) => {
  const status = prompt('Set KYC status: unverified / pending / verified', 'verified');
  if (!status) return;
  try {
    await api(`/api/admin/users/${id}/kyc`, { method: 'POST', body: JSON.stringify({ status }) });
    toast('KYC updated', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

window.approveKyc = async (id) => {
  try {
    await api(`/api/admin/users/${id}/kyc`, { method: 'POST', body: JSON.stringify({ status: 'verified' }) });
    toast('User verified', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

window.rejectKyc = async (id) => {
  try {
    await api(`/api/admin/users/${id}/kyc`, { method: 'POST', body: JSON.stringify({ status: 'unverified' }) });
    toast('KYC rejected', 'success');
    refreshAll();
  } catch (e) { toast(e.message, 'error'); }
};

window.saveBanner = async () => {
  const message = document.getElementById('banner-msg').value;
  const active = document.getElementById('banner-active').checked;
  try {
    await api('/api/admin/banner', { method: 'POST', body: JSON.stringify({ message, active }) });
    toast('Banner updated', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ COPY TRADING — SEED DEMO TRADERS ============ */
window.seedCopyTraders = async (force = false) => {
  const resultEl = document.getElementById('seed-copy-result');
  if (resultEl) resultEl.innerHTML = '<p class="tag">Seeding…</p>';
  try {
    const url = force ? '/api/copy/seed?force=true' : '/api/copy/seed';
    const r = await api(url, { method: 'POST' });
    if (resultEl) {
      resultEl.innerHTML = `<p class="success">✅ ${r.message || 'Seeded'} · ${r.count || 0} traders</p>`;
    }
    toast(r.message || 'Seeded', 'success');
    refreshAll();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<p class="error">❌ ${e.message}</p>`;
    toast(e.message, 'error');
  }
};

window.populateCopyTraders = async (count = 100) => {
  const resultEl = document.getElementById('seed-copy-result');
  if (resultEl) resultEl.innerHTML = `<p class="tag">Generating ${count} traders…</p>`;
  try {
    const r = await api(`/api/copy/populate?count=${count}`, { method: 'POST' });
    if (resultEl) {
      resultEl.innerHTML = `<p class="success">✅ ${r.message} · Total in database: ${r.total}</p>`;
    }
    toast(`${r.count} traders generated`, 'success');
    refreshAll();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<p class="error">❌ ${e.message}</p>`;
    toast(e.message, 'error');
  }
};

/* ============ COPY TRADING ACTIVITY ============ */
async function loadCopyStats() {
  const el = document.getElementById('copy-stats');
  if (!el) return;
  el.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(3);
  try {
    const s = await api('/api/copy/admin/stats');
    el.innerHTML = `
      <div class="card"><h3>Active Copies</h3><div class="balance">${s.activeRelations}</div></div>
      <div class="card"><h3>Total Allocated</h3><div class="balance">${s.totalAllocated.toFixed(2)}</div></div>
      <div class="card"><h3>Total Traders</h3><div class="balance">${s.traders}</div></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

async function loadCopyRelations() {
  const el = document.getElementById('copy-relations');
  if (!el) return;
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(3);
  try {
    const rels = await api('/api/copy/admin/relations');
    if (!rels.length) {
      el.innerHTML = '<div class="empty">No copy relations yet</div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Follower</th><th>Trader</th><th>Allocated</th><th>PnL</th>
          <th>Status</th><th>Since</th><th>Actions</th>
        </tr></thead>
        <tbody>${rels.map(r => `
          <tr>
            <td>${r.follower?.username || '-'}<div class="tag">${r.follower?.email || ''}</div></td>
            <td>${r.trader?.displayName || '-'}<div class="tag">${r.trader?.tier || ''}</div></td>
            <td style="font-weight:600;">${r.allocation.toFixed(2)} USDT</td>
            <td style="color: ${r.pnl >= 0 ? 'var(--accent)' : '#fca5a5'}; font-weight:600;">
              ${r.pnl >= 0 ? '+' : ''}${(r.pnl || 0).toFixed(2)}
            </td>
            <td>${r.active
              ? '<span class="badge completed">active</span>'
              : '<span class="badge rejected">stopped</span>'}</td>
            <td class="tag">${new Date(r.createdAt).toLocaleDateString()}</td>
            <td>${r.active
              ? `<button class="danger sm" onclick="stopCopy('${r._id}')">Stop</button>`
              : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

window.stopCopy = async (id) => {
  if (!confirm('Stop this copy relation? Funds return to the user.')) return;
  try {
    await api(`/api/copy/admin/relations/${id}/stop`, { method: 'POST' });
    toast('Relation stopped', 'success');
    await Promise.all([loadCopyStats(), loadCopyRelations()]);
  } catch (e) { toast(e.message, 'error'); }
};

// Hook into refreshAll
const _origRefresh = refreshAll;
refreshAll = async function () {
  await _origRefresh();
  await loadCopyStats();
  await loadCopyRelations();
};

/* ============ COPY TRADING ACTIVITY ============ */
async function loadCopyStats() {
  const el = document.getElementById('copy-stats');
  if (!el) return;
  el.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(3);
  try {
    const s = await api('/api/copy/admin/stats');
    el.innerHTML = `
      <div class="card"><h3>Active Copies</h3><div class="balance">${s.activeRelations}</div></div>
      <div class="card"><h3>Total Allocated</h3><div class="balance">${s.totalAllocated.toFixed(2)}</div></div>
      <div class="card"><h3>Total Traders</h3><div class="balance">${s.traders}</div></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

async function loadCopyRelations() {
  const el = document.getElementById('copy-relations');
  if (!el) return;
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(3);
  try {
    const rels = await api('/api/copy/admin/relations');
    if (!rels.length) {
      el.innerHTML = '<div class="empty">No copy relations yet</div>';
      return;
    }
    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Follower</th><th>Trader</th><th>Allocated</th><th>PnL</th>
          <th>Status</th><th>Since</th><th>Actions</th>
        </tr></thead>
        <tbody>${rels.map(r => `
          <tr>
            <td>${r.follower?.username || '-'}<div class="tag">${r.follower?.email || ''}</div></td>
            <td>${r.trader?.displayName || '-'}<div class="tag">${r.trader?.tier || ''}</div></td>
            <td style="font-weight:600;">${r.allocation.toFixed(2)} USDT</td>
            <td style="color: ${r.pnl >= 0 ? 'var(--accent)' : '#fca5a5'}; font-weight:600;">
              ${r.pnl >= 0 ? '+' : ''}${(r.pnl || 0).toFixed(2)}
            </td>
            <td>${r.active
              ? '<span class="badge completed">active</span>'
              : '<span class="badge rejected">stopped</span>'}</td>
            <td class="tag">${new Date(r.createdAt).toLocaleDateString()}</td>
            <td style="display:flex; gap:4px; flex-wrap:wrap;">
  ${r.active
    ? `<button class="danger sm" onclick="stopCopy('${r._id}')">Stop</button>`
    : ''}
  <button class="secondary sm" onclick="openAdjustPnl('${r._id}', ${r.pnl || 0}, '${r.trader?.displayName || ''}')">
    PnL
  </button>
  ${r.trader
    ? `<button class="secondary sm" onclick="openAdjustFees('${r.trader._id}', ${r.trader.performanceFee || 10}, ${r.trader.platformFee || 2}, '${r.trader.displayName}')">
         Fees
       </button>`
    : ''}
</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch (e) { toast(e.message, 'error'); }
}

window.stopCopy = async (id) => {
  if (!confirm('Stop this copy relation? Funds return to the user.')) return;
  try {
    await api(`/api/copy/admin/relations/${id}/stop`, { method: 'POST' });
    toast('Relation stopped', 'success');
    await Promise.all([loadCopyStats(), loadCopyRelations()]);
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ PROFIT SHARING STATS ============ */
async function loadFeeStats() {
  const el = document.getElementById('fee-stats');
  const topEl = document.getElementById('fee-top');
  if (!el) return;
  el.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(2);
  try {
    const f = await api('/api/copy/admin/fees');
    el.innerHTML = `
      <div class="card"><h3>Platform Fees Collected</h3><div class="balance">${f.totalPlatformFees.toFixed(2)}</div></div>
      <div class="card"><h3>Paid to Traders</h3><div class="balance">${f.totalTraderFees.toFixed(2)}</div></div>`;

    if (topEl) {
      topEl.innerHTML = f.topTraders.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Trader</th><th>Tier</th><th>Followers</th><th>Total Earned</th></tr></thead>
          <tbody>${f.topTraders.map(t => `
            <tr>
              <td style="font-weight:600;">${t.displayName}</td>
              <td>${t.tier}</td>
              <td>${t.followers}</td>
              <td style="color:var(--accent); font-weight:600;">${t.totalEarned.toFixed(2)} USDT</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty">No fees collected yet</div>';
    }
  } catch (e) { toast(e.message, 'error'); }
}

/* ============ LEADERBOARD SNAPSHOT ============ */
window.snapshotLeaderboard = async () => {
  try {
    const r = await api('/api/leaderboard/snapshot', { method: 'POST' });
    toast(r.message || 'Leaderboard snapshotted', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ SEED & POPULATE ============ */
window.seedCopyTraders = async (force = false) => {
  const resultEl = document.getElementById('seed-copy-result');
  if (resultEl) resultEl.innerHTML = '<p class="tag">Seeding…</p>';
  try {
    const url = force ? '/api/copy/seed?force=true' : '/api/copy/seed';
    const r = await api(url, { method: 'POST' });
    if (resultEl) {
      resultEl.innerHTML = `<p class="success">✅ ${r.message || 'Seeded'} · ${r.count || 0} traders</p>`;
    }
    toast(r.message || 'Seeded', 'success');
    refreshAll();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<p class="error">❌ ${e.message}</p>`;
    toast(e.message, 'error');
  }
};

window.populateCopyTraders = async (count = 100) => {
  const resultEl = document.getElementById('seed-copy-result');
  if (resultEl) resultEl.innerHTML = `<p class="tag">Generating ${count} traders…</p>`;
  try {
    const r = await api(`/api/copy/populate?count=${count}`, { method: 'POST' });
    if (resultEl) {
      resultEl.innerHTML = `<p class="success">✅ ${r.message} · Total in database: ${r.total}</p>`;
    }
    toast(`${r.count} traders generated`, 'success');
    refreshAll();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<p class="error">❌ ${e.message}</p>`;
    toast(e.message, 'error');
  }
};

/* ============ HOOK INTO refreshAll ============ */
const _origRefreshAll = refreshAll;
refreshAll = async function () {
  await _origRefreshAll();
  await Promise.all([loadCopyStats(), loadCopyRelations(), loadFeeStats()]);
};

window.openAdjustPnl = (relationId, currentPnl, traderName) => {
  document.getElementById('adjust-pnl-body').innerHTML = `
    <p class="tag" style="margin-bottom: 14px;">
      Adjust PnL for the copy of <b>${traderName}</b>. Positive = profit, negative = loss.
    </p>
    <div style="padding: 12px; background: rgba(148,163,184,.06); border-radius: 10px; margin-bottom: 14px;">
      <div style="display:flex; justify-content:space-between;">
        <span class="tag">Current PnL</span>
        <b style="color: ${currentPnl >= 0 ? 'var(--accent)' : '#fca5a5'};">
          ${currentPnl >= 0 ? '+' : ''}${currentPnl.toFixed(2)} USDT
        </b>
      </div>
    </div>
    <label>Amount to add (USDT)</label>
    <input id="adjust-amount" type="number" step="0.01" placeholder="50 or -25" />
    <label>Reason</label>
    <input id="adjust-reason" placeholder="Manual correction" />
    <button style="width:100%" onclick="confirmAdjustPnl('${relationId}')">Apply Adjustment</button>
  `;
  openModal('adjust-pnl-modal');
};

window.confirmAdjustPnl = async (id) => {
  const amount = Number(document.getElementById('adjust-amount').value);
  const reason = document.getElementById('adjust-reason').value;
  if (!amount) return toast('Enter an amount', 'warn');
  try {
    await api(`/api/copy/admin/relations/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify({ amount, reason })
    });
    closeModal('adjust-pnl-modal');
    toast('PnL adjusted', 'success');
    await Promise.all([loadCopyStats(), loadCopyRelations()]);
  } catch (e) { toast(e.message, 'error'); }
};

window.openAdjustFees = async (traderId, currentPerf, currentPlat, traderName) => {
  document.getElementById('adjust-fees-body').innerHTML = `
    <p class="tag" style="margin-bottom: 14px;">
      Set profit-sharing fees for <b>${traderName}</b>.
    </p>
    <label>Performance Fee (%)</label>
    <input id="perf-fee" type="number" min="0" max="50" value="${currentPerf}" />
    <p class="tag" style="margin-top: -6px; margin-bottom: 14px;">% of follower's profit paid to trader (0–50)</p>

    <label>Platform Fee (%)</label>
    <input id="plat-fee" type="number" min="0" max="20" value="${currentPlat}" />
    <p class="tag" style="margin-top: -6px; margin-bottom: 14px;">% of follower's profit paid to platform (0–20)</p>

    <button style="width:100%" onclick="confirmAdjustFees('${traderId}')">Save Fees</button>
  `;
  openModal('adjust-fees-modal');
};

window.confirmAdjustFees = async (traderId) => {
  const performanceFee = Number(document.getElementById('perf-fee').value);
  const platformFee = Number(document.getElementById('plat-fee').value);
  try {
    await api(`/api/copy/admin/traders/${traderId}/fees`, {
      method: 'POST',
      body: JSON.stringify({ performanceFee, platformFee })
    });
    closeModal('adjust-fees-modal');
    toast('Fees updated', 'success');
    await Promise.all([loadCopyStats(), loadCopyRelations()]);
  } catch (e) { toast(e.message, 'error'); }
};

/* ============ ADMIN CLOSE INDIVIDUAL INTERNAL POSITIONS ============ */
async function loadAdminPositions() {
  const el = document.getElementById('admin-positions');
  if (!el) return;
  el.innerHTML = '<div class="skeleton skeleton-row"></div>'.repeat(2);
  try {
    const positions = await api('/api/admin/positions');
    if (!positions.length) { el.innerHTML = '<div class="empty">No open positions.</div>'; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>User</th><th>Pair</th><th>Quantity</th><th>Average entry</th><th>Stop loss</th><th>Take profit</th><th>Close price (USDT)</th><th>Action</th></tr></thead><tbody>${positions.map(p => `
      <tr>
        <td>${escapeAdminText(p.user?.username || 'Unknown')}</td>
        <td>${escapeAdminText(p.pair)}</td>
        <td>${Number(p.amount).toPrecision(8)}</td>
        <td>${Number(p.avgCost).toPrecision(8)}</td>
        <td>${Number(p.stopLoss || 0) || '—'}</td>
        <td>${Number(p.takeProfit || 0) || '—'}</td>
        <td><input id="admin-close-price-${p._id}" type="number" min="0.00000001" step="any" placeholder="Execution price" style="min-width:125px;margin:0" /></td>
        <td><button class="danger sm" onclick="adminClosePosition('${p._id}','${String(p.pair).replace(/'/g, '')}')">Close position</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  } catch (e) { el.innerHTML = `<div class="empty">${escapeAdminText(e.message)}</div>`; }
}
function escapeAdminText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
window.adminClosePosition = async (id, pair) => {
  const input = document.getElementById(`admin-close-price-${id}`);
  const closePrice = Number(input?.value);
  if (!Number.isFinite(closePrice) || closePrice <= 0) return toast('Enter a valid close price', 'warn');
  if (!confirm(`Close ${pair} at ${closePrice} USDT? This changes the user's internal wallet balance and realizes profit or loss.`)) return;
  try {
    const result = await api(`/api/admin/positions/${id}/close`, { method: 'POST', body: JSON.stringify({ closePrice, reason: 'Admin manual close' }) });
    toast(`Position closed. Realized PnL: ${Number(result.pnl).toFixed(4)} ${result.quote}`, 'success');
    await Promise.all([loadAdminPositions(), loadAllTxs(), loadStats()]);
  } catch (e) { toast(e.message, 'error'); }
};


/* ============ DATABASE ADMIN TOOLS ============ */
async function loadDatabaseStatus() {
  const status = document.getElementById('database-status');
  const list = document.getElementById('database-collections');
  if (!status || !list) return;
  status.textContent = 'Checking database connection…';
  try {
    const data = await api('/api/admin/database/status');
    if (!data.connected) { status.textContent = 'Database is not connected.'; list.innerHTML = ''; return; }
    status.textContent = `Connected to ${data.database} · checked ${new Date(data.checkedAt).toLocaleString()}`;
    list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Collection</th><th>Documents</th><th>Indexes</th></tr></thead><tbody>${data.collections.map(c => `<tr><td>${escapeAdminText(c.name)}</td><td>${Number(c.documents).toLocaleString()}</td><td>${Number(c.indexes)}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { status.textContent = e.message; list.innerHTML = ''; }
}

async function exportDatabaseSnapshot() {
  try {
    const response = await fetch('/api/admin/database/export', { headers: { Authorization: `Bearer ${token()}` } });
    if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || 'Snapshot export failed'); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `novawallet-data-snapshot-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast('Redacted data snapshot exported', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function escapeAdminText(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

/* ============ USER DEPOSIT ADDRESS EDITOR ============ */
function editDepositAddresses(id) {
  const user = window.adminUsersById?.[id];
  if (!user) return toast('User details not loaded. Refresh the user list.', 'error');
  const addresses = user.depositAddresses || {};
  document.getElementById('deposit-address-user-id').value = id;
  document.getElementById('deposit-address-user').textContent = `Editing ${user.username}`;
  document.getElementById('deposit-address-trc20').value = addresses.TRC20 || '';
  document.getElementById('deposit-address-erc20').value = addresses.ERC20 || '';
  document.getElementById('deposit-address-bep20').value = addresses.BEP20 || '';
  openModal('deposit-address-modal');
}

async function saveDepositAddresses() {
  const id = document.getElementById('deposit-address-user-id').value;
  const changes = [
    ['TRC20', document.getElementById('deposit-address-trc20').value.trim()],
    ['ERC20', document.getElementById('deposit-address-erc20').value.trim()],
    ['BEP20', document.getElementById('deposit-address-bep20').value.trim()]
  ];
  try {
    for (const [network, address] of changes) {
      if (!address) continue;
      await api(`/api/admin/users/${id}/deposit-addresses`, { method: 'PUT', body: JSON.stringify({ network, address }) });
    }
    closeModal('deposit-address-modal');
    toast('Deposit addresses updated', 'success');
    await loadUsers();
  } catch (e) { toast(e.message, 'error'); }
}
