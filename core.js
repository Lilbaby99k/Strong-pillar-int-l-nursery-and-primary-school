/* ============================================================================
   Strong Pillar Int'l Nursery and Primary School
   core.js — SHARED RUNTIME, identical in the parent/ and admin/ builds.

   Everything in this file is used by BOTH portals: the Supabase client,
   app state, sign-in, the password-reset OTP flow, the router and sidebar,
   toasts/loading/confirm dialogs, and the report-card viewer.

   KEEP THE TWO COPIES IN SYNC. This file is deliberately byte-identical in
   parent/core.js and admin/core.js — change one, copy it over the other:
       cp parent/core.js admin/core.js

   Anything role-specific lives in each portal's own app.js, never here.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   1. SUPABASE CLIENT
   ---------------------------------------------------------------------------- */
const SUPABASE_URL = 'https://ubogavbhnfothnmzuvqh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVib2dhdmJobmZvdGhubXp1dnFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MjczMzAsImV4cCI6MjEwMDIwMzMzMH0.-0tZXqyI7QwgT2BaQ51TO3n1XJNAhrrJzNhv2xTi7hM';

// Renamed from `supabase` to `supabaseClient` — the CDN script tag already
// defines a global named `supabase`, so declaring a const with that same
// name throws "Identifier has already been declared".
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The Google Apps Script Web App that sends every email this system sends
// (invites, welcome notes, approval/publish alerts, announcements, and
// "Forgot password?" OTP codes) — see Code.gs. Hardcoded rather than a
// School Settings field so this just works with no admin setup step.
const APPS_SCRIPT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycby4FQOfhVTy5gNK5ZmQqdI8pcMPVe1kj5tdNyS-0CL_s0OmJ_1oO0AqSnRatcjMJRepzw/exec';

/* ----------------------------------------------------------------------------
   2. SINGLE IN-MEMORY APP STATE
   One object drives the whole UI. Nothing else should hold app data in a
   scattered global. Treat this as read-mostly outside the setState() helper
   so every state change flows through one place and is easy to trace.
   ---------------------------------------------------------------------------- */
const appState = {
  user: null,            // { id, email, full_name, role, phone }
  authUser: null,         // raw supabase auth user
  activeSessionId: null,  // current academic session (loaded once sessions/terms exist)
  activeTermId: null,     // current term
  currentView: 'login',   // which content-view is active inside the app shell
  schoolSettings: null,   // cached school_settings row
  sidebarCollapsed: false,
};

function setState(patch) {
  Object.assign(appState, patch);
}

/* ----------------------------------------------------------------------------
   4. UI HELPERS — loading, toasts
   ---------------------------------------------------------------------------- */
