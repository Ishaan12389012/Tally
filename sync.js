// Login + cloud sync for Tally (Supabase).
// The app stays offline-first: every change is saved on the device straight away,
// queued here, and pushed to the database when there is a connection.
(() => {
  'use strict';
  const cfg = window.LEDGER_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase || !window.Ledger) return;

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const $ = s => document.querySelector(s);
  const META = 'pocket-ledger-sync';
  const fresh = () => ({ userId: null, dirty: {}, deleted: {}, settings: 0, lastPulled: null, settingsAt: null, firstLink: false, skipped: false, lastSync: 0 });
  let meta = (() => { try { return { ...fresh(), ...JSON.parse(localStorage.getItem(META) || '{}') }; } catch (e) { return fresh(); } })();
  const saveMeta = () => { try { localStorage.setItem(META, JSON.stringify(meta)); } catch (e) {} };
  let seq = Date.now(); // version stamp so edits made mid-sync are not lost
  const VERSION = 13; // shown in Settings so we can tell which version a device is running
  let acct = null; // the account's category ids as of the last sync, for the check line in Settings
  let user = null, syncing = false, again = false, timer = null, lastError = '';

  // ---------- local change queue ----------
  window.LedgerSync = {
    onLocalChange({ changed, deleted, settings, all }) {
      if (!user) return; // first sign-in uploads everything, so nothing to queue before then
      const n = ++seq;
      if (all) Ledger.state().txns.forEach(t => { meta.dirty[t.id] = n; });
      changed.forEach(id => { meta.dirty[id] = n; delete meta.deleted[id]; });
      deleted.forEach(id => { delete meta.dirty[id]; meta.deleted[id] = n; });
      if (settings) meta.settings = n;
      saveMeta(); schedule();
    },
  };

  const toRow = t => ({ id: t.id, user_id: user.id, amount: t.amt, type: t.type, category: t.cat, note: t.note || '', date: t.date, created_ms: Math.round(t.ts || Date.now()), deleted: false });
  const fromRow = r => ({ id: r.id, amt: Number(r.amount), type: r.type, cat: r.category, note: r.note || '', date: r.date, ts: Number(r.created_ms) });
  const tomb = id => ({ id, user_id: user.id, amount: 0, type: 'out', category: 'other', note: '', date: '1970-01-01', created_ms: 0, deleted: true });

  function schedule(ms = 700) { clearTimeout(timer); timer = setTimeout(sync, ms); }

  async function sync() {
    if (!user) return;
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { setDot('off'); return; }
    syncing = true; setDot('busy');
    try {
      const S = Ledger.state();
      // 1. push transactions
      const dirty = { ...meta.dirty }, gone = { ...meta.deleted };
      const byId = new Map(S.txns.map(t => [t.id, t]));
      const rows = Object.keys(dirty).filter(id => byId.has(id)).map(id => toRow(byId.get(id)))
        .concat(Object.keys(gone).map(tomb));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,id' });
        if (error) throw error;
      }
      Object.entries(dirty).forEach(([id, v]) => { if (meta.dirty[id] === v) delete meta.dirty[id]; });
      Object.entries(gone).forEach(([id, v]) => { if (meta.deleted[id] === v) delete meta.deleted[id]; });

      // 2. pull everything changed since the last pull (before settings, so the check below
      // sees which categories entries use now)
      const ups = [], dels = []; let maxTs = meta.lastPulled;
      for (let offset = 0; ; offset += 1000) {
        let q = sb.from('transactions').select('*').order('updated_at').order('id').range(offset, offset + 999);
        // small overlap so rows committed slightly out of order by another device are not missed
        if (meta.lastPulled) q = q.gt('updated_at', new Date(Date.parse(meta.lastPulled) - 10000).toISOString());
        const { data, error } = await q;
        if (error) throw error;
        data.forEach(r => {
          if (!maxTs || r.updated_at > maxTs) maxTs = r.updated_at;
          if (meta.dirty[r.id] || meta.deleted[r.id]) return; // local edit is newer
          if (r.deleted) dels.push(r.id); else ups.push(fromRow(r));
        });
        if (data.length < 1000) break;
      }
      // 3. settings: take changes made on other devices. When this device has its own changes
      // too, keep every category from both sides and push the result, so one device's copy
      // can never wipe out categories that only exist on another
      let remoteSettings = null;
      {
        const { data: remote, error } = await sb.from('settings').select('*').maybeSingle();
        if (error) throw error;
        const local = Ledger.prefs(), st = Ledger.state();
        const rCats = remote && remote.budgets && Array.isArray(remote.budgets.categories) ? remote.budgets.categories : [];
        // which categories entries use, after this sync's pulled changes
        const pulled = new Set(dels.concat(ups.map(t => t.id))), used = new Set(ups.map(t => t.cat));
        st.txns.forEach(t => { if (!pulled.has(t.id)) used.add(t.cat); });
        const ids = new Set(local.categories.map(c => c.id)), rIds = new Set(rCats.map(c => c.id));
        const missing = rCats.filter(c => !ids.has(c.id));
        // entries here point at a category only the account has, or at one only this device has:
        // repair either way, even if the timestamps match (devices on older versions could lose them)
        const orphaned = missing.some(c => used.has(c.id));
        acct = rIds;
        const accountLacks = local.categories.some(c => used.has(c.id) && !rIds.has(c.id));
        if (!remote) { if (!meta.settings) meta.settings = ++seq; }
        else if (meta.firstLink || remote.updated_at !== meta.settingsAt || !rCats.length !== !local.categories.length || orphaned || accountLacks) {
          // edits waiting here, a first sign-in on a device that already has categories,
          // or an account copy that is missing categories this device's entries use
          if (local.categories.length && (meta.settings || meta.firstLink || !rCats.length || accountLacks)) {
            if (missing.length) Ledger.applyRemote({ settings: { currency: st.currency, startDay: st.startDay,
              budgets: { ...local, categories: local.categories.concat(missing), setupDone: local.setupDone || remote.budgets?.setupDone !== false } } });
            if (!meta.settings) meta.settings = ++seq;
          } else { remoteSettings = remote; meta.settings = 0; } // nothing local to keep: the account's copy wins, and this device's empty list is never pushed
          meta.settingsAt = remote.updated_at;
        }
        meta.firstLink = false;
      }
      if (meta.settings) {
        const v = meta.settings; const st = Ledger.state();
        const { data, error } = await sb.from('settings').upsert({ user_id: user.id, currency: st.currency, start_day: st.startDay || 1, budgets: Ledger.prefs() }).select().single();
        if (error) throw error;
        meta.settingsAt = data.updated_at; if (meta.settings === v) meta.settings = 0;
        acct = new Set(Ledger.prefs().categories.map(c => c.id));
      }

      meta.lastPulled = maxTs;
      if (ups.length || dels.length || remoteSettings) {
        Ledger.applyRemote({ upserts: ups, deletes: dels, settings: remoteSettings && { currency: remoteSettings.currency, startDay: remoteSettings.start_day, budgets: remoteSettings.budgets } });
      }
      meta.lastSync = Date.now(); lastError = ''; saveMeta(); setDot('ok');
    } catch (e) {
      lastError = (e && e.message) || 'Sync failed'; setDot('err'); console.warn('sync', e);
      schedule(15000);
    } finally {
      syncing = false;
      if (again) { again = false; schedule(200); }
      renderAccount();
    }
  }

  // ---------- status dot ----------
  function setDot(state) {
    const d = $('#syncDot'); if (!d) return;
    d.hidden = !user; d.className = 'sync' + (state === 'ok' ? '' : ' ' + state);
    d.title = { ok: 'Synced', busy: 'Syncing…', off: 'Offline. Changes are saved on this device.', err: 'Sync problem: ' + lastError }[state];
  }

  // ---------- account lifecycle ----------
  function onUser(u) {
    if (user && user.id === u.id) return;
    if (meta.userId && meta.userId !== u.id) { Ledger.reset(false); meta = fresh(); } // different account on this device
    user = u; hideAuth();
    if (meta.userId !== u.id) { // first sign-in on this device: upload what's here, adopt the account's settings
      Ledger.clearSample();
      const keepSkipped = meta.skipped; meta = fresh(); meta.skipped = keepSkipped; meta.userId = u.id; meta.firstLink = true;
      const n = ++seq; Ledger.state().txns.forEach(t => { meta.dirty[t.id] = n; });
      saveMeta();
    }
    setDot('busy'); sync(); renderAccount();
  }
  async function signOut() {
    if (Object.keys(meta.dirty).length || Object.keys(meta.deleted).length) await sync();
    await sb.auth.signOut();
    user = null; meta = fresh(); saveMeta(); Ledger.reset(false); Ledger.closeSheets(); setDot('ok'); showAuth('in');
  }

  // ---------- login screen ----------
  let mode = 'in';
  const T = {
    in: ['Sign in to Tally', 'Your budget syncs across your phone and computer.', 'Sign in', 'New here? Create an account'],
    up: ['Create your account', 'Free. Your data stays private to you.', 'Create account', 'Already have an account? Sign in'],
    reset: ['Choose a new password', 'Enter a new password for your account.', 'Save password', 'Back to sign in'],
    forgot: ['Reset your password', 'We’ll email you a link to set a new one.', 'Send reset link', 'Back to sign in'],
  };
  function showAuth(m = mode) {
    mode = m; const [title, sub, btn, toggle] = T[m];
    $('#authTitle').textContent = title; $('#authSub').textContent = sub; $('#authSubmit').textContent = btn; $('#authToggle').textContent = toggle;
    $('#authEmail').hidden = m === 'reset'; $('#authEmail').required = m !== 'reset';
    $('#authPass').hidden = m === 'forgot'; $('#authPass').required = m !== 'forgot';
    $('#authPass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
    $('#authForgot').hidden = m !== 'in'; $('#authSkip').hidden = m === 'reset';
    msg(''); $('#authScreen').hidden = false;
  }
  function hideAuth() { $('#authScreen').hidden = true; }
  function msg(text, ok) { const el = $('#authMsg'); el.textContent = text; el.classList.toggle('ok', !!ok); }
  function friendly(e) {
    const m = (e && e.message) || '';
    if (/invalid login/i.test(m)) return 'That email and password don’t match.';
    if (/not confirmed/i.test(m)) return 'Confirm your email first. The link is in your inbox.';
    if (/already registered/i.test(m)) return 'That email already has an account. Sign in instead.';
    if (/password/i.test(m) && /6|8|characters/i.test(m)) return 'Use a password with at least 8 characters.';
    if (/fetch|network/i.test(m)) return 'Can’t reach the server. Check your connection.';
    if (/rate limit/i.test(m)) return 'Too many tries. Wait a minute and try again.';
    return m || 'Something went wrong. Try again.';
  }

  // add the "forgot password" link next to the toggle
  const forgot = document.createElement('button');
  forgot.type = 'button'; forgot.className = 'link muted'; forgot.id = 'authForgot'; forgot.textContent = 'Forgot password?';
  $('#authToggle').after(forgot);

  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#authEmail').value.trim(), password = $('#authPass').value;
    const btn = $('#authSubmit'); btn.disabled = true; msg('');
    const redirect = location.origin + location.pathname;
    try {
      if (mode === 'in') {
        const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
      } else if (mode === 'up') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect } }); if (error) throw error;
        if (!data.session) { showAuth('in'); $('#authEmail').value = email; msg('Check your email and tap the confirmation link, then sign in here.', true); }
      } else if (mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect }); if (error) throw error;
        msg('If that email has an account, a reset link is on its way.', true);
      } else if (mode === 'reset') {
        const { error } = await sb.auth.updateUser({ password }); if (error) throw error;
        hideAuth(); Ledger.toast('Password updated');
      }
    } catch (err) { msg(friendly(err)); }
    btn.disabled = false;
  });
  $('#authToggle').addEventListener('click', () => showAuth(mode === 'in' ? 'up' : 'in'));
  forgot.addEventListener('click', () => showAuth('forgot'));
  $('#authSkip').addEventListener('click', () => { meta.skipped = true; saveMeta(); hideAuth(); });

  // ---------- settings: account row ----------
  function ago(ms) { const s = (Date.now() - ms) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return new Date(ms).toLocaleDateString(); }
  function renderAccount() {
    const row = $('#accountRow'); if (!row) return; row.hidden = false;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    if (user) {
      const status = lastError ? 'Sync problem: ' + esc(lastError) : !navigator.onLine ? 'Offline, will sync later' : syncing ? 'Syncing…' : meta.lastSync ? 'Synced ' + ago(meta.lastSync) : 'Syncing…';
      // a quick check line: which version runs here and whether categories match the account's
      const S = Ledger.state(), here = new Set(S.cats.map(c => c.id));
      const lost = new Set(S.txns.map(t => t.cat).filter(id => id !== 'none' && id !== 'income' && !here.has(id)));
      const lostN = S.txns.filter(t => lost.has(t.cat)).length;
      const check = `Check: version ${VERSION} · ${S.cats.length} categories here, ${acct ? acct.size : '?'} on account · `
        + (lostN ? `${lostN} entries point at ${lost.size} unknown categor${lost.size > 1 ? 'ies' : 'y'}, ${acct ? [...lost].filter(id => acct.has(id)).length : '?'} of them on the account` : 'every entry has its category');
      row.innerHTML = `<span style="min-width:0">${esc(user.email || 'Signed in')}<br><span class="small">${status}</span><br><span class="small">${check}</span></span><button class="btn ghost" id="signOutBtn" style="flex:0 0 auto">Sign out</button>`;
      $('#signOutBtn').onclick = signOut;
    } else {
      row.innerHTML = `<span>Sync across devices<br><span class="small">Sign in to back up your budget</span></span><button class="btn" id="signInBtn" style="flex:0 0 auto">Sign in</button>`;
      $('#signInBtn').onclick = () => { Ledger.closeSheets(); showAuth('in'); };
    }
  }
  $('#openSettings').addEventListener('click', renderAccount);

  // ---------- triggers ----------
  window.addEventListener('online', () => schedule(100));
  window.addEventListener('offline', () => setDot('off'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(100); });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

  sb.auth.onAuthStateChange((event, session) => {
    // defer: supabase-js recommends not awaiting other calls inside this callback
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') { if (session) onUser(session.user); showAuth('reset'); return; }
      if (session && session.user) onUser(session.user);
      else if (event === 'INITIAL_SESSION' && !meta.skipped) showAuth('in');
      else if (event === 'SIGNED_OUT' && user) { user = null; showAuth('in'); }
      renderAccount();
    }, 0);
  });
})();