function showLoading() {
  document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function showToast(message, type = 'default') {
  const region = document.getElementById('toast-region');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : ''}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

/* ----------------------------------------------------------------------------
   5. AUTH FLOW
   ---------------------------------------------------------------------------- */
// Supabase Auth needs an email to sign a user up/in — there's no SMS provider
// configured for real phone-based auth here. So a parent who registers
// without an email gets a synthetic one derived from their phone number,
// and can sign back in by typing that same phone number in the "email"
// field on the login screen. Not a real address; never shown to them.
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}
function phoneToSyntheticEmail(phone) {
  return `p${normalizePhone(phone)}@parent.internal`;
}
function looksLikeEmail(value) {
  return /\S+@\S+\.\S+/.test(value);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const rawInput = document.getElementById('login-email').value.trim();
  const email = looksLikeEmail(rawInput) ? rawInput : phoneToSyntheticEmail(rawInput);
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit-btn');

  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  showLoading();

  try {
    // "Remember me" stores only the typed identifier so it can be
    // prefilled next visit — never the password. The Supabase session
    // itself is handled by the SDK and is unaffected by this checkbox.
    const remember = document.getElementById('login-remember');
    if (remember) {
      if (remember.checked) localStorage.setItem('sp.rememberedLogin', rawInput);
      else localStorage.removeItem('sp.rememberedLogin');
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;

    await loadUserProfileAndEnterApp(data.user);
  } catch (err) {
    errorEl.textContent = mapAuthError(err);
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    hideLoading();
  }
}

function mapAuthError(err) {
  const msg = (err && err.message) || '';
  if (msg.toLowerCase().includes('invalid login')) {
    return 'Incorrect email or password. Please try again.';
  }
  if (msg.toLowerCase().includes('email not confirmed')) {
    return 'This account has not been confirmed yet. Contact the administrator.';
  }
  return msg || 'Sign in failed. Please try again.';
}

// SECURITY: the browser no longer creates its own profile row.
//
// It used to call `.from('users').insert({ id, role: 'parent', ... })`, which
// meant the ROLE was chosen client-side — anyone could sign up and send
// role: 'admin' instead. The profile is now created by the
// handle_new_auth_user() trigger on auth.users (see sql/02), which reads the
// role from the administrator's invite in pending_accounts, or defaults to
// 'parent' when there is no invite. There is no request that can choose its
// own role any more.
//
// The trigger fires inside the same transaction as the auth insert, but
// PostgREST may serve the very next read from a replica, so give it a moment
// rather than assuming the row is instantly visible.
async function waitForProfileRow(authUser, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const { data } = await supabaseClient
      .from('users')
      .select('id, role, full_name, email, phone, is_active')
      .eq('id', authUser.id)
      .maybeSingle();
    if (data) return data;
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

async function loadSchoolSettings() {
  const { data, error } = await supabaseClient.from('school_settings').select('*').single();
  if (!error && data) {
    setState({ schoolSettings: data });
    applySchoolBranding(data);
  }
}

async function loadActiveSessionAndTerm() {
  const { data: session } = await supabaseClient.from('sessions').select('id').eq('is_active', true).maybeSingle();
  const { data: term } = await supabaseClient.from('terms').select('id').eq('is_current', true).maybeSingle();
  setState({
    activeSessionId: session ? session.id : null,
    activeTermId: term ? term.id : null,
  });
}

/* ----------------------------------------------------------------------------
   5b. ACTIVE TERM SYNC (bugfix)
   BUG: appState.activeTermId/activeSessionId were only ever set at login and
   in the admin's own "Make Active" button handler — so any *other* already
   signed-in tab (e.g. a teacher's) kept the OLD term id in memory forever.
   Every term-scoped screen (Results, Report Cards, Promotions,
   Dashboard, Settings) reads/writes against appState.activeTermId, so a
   teacher who was signed in before the switch would keep seeing/editing the
   PREVIOUS term's enrollment+results — which looks exactly like "this
   term's boxes are pre-filled with last term's scores," because it's
   actually still last term's screen.

   Fix has two layers:
   1. A Supabase Realtime subscription so every open tab re-syncs the moment
      any admin flips the active session/term, anywhere.
   2. A cheap resync-on-navigate safety net (in dispatchViewLoad below) that
      re-checks the real active term before loading any term-scoped screen,
      so correctness doesn't depend on the realtime channel staying connected.
   ---------------------------------------------------------------------------- */
const TERM_DEPENDENT_VIEWS = ['dashboard', 'students', 'results', 'approvals', 'reportcards', 'promotions', 'settings'];

let termChangesChannel = null;

function subscribeToActiveTermChanges() {
  if (termChangesChannel) return; // already subscribed for this session
  termChangesChannel = supabaseClient
    .channel('active-term-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'terms' }, handleActiveTermOrSessionChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, handleActiveTermOrSessionChange)
    .subscribe();
}

function unsubscribeFromActiveTermChanges() {
  if (termChangesChannel) {
    supabaseClient.removeChannel(termChangesChannel);
    termChangesChannel = null;
  }
}

async function handleActiveTermOrSessionChange() {
  const previousTermId = appState.activeTermId;
  const previousSessionId = appState.activeSessionId;
  await loadActiveSessionAndTerm();
  renderTopbarContext();

  if (appState.activeTermId !== previousTermId || appState.activeSessionId !== previousSessionId) {
    if (TERM_DEPENDENT_VIEWS.includes(appState.currentView)) {
      dispatchViewLoad(appState.currentView);
    }
    showToast('The active academic term changed — this screen has refreshed to match.', 'default');
  }
}

async function handleLogout() {
  showLoading();
  unsubscribeFromActiveTermChanges();
  await supabaseClient.auth.signOut();
  setState({ user: null, authUser: null, currentView: 'login' });
  hideLoading();
  showView('login');
}

/* ---- Forgot password — OTP flow via Google Apps Script --------------------
   Replaces Supabase's own resetPasswordForEmail() link-based flow. The
   Apps Script webhook (School Settings > Email notifications) is the ONLY
   thing that sends this email now. Step 1 emails a 6-digit code; step 2
   sends the code + new password back to the same webhook, which verifies
   the code and changes the password via Supabase's Admin API — the
   anon key this page uses can't change another session's password, so
   that step has to happen server-side, inside the Apps Script.
   ---------------------------------------------------------------------------- */
const resetFlowState = { email: null };

function resetPasswordResetForm() {
  document.getElementById('reset-form-subtitle').textContent =
    "Enter your email (or phone, if that's how you sign in) and we'll email you a 6-digit code.";
  document.getElementById('reset-request-form').classList.remove('hidden');
  document.getElementById('reset-confirm-form').classList.add('hidden');
  document.getElementById('reset-resend-btn').classList.add('hidden');
  document.getElementById('reset-request-error').classList.add('hidden');
  document.getElementById('reset-confirm-error').classList.add('hidden');
  document.getElementById('reset-confirm-notice').classList.add('hidden');
  document.getElementById('reset-email').value = '';
  document.getElementById('reset-otp').value = '';
  document.getElementById('reset-new-password').value = '';
  document.getElementById('reset-new-password-confirm').value = '';
  resetFlowState.email = null;
}

async function handleResetRequestSubmit(event) {
  event.preventDefault();
  const errorEl = document.getElementById('reset-request-error');
  const btn = document.getElementById('reset-request-btn');
  errorEl.classList.add('hidden');

  const webhookUrl = APPS_SCRIPT_WEBHOOK_URL;
  if (!webhookUrl) {
    errorEl.textContent = "Password reset isn't set up for this school yet. Contact the administrator.";
    errorEl.classList.remove('hidden');
    return;
  }

  const rawInput = document.getElementById('reset-email').value.trim();
  if (!rawInput) {
    errorEl.textContent = 'Enter your email or phone number.';
    errorEl.classList.remove('hidden');
    return;
  }
  const email = looksLikeEmail(rawInput) ? rawInput : phoneToSyntheticEmail(rawInput);

  btn.disabled = true;
  showLoading();
  try {
    const res = await fetch(webhookUrl, { method: 'POST', body: JSON.stringify({ type: 'otp_request', email }) });
    if (!res.ok) {
      // A non-2xx here (e.g. 403) almost always means the Apps Script Web
      // App deployment's access isn't set to "Anyone" — Google intercepts
      // the request with a permission page before doPost() ever runs, so
      // there's no useful JSON body to parse. Surface the status so this
      // doesn't get mistaken for a code/expiry issue during support.
      throw new Error(`The email service rejected the request (HTTP ${res.status}). Contact the administrator — the Apps Script webhook deployment may need its access permissions fixed.`);
    }
    const data = await res.json().catch(() => null);
    if (data && data.error) throw new Error(data.error);

    resetFlowState.email = email;
    document.getElementById('reset-request-form').classList.add('hidden');
    document.getElementById('reset-confirm-form').classList.remove('hidden');
    document.getElementById('reset-resend-btn').classList.remove('hidden');
    document.getElementById('reset-form-subtitle').textContent =
      `If an account exists for ${rawInput}, a 6-digit code was just emailed. Enter it below with your new password.`;
  } catch (err) {
    // fetch() itself throws a generic "TypeError: Failed to fetch" when the
    // request is blocked by CORS or otherwise never reaches a server (as
    // opposed to reaching it and getting a non-2xx status, handled above).
    // That's indistinguishable from a dead network in the browser's own
    // message, so translate it into something actionable rather than
    // showing "Failed to fetch" verbatim.
    if (err instanceof TypeError) {
      errorEl.textContent = "Could not reach the email service (blocked by the browser). Contact the administrator — the Apps Script webhook deployment's access permissions likely need fixing.";
    } else {
      errorEl.textContent = err.message || 'Could not send the code right now. Please try again.';
    }
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    hideLoading();
  }
}

async function handleResetConfirmSubmit(event) {
  event.preventDefault();
  const errorEl = document.getElementById('reset-confirm-error');
  const noticeEl = document.getElementById('reset-confirm-notice');
  errorEl.classList.add('hidden');
  noticeEl.classList.add('hidden');

  if (!resetFlowState.email) {
    errorEl.textContent = 'Something went wrong — start over with "Forgot password?"';
    errorEl.classList.remove('hidden');
    return;
  }
  const otp = document.getElementById('reset-otp').value.trim();
  const newPassword = document.getElementById('reset-new-password').value;
  const confirmPassword = document.getElementById('reset-new-password-confirm').value;

  if (!/^\d{6}$/.test(otp)) {
    errorEl.textContent = 'Enter the 6-digit code from your email.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (newPassword.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.classList.remove('hidden');
    return;
  }

  const webhookUrl = APPS_SCRIPT_WEBHOOK_URL;
  const btn = document.getElementById('reset-confirm-btn');
  btn.disabled = true;
  showLoading();
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      body: JSON.stringify({ type: 'otp_verify', email: resetFlowState.email, otp, newPassword }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.success) throw new Error((data && data.error) || 'That code is invalid or has expired.');

    noticeEl.textContent = 'Password reset. You can sign in with it now.';
    noticeEl.classList.remove('hidden');
    setTimeout(() => showResetForm(false), 1800);
  } catch (err) {
    errorEl.textContent = err.message || 'Could not reset your password.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    hideLoading();
  }
}

/* ---- Activate-account, register, reset, & contact-form toggles ----------- */
function reportCardLinkURL(reportCardId) {
  return `${window.location.origin}${window.location.pathname}?rc=${reportCardId}`;
}

/* ----------------------------------------------------------------------------
   7. SIDEBAR RENDERING (role-scoped)
   ---------------------------------------------------------------------------- */
function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';
  const items = NAV_BY_ROLE[appState.user.role] || [];

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-nav-item';
    btn.dataset.viewKey = item.key;
    btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
    btn.addEventListener('click', () => { navigateTo(item.key); closeMobileSidebar(); });
    nav.appendChild(btn);
  });
}

function renderUserSummary() {
  const { user } = appState;
  document.getElementById('sidebar-user-name').textContent = user.full_name;
  document.getElementById('sidebar-user-role').textContent = user.role;
  document.getElementById('dash-user-name').textContent = user.full_name;
  document.getElementById('dash-user-role').textContent = user.role.charAt(0).toUpperCase() + user.role.slice(1);
  document.getElementById('dash-user-email').textContent = user.email;
  document.getElementById('dashboard-subheading').textContent =
    user.role === 'admin' ? "Here's what's happening across the school right now."
    : user.role === 'teacher' ? 'Welcome back — your class at a glance.'
    : "Welcome — here's what's new for your child.";
}

async function renderTopbarContext() {
  const el = document.getElementById('topbar-session-term');
  if (!appState.activeSessionId || !appState.activeTermId) {
    el.textContent = 'No active session/term set';
    return;
  }
  const { data: session } = await supabaseClient.from('sessions').select('name').eq('id', appState.activeSessionId).single();
  const { data: term } = await supabaseClient.from('terms').select('name').eq('id', appState.activeTermId).single();
  el.textContent = `${session ? session.name : '—'} · ${term ? term.name : '—'}`;
}

/* ----------------------------------------------------------------------------
   8. ROUTER
   Views are plain sections inside #app-content. Only #view-dashboard exists
   in Phase 1; every other nav key resolves to a placeholder until its phase
   is built, so navigation is fully wired from day one and each phase only
   needs to add a <section id="view-<key>"> plus real content — no router
   rewrite required.
   ---------------------------------------------------------------------------- */
// `fromHistory` is true only when we're reacting to a Back/Forward button
// press (see popstate listener below) — in that case the browser has
// already moved us to the right history entry, so we must NOT push a new
// one, or Back would feel like it does nothing / pushes you forward again.
function navigateTo(viewKey, fromHistory = false) {
  setState({ currentView: viewKey });

  document.querySelectorAll('.sidebar-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === viewKey);
  });

  if (!fromHistory) {
    // Record this screen as its own entry in the browser's history so the
    // Back/Forward buttons move between in-app screens instead of leaving
    // the app. The user's Supabase session lives in localStorage and is
    // completely untouched by this — moving through history never logs
    // them out, it just changes which screen is shown.
    const url = `#${viewKey}`;
    if (window.location.hash !== url) {
      history.pushState({ viewKey }, '', url);
    }
  }

  const content = document.getElementById('app-content');
  const existing = content.querySelector(`#view-${viewKey}`);

  if (existing) {
    content.querySelectorAll('.content-view').forEach(v => v.classList.add('hidden'));
    existing.classList.remove('hidden');
    dispatchViewLoad(viewKey);
    return;
  }

  renderPlaceholderView(viewKey);
}

// Fires on Back/Forward. We only ever push states of the shape
// { viewKey } from navigateTo() above, so if that's what we find, just
// re-render that screen (without pushing a duplicate history entry). If
// there's no state (e.g. the user landed here from outside the app, or
// this is the very first entry), fall back to the dashboard rather than
// doing nothing.
window.addEventListener('popstate', (event) => {
  if (!appState.user || document.getElementById('view-app').classList.contains('hidden')) return;
  const viewKey = (event.state && event.state.viewKey) || 'dashboard';
  navigateTo(viewKey, true);
});

// Screens that need to (re)fetch their data every time the admin navigates
// to them. Kept as one dispatch table rather than scattering calls through
// navigateTo(), so adding a new screen in a later phase is a one-line add.
async function dispatchViewLoad(viewKey) {
  // Safety net: even if the realtime subscription above is disconnected or
  // still connecting, never let a term-scoped screen load against a stale
  // appState.activeTermId — always re-check the real current term first.
  if (TERM_DEPENDENT_VIEWS.includes(viewKey)) {
    await loadActiveSessionAndTerm();
    renderTopbarContext();
  }
  const handler = VIEW_LOAD_HANDLERS[viewKey];
  if (handler) handler();
}

function renderPlaceholderView(viewKey) {
  const content = document.getElementById('app-content');
  content.querySelectorAll('.content-view').forEach(v => v.classList.add('hidden'));

  let placeholder = content.querySelector('#view-placeholder');
  if (!placeholder) {
    placeholder = document.createElement('section');
    placeholder.id = 'view-placeholder';
    placeholder.className = 'content-view';
    content.appendChild(placeholder);
  }

  const label = (NAV_BY_ROLE[appState.user.role] || []).find(i => i.key === viewKey);
  placeholder.classList.remove('hidden');
  placeholder.innerHTML = `
    <div class="view-header">
      <h1>${label ? label.label : viewKey}</h1>
      <p class="view-subheading">This module is built in a later phase, per the agreed build order.</p>
    </div>
    <div class="card card-notice">
      <p>Sidebar navigation and routing are already wired for this section — only the screen content is pending.</p>
    </div>
  `;
}

/* ----------------------------------------------------------------------------
   9. SIDEBAR COLLAPSE (mobile/tablet)
   ---------------------------------------------------------------------------- */
function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (window.innerWidth <= 860) {
    const isOpen = sidebar.classList.toggle('mobile-open');
    backdrop.classList.toggle('visible', isOpen);
  } else {
    setState({ sidebarCollapsed: !appState.sidebarCollapsed });
    sidebar.classList.toggle('collapsed', appState.sidebarCollapsed);
  }
}

function closeMobileSidebar() {
  document.getElementById('app-sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
}

/* ----------------------------------------------------------------------------
   11. SHARED HELPERS
   ---------------------------------------------------------------------------- */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Promise-based replacement for window.confirm(). Resolves true/false —
// call sites just add `await` in front of the old `confirm(...)` call and
// everything else about them (the `if (!... ) return;` guard) keeps working
// unchanged. Renders the shared #confirm-modal markup in index.html rather
// than the browser's native dialog, so it matches the rest of the app and
// can carry a proper title, longer body copy, and a danger styling variant
// for destructive actions (delete/withdraw/reject/cancel-invite).
let resolveConfirmDialog = null;

function showConfirmDialog(message, opts = {}) {
  const {
    title = 'Please confirm',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  } = opts;

  const overlay = document.getElementById('confirm-modal');
  const card = overlay.querySelector('.confirm-modal-card');
  const okBtn = document.getElementById('confirm-modal-ok-btn');
  const cancelBtn = document.getElementById('confirm-modal-cancel-btn');

  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-body').textContent = message;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;

  card.classList.toggle('is-danger', danger);
  okBtn.classList.toggle('btn-danger', danger);
  document.getElementById('confirm-modal-icon-question').classList.toggle('hidden', danger);
  document.getElementById('confirm-modal-icon-warning').classList.toggle('hidden', !danger);

  overlay.classList.remove('hidden');
  okBtn.focus();

  return new Promise((resolve) => {
    resolveConfirmDialog = (result) => {
      overlay.classList.add('hidden');
      resolveConfirmDialog = null;
      resolve(result);
    };
  });
}

// Wired once at bootstrap (section 28): OK/Cancel buttons, clicking the
// dark backdrop, and Escape all resolve the pending promise. A stray Enter
// keypress elsewhere in the app can't accidentally confirm something
// destructive, because this only listens while the modal is actually open.
function initConfirmDialog() {
  const overlay = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-ok-btn').addEventListener('click', () => {
    if (resolveConfirmDialog) resolveConfirmDialog(true);
  });
  document.getElementById('confirm-modal-cancel-btn').addEventListener('click', () => {
    if (resolveConfirmDialog) resolveConfirmDialog(false);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && resolveConfirmDialog) resolveConfirmDialog(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!resolveConfirmDialog) return;
    if (e.key === 'Escape') resolveConfirmDialog(false);
    if (e.key === 'Enter') resolveConfirmDialog(true);
  });
}

// Fires an outbound email via the school's Google Apps Script Web App, if
// one has been configured in Settings. Deliberately fire-and-forget: a
// failed or unconfigured notification should never block the underlying
// action (creating an invite, publishing a report card) from succeeding.
// The plain-string body (no custom headers) keeps this a CORS "simple
// request", which is what lets Apps Script Web Apps accept it without a
// preflight OPTIONS call.
// SECURITY: the webhook used to accept any { to, subject, body } from anyone
// on the internet — an open mail relay sending from the school's own address.
// It now requires a Supabase access token belonging to an active member of
// staff, which it verifies against Supabase rather than trusting. Attaching
// the token here is what keeps notifications working.
async function currentAccessToken() {
  const { data } = await supabaseClient.auth.getSession();
  return data?.session?.access_token || null;
}

async function sendAppsScriptEmail(payload) {
  const url = APPS_SCRIPT_WEBHOOK_URL;
  if (!url) return;
  try {
    const token = await currentAccessToken();
    await fetch(url, { method: 'POST', body: JSON.stringify({ type: 'notify', token, ...payload }) });
  } catch (err) {
    console.warn('Email notification failed to send:', err);
  }
}

// Same subject/body to many recipients at once (announcements). The Apps
// Script sends them one at a time server-side so one bad address can't
// block the rest — see Code.gs's handleBulk().
async function sendAppsScriptBulkEmail({ recipients, subject, body }) {
  const url = APPS_SCRIPT_WEBHOOK_URL;
  if (!url || !recipients || recipients.length === 0) return;
  try {
    const token = await currentAccessToken();
    await fetch(url, { method: 'POST', body: JSON.stringify({ type: 'bulk', token, recipients, subject, body }) });
  } catch (err) {
    console.warn('Bulk email notification failed to send:', err);
  }
}

function toggleInlineForm(cardId, show) {
  document.getElementById(cardId).classList.toggle('hidden', !show);
}

// Generic pagination: slices `rows`, renders `renderRowsFn` for the current
// page, and draws Prev/Next controls into `paginationElId`. Reused by
// Students, Staff, and Parents so large lists don't render hundreds of rows
// at once.
const PAGE_SIZE = 10;
function paginate(rows, page, paginationElId, onPageChange) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const start = (clampedPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const el = document.getElementById(paginationElId);
  if (el) {
    el.innerHTML = rows.length <= PAGE_SIZE ? '' : `
      <button type="button" id="${paginationElId}-prev" ${clampedPage === 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${clampedPage} of ${totalPages} (${rows.length} total)</span>
      <button type="button" id="${paginationElId}-next" ${clampedPage === totalPages ? 'disabled' : ''}>Next →</button>
    `;
    const prevBtn = document.getElementById(`${paginationElId}-prev`);
    const nextBtn = document.getElementById(`${paginationElId}-next`);
    if (prevBtn) prevBtn.addEventListener('click', () => onPageChange(clampedPage - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => onPageChange(clampedPage + 1));
  }
  return { pageRows, clampedPage };
}

// Shared cache of classes + their arms, used by both the Classes screen and
// the Students screen's class/arm dropdowns, so we don't fetch it twice.
/* ----------------------------------------------------------------------------
   20. REPORT CARD PREVIEW / PRINT (Phase 6)
   Shared overlay used by admin (preview + edit comments + publish before
   parents can see it), teacher (view their class's cards), and parent
   (view + print/save-as-PDF published cards). window.print() + the print
   stylesheet in styles.css does the PDF export — no extra library needed.
   ---------------------------------------------------------------------------- */
let currentPreviewCardId = null;

// Remembers the app's normal mobile viewport so it can be restored when the
// report card closes. Read once, lazily, the first time we need it.
let ORIGINAL_VIEWPORT_CONTENT = null;
function getViewportMeta() {
  return document.querySelector('meta[name="viewport"]');
}

// Phones/small tablets only — desktops and laptops should never be affected.
// A simple width check is more reliable than UA-sniffing across browsers.
function isMobileViewport() {
  return window.innerWidth <= 860;
}

// "Force desktop mode" for the report card only: swap the viewport meta tag
// from `width=device-width` to a fixed pixel width. The phone then lays the
// whole page out as if it were that wide (same effect as Chrome's "Desktop
// site" toggle) and lets the user pinch-zoom/pan to read it, instead of us
// trying to squeeze a ledger-style table into 360px. Parents only — admin
// and teacher keep the normal responsive layout on their own phones.
function forceDesktopViewportForReportCard() {
  if (appState.user.role !== 'parent' || !isMobileViewport()) return;
  const meta = getViewportMeta();
  if (!meta) return;
  ORIGINAL_VIEWPORT_CONTENT = meta.getAttribute('content');
  meta.setAttribute('content', 'width=1024');
}

function restoreNormalViewport() {
  if (ORIGINAL_VIEWPORT_CONTENT === null) return;
  const meta = getViewportMeta();
  if (meta) meta.setAttribute('content', ORIGINAL_VIEWPORT_CONTENT);
  ORIGINAL_VIEWPORT_CONTENT = null;
}

async function openReportCardPreview(reportCardId) {
  showLoading();
  try {
    const data = await fetchFullReportCardData(reportCardId);
    currentPreviewCardId = reportCardId;
    document.getElementById('report-card-print-area').innerHTML = renderReportCardHTML(data);

    const adminPanel = document.getElementById('report-card-admin-panel');
    const publishBtn = document.getElementById('rc-publish-btn');
    // Null-guarded: the parent build ships no admin panel markup at all,
    // so this same function works unchanged in both portals.
    if (adminPanel && publishBtn && appState.user.role === 'admin') {
      // Comments stay editable even after publishing — a card being
      // published locks the scores/grades, not the remark text, so an
      // admin can still go back and fill in (or fix) General Conduct,
      // the Class Teacher's Remark, the Head Teacher's Remark, or the
      // next-term details at any point. Previously this whole panel was
      // hidden the moment published_at was set, which meant those fields
      // could only ever be filled in BEFORE publishing and were stuck
      // showing "—" forever if that step was missed.
      document.getElementById('rc-general-conduct').value = data.card.general_conduct || '';
      document.getElementById('rc-teacher-comment').value = data.card.class_teacher_comment || '';
      document.getElementById('rc-head-comment').value = data.card.head_teacher_comment || '';
      document.getElementById('rc-next-term-begins').value = data.card.next_term_begins || '';
      document.getElementById('rc-next-term-fees').value = data.card.next_term_fees || '';
      adminPanel.classList.remove('hidden');

      if (data.card.published_at) {
        publishBtn.disabled = true;
        publishBtn.textContent = 'Already published';
      } else if (data.card.teacher_confirmed_at) {
        publishBtn.disabled = false;
        publishBtn.textContent = 'Publish this report card';
      } else {
        publishBtn.disabled = true;
        publishBtn.textContent = 'Waiting on class teacher to confirm first';
      }
    } else if (adminPanel) {
      adminPanel.classList.add('hidden');
    }

    forceDesktopViewportForReportCard();
    document.getElementById('report-card-overlay').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || 'Could not load report card.', 'error');
  } finally {
    hideLoading();
  }
}

function closeReportCardPreview() {
  document.getElementById('report-card-overlay').classList.add('hidden');
  currentPreviewCardId = null;
  restoreNormalViewport();
}

// TERM_ORDER lets us know which terms come "at or before" the term being
// printed, so a First Term card never shows Second/Third Term data (it
// wouldn't exist yet at that point in the year) while a Third Term card
// naturally shows all three — which is what makes it double as the annual
// view, per the school's actual printed template.
// Turns whatever is in students.passport_url into something displayable.
// A bare object path is signed against the private bucket; a legacy full URL
// is returned untouched so nothing breaks mid-migration.
async function studentPhotoUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const { data, error } = await supabaseClient
    .storage.from('student-photos').createSignedUrl(pathOrUrl, 3600);
  if (error) return null;
  return data?.signedUrl || null;
}

const TERM_ORDER = ['First Term', 'Second Term', 'Third Term'];

async function fetchFullReportCardData(reportCardId) {
  const { data: card, error } = await supabaseClient.from('report_cards').select('*').eq('id', reportCardId).single();
  if (error) throw error;

  const { data: enrollment } = await supabaseClient
    .from('enrollments')
    .select('id, class_id, arm_id, term_id, session_id, classes(name), class_arms(name, class_teacher_id), sessions(name), terms(name)')
    .eq('id', card.enrollment_id).single();

  const { data: student } = await supabaseClient
    .from('students').select('full_name, admission_number, gender, passport_url').eq('id', card.student_id).single();

  // SECURITY: a child's photograph must not sit on a permanent public URL.
  // It now lives in the private `student-photos` bucket and is fetched
  // through a signed link that expires in an hour. Rows that still hold an
  // old full URL keep working until the storage migration in sql/04 is done.
  if (student) student.passport_display_url = await studentPhotoUrl(student.passport_url);

  let teacherName = '—';
  if (enrollment?.class_arms?.class_teacher_id) {
    // SECURITY: reading this through .from('staff').select('users(full_name)')
    // would require parents to have read access to the users table for staff
    // rows — which would hand them every teacher's email and phone number.
    // staff_name() (sql/01) returns one string and nothing else.
    const { data: name } = await supabaseClient
      .rpc('staff_name', { p_id: enrollment.class_arms.class_teacher_id });
    teacherName = name || '—';
  }

  // Every subject the class is meant to study, so a subject with no
  // approved result yet for a given term still gets a blank row/cell
  // rather than disappearing entirely.
  const { data: classSubjectLinks } = await supabaseClient
    .from('class_subjects').select('subjects(id, name)').eq('class_id', enrollment.class_id);
  const allSubjects = (classSubjectLinks || []).map(l => l.subjects).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  // First Term and Second Term cards show only their own term's results.
  // The Third Term card is the session's final/annual ledger, so it shows
  // all three terms side by side per subject, standard Nigerian report-card
  // style — with an annual (First+Second+Third)/3 average per subject too.
  const includedTermNames = enrollment.terms.name === 'Third Term' ? TERM_ORDER : [enrollment.terms.name];
  const { data: sessionTerms } = await supabaseClient
    .from('terms').select('id, name').eq('session_id', enrollment.session_id).in('name', includedTermNames);

  // This student's enrollment in each of those terms (may not all exist).
  const { data: studentEnrollments } = await supabaseClient
    .from('enrollments').select('id, term_id').eq('student_id', card.student_id).eq('session_id', enrollment.session_id);

  // Approved results for each of those enrollments, keyed by term then subject.
  const resultsByTermAndSubject = {}; // { termName: { subjectId: {ca,exam,total,grade,remark} } }
  for (const termName of includedTermNames) {
    const term = (sessionTerms || []).find(t => t.name === termName);
    const enr = term ? (studentEnrollments || []).find(e => e.term_id === term.id) : null;
    resultsByTermAndSubject[termName] = {};
    if (!enr) continue;
    const { data: results } = await supabaseClient
      .from('results').select('subject_id, ca_score, exam_score, total_score, grade, remark')
      .eq('enrollment_id', enr.id).eq('status', 'approved');
    (results || []).forEach(r => { resultsByTermAndSubject[termName][r.subject_id] = r; });
  }

  // Build one row per subject with each included term's CA/Exam/Total, plus
  // a single Grade/Remark reflecting the most recently completed term that
  // has data for that subject (per the school's own template design). On
  // the Third Term card, also add this subject's annual total/average —
  // First + Second + Third Term totals, divided by 3 — but only once all
  // three terms actually have an approved result for that subject.
  // Fetch the current grading bands so the Annual Average gets its OWN grade —
  // previously this column just carried over whichever single term's grade was
  // most recent, which looks wrong sitting next to a different Annual Average
  // number (e.g. Annual Avg 65.3% showing the Third Term's own "A" instead of
  // the "B" that 65.3% itself falls into).
  const { data: gradingBands } = await supabaseClient
    .from('grading_rules').select('min_score, max_score, grade, remark').is('session_id', null);
  const findGradeBand = (score) => (gradingBands || []).find(b => score >= b.min_score && score <= b.max_score) || null;

  const isThirdTermCard = includedTermNames.length === 3;
  const subjectRows = allSubjects.map(subj => {
    const terms = includedTermNames.map(termName => resultsByTermAndSubject[termName][subj.id] || null);
    const latest = [...terms].reverse().find(t => t) || null;
    const allThreeTermsPresent = isThirdTermCard && terms.every(t => t);
    const annualTotal = allThreeTermsPresent ? terms.reduce((s, t) => s + Number(t.total_score), 0) : null;
    const annualAverage = allThreeTermsPresent ? annualTotal / 3 : null;
    const annualBand = annualAverage != null ? findGradeBand(annualAverage) : null;
    return {
      subjectName: subj.name,
      terms, // aligned with includedTermNames
      grade: annualBand ? annualBand.grade : (latest ? latest.grade : null),
      remark: annualBand ? annualBand.remark : (latest ? latest.remark : null),
      annualAverage,
    };
  });

  // Annual class position: rank this student against arm-mates' annual_average
  // (already computed by "Calculate annual averages" in Promotions, which
  // itself averages each student's First/Second/Third Term overall
  // percentage) — not by the Third Term's own percentage/position alone.
  let annualPosition = null, annualClassSize = null;
  if (isThirdTermCard && card.annual_average != null) {
    const { data: armEnrollments } = await supabaseClient
      .from('enrollments').select('id').eq('arm_id', enrollment.arm_id).eq('term_id', enrollment.term_id);
    const { data: siblingCards } = await supabaseClient
      .from('report_cards').select('id, annual_average').eq('is_annual', false)
      .not('annual_average', 'is', null)
      .in('enrollment_id', (armEnrollments || []).map(e => e.id));
    const ranked = (siblingCards || []).slice().sort((a, b) => Number(b.annual_average) - Number(a.annual_average));
    const idx = ranked.findIndex(c => c.id === card.id);
    if (idx !== -1) { annualPosition = idx + 1; annualClassSize = ranked.length; }
  }

  return {
    card, student, enrollment, teacherName,
    includedTermNames, subjectRows,
    annualPosition, annualClassSize,
    school: appState.schoolSettings,
  };
}

function renderReportCardHTML(data) {
  const { card, student, enrollment, teacherName, includedTermNames, subjectRows, annualPosition, annualClassSize, school } = data;
  const showAnnualColumn = includedTermNames.length === 3;
  const watermark = school?.report_watermark_url
    ? `<div class="rc-watermark"><img src="${school.report_watermark_url}" alt=""></div>` : '';
  const logo = school?.logo_url ? `<img class="rc-logo" src="${school.logo_url}" alt="School logo">` : '';
  const passport = student.passport_display_url
    ? `<img class="rc-passport" src="${student.passport_display_url}" alt="Passport photo">`
    : `<div class="rc-passport"></div>`;
  const signature = school?.principal_signature_url
    ? `<img src="${school.principal_signature_url}" alt="Principal's signature">` : '';

  const termAbbrev = { 'First Term': 'FIRST TERM', 'Second Term': 'SECOND TERM', 'Third Term': 'THIRD TERM' };

  const groupHeaderCells = includedTermNames.map(t => `<th colspan="3">${escapeHtml(termAbbrev[t] || t)}</th>`).join('');
  const subHeaderCells = includedTermNames.map(() => `<th class="num">C.A<br>40</th><th class="num">EXAM<br>60</th><th class="num">TOTAL<br>100</th>`).join('');
  const markObtainableCells = includedTermNames.map(() => `<td class="num">40</td><td class="num">60</td><td class="num">100</td>`).join('');

  const subjectBodyRows = subjectRows.map(row => {
    const termCells = row.terms.map(t => `
      <td class="num">${t ? t.ca_score : ''}</td>
      <td class="num">${t ? t.exam_score : ''}</td>
      <td class="num">${t ? t.total_score : ''}</td>
    `).join('');
    const annualCell = showAnnualColumn ? `<td class="num">${row.annualAverage != null ? row.annualAverage.toFixed(1) : ''}</td>` : '';
    return `
      <tr>
        <td>${escapeHtml(row.subjectName)}</td>
        ${termCells}
        ${annualCell}
        <td class="num">${escapeHtml(row.grade || '')}</td>
        <td>${escapeHtml(row.remark || '')}</td>
      </tr>`;
  }).join('');

  return `
    ${watermark}
    <div class="rc-header">
      ${logo}
      <div>
        <h1>${escapeHtml(school?.school_name || 'School')}</h1>
        <p>${escapeHtml(school?.address || '')}</p>
        <p>${escapeHtml(school?.motto || '')}</p>
      </div>
    </div>

    <div class="rc-report-title">
      <span>${escapeHtml(enrollment.terms.name)} Report</span>
      <span>${escapeHtml(enrollment.sessions.name)} Session</span>
    </div>

    <div class="rc-student-block">
      ${passport}
      <div class="rc-student-grid">
        <div><span>Name</span><span>${escapeHtml(student.full_name)}</span></div>
        <div><span>Sex</span><span>${escapeHtml(student.gender || '—')}</span></div>
        <div><span>Class</span><span>${escapeHtml(enrollment.classes.name)}</span></div>
        <div><span>No. in Class</span><span>${card.class_size ?? '—'}</span></div>
        <div><span>Total Score</span><span>${card.total_score != null ? card.total_score : '—'}</span></div>
        <div><span>Percentage</span><span>${card.percentage != null ? Number(card.percentage).toFixed(1) + '%' : '—'}</span></div>
        <div><span>Class Highest %</span><span>${card.class_highest_percentage != null ? Number(card.class_highest_percentage).toFixed(1) + '%' : '—'}</span></div>
        <div><span>Class Lowest %</span><span>${card.class_lowest_percentage != null ? Number(card.class_lowest_percentage).toFixed(1) + '%' : '—'}</span></div>
      </div>
    </div>

    <div class="rc-table-scroll">
      <table class="rc-subjects-table rc-ledger-table">
        <thead>
          <tr><th rowspan="2">Subject</th>${groupHeaderCells}${showAnnualColumn ? '<th rowspan="2">Annual<br>Avg</th>' : ''}<th rowspan="2">Grade</th><th rowspan="2">Teacher's Remark</th></tr>
          <tr>${subHeaderCells}</tr>
        </thead>
        <tbody>
          <tr class="rc-mark-obtainable"><td>Mark Obtainable</td>${markObtainableCells}${showAnnualColumn ? '<td></td>' : ''}<td></td><td></td></tr>
          ${subjectBodyRows || `<tr><td colspan="${2 + includedTermNames.length * 3 + (showAnnualColumn ? 1 : 0)}" style="text-align:center;color:var(--color-slate);">No approved subject results yet.</td></tr>`}
        </tbody>
      </table>
    </div>

    ${enrollment.terms.name === 'Third Term' && card.annual_average != null ? `
      <div class="rc-summary" style="grid-template-columns: repeat(3, 1fr);">
        <div class="rc-summary-box"><div class="label">Annual Average</div><div class="value">${Number(card.annual_average).toFixed(1)}%</div></div>
        <div class="rc-summary-box"><div class="label">Annual Position</div><div class="value" style="font-size:14px;">${annualPosition != null ? `${annualPosition} of ${annualClassSize}` : '—'}</div></div>
        <div class="rc-summary-box"><div class="label">Promotion Status</div><div class="value" style="font-size:14px;">${escapeHtml(card.promotion_status || 'Pending')}</div></div>
      </div>` : ''}

    <div class="rc-comments">
      <div class="rc-comment-row"><div class="who">General Conduct</div><div>${escapeHtml(card.general_conduct || '—')}</div></div>
      <div class="rc-comment-row"><div class="who">Class Teacher's Remark</div><div>${escapeHtml(card.class_teacher_comment || '—')}</div></div>
      <div class="rc-comment-row"><div class="who">Head Teacher's Remark</div><div>${escapeHtml(card.head_teacher_comment || '—')}</div></div>
      <div class="rc-comment-row"><div class="who">Next Term Begins</div><div>${card.next_term_begins ? new Date(card.next_term_begins).toLocaleDateString() : '—'}</div></div>
      <div class="rc-comment-row"><div class="who">Next Term School Fees</div><div>${escapeHtml(card.next_term_fees || '—')}</div></div>
    </div>

    <div class="rc-signatures">
      <div class="rc-signature-box">
        <div class="rc-signature-line">Class Teacher — ${escapeHtml(teacherName)}</div>
      </div>
      <div class="rc-signature-box">
        ${signature}
        <div class="rc-signature-line">Principal — ${escapeHtml(school?.principal_name || '')}</div>
      </div>
    </div>

    <p class="rc-footer-date">Generated ${card.generated_at ? new Date(card.generated_at).toLocaleDateString() : ''}${card.published_at ? ` · Published ${new Date(card.published_at).toLocaleDateString()}` : ''}</p>
  `;
}


/* ----------------------------------------------------------------------------
   REPORT CARD OVERLAY — shared wiring (close + print only).
   The admin build adds its own "save comments" / "publish" wiring on top of
   this in app.js; the parent build never does.
   ---------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('close-report-card-btn').addEventListener('click', closeReportCardPreview);
  document.getElementById('print-report-card-btn').addEventListener('click', () => window.print());
});

/* ----------------------------------------------------------------------------
   SHARED BOOTSTRAP PIECES — called from each portal's own bootstrap().
   ---------------------------------------------------------------------------- */
function wirePasswordToggles() {
  document.querySelectorAll('[data-password-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.passwordToggle);
      if (!input) return;
      const nowVisible = input.type === 'password';
      input.type = nowVisible ? 'text' : 'password';
      btn.querySelector('.icon-eye-open').classList.toggle('hidden', nowVisible);
      btn.querySelector('.icon-eye-closed').classList.toggle('hidden', !nowVisible);
      btn.setAttribute('aria-label', nowVisible ? 'Hide password' : 'Show password');
    });
  });
}

function wireSharedLoginEvents() {
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('forgot-password-btn').addEventListener('click', () => showResetForm(true));
  document.getElementById('back-to-login-from-reset-btn').addEventListener('click', () => showResetForm(false));
  document.getElementById('reset-request-form').addEventListener('submit', handleResetRequestSubmit);
  document.getElementById('reset-confirm-form').addEventListener('submit', handleResetConfirmSubmit);
  document.getElementById('reset-resend-btn').addEventListener('click', () => {
    document.getElementById('reset-request-form').classList.remove('hidden');
    document.getElementById('reset-confirm-form').classList.add('hidden');
    document.getElementById('reset-resend-btn').classList.add('hidden');
  });
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);
  initConfirmDialog();

  // Prefill the identifier if "Remember me" was ticked on a previous visit.
  const remembered = localStorage.getItem('sp.rememberedLogin');
  if (remembered) {
    document.getElementById('login-email').value = remembered;
    const cb = document.getElementById('login-remember');
    if (cb) cb.checked = true;
  }
}

// Signs the user straight back out when they reach the wrong portal, so a
// parent who lands on the staff URL (or vice versa) gets a clear message
// instead of an empty, half-broken shell. This is a usability guard, NOT a
// security boundary — the real enforcement is Supabase Row Level Security.
async function rejectWrongPortal(message, redirectTo) {
  showToast(message, 'error');
  await supabaseClient.auth.signOut();
  setState({ user: null, authUser: null });
  showView('login');
  if (redirectTo) {
    setTimeout(() => { window.location.href = redirectTo; }, 2600);
  }
}